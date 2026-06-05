package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// localExecLoopback is the bridge-facing HTTP server kari-server runs
// on a process-local unix socket under the server-wide MCP runtime root.
// Each launched kari-mcp-bridge sidecar reads the socket path + token
// from its per-terminal context and posts MCP tool-call payloads here.
// We deliberately do
// NOT expose this on the public gRPC listener — both for blast radius
// (bridge bugs shouldn't reach untrusted callers) and for setup
// simplicity (no AES envelope to manage when both ends are co-located).
type localExecLoopback struct {
	router *localExecRouter

	mu            sync.Mutex
	unixListener  net.Listener
	tcpListener   net.Listener
	socketPath    string
	tcpAddr       string
	containerAddr string
	server        *http.Server
	signingKey    []byte
	revokedTokens map[string]time.Time
	now           func() time.Time

	terminalAlive func(workspaceID, terminalID string) bool
	touchSession  func(terminalID string)
}

type loopbackTokenScope struct {
	WorkspaceID string
	ClientID    string
	TerminalID  string
	ExpiresAt   time.Time
}

type loopbackAuth struct {
	Token string
	Scope loopbackTokenScope
}

func newLocalExecLoopback(router *localExecRouter, signingKey []byte) *localExecLoopback {
	return &localExecLoopback{
		router:        router,
		signingKey:    append([]byte(nil), signingKey...),
		revokedTokens: map[string]time.Time{},
		now:           time.Now,
	}
}

// Start binds to <runtimeRoot>/loopback.sock and also to a host-only
// TCP listener. Host-side bridges prefer the unix socket; container-side
// bridges can reach the TCP listener through host.docker.internal because
// Docker Desktop does not support connecting to a bind-mounted host unix
// socket from inside the container. Per-bridge bearer tokens are minted by
// IssueToken after the PTY session has resolved its workspace/client scope.
func (l *localExecLoopback) Start(runtimeRoot string) error {
	socketPath, err := prepareLocalExecSocket(runtimeRoot)
	if err != nil {
		return err
	}
	unixLis, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("loopback listen unix %s: %w", socketPath, err)
	}
	if err := os.Chmod(socketPath, 0o666); err != nil {
		_ = unixLis.Close()
		return fmt.Errorf("chmod loopback socket %s: %w", socketPath, err)
	}
	tcpLis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = unixLis.Close()
		return fmt.Errorf("loopback listen tcp: %w", err)
	}
	tcpAddr := tcpLis.Addr().String()
	_, port, err := net.SplitHostPort(tcpAddr)
	if err != nil {
		_ = unixLis.Close()
		_ = tcpLis.Close()
		return fmt.Errorf("loopback tcp addr %q: %w", tcpAddr, err)
	}
	containerAddr := net.JoinHostPort("host.docker.internal", port)
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/local-exec/register", l.requireAuth(l.handleRegister))
	mux.HandleFunc("/v1/local-exec/register/release", l.requireAuth(l.handleUnregister))
	mux.HandleFunc("/v1/local-exec/run", l.requireAuth(l.handleRun))

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout — long builds need to stay connected. Per-
		// request ctx (and the upstream bridge's own ctx) handles
		// cancellation; an idle hang would be visible via the bridge
		// disconnecting from the LLM side.
	}
	l.mu.Lock()
	l.unixListener = unixLis
	l.tcpListener = tcpLis
	l.socketPath = socketPath
	l.tcpAddr = tcpAddr
	l.containerAddr = containerAddr
	l.server = srv
	l.mu.Unlock()
	serve := func(name string, lis net.Listener) {
		if err := srv.Serve(lis); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("local-exec loopback serve %s: %v", name, err)
		}
	}
	go serve("unix", unixLis)
	go serve("tcp", tcpLis)
	log.Printf("local-exec loopback listening on %s tcp=%s container_tcp=%s", socketPath, tcpAddr, containerAddr)
	return nil
}

// Stop closes the loopback listener and waits for in-flight handlers
// to drain. Called from the server's shutdown path.
func (l *localExecLoopback) Stop(ctx context.Context) error {
	l.mu.Lock()
	srv := l.server
	l.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

// Addr returns the listener address. Since v2.3.2 this is the unix
// socket path, not a host:port pair. Kept for compatibility with
// dormant callers that only need a string to pass to bridge config.
func (l *localExecLoopback) Addr() string { return l.SocketPath() }

// SocketPath returns the unix socket path the loopback is listening on,
// or "" if Start has not been called yet.
func (l *localExecLoopback) SocketPath() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.socketPath
}

// ContainerAddr returns the host address containers should use to reach
// the loopback TCP listener. Empty when Start has not completed.
func (l *localExecLoopback) ContainerAddr() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.containerAddr
}

