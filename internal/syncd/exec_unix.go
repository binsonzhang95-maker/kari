//go:build !windows

package syncd

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// localExecPlatformSupported is true on POSIX where we can do
// Setpgid + kill(-pgid, signal). Windows uses Job Objects to reach
// the same "kill the whole tree on cancel" guarantee — see
// exec_windows.go.
func localExecPlatformSupported() bool { return true }

// processGroup mirrors the Windows lifecycle but is mostly trivial on
// POSIX: there's no per-request state to track because Setpgid +
// kill(-pgid) only needs the cmd's PID at cancel time.
type processGroup struct{}

func newProcessGroup() (*processGroup, error) { return &processGroup{}, nil }

func (pg *processGroup) apply(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func (pg *processGroup) afterStart(_ *exec.Cmd) error { return nil }

func (pg *processGroup) watchCancel(cmd *exec.Cmd, cmdCtx context.Context, grace time.Duration, finished <-chan struct{}) {
	select {
	case <-finished:
		return
	case <-cmdCtx.Done():
	}
	if cmd.Process == nil {
		return
	}
	posixKillLadder(cmd.Process.Pid, grace, finished)
}

func (pg *processGroup) close() {}

// posixKillLadder factors the SIGTERM → grace → SIGKILL sequence so
// both the legacy watchCancel and the new processGroup.watchCancel
// share one implementation. Resolves the real pgid (Setpgid makes
// child its own group leader; Getpgid is the truth source but PID is
// a safe fallback when the child is already gone).
func posixKillLadder(pid int, grace time.Duration, finished <-chan struct{}) {
	pgid := pid
	if gpid, gerr := syscall.Getpgid(pid); gerr == nil {
		pgid = gpid
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-finished:
		return
	case <-time.After(grace):
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}
