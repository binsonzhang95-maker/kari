// Command karid is the single-tenant, self-hostable kari server.
//
// It speaks the same gRPC FileService protocol as the multi-tenant server
// (file sync, remote exec, PTY) but with no registry / billing / multi-tenant
// key database: one shared secret gates all access, and one sync directory
// holds the workspace tree(s). Point a kari client at it with the shared
// secret used as its activation code.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
	"github.com/binsonzhang95-maker/kari/internal/remoteexec"
	"github.com/binsonzhang95-maker/kari/internal/sessionhistory"
	"github.com/binsonzhang95-maker/kari/internal/syncthing"
	"github.com/binsonzhang95-maker/kari/internal/transport"
	"github.com/binsonzhang95-maker/kari/web"

	"github.com/soheilhy/cmux"
	"google.golang.org/grpc"
)

// Config is the trimmed single-tenant server config (no registry_dsn,
// license, data-key, allowlist — those are the multi-tenant server's).
type Config struct {
	ListenAddr     string
	SyncDir        string
	Secret         string // shared secret; client key = SHA-256(secret)
	Shell          string
	RescanInterval time.Duration
	CommandTimeout time.Duration
	PtyTimeout     time.Duration
	MaxOutputBytes int64
	SyncthingBinary string // absolute path; empty = auto-detect on PATH
	SyncthingAddr   string // advertised syncthing address for clients; empty = derive from request host + SyncthingPort
	SyncthingPort   int    // BEP data port the sidecar binds on 0.0.0.0 and clients connect to (default 22000)
}

func loadConfig() Config {
	c := Config{
		ListenAddr:     env("KARI_LISTEN_ADDR", "0.0.0.0:8443"),
		SyncDir:        env("KARI_SYNC_DIR", "./workspaces"),
		Secret:         os.Getenv("KARI_SECRET"),
		Shell:          env("KARI_SHELL", "/bin/bash"),
		RescanInterval: 30 * time.Second,
		CommandTimeout: time.Hour,
		PtyTimeout:     0,
		MaxOutputBytes: 10 << 20,
		SyncthingBinary: os.Getenv("KARI_SYNCTHING_BINARY"),
		SyncthingAddr:   os.Getenv("KARI_SYNCTHING_ADDR"),
		SyncthingPort:   envInt("KARI_SYNCTHING_PORT", 22000),
	}
	flag.StringVar(&c.ListenAddr, "listen", c.ListenAddr, "listen address")
	flag.StringVar(&c.SyncDir, "sync-dir", c.SyncDir, "directory holding the synced workspace tree(s)")
	flag.StringVar(&c.Secret, "secret", c.Secret, "shared secret; clients use it as their activation code (or set KARI_SECRET)")
	flag.StringVar(&c.Shell, "shell", c.Shell, "shell for exec/pty")
	flag.StringVar(&c.SyncthingBinary, "syncthing-binary", c.SyncthingBinary, "absolute path to the syncthing binary (empty = auto-detect on PATH)")
	flag.StringVar(&c.SyncthingAddr, "syncthing-addr", c.SyncthingAddr, "advertised syncthing address for clients, e.g. tcp://host:22000 (empty = derive from request host)")
	flag.IntVar(&c.SyncthingPort, "syncthing-port", c.SyncthingPort, "BEP data port the syncthing sidecar binds (0.0.0.0) and clients connect to")
	flag.Parse()
	if c.SyncthingPort <= 0 || c.SyncthingPort > 65535 {
		c.SyncthingPort = 22000
	}
	return c
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// singleKeyResolver returns one fixed key for every workspace_id — the
// single-tenant replacement for the registry's per-activation-code key
// derivation. The key matches what a client derives: SHA-256(secret).
type singleKeyResolver struct{ key []byte }

func (r singleKeyResolver) Resolve(_ context.Context, _ string) ([]byte, error) {
	if len(r.key) == 0 {
		return nil, errors.New("server has no shared secret configured")
	}
	return r.key, nil
}

type server struct {
	cfg      Config
	root     string
	resolver transport.KeyResolver
	runner   remoteexec.Runner
	pty      remoteexec.PtyRunner

	enginesMu sync.Mutex
	engines   map[string]*filesync.Engine

	syncMu         sync.Mutex
	syncSidecar    *syncthing.SidecarManager
	syncReconciler *syncthing.Reconciler
	syncDevice     string

	// pairMu serializes the reconciler Desired read-modify-write so
	// concurrent pair requests can't clobber each other's folders.
	pairMu sync.Mutex

	// MCP local-exec: the loopback the bridge calls + the index of
	// connected clients that advertised CapabilityLocalExec.
	localExec         *localExecSessionIndex
	localExecRouter   *localExecRouter
	localExecLoopback *localExecLoopback
	mcpSessions       *mcpSessionManager
}

// engineFor returns the filesync engine rooted at this workspace's subdir.
// Single-tenant: a plain join under SyncDir (no registry tenant sanitizer).
func (s *server) engineFor(workspaceID, workspaceName string) (*filesync.Engine, error) {
	// Isolate by workspace_id (always present from the handshake, unique) so
	// distinct workspaces never share a tree; workspace_name is only a
	// readable sub-segment under the id.
	cacheKey := workspaceID + "/" + workspaceName
	dir := filepath.Join(s.root, safeName(workspaceID), safeName(workspaceName))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s.enginesMu.Lock()
	defer s.enginesMu.Unlock()
	if e := s.engines[cacheKey]; e != nil {
		return e, nil
	}
	e, err := filesync.New(dir, "server")
	if err != nil {
		return nil, err
	}
	s.engines[cacheKey] = e
	return e, nil
}

// safeName keeps a workspace name to a single safe path segment.
func safeName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "default"
	}
	name = filepath.Base(filepath.Clean("/" + name))
	if name == "." || name == "/" || name == "" {
		return "default"
	}
	return name
}

