//go:build !windows

package remoteexec

import (
	"errors"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// PtyHandle wraps a running shell + its PTY master file descriptor in a
// platform-neutral surface (creack/pty on POSIX, admpub/conpty on Windows).
//
// Lifecycle: callers Read/Write/Resize freely while the shell runs, then
// either Wait() blocks until exit (returning the code) or Close()
// terminates eagerly. Wait+Close together are idempotent.
type PtyHandle struct {
	pty *os.File
	cmd *exec.Cmd

	waitOnce sync.Once
	exitCode int
	waitErr  error

	closeOnce sync.Once
}

// SpawnShell starts an interactive host shell behind a PTY using the
// runner's configured shell and the start envelope's WorkDir/Rows/Cols.
// (The single-tenant team-sharing server runs the shell directly on the
// host — no AI sandbox profile and no container routing.)
func (r PtyRunner) SpawnShell(start *transport.Message, extraEnv []string) (*PtyHandle, error) {
	workDir := start.WorkDir
	if workDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			workDir = home
		}
	}
	shell := r.Shell
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell)
	if workDir != "" {
		cmd.Dir = workDir
	}
	// Force a UTF-8 locale so non-ASCII output (e.g. Chinese filenames in
	// `ls`) renders correctly; extraEnv carries per-session injections
	// (e.g. KARI_MCP_CONTEXT).
	cmd.Env = prepareShellEnv(append(os.Environ(), extraEnv...))
	f, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: fallbackSize(start.Rows, 24),
		Cols: fallbackSize(start.Cols, 80),
	})
	if err != nil {
		return nil, err
	}
	return &PtyHandle{pty: f, cmd: cmd}, nil
}

// Read drains pending PTY output. Blocks until at least one byte is
// available or the PTY closes.
func (h *PtyHandle) Read(p []byte) (int, error) { return h.pty.Read(p) }

// Write forwards user input bytes to the shell. PTY semantics handle
// echoing, line-buffering, and signal generation (Ctrl-C → SIGINT).
func (h *PtyHandle) Write(p []byte) (int, error) { return h.pty.Write(p) }

// Resize tells the kernel the controlling-terminal size has changed so
// programs that listen for SIGWINCH (vim, htop, less) redraw to fit.
func (h *PtyHandle) Resize(rows, cols uint16) error {
	return pty.Setsize(h.pty, &pty.Winsize{
		Rows: fallbackSize(rows, 24),
		Cols: fallbackSize(cols, 80),
	})
}

// Wait blocks until the shell exits, returns the exit code, and is safe to
// call from multiple goroutines (cmd.Wait itself is not, hence sync.Once).
// After Wait returns, the PTY master is closed; Read will return EOF.
func (h *PtyHandle) Wait() (int, error) {
	h.waitOnce.Do(func() {
		err := h.cmd.Wait()
		h.waitErr = err
		var exitErr *exec.ExitError
		switch {
		case err == nil:
			h.exitCode = 0
		case errors.As(err, &exitErr):
			h.exitCode = exitErr.ExitCode()
		default:
			h.exitCode = -1
		}
		_ = h.pty.Close()
	})
	return h.exitCode, h.waitErr
}

// Close terminates the shell process (SIGKILL) and frees the PTY. Safe to
// call multiple times.
func (h *PtyHandle) Close() error {
	h.closeOnce.Do(func() {
		if h.cmd != nil && h.cmd.Process != nil {
			_ = h.cmd.Process.Kill()
		}
		if h.pty != nil {
			_ = h.pty.Close()
		}
	})
	return nil
}
