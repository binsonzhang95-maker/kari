//go:build windows

package syncd

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// localExecPlatformSupported returns true only on Win10+ (major == 10
// covers both Windows 10 and Windows 11). Older hosts are out of
// scope for kari-syncd; on those, NewLocalExecRunner returns nil and
// the daemon doesn't advertise local_exec_v1 capability, so the
// server's RouteLocalExec returns "unsupported" rather than executing
// commands without Job Object containment.
//
// Uses RtlGetNtVersionNumbers rather than RtlGetVersion: the former
// is the raw kernel version unaffected by application compatibility
// shims, which is what we want for a security-critical capability gate.
func localExecPlatformSupported() bool {
	major, _, _ := windows.RtlGetNtVersionNumbers()
	return major >= 10
}

const (
	// Minimum process-access mask we need on the child handle:
	//   PROCESS_SET_QUOTA       — AssignProcessToJobObject
	//   PROCESS_TERMINATE       — failure-path TerminateProcess
	//   PROCESS_SUSPEND_RESUME  — NtResumeProcess (and the Toolhelp
	//                             fallback's per-thread OpenThread
	//                             uses THREAD_SUSPEND_RESUME, which
	//                             is per-thread and granted separately)
	childProcessAccess = windows.PROCESS_SET_QUOTA |
		windows.PROCESS_TERMINATE |
		windows.PROCESS_SUSPEND_RESUME
)

// processGroup is the per-request platform-state owner for local exec.
// Lifecycle:
//
//	newProcessGroup()       — Windows: create job + KILL_ON_JOB_CLOSE
//	pg.apply(cmd)           — before Start: set CREATE_SUSPENDED
//	pg.afterStart(cmd)      — after Start: Open + Assign + Resume.
//	                          On error, the suspended child has been
//	                          TerminateProcess'd; caller MUST Wait().
//	pg.watchCancel(...)     — on cancel: TerminateJobObject
//	pg.close()              — release the job handle
type processGroup struct {
	hJob windows.Handle
}

func newProcessGroup() (*processGroup, error) {
	hJob, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(hJob,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(hJob)
		return nil, fmt.Errorf("SetInformationJobObject KILL_ON_JOB_CLOSE: %w", err)
	}
	return &processGroup{hJob: hJob}, nil
}

func (pg *processGroup) apply(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// OR — don't assign — so callers that already set flags survive.
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
}

// afterStart contract:
//
//   - returns nil  → process is in the job and running (resumed)
//   - returns err  → the suspended child has been terminated via
//     TerminateProcess; the caller MUST still call
//     cmd.Wait() to release Go's process handle and any
//     pipe FDs. Falling through to relay goroutines would
//     deadlock — the pipes were never connected to a
//     running process.
func (pg *processGroup) afterStart(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return errors.New("cmd.Process is nil")
	}
	hProc, openErr := windows.OpenProcess(childProcessAccess, false, uint32(cmd.Process.Pid))
	if openErr != nil {
		// Suspended child has no other handle except Go's internal one
		// (which cmd.Wait will close). Try to kill via cmd.Process.Kill();
		// that uses Go's stored handle and doesn't need ours.
		_ = cmd.Process.Kill()
		return fmt.Errorf("OpenProcess pid=%d: %w", cmd.Process.Pid, openErr)
	}
	defer windows.CloseHandle(hProc)

	// From here, any failure must TerminateProcess(hProc) before return,
	// since the child is still suspended and AssignProcessToJobObject
	// may have or may not have taken effect.
	cleanup := func() { _ = windows.TerminateProcess(hProc, 1) }

	if err := windows.AssignProcessToJobObject(pg.hJob, hProc); err != nil {
		// Win10/Win11 supports nested jobs, but AssignProcessToJobObject
		// still has constraints: a process already in a job can only be
		// added to a nested job if (a) the target job has no UI limits,
		// (b) it sits in the same job hierarchy or is empty, and
		// (c) the existing job isn't terminating. See:
		//   https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
		//   https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs
		// Treat any failure here as fail-closed — we won't degrade to
		// direct-child TerminateProcess without containment.
		cleanup()
		return fmt.Errorf("AssignProcessToJobObject (process containment unavailable): %w", err)
	}
	// No IsProcessInJob check: Go's cmd.Process holds the CreateProcess
	// handle until Wait, so Windows guarantees the PID is not recycled
	// between cmd.Start and our OpenProcess.

	// Atomic resume via NtResumeProcess (one syscall, all threads).
	// CREATE_SUSPENDED means only the main thread exists right now —
	// there's no user code yet to spawn other threads — so "all
	// threads" == "main thread". Toolhelp32 fallback covers the
	// (Win10/11-unrealistic) case where ntdll!NtResumeProcess can't
	// be found.
	if err := ntResumeProcess(hProc); err != nil {
		if err2 := resumeViaToolhelp(cmd.Process.Pid); err2 != nil {
			cleanup()
			return fmt.Errorf("resume failed (NtResumeProcess: %v, Toolhelp32: %v)", err, err2)
		}
	}
	return nil
}