func (s *server) Sync(stream transport.FileService_SyncServer) error {
	ctx := stream.Context()
	secureStream, hello, err := transport.AcceptSyncStream(ctx, stream, s.resolver)
	if err != nil {
		log.Printf("sync handshake rejected: %v", err)
		return err
	}
	wsid := secureStream.WorkspaceID()
	if hello.Type != transport.MessageHello || hello.WorkspaceID != wsid {
		return fmt.Errorf("expected hello{workspace_id=%s}, got %s", wsid, hello.Type)
	}
	wsname := hello.WorkspaceName
	clientID := strings.TrimSpace(hello.ClientID)
	if err := secureStream.Send(&transport.Message{
		Type:          transport.MessageHello,
		ServerInfo:    "ok",
		WorkspaceID:   wsid,
		WorkspaceName: wsname,
	}); err != nil {
		return err
	}
	engine, err := s.engineFor(wsid, wsname)
	if err != nil {
		return err
	}
	log.Printf("sync connected workspace=%s name=%q root=%s", wsid, wsname, engine.Root())
	session := filesync.NewSession(engine, secureStream)
	// Syncthing is the mandatory (and only) file mover in the single-tenant
	// server: the gRPC Sync stream is a CONTROL channel — bootstrap, remote
	// session listing, MCP local-exec, PTY-count — never a file plane. Force
	// control-only so the server never pushes the workspace tree over gRPC
	// (which would double-deliver files Syncthing already manages and race
	// its writes). The legacy gRPC file transfer is intentionally disabled.
	session.SetControlOnly(true)
	// Serve the client's session-history request (the desktop's history view)
	// over the control stream: a read-only scan of the host's
	// ~/.claude / ~/.codex session dirs, scoped to this workspace tree. Without
	// this handler the request is received but never answered and the client's
	// in-flight slot wedges ("list sessions request already in flight").
	session.SetListSessionsHandler(func(req transport.ListSessionsRequest) transport.ListSessionsResult {
		home, _ := os.UserHomeDir()
		return sessionhistory.ScanHome(home, req, engine.Root())
	})
	// Register for MCP local-exec routing if the client advertised it.
	if s.localExec != nil && clientID != "" && transport.HasCapability(hello, transport.CapabilityLocalExec) {
		unregister := s.localExec.register(wsid, clientID, session, hello.Capabilities)
		defer unregister()
	}
	return session.Run(ctx, s.cfg.RescanInterval, nil)
}

func (s *server) Exec(stream transport.FileService_ExecServer) error {
	ctx := stream.Context()
	secureStream, req, err := transport.AcceptExecStream(ctx, stream, s.resolver)
	if err != nil {
		log.Printf("exec handshake rejected: %v", err)
		return err
	}
	if req.Type != transport.MessageCommand {
		return fmt.Errorf("expected command, got %s", req.Type)
	}
	if req.WorkDir == "" {
		engine, err := s.engineFor(secureStream.WorkspaceID(), req.WorkspaceName)
		if err != nil {
			return err
		}
		req.WorkDir = engine.Root()
	}
	log.Printf("exec workspace=%s name=%q id=%s workdir=%s", secureStream.WorkspaceID(), req.WorkspaceName, req.CommandID, req.WorkDir)
	return s.runner.Run(ctx, secureStream, req)
}

