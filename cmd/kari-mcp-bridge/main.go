// kari-mcp-bridge is the stdio MCP server kari-server launches
// alongside each remote Claude / Codex PTY session. It exposes one
// tool — local_shell_exec — that the LLM can call to run argv-style
// commands on the user's local desktop, routed through the
// already-established sync stream by the server's localExecRouter.
//
// The bridge is intentionally tiny: it speaks MCP JSON-RPC 2.0 over
// stdin/stdout (newline-delimited per the 2024-11-05 stdio spec),
// validates one tool's input shape, and proxies the call to kari-
// server's loopback HTTP endpoint with a per-session bearer token.
// Everything that matters for safety — policy decisions, process
// group cancellation, audit logging — lives on the desktop daemon;
// this binary is just plumbing.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

func main() {
	workspaceID := flag.String("workspace", "", "workspace id this bridge instance serves (required unless KARI_MCP_CONTEXT is set)")
	clientID := flag.String("client-id", "", "client_id of the desktop daemon to route requests to (required unless KARI_MCP_CONTEXT is set)")
	terminalID := flag.String("terminal-id", "", "terminal id this bridge instance is bound to (required unless KARI_MCP_CONTEXT is set)")
	serverAddr := flag.String("server-addr", "127.0.0.1:0", "kari-server internal loopback endpoint, host:port (legacy flag mode)")
	serverSocket := flag.String("server-socket", "", "kari-server internal loopback unix socket path (context mode uses server_socket)")
	tokenFile := flag.String("token-file", "", "path to a file containing the bearer token for the server loopback (required unless KARI_MCP_CONTEXT is set)")
	debug := flag.Bool("debug", false, "log MCP requests + server interactions to stderr")
	flag.Parse()

	cfg, err := resolveBridgeConfig(*workspaceID, *clientID, *terminalID, *serverAddr, *serverSocket, *tokenFile, *debug)
	if err != nil {
		fmt.Fprintln(os.Stderr, "kari-mcp-bridge: "+err.Error())
		os.Exit(2)
	}

	// Log to stderr so MCP stdio (stdin/stdout) stays clean — Claude
	// CLI treats anything on stderr as a debug stream it routes to its
	// own logs, while stdout is the JSON-RPC channel.
	//
	// When KARI_MCP_BRIDGE_LOG is set, also mirror to that file. Codex
	// swallows stderr into its own logs, which makes diagnosing bridge
	// startup failures (token mismatch, dial errors) impractical without
	// out-of-band capture. The aicontainer image sets this env var by
	// default so every bridge invocation produces a persistent log.
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	logSinks := []io.Writer{os.Stderr}
	if path := strings.TrimSpace(os.Getenv("KARI_MCP_BRIDGE_LOG")); path != "" {
		f, ferr := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if ferr == nil {
			logSinks = append(logSinks, f)
			// Best-effort: leave the file open for the lifetime of the
			// process. It's a debug sink so we don't need a clean Close().
		} else {
			fmt.Fprintf(os.Stderr, "kari-mcp-bridge: KARI_MCP_BRIDGE_LOG=%s open failed: %v\n", path, ferr)
		}
	}
	log.SetOutput(io.MultiWriter(logSinks...))
	if cfg.Debug {
		endpoint := cfg.ServerAddr
		if cfg.ServerSocket != "" {
			endpoint = cfg.ServerSocket
		}
		log.Printf("starting workspace=%s client_id=%s terminal_id=%s server=%s", cfg.WorkspaceID, cfg.ClientID, cfg.TerminalID, endpoint)
	}

	token, err := readTokenFile(cfg.TokenFile)
	if err != nil {
		log.Fatalf("read token file %s: %v", cfg.TokenFile, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// SIGTERM/SIGINT from the Claude CLI's process-group teardown
	// translates to a clean shutdown: cancel the context so the stdio
	// loop returns, deferred cleanup runs, and the loopback unregister
	// fires (so the server cancels any in-flight requests). Without
	// this, a hung Read on stdin would keep the bridge alive past the
	// CLI's exit.
	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		s := <-sig
		log.Printf("shutdown on signal %s", s)
		cancel()
	}()

	client := newServerClient(cfg.ServerAddr, cfg.ServerSocket, token, cfg.WorkspaceID, cfg.ClientID, cfg.TerminalID)
	bridgeID, err := client.RegisterBridge(ctx)
	if err != nil && cfg.ServerSocket != "" && cfg.ServerAddr != "" && shouldFallbackFromSocket(err) {
		log.Printf("register via unix socket failed, retrying tcp fallback %s: %v", cfg.ServerAddr, err)
		client = newServerClient(cfg.ServerAddr, "", token, cfg.WorkspaceID, cfg.ClientID, cfg.TerminalID)
		bridgeID, err = client.RegisterBridge(ctx)
	}
	if err != nil {
		log.Fatalf("register bridge with server: %v", err)
	}
	defer client.UnregisterBridge(context.Background(), bridgeID)
	if cfg.Debug {
		log.Printf("registered bridge_id=%s", bridgeID)
	}

	srv := &mcpServer{
		debug:     cfg.Debug,
		serverAPI: client,
		bridgeID:  bridgeID,
	}
	if err := srv.Run(ctx, os.Stdin, os.Stdout); err != nil && ctx.Err() == nil {
		log.Fatalf("mcp loop: %v", err)
	}
}

func readTokenFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	tok := ""
	for _, b := range data {
		if b == '\r' || b == '\n' || b == ' ' || b == '\t' {
			continue
		}
		tok += string(b)
	}
	if tok == "" {
		return "", fmt.Errorf("token file %s is empty", path)
	}
	return tok, nil
}

func shouldFallbackFromSocket(err error) bool {
	return err != nil && strings.Contains(err.Error(), "dial unix")
}
