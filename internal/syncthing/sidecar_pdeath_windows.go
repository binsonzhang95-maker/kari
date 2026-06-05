//go:build windows

package syncthing

import "os/exec"

// applyPdeath is currently a no-op on Windows. The clean Windows
// equivalent of Pdeathsig is a Job Object with the
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE limit — when the parent dies
// and its last handle to the job closes, the kernel terminates
// every process in the job. That implementation needs:
//
//   - CreateJobObjectW / SetInformationJobObject /
//     AssignProcessToJobObject calls via golang.org/x/sys/windows
//     (not in stdlib).
//   - A stable handle the parent keeps until exit.
//   - Care around CREATE_BREAKAWAY_FROM_JOB if the parent process
//     itself is already inside a job (CI containers, some IDEs).
//
// Per §3.7 D9 (d), the pidfile + cmdline-hash orphan-check is
// the HARD cross-platform guarantee; per-OS parent-death is a
// degraded best-effort. Shipping Windows Job Object support
// here would pull a new module dependency (x/sys/windows) into
// PR1.3b-2, which the user-locked step-3 scope explicitly allows
// to skip if it's "too much code" — taking that escape hatch.
//
// TODO(PR1.3b-3 or later): implement Job Object containment so
// trans-server crashes on Windows promptly tear down the
// sidecar. Until then the orphan-check at next Start is the
// recovery path.
func applyPdeath(_ *exec.Cmd) {}