func (s *server) Pty(stream transport.FileService_PtyServer) error {
	ctx := stream.Context()
	secureStream, req, err := transport.AcceptPtyStream(ctx, stream, s.resolver)
	if err != nil {
		log.Printf("pty handshake rejected: %v", err)
		return err
	}
	if req.Type != transport.MessagePtyStart {
		return fmt.Errorf("expected pty_start, got %s", req.Type)
	}
	if req.WorkDir == "" {
		engine, err := s.engineFor(secureStream.WorkspaceID(), req.WorkspaceName)
		if err != nil {
			return err
		}
		req.WorkDir = engine.Root()
	}
	// Host shell only — the multi-tenant container routing is intentionally
	// dropped for the single-tenant self-host server.
	req.UseContainer = false
	req.ContainerName = ""
	// MCP: if the client started an agent (StartupKind claude/codex), issue a
	// per-terminal MCP session and inject KARI_MCP_CONTEXT so the agent's
	// bridge can reach the local-exec loopback.
	var extraEnv []string
	var mcpAttach string
	if mcpInfo, _ := s.prepareCLIMCPSession(req, false); mcpInfo != nil && mcpInfo.ContextPath != "" {
		extraEnv = append(extraEnv, "KARI_MCP_CONTEXT="+mcpInfo.ContextPath)
		mcpAttach = strings.TrimSpace(req.AttachID)
	}
	handle, err := s.pty.SpawnShell(req, extraEnv)
	if err != nil {
		msg := "pty spawn failed: " + err.Error()
		_ = secureStream.Send(&transport.Message{Type: transport.MessageError, Error: msg, ServerInfo: msg})
		return err
	}
	log.Printf("pty workspace=%s workdir=%s", secureStream.WorkspaceID(), req.WorkDir)

	// One goroutine owns the handle end-to-end (read -> wait -> exit -> close)
	// so Wait and Close never run concurrently, and output is fully drained
	// before the exit code is sent. Send is only ever called from here, so the
	// gRPC stream has a single writer.
	outDone := make(chan struct{})
	go func() {
		defer close(outDone)
		buf := make([]byte, 32*1024)
		for {
			n, rerr := handle.Read(buf)
			if n > 0 {
				if serr := secureStream.Send(&transport.Message{
					Type: transport.MessagePtyOutput,
					Data: append([]byte(nil), buf[:n]...),
				}); serr != nil {
					break // client gone — stop draining
				}
			}
			if rerr != nil {
				break // shell exited / PTY closed
			}
		}
		code, _ := handle.Wait()
		_ = secureStream.Send(&transport.Message{Type: transport.MessagePtyExit, ExitCode: code})
		_ = handle.Close()
		// Release the MCP session when the shell actually exits — not when the
		// client merely closes its input side (the agent may still be running).
		if mcpAttach != "" && s.mcpSessions != nil {
			s.mcpSessions.ReleaseSession(mcpAttach)
		}
	}()

	// Input pump: client -> PTY. Never touches Wait/Close.
	inDone := make(chan struct{})
	go func() {
		defer close(inDone)
		for {
			msg, rerr := secureStream.Recv()
			if rerr != nil {
				return
			}
			switch msg.Type {
			case transport.MessagePtyInput:
				if len(msg.Data) > 0 {
					_, _ = handle.Write(msg.Data)
				}
			case transport.MessagePtyResize:
				_ = handle.Resize(msg.Rows, msg.Cols)
			case transport.MessagePtyExit:
				return
			}
		}
	}()

	// Return when the shell exits or the client closes its input side; the
	// output goroutine reaps + closes the handle on its own timeline (capped
	// by PtyRunner.Timeout if the client vanished while the shell sits idle).
	select {
	case <-outDone:
	case <-inDone:
	}
	return nil
}

