package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

func isMCPStartupKind(kind string) bool {
	switch kind {
	case "claude", "codex":
		return true
	default:
		return false
	}
}

func hostClaudeMCPConfigPath() string {
	dir := strings.TrimSpace(os.Getenv("KARI_MCP_CONFIG_DIR"))
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "claude.json")
}

func hostClaudeMCPReady(configPath string) bool {
	if configPath == "" {
		return false
	}
	if resolveMCPBridgeBinary() == "" {
		return false
	}
	if st, err := os.Stat(configPath); err != nil || st.IsDir() {
		return false
	}
	return true
}

// prepareCLIMCPSession creates (or fetches) the per-terminal MCP session for an
// agent started in this PTY, returning the info needed to point the agent at
// the kari-mcp-bridge. Host-only — the single-tenant server drops container
// routing.
func (s *server) prepareCLIMCPSession(req *transport.Message, alreadyPresent bool) (*transport.MCPSessionInfo, bool) {
	if s == nil || s.mcpSessions == nil || req == nil {
		return nil, false
	}
	if !isMCPStartupKind(req.StartupKind) || strings.TrimSpace(req.AttachID) == "" {
		return nil, false
	}
	commandPath := resolveMCPBridgeBinary()
	if commandPath == "" {
		return nil, false
	}
	configPath := ""
	if req.StartupKind == "claude" {
		configPath = hostClaudeMCPConfigPath()
		if !hostClaudeMCPReady(configPath) {
			return nil, false
		}
	}
	if existing, ok := s.mcpSessions.GetSession(req.AttachID); ok {
		// Ownership check: never hand back (or let the caller later revoke) a
		// session created by a different workspace/client.
		if existing.WorkspaceID != req.WorkspaceID || existing.ClientID != req.ClientID {
			return nil, false
		}
		return mcpSessionInfo(existing, configPath, commandPath), false
	}
	if alreadyPresent {
		return nil, false
	}
	created, err := s.mcpSessions.CreateSessionForTerminal(req.WorkspaceID, req.ClientID, req.AttachID, mcpTargetHost)
	if err != nil {
		log.Printf("mcp session create failed workspace=%s client=%s attach=%s: %v", req.WorkspaceID, req.ClientID, req.AttachID, err)
		return nil, false
	}
	return mcpSessionInfo(created, configPath, commandPath), true
}

func mcpSessionInfo(s *mcpSession, configPath, commandPath string) *transport.MCPSessionInfo {
	if s == nil {
		return nil
	}
	return &transport.MCPSessionInfo{
		TerminalID:     s.TerminalID,
		ContextPath:    s.ContextPath,
		MCPConfigPath:  configPath,
		MCPCommandPath: commandPath,
	}
}