// resumeViaToolhelp resumes every thread that belongs to pid. At the
// post-CREATE_SUSPENDED moment that's just the main thread, but we
// resume all matches to be resilient against future kernels that
// might create internal threads pre-resume. Bounded iteration so a
// pathological snapshot can't hang us.
//
// resumed counts ONLY successful ResumeThread calls. OpenThread or
// ResumeThread failure on a matching thread is captured in lastErr and
// surfaced if we exit having resumed nothing — otherwise afterStart
// could return nil while the child is still suspended.
func resumeViaToolhelp(pid int) error {
	s, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(s)
	var e windows.ThreadEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := windows.Thread32First(s, &e); err != nil {
		return err
	}
	resumed := 0
	var lastErr error
	for i := 0; i < 8192; i++ {
		if int(e.OwnerProcessID) == pid && e.ThreadID != 0 {
			hT, oerr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, e.ThreadID)
			if oerr != nil {
				lastErr = fmt.Errorf("OpenThread tid=%d: %w", e.ThreadID, oerr)
			} else {
				if _, rerr := windows.ResumeThread(hT); rerr != nil {
					lastErr = fmt.Errorf("ResumeThread tid=%d: %w", e.ThreadID, rerr)
				} else {
					resumed++
				}
				_ = windows.CloseHandle(hT)
			}
		}
		if err := windows.Thread32Next(s, &e); err != nil {
			// ERROR_NO_MORE_FILES is end-of-iteration, not failure.
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				break
			}
			return err
		}
	}
	if resumed == 0 {
		if lastErr != nil {
			return fmt.Errorf("no thread resumed (last error: %w)", lastErr)
		}
		return errors.New("no threads matched pid")
	}
	return nil
}

// watchCancel signature matches the POSIX side intentionally so
// exec.go can call `go pg.watchCancel(cmd, cmdCtx, graceDur, finished)`
// uniformly across platforms in Phase 4. Windows ignores cmd and
// grace — it only needs the job handle held by pg.
func (pg *processGroup) watchCancel(_ *exec.Cmd, cmdCtx context.Context, _ time.Duration, finished <-chan struct{}) {
	select {
	case <-finished:
		return
	case <-cmdCtx.Done():
	}
	// No graceful path in v1: TerminateJobObject kills the whole tree
	// at once. The policy's cancel_grace_seconds is POSIX-only and
	// ignored here — documented limitation, revisit in v1.1 with
	// telemetry on which programs the LLM actually invokes.
	_ = windows.TerminateJobObject(pg.hJob, 1)
}

func (pg *processGroup) close() {
	if pg == nil || pg.hJob == 0 {
		return
	}
	_ = windows.CloseHandle(pg.hJob)
	pg.hJob = 0
}