// httpHandler is the single-tenant HTTP face: health, a read-only session
// list, the Syncthing pair endpoint, and the embedded web console.
func (s *server) httpHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !s.authHTTP(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		home, _ := os.UserHomeDir()
		var sources []string
		if q := strings.TrimSpace(r.URL.Query().Get("sources")); q != "" {
			sources = strings.Split(q, ",")
		}
		res := sessionhistory.ScanHome(home, transport.ListSessionsRequest{Sources: sources}, "")
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	})
	// Syncthing pairing: a client joins a workspace folder.
	mux.HandleFunc("/v1/syncthing/pair", s.handleSyncthingPair)
	// Embedded single-tenant console (built from client-web).
	if dist, err := fs.Sub(web.FS, "dist"); err == nil {
		mux.Handle("/", http.FileServer(http.FS(dist)))
	}
	return mux
}

// authHTTP gates HTTP routes on the shared secret (Bearer or X-Kari-Token),
// compared in constant time.
func (s *server) authHTTP(r *http.Request) bool {
	var got string
	// Only treat Authorization as a token if it's a (case-insensitive) Bearer
	// scheme; otherwise fall through to X-Kari-Token rather than mistaking a
	// malformed header for the token.
	if a := r.Header.Get("Authorization"); len(a) >= 7 && strings.EqualFold(a[:7], "Bearer ") {
		got = strings.TrimSpace(a[7:])
	}
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Kari-Token"))
	}
	return got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Secret)) == 1
}

// resolveOrGenerateSecret returns the configured shared secret, or — when none
// was provided — a persisted one from <sync-dir>/.kari-secret, or a freshly
// minted strong secret which it persists (0600) and prints once so the operator
// can share it with the team. Persisting keeps the secret stable across
// restarts so already-paired clients keep working.
func resolveOrGenerateSecret(syncDir, explicit string) (string, error) {
	if s := strings.TrimSpace(explicit); s != "" {
		return s, nil
	}
	path := filepath.Join(syncDir, ".kari-secret")
	if data, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(data)); s != "" {
			log.Printf("shared secret: loaded from %s (set KARI_SECRET to override)", path)
			return s, nil
		}
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(secret+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("persist secret to %s: %w", path, err)
	}
	log.Printf("────────────────────────────────────────────────────────")
	log.Printf("no KARI_SECRET set — generated one and saved it to %s:", path)
	log.Printf("    %s", secret)
	log.Printf("share it with your team; they enter it as the shared secret.")
	log.Printf("────────────────────────────────────────────────────────")
	return secret, nil
}

func main() {
	cfg := loadConfig()
	if err := os.MkdirAll(cfg.SyncDir, 0o755); err != nil {
		log.Fatalf("create sync dir: %v", err)
	}
	secret, err := resolveOrGenerateSecret(cfg.SyncDir, cfg.Secret)
	if err != nil {
		log.Fatalf("resolve shared secret: %v", err)
	}
	cfg.Secret = secret
	sum := sha256.Sum256([]byte(cfg.Secret))

	s := &server{
		cfg:      cfg,
		root:     cfg.SyncDir,
		resolver: singleKeyResolver{key: sum[:]},
		runner:   remoteexec.Runner{Shell: cfg.Shell, Timeout: cfg.CommandTimeout, MaxOutputBytes: cfg.MaxOutputBytes},
		pty:      remoteexec.PtyRunner{Shell: cfg.Shell, Timeout: cfg.PtyTimeout, MaxOutputBytes: cfg.MaxOutputBytes},
		engines:  map[string]*filesync.Engine{},
	}

	lis, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", cfg.ListenAddr, err)
	}
	m := cmux.New(lis)
	httpLis := m.Match(cmux.HTTP1Fast())
	grpcLis := m.Match(cmux.HTTP2())

	grpcServer := grpc.NewServer()
	transport.RegisterFileServiceServer(grpcServer, s)
	go func() {
		if err := grpcServer.Serve(grpcLis); err != nil {
			log.Printf("grpc serve: %v", err)
		}
	}()

	httpServer := &http.Server{Handler: s.httpHandler()}
	go func() {
		if err := httpServer.Serve(httpLis); err != nil {
			log.Printf("http serve: %v", err)
		}
	}()

	// Syncthing is the mandatory file-sync backend for the OSS server —
	// fail loudly if it can't start.
	if err := s.startSyncthing(context.Background()); err != nil {
		log.Fatalf("%v", err)
	}
	s.startMCP()

	log.Printf("karid (single-tenant) listening on %s, sync-dir=%s", cfg.ListenAddr, cfg.SyncDir)
	if err := m.Serve(); err != nil {
		log.Fatalf("cmux serve: %v", err)
	}
}
