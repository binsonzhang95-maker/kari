package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	mcpContextSchemaVersion = 1
	mcpSessionTTL           = 12 * time.Hour
	mcpTargetHost           = "host"
	mcpTargetContainer      = "container"
)

// containerUsesUnixSocket reports whether a container-side MCP bridge
// should reach the local-exec loopback over the bind-mounted unix socket
// instead of the TCP listener.
//
// On native Linux Docker the runtime-root bind mount makes the host unix
// socket directly reachable inside the container, and host.docker.internal
// resolves to the docker bridge gateway (e.g. 172.17.0.1) — which the
// loopback's 127.0.0.1-bound TCP listener does NOT answer, so TCP fails
// with EOF. On Docker Desktop (macOS/Windows) the reverse holds: a
// bind-mounted host unix socket is not connectable from the container, but
// host.docker.internal reaches the host loopback, so TCP is required.
func containerUsesUnixSocket() bool {
	return runtime.GOOS == "linux"
}

type mcpSessionManager struct {
	mu          sync.Mutex
	runtimeRoot string
	socketPath  string
	serverAddr  string
	issueToken  func(workspaceID, clientID, terminalID string) (string, error)
	revokeToken func(token string)
	now         func() time.Time
	ttl         time.Duration
	sessions    map[string]*mcpSession
}

type mcpSession struct {
	TerminalID  string
	WorkspaceID string
	ClientID    string
	Token       string
	ContextPath string
	TokenPath   string
	CreatedAt   time.Time
	LastUsedAt  time.Time
}

type mcpContextJSON struct {
	SchemaVersion int    `json:"schema_version"`
	WorkspaceID   string `json:"workspace_id"`
	ClientID      string `json:"client_id"`
	TerminalID    string `json:"terminal_id"`
	ServerSocket  string `json:"server_socket,omitempty"`
	ServerAddr    string `json:"server_addr,omitempty"`
	TokenFile     string `json:"token_file"`
}

func newMCPSessionManager(runtimeRoot, socketPath, serverAddr string, issueToken func(string, string, string) (string, error), revokeToken func(string)) *mcpSessionManager {
	return &mcpSessionManager{
		runtimeRoot: strings.TrimSpace(runtimeRoot),
		socketPath:  strings.TrimSpace(socketPath),
		serverAddr:  strings.TrimSpace(serverAddr),
		issueToken:  issueToken,
		revokeToken: revokeToken,
		now:         time.Now,
		ttl:         mcpSessionTTL,
		sessions:    map[string]*mcpSession{},
	}
}

func (m *mcpSessionManager) CreateSession(workspaceID, clientID string) (*mcpSession, error) {
	terminalID, err := newMCPTerminalID()
	if err != nil {
		return nil, err
	}
	return m.CreateSessionForTerminal(workspaceID, clientID, terminalID, mcpTargetHost)
}

