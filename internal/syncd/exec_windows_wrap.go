//go:build windows

package syncd

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// Win32 / NT syscall wrappers we need that golang.org/x/sys/windows
// v0.44.0 doesn't ship. Lives in its own file so Phase 1 (the wrapper +
// wrapper-only tests) is independently committable and verifiable
// before the processGroup struct in exec_windows.go takes a dependency
// on it.
//
// Test-only helpers (queryJobProcessCount + JOBOBJECT_BASIC_PROCESS_ID_LIST
// header) live in exec_windows_wrap_test.go so they never enter
// production builds.

var (
	modntdll         = windows.NewLazySystemDLL("ntdll.dll")
	procNtResumeProc = modntdll.NewProc("NtResumeProcess")
)

// ntResumeProcess atomically resumes every thread of the target
// process. Used right after AssignProcessToJobObject so a child created
// with CREATE_SUSPENDED can start running while contained.
//
// Stable since Windows XP and used by every Windows debugger; the
// alternative (Toolhelp32 thread enumeration + ResumeThread per
// thread) is exposed as a fallback in exec_windows.go.
//
// Required access right on hProc: PROCESS_SUSPEND_RESUME.
//
// IMPORTANT: r1 is NTSTATUS, NOT a Win32 errno. We must not wrap with
// syscall.Errno — the two error-code spaces don't share numbering and
// the resulting log would point operators to the wrong reference. Use
// hex so an operator can grep ntstatus.h directly.
func ntResumeProcess(hProc windows.Handle) error {
	if err := procNtResumeProc.Find(); err != nil {
		return err
	}
	r1, _, _ := procNtResumeProc.Call(uintptr(hProc))
	if r1 != 0 {
		return fmt.Errorf("NtResumeProcess: NTSTATUS=0x%08x", uint32(r1))
	}
	return nil
}
