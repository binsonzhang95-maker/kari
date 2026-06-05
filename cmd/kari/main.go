package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/term"
	"github.com/binsonzhang95-maker/kari/internal/config"
	"github.com/binsonzhang95-maker/kari/internal/ptyinput"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

var version = "dev"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "pty":
		if err := runPty(os.Args[2:]); err != nil {
			log.Fatalf("kari pty failed: %v", err)
		}
	case "-h", "--help", "help":
		printUsage()
	case "-v", "--version", "version":
		fmt.Println(version)
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Println("Usage:")
	fmt.Println("  kari pty --server <host:port> --workspace <workspace_id> --workspace-name <folder_name> --license <activation_code>")
	fmt.Println("  kari --version")
}

// ptyClientState holds the mutable per-reconnect bits so the stdin
// reader and SIGWINCH goroutine (which run for the lifetime of the
// invocation) can keep working across stream rebuilds. Input sent
// during the disconnect window is dropped on the floor — buffering
// would surprise the user (their queued ^C lands after reconnect,
// possibly killing a different command than the one they meant).
type ptyClientState struct {
	mu          sync.Mutex
	stream      *transport.SecurePtyClient // nil during reconnect
	sendMu      sync.Mutex
	workspaceID string
	lastSeq     atomic.Int64 // bytes of PTY output we've already received
}

func (c *ptyClientState) setStream(s *transport.SecurePtyClient) {
	c.mu.Lock()
	c.stream = s
	c.mu.Unlock()
}