func prepareLocalExecSocket(runtimeRoot string) (string, error) {
	runtimeRoot = strings.TrimSpace(runtimeRoot)
	if runtimeRoot == "" {
		return "", errors.New("mcp runtime root required")
	}
	if err := os.MkdirAll(runtimeRoot, 0o755); err != nil {
		return "", fmt.Errorf("mkdir mcp runtime root %s: %w", runtimeRoot, err)
	}
	socketPath := filepath.Join(runtimeRoot, "loopback.sock")
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("remove stale loopback socket %s: %w", socketPath, err)
	}
	return socketPath, nil
}

const (
	loopbackTokenVersion = 1
	loopbackTokenPrefix  = "kmt1"
	// Twelve hours covers the intended upper bound of one long remote
	// Claude/Codex work session without requiring the bridge to refresh
	// credentials mid-build. Stale context directories are swept every
	// five minutes by the MCP session manager; if PTY cleanup, bridge
	// release, and sweeping all fail, the worst-case leaked local-exec
	// capability window is this fixed token TTL.
	loopbackTokenTTL = 12 * time.Hour
)

type loopbackTokenClaims struct {
	Version       int    `json:"v"`
	WorkspaceID   string `json:"workspace_id"`
	ClientID      string `json:"client_id"`
	TerminalID    string `json:"terminal_id"`
	IssuedAtUnix  int64  `json:"iat"`
	ExpiresAtUnix int64  `json:"exp"`
	Nonce         string `json:"nonce"`
}

// IssueToken returns a fresh bearer token scoped to exactly one
// workspace/client/terminal tuple. The bridge still sends those fields
// in its register body for diagnostics and mismatch detection, but the
// loopback endpoint derives authority from this signed token rather
// than trusting the body. Tokens are stateless so a ConsoleZ restart
// does not invalidate a just-written context file before Claude/Codex
// has a chance to register its MCP bridge.
func (l *localExecLoopback) IssueToken(workspaceID, clientID, terminalID string) (string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	clientID = strings.TrimSpace(clientID)
	terminalID = strings.TrimSpace(terminalID)
	if workspaceID == "" || clientID == "" {
		return "", errors.New("workspace_id and client_id are required")
	}
	if !validMCPTerminalID(terminalID) {
		return "", fmt.Errorf("invalid terminal_id %q", terminalID)
	}
	if len(l.signingKey) == 0 {
		return "", errors.New("loopback signing key is not configured")
	}
	nonce, err := newLoopbackNonce()
	if err != nil {
		return "", err
	}
	now := l.currentTime()
	claims := loopbackTokenClaims{
		Version:       loopbackTokenVersion,
		WorkspaceID:   workspaceID,
		ClientID:      clientID,
		TerminalID:    terminalID,
		IssuedAtUnix:  now.Unix(),
		ExpiresAtUnix: now.Add(loopbackTokenTTL).Unix(),
		Nonce:         nonce,
	}
	return l.signLoopbackToken(claims)
}

func (l *localExecLoopback) revokeToken(token string) {
	if token == "" {
		return
	}
	authInfo, ok := l.authenticateToken(token)
	exp := l.currentTime().Add(loopbackTokenTTL)
	if ok {
		exp = authInfo.Scope.ExpiresAt
	}
	l.mu.Lock()
	if l.revokedTokens == nil {
		l.revokedTokens = map[string]time.Time{}
	}
	l.purgeRevokedTokensLocked(l.currentTime())
	l.revokedTokens[loopbackTokenFingerprint(token)] = exp
	l.mu.Unlock()
}

func (l *localExecLoopback) authenticateToken(token string) (loopbackAuth, bool) {
	now := l.currentTime()
	claims, ok := l.verifyLoopbackToken(token, now)
	if !ok {
		return loopbackAuth{}, false
	}
	l.mu.Lock()
	l.purgeRevokedTokensLocked(now)
	if exp, revoked := l.revokedTokens[loopbackTokenFingerprint(token)]; revoked && now.Before(exp) {
		l.mu.Unlock()
		return loopbackAuth{}, false
	}
	l.mu.Unlock()
	scope := loopbackTokenScope{
		WorkspaceID: claims.WorkspaceID,
		ClientID:    claims.ClientID,
		TerminalID:  claims.TerminalID,
		ExpiresAt:   time.Unix(claims.ExpiresAtUnix, 0),
	}
	return loopbackAuth{Token: token, Scope: scope}, true
}

func (l *localExecLoopback) purgeRevokedTokensLocked(now time.Time) {
	for token, exp := range l.revokedTokens {
		if !now.Before(exp) {
			delete(l.revokedTokens, token)
		}
	}
}

