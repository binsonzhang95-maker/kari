package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/syncd"
)

var version = "dev"

func main() {
	addr := flag.String("addr", "127.0.0.1:46321", "daemon control listen addr")
	flag.Parse()

	// Route log output to a user-scoped file BEFORE anything else
	// runs. kari-desktop spawns this daemon with stdio=ignore, so
	// without explicit file output the daemon is invisible:
	// log.Printf goes to /dev/null. Old (0.9.72) builds installed via
	// `~/.kari/runtime/<ver>/` did their own log.SetOutput; the
	// bundled-runtime path inside Kari.app started shipping in the
	// kari-desktop refactor without that piece, leaving operators
	// (and us) unable to diagnose recipient-side sync issues. See:
	//   kari-desktop src/main/main.cjs startManagedDaemon (stdio: 'ignore').
	// Path is overridable via KARI_SYNCD_LOG for dev / CI.
	setupDaemonLog()

	// Lift NOFILE before filesync starts a platform watcher. macOS
	// launchd commonly starts GUI-spawned helpers with a 256 soft cap.
	raiseFileLimit()

	svc := syncd.NewService()
	server := &http.Server{
		Addr:              *addr,
		ReadHeaderTimeout: 8 * time.Second,
	}
	server.Handler = corsWrap(newMux(svc, func() {
		go func() {
			time.Sleep(100 * time.Millisecond)
			svc.Stop()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = server.Shutdown(ctx)
		}()
	}))

	log.Printf("kari-syncd %s listening on %s", version, *addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// corsWrap permits the VS Code webview (vscode-webview:// origin) to
// fetch /v1/status and other daemon endpoints directly. The daemon is
// bound to loopback only, so anyone who can reach it already has at
// least local-process access — CORS adds no meaningful protection here
// and just breaks Windows webviews where Chromium enforces preflight
// more strictly than on macOS.
func corsWrap(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Max-Age", "3600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// daemonLogMaxBytes is the size threshold for rotating daemon.log.
// 10 MiB matches what kari-desktop's old packaging shipped (.log /
// .log.1 pair around 5–10 MiB each) so operators don't see a sudden
// behavior change in the file footprint. Var (not const) for tests.
var daemonLogMaxBytes int64 = 10 << 20

// setupDaemonLog wires log.SetOutput to a rotating file writer at the
// platform-specific user-scoped logs path. Falls back to stderr-only
// on any error (no panic, no fatal — we want the daemon to keep
// running even if the log volume is read-only or full). Always also
// writes to stderr via MultiWriter so `npm run dev` style debugging
// still shows live output when a parent process bothers to read it.
func setupDaemonLog() {
	path := os.Getenv("KARI_SYNCD_LOG")
	if path == "" {
		p, err := defaultDaemonLogPath()
		if err != nil {
			fmt.Fprintf(os.Stderr, "kari-syncd: cannot determine log path: %v (logging to stderr only)\n", err)
			return
		}
		path = p
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "kari-syncd: cannot create log dir %s: %v (logging to stderr only)\n", filepath.Dir(path), err)
		return
	}
	w := newRotatingLogWriter(path, daemonLogMaxBytes)
	if w == nil {
		return // newRotatingLogWriter already logged to stderr
	}
	log.SetOutput(io.MultiWriter(os.Stderr, w))
}

// defaultDaemonLogPath returns the canonical daemon.log path per OS.
// macOS:   ~/Library/Logs/kari/daemon.log
// Windows: %LOCALAPPDATA%\kari\Logs\daemon.log
// Other:   ~/.local/state/kari/daemon.log
func defaultDaemonLogPath() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Logs", "kari", "daemon.log"), nil
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "kari", "Logs", "daemon.log"), nil
	default:
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "state", "kari", "daemon.log"), nil
	}
}

// rotatingLogWriter is the io.Writer behind log.SetOutput. Trivial
// rotation: when the current file exceeds maxBytes, close it, rename
// to .1 (overwriting any prior .1), and reopen fresh. Matches the
// existing .log + .log.1 pair pattern operators expect from the
// pre-rewrite daemon. Single-rotation (no .2, .3, ...) is plenty for
// the read-once-on-incident debug workflow this enables.
type rotatingLogWriter struct {
	path     string
	maxBytes int64
	mu       sync.Mutex
	f        *os.File
}

func newRotatingLogWriter(path string, maxBytes int64) *rotatingLogWriter {
	r := &rotatingLogWriter{path: path, maxBytes: maxBytes}
	if err := r.reopenLocked(); err != nil {
		fmt.Fprintf(os.Stderr, "kari-syncd: cannot open log file %s: %v (logging to stderr only)\n", path, err)
		return nil
	}
	return r
}

func (r *rotatingLogWriter) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		// Lost the file (e.g. previous reopen failed); drop quietly
		// rather than fail every log.Printf call. Returning len(p)
		// keeps the upstream log package happy and avoids cascading
		// errors at process shutdown.
		return len(p), nil
	}
	n, err := r.f.Write(p)
	if err == nil {
		if fi, statErr := r.f.Stat(); statErr == nil && fi.Size() > r.maxBytes {
			r.rotateLocked()
		}
	}
	return n, err
}

func (r *rotatingLogWriter) reopenLocked() error {
	f, err := os.OpenFile(r.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	r.f = f
	return nil
}

func (r *rotatingLogWriter) rotateLocked() {
	if r.f != nil {
		_ = r.f.Close()
		r.f = nil
	}
	// Best-effort: rename overwrites .1 if it exists on macOS/Linux;
	// on Windows os.Rename returns an error if .1 exists, so remove
	// first. _ = err is intentional — if rotation fails we just
	// re-open the original path; nothing else is recoverable here.
	_ = os.Remove(r.path + ".1")
	_ = os.Rename(r.path, r.path+".1")
	if err := r.reopenLocked(); err != nil {
		fmt.Fprintf(os.Stderr, "kari-syncd: cannot reopen log after rotate: %v\n", err)
	}
}