func (m *mcpSessionManager) CreateSessionForTerminal(workspaceID, clientID, terminalID, target string) (*mcpSession, error) {
	if m == nil {
		return nil, errors.New("mcp session manager not configured")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	clientID = strings.TrimSpace(clientID)
	terminalID = strings.TrimSpace(terminalID)
	target = strings.TrimSpace(target)
	if target == "" {
		target = mcpTargetHost
	}
	if workspaceID == "" || clientID == "" {
		return nil, errors.New("workspace_id and client_id are required")
	}
	if !validMCPTerminalID(terminalID) {
		return nil, fmt.Errorf("invalid terminal_id %q", terminalID)
	}
	if m.runtimeRoot == "" || m.issueToken == nil {
		return nil, errors.New("mcp session manager incomplete")
	}
	switch target {
	case mcpTargetHost:
		if m.socketPath == "" {
			return nil, errors.New("mcp session manager missing host server_socket")
		}
	case mcpTargetContainer:
		if containerUsesUnixSocket() {
			if m.socketPath == "" {
				return nil, errors.New("mcp session manager missing container server_socket")
			}
		} else if m.serverAddr == "" {
			return nil, errors.New("mcp session manager missing container server_addr")
		}
	default:
		return nil, fmt.Errorf("unknown mcp target %q", target)
	}

	m.mu.Lock()
	if _, exists := m.sessions[terminalID]; exists {
		m.mu.Unlock()
		return nil, fmt.Errorf("mcp session %s already exists", terminalID)
	}
	m.mu.Unlock()

	token, err := m.issueToken(workspaceID, clientID, terminalID)
	if err != nil {
		return nil, err
	}
	sessionDir := filepath.Join(m.runtimeRoot, "sessions", terminalID)
	tokenPath := filepath.Join(sessionDir, "mcp-token")
	contextPath := filepath.Join(sessionDir, "context.json")
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		m.revoke(token)
		return nil, fmt.Errorf("mkdir mcp session dir %s: %w", sessionDir, err)
	}
	if err := os.Chmod(sessionDir, 0o700); err != nil {
		m.revoke(token)
		_ = os.RemoveAll(sessionDir)
		return nil, fmt.Errorf("chmod mcp session dir %s: %w", sessionDir, err)
	}
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		m.revoke(token)
		_ = os.RemoveAll(sessionDir)
		return nil, fmt.Errorf("write mcp token %s: %w", tokenPath, err)
	}
	ctx := mcpContextJSON{
		SchemaVersion: mcpContextSchemaVersion,
		WorkspaceID:   workspaceID,
		ClientID:      clientID,
		TerminalID:    terminalID,
		TokenFile:     tokenPath,
	}
	switch target {
	case mcpTargetContainer:
		// Linux: the bind-mounted unix socket is reachable in-container and
		// avoids exposing a TCP RCE port; Docker Desktop: TCP is the only
		// path that works. See containerUsesUnixSocket.
		if containerUsesUnixSocket() {
			ctx.ServerSocket = m.socketPath
		} else {
			ctx.ServerAddr = m.serverAddr
		}
	case mcpTargetHost:
		ctx.ServerSocket = m.socketPath
	}
	data, err := json.MarshalIndent(ctx, "", "  ")
	if err != nil {
		m.revoke(token)
		_ = os.RemoveAll(sessionDir)
		return nil, err
	}
	if err := os.WriteFile(contextPath, data, 0o600); err != nil {
		m.revoke(token)
		_ = os.RemoveAll(sessionDir)
		return nil, fmt.Errorf("write mcp context %s: %w", contextPath, err)
	}
	now := m.now()
	s := &mcpSession{
		TerminalID:  terminalID,
		WorkspaceID: workspaceID,
		ClientID:    clientID,
		Token:       token,
		ContextPath: contextPath,
		TokenPath:   tokenPath,
		CreatedAt:   now,
		LastUsedAt:  now,
	}
	m.mu.Lock()
	if _, exists := m.sessions[terminalID]; exists {
		m.mu.Unlock()
		m.revoke(token)
		_ = os.RemoveAll(sessionDir)
		return nil, fmt.Errorf("mcp session %s already exists", terminalID)
	}
	m.sessions[terminalID] = s
	m.mu.Unlock()
	return s, nil
}

func (m *mcpSessionManager) GetSession(terminalID string) (*mcpSession, bool) {
	if m == nil || strings.TrimSpace(terminalID) == "" {
		return nil, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[terminalID]
	if s == nil {
		return nil, false
	}
	s.LastUsedAt = m.now()
	copy := *s
	return &copy, true
}

func (m *mcpSessionManager) TouchSession(terminalID string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	if s := m.sessions[terminalID]; s != nil {
		s.LastUsedAt = m.now()
	}
	m.mu.Unlock()
}

func (m *mcpSessionManager) ReleaseSession(terminalID string) {
	if m == nil || strings.TrimSpace(terminalID) == "" {
		return
	}
	m.mu.Lock()
	s := m.sessions[terminalID]
	delete(m.sessions, terminalID)
	m.mu.Unlock()
	if s == nil {
		return
	}
	m.revoke(s.Token)
	if err := os.RemoveAll(filepath.Dir(s.ContextPath)); err != nil {
		log.Printf("mcp session release: remove %s: %v", filepath.Dir(s.ContextPath), err)
	}
}

func (m *mcpSessionManager) SweepExpired() int {
	if m == nil {
		return 0
	}
	now := m.now()
	var expired []*mcpSession
	m.mu.Lock()
	for id, s := range m.sessions {
		if now.Sub(s.LastUsedAt) > m.ttl {
			expired = append(expired, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range expired {
		m.revoke(s.Token)
		if err := os.RemoveAll(filepath.Dir(s.ContextPath)); err != nil {
			log.Printf("mcp sweep: remove %s: %v", filepath.Dir(s.ContextPath), err)
		}
	}
	if len(expired) > 0 {
		log.Printf("mcp sweep: cleaned %d expired sessions", len(expired))
	}
	return len(expired)
}

func (m *mcpSessionManager) runSweepLoop(ctx context.Context, interval time.Duration) {
	if m == nil {
		return
	}
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.SweepExpired()
		}
	}
}

func (m *mcpSessionManager) revoke(token string) {
	if m.revokeToken != nil {
		m.revokeToken(token)
	}
}

func newMCPTerminalID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func validMCPTerminalID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_':
			continue
		default:
			return false
		}
	}
	return true
}