func (l *localExecLoopback) currentTime() time.Time {
	if l != nil && l.now != nil {
		return l.now()
	}
	return time.Now()
}

func (l *localExecLoopback) signLoopbackToken(claims loopbackTokenClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(payload)
	sig := l.loopbackSignature([]byte(payloadB64))
	return loopbackTokenPrefix + "." + payloadB64 + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func (l *localExecLoopback) verifyLoopbackToken(token string, now time.Time) (loopbackTokenClaims, bool) {
	var zero loopbackTokenClaims
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != loopbackTokenPrefix || parts[1] == "" || parts[2] == "" || len(l.signingKey) == 0 {
		return zero, false
	}
	want := l.loopbackSignature([]byte(parts[1]))
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(got, want) {
		return zero, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return zero, false
	}
	var claims loopbackTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return zero, false
	}
	if claims.Version != loopbackTokenVersion ||
		strings.TrimSpace(claims.WorkspaceID) == "" ||
		strings.TrimSpace(claims.ClientID) == "" ||
		!validMCPTerminalID(claims.TerminalID) ||
		claims.ExpiresAtUnix <= 0 ||
		!now.Before(time.Unix(claims.ExpiresAtUnix, 0)) {
		return zero, false
	}
	return claims, true
}

func (l *localExecLoopback) loopbackSignature(payload []byte) []byte {
	mac := hmac.New(sha256.New, l.signingKey)
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func deriveLoopbackSigningKey(parts ...string) []byte {
	h := sha256.New()
	_, _ = h.Write([]byte("kari-mcp-loopback-v1"))
	for _, p := range parts {
		_, _ = h.Write([]byte{0})
		_, _ = h.Write([]byte(strings.TrimSpace(p)))
	}
	return h.Sum(nil)
}

func loopbackTokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", sum[:8])
}

// requireAuth wraps a handler with bearer-token validation. The listener
// is a unix socket, so there is no network remote address to sanity-check;
// socket filesystem visibility plus the scoped bearer token are the
// intended boundary.
func (l *localExecLoopback) requireAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(auth, prefix) {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(auth, prefix)
		authInfo, ok := l.authenticateToken(token)
		if !ok {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), loopbackAuthContextKey{}, authInfo)))
	}
}

type loopbackAuthContextKey struct{}

func loopbackAuthFromContext(ctx context.Context) (loopbackAuth, bool) {
	authInfo, ok := ctx.Value(loopbackAuthContextKey{}).(loopbackAuth)
	return authInfo, ok
}

func (l *localExecLoopback) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req bridgeRegistrationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	authInfo, ok := loopbackAuthFromContext(r.Context())
	if !ok {
		http.Error(w, "missing auth scope", http.StatusInternalServerError)
		return
	}
	if req.WorkspaceID != authInfo.Scope.WorkspaceID || req.ClientID != authInfo.Scope.ClientID || req.TerminalID != authInfo.Scope.TerminalID {
		http.Error(w, "token scope does not match bridge registration", http.StatusForbidden)
		return
	}
	if l.terminalAlive != nil && !l.terminalAlive(authInfo.Scope.WorkspaceID, authInfo.Scope.TerminalID) {
		http.Error(w, "mcp terminal session is no longer active", http.StatusGone)
		return
	}
	id, err := l.router.RegisterBridge(authInfo.Scope.WorkspaceID, authInfo.Scope.ClientID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if l.touchSession != nil {
		l.touchSession(authInfo.Scope.TerminalID)
	}
	log.Printf("loopback bridge registered workspace=%s client=%s terminal=%s bridge=%s",
		shortLoopbackID(authInfo.Scope.WorkspaceID),
		shortLoopbackID(authInfo.Scope.ClientID),
		shortLoopbackID(authInfo.Scope.TerminalID),
		shortLoopbackID(id),
	)
	writeJSON(w, http.StatusOK, bridgeRegistrationResponse{BridgeID: id})
}

