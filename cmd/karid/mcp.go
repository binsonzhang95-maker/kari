package main

import (
	"crypto/sha256"
	"log"
	"os"
	"path/filepath"
)

// startMCP brings up the loopback-only HTTP endpoint that the kari-mcp-bridge
// talks to. The bridge (running next to an agent in a server PTY) routes tool
// calls through this loopback to a connected client's gRPC session that
// advertised CapabilityLocalExec, so the agent can run commands on the user's
// machine. Degrades gracefully — MCP just stays off if it can't start.
func (s *server) startMCP() {
	s.localExec = newLocalExecSessionIndex()
	s.localExecRouter = newLocalExecRouter(s.localExec)
	sum := sha256.Sum256([]byte(s.cfg.Secret + "\x00mcp-loopback"))
	s.localExecLoopback = newLocalExecLoopback(s.localExecRouter, sum[:])

	runtimeRoot := filepath.Join(s.cfg.SyncDir, ".kari-mcp")
	if err := os.MkdirAll(runtimeRoot, 0o700); err != nil {
		log.Printf("mcp: runtime root %q: %v (mcp disabled)", runtimeRoot, err)
		s.localExecLoopback = nil
		return
	}
	// Enforce an owner-only, non-symlinked runtime root before exposing the
	// loopback socket (it carries the local-exec auth token).
	if fi, err := os.Lstat(runtimeRoot); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		log.Printf("mcp: runtime root %q is a symlink or unstat-able: %v (mcp disabled)", runtimeRoot, err)
		s.localExecLoopback = nil
		return
	}
	if err := os.Chmod(runtimeRoot, 0o700); err != nil {
		log.Printf("mcp: runtime root chmod 0700 failed: %v (mcp disabled)", err)
		s.localExecLoopback = nil
		return
	}
	if err := s.localExecLoopback.Start(runtimeRoot); err != nil {
		log.Printf("mcp: local-exec loopback start failed: %v (mcp disabled)", err)
		s.localExecLoopback = nil
		return
	}
	// Per-terminal MCP session manager: issues a context file (loopback
	// socket + bearer token) that the bridge reads via KARI_MCP_CONTEXT.
	s.mcpSessions = newMCPSessionManager(
		runtimeRoot,
		s.localExecLoopback.SocketPath(),
		s.localExecLoopback.ContainerAddr(),
		s.localExecLoopback.IssueToken,
		s.localExecLoopback.revokeToken,
	)
	// Self-wire a host claude MCP config pointing at the bridge so agents
	// started in a PTY auto-discover it (unless KARI_MCP_CONFIG_DIR is set).
	if os.Getenv("KARI_MCP_CONFIG_DIR") == "" {
		if bridge := resolveMCPBridgeBinary(); bridge != "" {
			if cfgPath, err := ensureHostMCPConfig(bridge, runtimeRoot); err != nil {
				log.Printf("mcp: host config generate failed: %v", err)
			} else if cfgPath != "" {
				_ = os.Setenv("KARI_MCP_CONFIG_DIR", runtimeRoot)
				log.Printf("mcp: wrote host claude config %s (bridge=%s)", cfgPath, bridge)
			}
		}
	}
	log.Printf("mcp: local-exec loopback up, socket=%s", s.localExecLoopback.SocketPath())
}