func (c *ptyClientState) send(msg *transport.Message) error {
	c.mu.Lock()
	s := c.stream
	c.mu.Unlock()
	if s == nil {
		// Reconnecting — drop. Returning nil keeps the caller (stdin
		// reader / resize goroutine) alive for the eventual reattach.
		return nil
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	return s.Send(msg)
}

func runPty(args []string) error {
	fs := flag.NewFlagSet("pty", flag.ContinueOnError)
	serverAddr := fs.String("server", "127.0.0.1:8443", "trans server address")
	workspaceID := fs.String("workspace", "", "workspace id")
	workspaceName := fs.String("workspace-name", "", "workspace folder name on server")
	license := fs.String("license", "", "activation code")
	clientID := fs.String("client-id", "", "stable client id (defaults to KARI_CLIENT_ID or a generated UUID)")
	rows := fs.Int("rows", 32, "pty rows")
	cols := fs.Int("cols", 120, "pty cols")
	syncdURL := fs.String("syncd", "http://127.0.0.1:46321", "kari-syncd base URL for drop-image uploads")
	enableAttach := fs.Bool("attach-on-drop", true, "intercept dragged image paths and upload via syncd")
	forceInteractive := fs.Bool("force-interactive", false, "force interactive stdin/stdout handling when launched inside a nested pty")
	model := fs.String("model", "", "session model: shell|claude|codex (empty = shell). Picks which CLI runs behind the server-side sandbox.")
	startupKind := fs.String("startup-kind", "", "desktop startup hint for shell PTYs; does not affect server-side runner selection")
	localSSHHost := fs.String("local-ssh-host", "", "reverse proxy SSH host exposed to the container")
	localSSHPort := fs.Int("local-ssh-port", 0, "reverse proxy SSH port exposed to the container")
	localSSHUser := fs.String("local-ssh-user", "", "reverse proxy SSH user exposed to the container")
	localSSHKey := fs.String("local-ssh-key", "", "reverse proxy SSH key path inside the container")
	fs.SetOutput(io.Discard)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *workspaceID == "" || *license == "" {
		return errors.New("--workspace and --license are required")
	}
	resolvedClientID := *clientID
	if resolvedClientID == "" {
		// MachineClientID handles the KARI_CLIENT_ID env override and
		// the on-disk ~/.kari/client_id cache, so two pty invocations
		// from the same box land on the same id and the server's
		// "one machine, one client_id" rule lets them coexist.
		gen, err := config.MachineClientID()
		if err != nil {
			return fmt.Errorf("resolve client_id: %w", err)
		}
		resolvedClientID = gen
	}

	// AttachID is the server-side resumable-PTY identifier for THIS
	// invocation. Stays the same across all reconnects done by this
	// process, so the server reattaches us to the same shell. Fresh
	// invocations get a fresh AttachID — that's the right behaviour:
	// "I closed the terminal, I expect a fresh shell."
	attachID, err := newAttachID()
	if err != nil {
		return fmt.Errorf("generate attach id: %w", err)
	}

	keyB64 := config.SharedKeyFromActivationCode(*license)
	key, err := config.DecodeSharedKey(keyB64)
	if err != nil {
		return fmt.Errorf("derive key from license: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Dial once; grpc.NewClient handles per-stream connection reuse so
	// reconnects are cheap (no TCP handshake when the underlying HTTP/2
	// connection is still up; full redial when it's been kicked).
	cc, err := transport.Dial(ctx, *serverAddr)
	if err != nil {
		return fmt.Errorf("dial %s: %w", *serverAddr, err)
	}
	defer cc.Close()
	client := transport.NewClient(cc)

	var (
		stdinFD     = int(os.Stdin.Fd())
		stdoutFD    = int(os.Stdout.Fd())
		interactive = *forceInteractive || (term.IsTerminal(stdinFD) && term.IsTerminal(stdoutFD))
	)

	rows16 := uint16(*rows)
	cols16 := uint16(*cols)
	if interactive {
		w, h, sizeErr := term.GetSize(stdoutFD)
		if sizeErr == nil && w > 0 && h > 0 {
			rows16 = uint16(h)
			cols16 = uint16(w)
		}
	}

	var oldState *term.State
	if interactive {
		state, rawErr := term.MakeRaw(stdinFD)
		if rawErr != nil {
			return fmt.Errorf("enable raw mode: %w", rawErr)
		}
		oldState = state
		defer func() { _ = term.Restore(stdinFD, oldState) }()

		// Kari brand palette: warm-dark theme distinct from the user's
		// default terminal so a Kari Remote Terminal is visually
		// identifiable. OSC 10/11/12 are honored by xterm.js (and thus
		// VS Code's terminal renderer) and ConPTY on Windows 11.
		// Colors live only for this terminal — VS Code closes the
		// transient terminal on exit, no reset needed.
		_, _ = os.Stdout.WriteString(
			"\x1b]10;#d4d4d4\x07" +
				"\x1b]11;#1a1612\x07" +
				"\x1b]12;#d4a96a\x07",
		)
	}

	state := &ptyClientState{workspaceID: *workspaceID}
	terminatedBySignal := make(chan struct{})
	if signals := terminationSignals(); len(signals) > 0 {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, signals...)
		defer signal.Stop(sigCh)
		go func() {
			<-sigCh
			// A closed local terminal is an explicit stop, not a
			// resumable network detach. Ask the server to kill the
			// remote shell before canceling the client stream.
			_ = state.send(&transport.Message{
				Type:        transport.MessagePtyExit,
				WorkspaceID: *workspaceID,
			})
			close(terminatedBySignal)
			cancel()
		}()
	}

	// remoteWorkDir caches the server-side cwd echoed back in
	// MessagePtyStart, used by HTTPUploader to absolutise rel paths
	// returned by /v1/pty-attach for dragged images.
	var remoteWorkDir atomic.Pointer[string]

	// stdin reader runs for the full invocation. send() returns nil
	// (no error) while reconnecting, so the goroutine keeps looping
	// instead of dying with a confusing "broken pipe" the moment
	// wifi blips.
	stdinExitCh := make(chan error, 1)
	forward := func(b []byte) error {
		return state.send(&transport.Message{
			Type:        transport.MessagePtyInput,
			WorkspaceID: *workspaceID,
			Data:        append([]byte(nil), b...),
		})
	}
	sniffer := ptyinput.NewSniffer(ptyinput.Options{
		MaxPasteBytes: 64 * 1024,
		Attach:        *enableAttach,
		Uploader: ptyinput.HTTPUploader{
			Base:          *syncdURL,
			HTTP:          &http.Client{Timeout: 60 * time.Second},
			RemoteWorkDir: &remoteWorkDir,
		},
		LocalDiag:     os.Stderr,
		Forward:       forward,
		AttachTimeout: 45 * time.Second,
		// Share the same pointer Uploader watches so the sniffer can
		// short-circuit paths Desktop already uploaded via the new
		// direct-upload bypass — without this, single-host dev setups
		// would round-trip the file through /v1/pty-attach a second
		// time, defeating the whole optimisation.
		RemoteWorkDir: &remoteWorkDir,
	})
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := os.Stdin.Read(buf)
			if n > 0 {
				if feedErr := sniffer.Feed(buf[:n]); feedErr != nil {
					stdinExitCh <- feedErr
					return
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					_ = sniffer.Flush()
					// Tell server to terminate the shell cleanly.
					// During reconnect this drops silently, but
					// stdin EOF is rare in interactive mode so the
					// race window is negligible.
					_ = state.send(&transport.Message{
						Type:        transport.MessagePtyExit,
						WorkspaceID: *workspaceID,
					})
					stdinExitCh <- nil
					return
				}
				stdinExitCh <- readErr
				return
			}
		}
	}()

	if interactive {
		go func() {
			sigCh := make(chan os.Signal, 1)
			resizeSig := resizeSignal()
			if resizeSig == nil {
				return
			}
			signal.Notify(sigCh, resizeSig)
			defer signal.Stop(sigCh)
			for range sigCh {
				w, h, sizeErr := term.GetSize(stdoutFD)
				if sizeErr != nil || w <= 0 || h <= 0 {
					continue
				}
				_ = state.send(&transport.Message{
					Type:        transport.MessagePtyResize,
					WorkspaceID: *workspaceID,
					Rows:        uint16(h),
					Cols:        uint16(w),
				})
			}
		}()
	}

	// Outer reconnect loop. Each iteration attempts one stream;
	// transient errors (network blip, server restart) cause a backoff
	// + retry. Terminal errors (shell exited, kicked) end the loop.
	backoff := time.Second
	for attempt := 0; ; attempt++ {
		outcome := runPtySession(ctx, client, key, state, attachID, resolvedClientID,
			*workspaceID, *workspaceName, rows16, cols16, *model, *startupKind,
			*localSSHHost, *localSSHPort, *localSSHUser, *localSSHKey,
			&remoteWorkDir, interactive)

		// stdin reader hitting EOF takes priority — user explicitly
		// closed their input, don't keep reconnecting in the background.
		select {
		case stdinErr := <-stdinExitCh:
			return stdinErr
		default:
		}
		select {
		case <-terminatedBySignal:
			return nil
		default:
		}

		switch outcome.kind {
		case outcomeExit:
			// Shell exited (PtyExit landed). Done.
			return nil
		case outcomeKicked:
			fmt.Fprintln(os.Stderr, "\nsession replaced by another client; exiting")
			return nil
		case outcomeServerError:
			return outcome.err
		case outcomeTransient:
			if ctx.Err() != nil {
				select {
				case <-terminatedBySignal:
					return nil
				default:
				}
				return ctx.Err()
			}
			if interactive {
				// \r resets cursor to col 0; ANSI K clears to end of
				// line so the previous prompt fragment doesn't bleed
				// through. The line is overwritten by the server's
				// next backlog Send on reattach, so users only see
				// it briefly.
				fmt.Fprintf(os.Stderr, "\r\x1b[2K[reconnecting in %s…]", backoff)
			} else {
				fmt.Fprintf(os.Stderr, "\n[reconnecting in %s: %v]\n", backoff, outcome.err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
			if backoff < 15*time.Second {
				backoff *= 2
			}
			continue
		}
	}
}

type sessionOutcomeKind int

const (
	outcomeTransient sessionOutcomeKind = iota
	outcomeExit
	outcomeKicked
	outcomeServerError
)

type sessionOutcome struct {
	kind sessionOutcomeKind
	err  error
}

// runPtySession opens one gRPC PTY stream, attaches to the server-side
// resumable session (creating it on first call, resuming on later
// calls), and runs the recv loop until the stream ends. Returns the
// reason the stream ended so the outer loop knows whether to reconnect.
func runPtySession(
	ctx context.Context,
	client transport.FileServiceClient,
	key []byte,
	state *ptyClientState,
	attachID string,
	clientID string,
	workspaceID string,
	workspaceName string,
	rows uint16,
	cols uint16,
	model string,
	startupKind string,
	localSSHHost string,
	localSSHPort int,
	localSSHUser string,
	localSSHKey string,
	remoteWorkDir *atomic.Pointer[string],
	interactive bool,
) sessionOutcome {
	// Per-session state for the kitty keyboard escape stripper; a fresh
	// filter on every reconnect keeps the parser state machine simple.
	kittyFilter := newKittyKeyboardFilter()
	stream, err := client.Pty(ctx)
	if err != nil {
		return sessionOutcome{kind: outcomeTransient, err: fmt.Errorf("open pty stream: %w", err)}
	}
	secure, err := transport.NewSecurePtyClient(stream, key, workspaceID)
	if err != nil {
		return sessionOutcome{kind: outcomeServerError, err: fmt.Errorf("create secure stream: %w", err)}
	}

	state.setStream(secure)
	// Send PtyStart with the resume offset. Server uses (workspace_id,
	// attach_id) to find the existing session and replays from Seq.
	// First connect: Seq=0, server treats as new spawn.
	if err := secure.Send(&transport.Message{
		Type:          transport.MessagePtyStart,
		WorkspaceID:   workspaceID,
		WorkspaceName: workspaceName,
		ClientID:      clientID,
		Rows:          rows,
		Cols:          cols,
		Model:         model,
		StartupKind:   startupKind,
		LocalSSHHost:  localSSHHost,
		LocalSSHPort:  localSSHPort,
		LocalSSHUser:  localSSHUser,
		LocalSSHKey:   localSSHKey,
		AttachID:      attachID,
		Seq:           state.lastSeq.Load(),
	}); err != nil {
		state.setStream(nil)
		return sessionOutcome{kind: outcomeTransient, err: fmt.Errorf("send pty_start: %w", err)}
	}

	// Recv loop, runs until the stream ends.
	for {
		msg, recvErr := secure.Recv()
		if recvErr != nil {
			state.setStream(nil)
			if recvErr == io.EOF {
				// Server-initiated graceful close. Without an exit
				// message it usually means the underlying transport
				// dropped; treat as transient.
				return sessionOutcome{kind: outcomeTransient, err: io.EOF}
			}
			if errors.Is(recvErr, transport.ErrSessionReplaced) {
				return sessionOutcome{kind: outcomeKicked}
			}
			return sessionOutcome{kind: outcomeTransient, err: recvErr}
		}
		switch msg.Type {
		case transport.MessagePtyOutput:
			// Filter out kitty keyboard protocol control sequences
			// before they reach VS Code's xterm.js — those would
			// otherwise round-trip every keystroke onto the screen
			// as `[27u`-style garbage. See kitty_filter.go.
			data := kittyFilter.Filter(msg.Data)
			if _, wErr := os.Stdout.Write(data); wErr != nil {
				state.setStream(nil)
				return sessionOutcome{kind: outcomeServerError, err: wErr}
			}
			// Track absolute byte offset for the next reconnect. The
			// chunk's first byte is at msg.Seq; after writing,
			// lastSeq = msg.Seq + len(Data). max() defends against
			// out-of-order or zero-Seq messages from old servers.
			next := msg.Seq + int64(len(msg.Data))
			for {
				cur := state.lastSeq.Load()
				if next <= cur || state.lastSeq.CompareAndSwap(cur, next) {
					break
				}
			}
		case transport.MessagePtyStart:
			writeMCPSessionFrame(os.Stdout, msg.MCPSession)
			// Server echo with resolved WorkDir + the ring buffer's
			// current head Seq. If our lastSeq lagged behind head we
			// silently lost some output; just sync up so future seq
			// math stays right.
			if msg.WorkDir != "" {
				wd := msg.WorkDir
				remoteWorkDir.Store(&wd)
			}
			if msg.Seq > state.lastSeq.Load() {
				state.lastSeq.Store(msg.Seq)
			}
		case transport.MessagePtyExit:
			state.setStream(nil)
			if interactive {
				fmt.Fprintf(os.Stdout, "\r\n[remote exit code=%d]\r\n", msg.ExitCode)
			} else {
				fmt.Fprintf(os.Stdout, "\n[remote exit code=%d]\n", msg.ExitCode)
			}
			return sessionOutcome{kind: outcomeExit}
		case transport.MessageError:
			state.setStream(nil)
			return sessionOutcome{kind: outcomeServerError,
				err: fmt.Errorf("server error: %s (server_info=%s)", msg.Error, msg.ServerInfo)}
		}
	}
}

// newAttachID returns a 128-bit hex identifier used as the server-side
// resumable-PTY key for this invocation. Random rather than
// deterministic (e.g. PID-based) so two parallel `kari pty` invocations
// from the same machine each get their own shell instead of dog-piling
// on one session.
func newAttachID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

const kariMCPSessionOSCPrefix = "\x1b]777;kari-mcp-session;"

func writeMCPSessionFrame(w io.Writer, info *transport.MCPSessionInfo) {
	if w == nil || info == nil || info.ContextPath == "" {
		return
	}
	payload, err := json.Marshal(info)
	if err != nil {
		return
	}
	_, _ = io.WriteString(w, kariMCPSessionOSCPrefix+base64.StdEncoding.EncodeToString(payload)+"\a")
}