func (l *localExecLoopback) handleUnregister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		BridgeID string `json:"bridge_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	authInfo, ok := loopbackAuthFromContext(r.Context())
	if !ok {
		http.Error(w, "missing auth scope", http.StatusInternalServerError)
		return
	}
	if !l.router.BridgeMatches(req.BridgeID, authInfo.Scope.WorkspaceID, authInfo.Scope.ClientID) {
		http.Error(w, "token scope does not match bridge", http.StatusForbidden)
		return
	}
	// Token lifetime is tied to the PTY MCP session, not to one bridge
	// process. Claude/Codex may restart the stdio MCP child while reusing
	// the same context.json, so revoking here would make the next register
	// fail with "invalid token". ReleaseSession/SweepExpired revoke it.
	l.router.UnregisterBridge(req.BridgeID)
	w.WriteHeader(http.StatusOK)
}

func (l *localExecLoopback) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req localExecRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.BridgeID == "" || len(req.Argv) == 0 {
		http.Error(w, "bridge_id and non-empty argv are required", http.StatusBadRequest)
		return
	}
	authInfo, ok := loopbackAuthFromContext(r.Context())
	if !ok {
		http.Error(w, "missing auth scope", http.StatusInternalServerError)
		return
	}
	if !l.router.BridgeMatches(req.BridgeID, authInfo.Scope.WorkspaceID, authInfo.Scope.ClientID) {
		http.Error(w, "token scope does not match bridge", http.StatusForbidden)
		return
	}
	if l.touchSession != nil {
		l.touchSession(authInfo.Scope.TerminalID)
	}

	execReq := transport.LocalExecRequest{
		Argv:           req.Argv,
		CWD:            req.CWD,
		TimeoutSeconds: req.TimeoutSeconds,
	}
	events, cleanup, err := l.router.Route(r.Context(), req.BridgeID, execReq)
	if err != nil {
		switch {
		case errors.Is(err, errLocalExecDaemonOffline):
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
		case errors.Is(err, errLocalExecUnsupported):
			http.Error(w, err.Error(), http.StatusFailedDependency)
		case errors.Is(err, filesync.ErrLocalExecBusy):
			http.Error(w, err.Error(), http.StatusTooManyRequests)
		default:
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
		return
	}
	defer cleanup()

	// Drain events into stdout/stderr buffers + Done. The bridge sees
	// one consolidated result; we can graduate to streaming later
	// (SSE) without breaking the JSON shape.
	var resp localExecRunResponse
	var stdout, stderr []byte
	for ev := range events {
		switch {
		case ev.Output != nil:
			if ev.Output.Stream == "stderr" {
				stderr = append(stderr, ev.Output.Data...)
			} else {
				stdout = append(stdout, ev.Output.Data...)
			}
		case ev.Done != nil:
			resp.ExitCode = ev.Done.ExitCode
			resp.DurationMS = ev.Done.DurationMS
			resp.DeniedReason = ev.Done.DeniedReason
			resp.Error = ev.Done.Error
			resp.Truncated = ev.Done.Truncated
			resp.TruncatedReason = ev.Done.TruncatedReason
			resp.OutputBytes = ev.Done.OutputBytes
		}
	}
	resp.Stdout = stdout
	resp.Stderr = stderr
	writeJSON(w, http.StatusOK, resp)
}

type localExecRunRequest struct {
	BridgeID       string   `json:"bridge_id"`
	Argv           []string `json:"argv"`
	CWD            string   `json:"cwd,omitempty"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
}

type localExecRunResponse struct {
	ExitCode        int    `json:"exit_code"`
	DurationMS      int64  `json:"duration_ms"`
	DeniedReason    string `json:"denied_reason,omitempty"`
	Error           string `json:"error,omitempty"`
	Truncated       bool   `json:"truncated,omitempty"`
	TruncatedReason string `json:"truncated_reason,omitempty"`
	OutputBytes     int64  `json:"output_bytes,omitempty"`
	Stdout          []byte `json:"stdout,omitempty"`
	Stderr          []byte `json:"stderr,omitempty"`
}

type bridgeRegistrationRequest struct {
	WorkspaceID string `json:"workspace_id"`
	ClientID    string `json:"client_id"`
	TerminalID  string `json:"terminal_id"`
}

type bridgeRegistrationResponse struct {
	BridgeID string `json:"bridge_id"`
}

// resolveMCPBridgeBinary returns the absolute path to kari-mcp-bridge.
// Order: KARI_MCP_BRIDGE env var override → sibling of the kari-server
// binary → empty (caller logs and disables the feature). We don't
// PATH-resolve because the binary is internal and shouldn't be picked
// up from an arbitrary directory; explicit colocation is the
// deployment story.
func resolveMCPBridgeBinary() string {
	if env := strings.TrimSpace(os.Getenv("KARI_MCP_BRIDGE")); env != "" {
		if _, err := os.Stat(env); err == nil {
			return env
		}
		log.Printf("KARI_MCP_BRIDGE=%s not found, falling back to sibling lookup", env)
	}
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := strings.TrimSuffix(self, "/"+filepathBase(self))
	candidates := []string{
		dir + "/kari-mcp-bridge",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func filepathBase(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == os.PathSeparator {
			return p[i+1:]
		}
	}
	return p
}

func newLoopbackNonce() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func isLoopbackHost(host string) bool {
	if host == "127.0.0.1" || host == "::1" || host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

func shortLoopbackID(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= 8 {
		return s
	}
	return s[:8]
}
