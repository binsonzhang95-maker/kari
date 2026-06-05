//go:build !windows

package syncthing

import (
	"errors"
	"fmt"
	"syscall"
	"time"
)

// probeProcess returns the tri-state existence of pid via
// syscall.Kill(pid, 0). Negative/zero pids are processGone
// (defensive — signalling -1 would broadcast on Unix to every
// process in our process group).
//
//   - kill(pid, 0) == nil               → processAlive
//   - kill(pid, 0) == ESRCH             → processGone
//   - any other errno (EPERM commonly)  → processUnknown
//
// EPERM ("operation not permitted") means the process exists but
// is owned by another uid or we're in a different namespace; we
// CANNOT verify it's gone, so we MUST NOT treat it as gone.
// processUnknown is the explicit "cannot determine" verdict.
func probeProcess(pid int) processProbe {
	if pid <= 0 {
		return processGone
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return processAlive
	}
	if errors.Is(err, syscall.ESRCH) {
		return processGone
	}
	// EPERM / EINVAL / other — can't determine.
	return processUnknown
}

// killOrphan runs the §3.7 D9 (b) orphan-cleanup sequence on a
// previously-recorded pid:
//
//	SIGTERM → wait 5s → SIGKILL → wait 2s → still alive → error
//
// Caller invokes this BEFORE writing its own pidfile / spawning a
// fresh child. The 5s/2s budgets mirror Stop's normal grace windows
// so the orphan-check budget is bounded.
//
// Returns nil only when probeProcess observes processGone within
// the budget. Returns error if SIGKILL didn't take effect within
// budget OR if the probe lands in processUnknown (EPERM mid-kill,
// etc.) since we cannot prove the process is reaped.
//
// Caller (checkOrphanOnStart) has already verified probe == Alive
// at entry; this function only handles ESRCH races and propagates
// other errors.
func killOrphan(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("killOrphan: invalid pid %d", pid)
	}
	switch probeProcess(pid) {
	case processGone:
		return nil // already dead by the time we got here
	case processUnknown:
		return fmt.Errorf("killOrphan: pid=%d state ambiguous (EPERM or similar); refusing to manage", pid)
	}
	// processAlive past this point.

	// SIGTERM phase: 5s grace.
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		// ESRCH = race; process died between probe and signal.
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return fmt.Errorf("killOrphan: SIGTERM pid=%d: %w", pid, err)
	}
	if !waitForProcessGone(pid, 5*time.Second) {
		// SIGKILL phase: 2s.
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			return fmt.Errorf("killOrphan: SIGKILL pid=%d: %w", pid, err)
		}
		if !waitForProcessGone(pid, 2*time.Second) {
			return fmt.Errorf("killOrphan: pid=%d still alive 2s after SIGKILL", pid)
		}
	}
	return nil
}
