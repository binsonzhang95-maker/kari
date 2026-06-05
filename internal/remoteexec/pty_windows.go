//go:build windows

package remoteexec

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/admpub/conpty"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// PtyHandle mirrors the POSIX surface in pty.go, backed by Windows
// ConPTY. Same lifecycle contract: Read/Write/Resize freely; Wait
// blocks for exit; Close terminates eagerly. Shared method names let
// cmd/server's registry treat both platforms uniformly.
type PtyHandle struct {
	cpty *conpty.ConPty

	waitOnce sync.Once
	exitCode int
	waitErr  error

	closeOnce sync.Once
}

// SpawnShell starts the configured shell behind a ConPTY pseudo-terminal.
// PtyRunner's Timeout/MaxOutputBytes are intentionally not enforced here —
// the registry layers idle GC + per-session output budget on top so the
// shell's lifetime isn't yoked to whatever stream was attached at spawn.
func (r PtyRunner) SpawnShell(start *transport.Message, extraEnv []string) (*PtyHandle, error) {
	if !conpty.IsConPtyAvailable() {
		return nil, fmt.Errorf("ConPTY API unavailable (need Windows 10 1809+): install a newer build")
	}
	cols := int(fallbackSize(start.Cols, 80))
	rows := int(fallbackSize(start.Rows, 24))

	workDir := start.WorkDir
	if workDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			workDir = home
		}
	}
	// Spawn the configured shell directly (no AI sandbox profile).
	argv := append([]string{shellName(r.Shell)}, interactiveShellArgs(r.Shell)...)

	opts := []conpty.ConPtyOption{
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyEnv(prepareShellEnv(append(os.Environ(), extraEnv...))),
	}
	if workDir != "" {
		opts = append(opts, conpty.ConPtyWorkDir(workDir))
	}

	cpty, err := conpty.Start(argv, opts...)
	if err != nil {
		if errors.Is(err, conpty.ErrConPtyUnsupported) {
			return nil, fmt.Errorf("ConPTY unsupported on this Windows build: %w", err)
		}
		return nil, fmt.Errorf("conpty start: %w", err)
	}
	return &PtyHandle{cpty: cpty}, nil
}

func (h *PtyHandle) Read(p []byte) (int, error)  { return h.cpty.Read(p) }
func (h *PtyHandle) Write(p []byte) (int, error) { return h.cpty.Write(p) }

func (h *PtyHandle) Resize(rows, cols uint16) error {
	return h.cpty.Resize(int(fallbackSize(cols, 80)), int(fallbackSize(rows, 24)))
}

// Wait blocks until the shell exits. ConPTY's exitCodeU == 259 means
// STILL_ACTIVE — we map that to -1 to match POSIX's "killed by signal"
// convention so callers don't need to special-case Windows.
func (h *PtyHandle) Wait() (int, error) {
	h.waitOnce.Do(func() {
		// context.Background — the handle's lifetime is owned by Close,
		// not by any caller's context. Anyone who wants to kill the
		// shell calls Close() (which closes the ConPty, which returns
		// from Wait).
		exitCodeU, err := h.cpty.Wait(context.Background())
		h.waitErr = err
		code := int(exitCodeU)
		if err != nil {
			code = -1
		} else if exitCodeU == 259 {
			code = -1
		}
		h.exitCode = code
	})
	return h.exitCode, h.waitErr
}

func (h *PtyHandle) Close() error {
	h.closeOnce.Do(func() {
		if h.cpty != nil {
			_ = h.cpty.Close()
		}
	})
	return nil
}

func interactiveShellArgs(shell string) []string {
	switch shellName(shell) {
	case "powershell", "powershell.exe", "pwsh", "pwsh.exe":
		// Only -NoLogo: skip the startup banner so AI CLIs reading the
		// first PTY frames don't have to filter it out. We intentionally
		// drop -NoProfile and -ExecutionPolicy Bypass so the session
		// matches a normal user-launched PowerShell ($PROFILE loaded,
		// PSModulePath user-extended, machine policy honoured), which is
		// what CLIs heuristically check for when deciding whether the
		// parent shell is genuine.
		return []string{"-NoLogo"}
	default:
		return nil
	}
}
