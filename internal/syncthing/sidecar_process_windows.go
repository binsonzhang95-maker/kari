//go:build windows

package syncthing

import (
	"errors"
	"fmt"
	"syscall"
	"time"
)

// Windows process-management constants. Defined locally rather
// than importing golang.org/x/sys/windows to keep PR1.3b-2 free of
// new module deps. Values match winnt.h / processthreadsapi.h.
const (
	// PROCESS_QUERY_LIMITED_INFORMATION is enough to call
	// GetExitCodeProcess and check whether a process is alive,
	// without requiring the broader PROCESS_QUERY_INFORMATION
	// privilege. Available on Vista / Server 2008+.
	processQueryLimitedInformation uint32 = 0x1000

	// PROCESS_TERMINATE allows TerminateProcess.
	processTerminate uint32 = 0x0001

	// SYNCHRONIZE allows WaitForSingleObject on the process handle.
	processSynchronize uint32 = 0x00100000

	// stillActive is the magic exit code GetExitCodeProcess returns
	// for a still-running process (STILL_ACTIVE in winbase.h).
	stillActive uint32 = 259

	// errInvalidParameter is returned by OpenProcess when the pid
	// doesn't refer to any process (gone or never existed).
	errInvalidParameter syscall.Errno = 87
)

// probeProcess returns the tri-state existence of pid via
// OpenProcess + GetExitCodeProcess. Negative/zero pids are
// processGone (defensive; matches Unix behaviour).
//
//   - OpenProcess(ERROR_INVALID_PARAMETER) → processGone
//   - OpenProcess(ERROR_ACCESS_DENIED) or other error → processUnknown
//   - OpenProcess succeeds + GetExitCodeProcess == STILL_ACTIVE →
//     processAlive
//   - OpenProcess succeeds + GetExitCodeProcess != STILL_ACTIVE →
//     processGone (the kernel keeps the process record around
//     until all handles close, but the exit code tells us it's
//     terminated)
//
// The Windows EPERM analog is ERROR_ACCESS_DENIED (5) — process
// exists but is owned by another user / session. We cannot verify
// liveness in that case, so processUnknown.
func probeProcess(pid int) processProbe {
	if pid <= 0 {
		return processGone
	}
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		if errors.Is(err, errInvalidParameter) {
			return processGone
		}
		// ERROR_ACCESS_DENIED / unexpected → can't determine.
		return processUnknown
	}
	defer syscall.CloseHandle(h)

	var exitCode uint32
	if err := syscall.GetExitCodeProcess(h, &exitCode); err != nil {
		return processUnknown
	}
	if exitCode == stillActive {
		return processAlive
	}
	return processGone
}

// killOrphan runs the §3.7 D9 (b) orphan-cleanup sequence — Windows
// flavor. Windows has no SIGTERM equivalent for arbitrary processes
// (sending Ctrl+C / Ctrl+Break only works for processes attached to
// our console), so we skip the SIGTERM grace window and go straight
// to TerminateProcess. The 2s reap budget is preserved.
//
// Graceful shutdown is degraded compared to Unix; if syncthing needs
// to flush state on Windows, that's a separate concern best handled
// by Stop on a still-managed sidecar (which still goes through
// cmd.Process.Signal first). orphan-check is for sidecars we no
// longer have a parent-child relationship with, so the graceful
// option isn't really available regardless.
func killOrphan(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("killOrphan: invalid pid %d", pid)
	}
	switch probeProcess(pid) {
	case processGone:
		return nil
	case processUnknown:
		return fmt.Errorf("killOrphan: pid=%d state ambiguous (ERROR_ACCESS_DENIED or similar); refusing to manage", pid)
	}
	// processAlive.
	h, err := syscall.OpenProcess(processTerminate|processSynchronize, false, uint32(pid))
	if err != nil {
		if errors.Is(err, errInvalidParameter) {
			return nil // raced; already gone
		}
		return fmt.Errorf("killOrphan: OpenProcess pid=%d: %w", pid, err)
	}
	defer syscall.CloseHandle(h)

	if err := syscall.TerminateProcess(h, 1); err != nil {
		if errors.Is(err, errInvalidParameter) {
			return nil
		}
		return fmt.Errorf("killOrphan: TerminateProcess pid=%d: %w", pid, err)
	}

	// Poll up to 2s for the kernel to reflect "gone" via probeProcess.
	// We could WaitForSingleObject(h, 2000) for a kernel-level event
	// but probeProcess's polling is good enough and stays consistent
	// with the Unix budget shape.
	if !waitForProcessGone(pid, 2*time.Second) {
		return fmt.Errorf("killOrphan: pid=%d still alive 2s after TerminateProcess", pid)
	}
	return nil
}
