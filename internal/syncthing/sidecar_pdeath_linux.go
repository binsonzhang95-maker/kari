//go:build linux

package syncthing

import (
	"os/exec"
	"syscall"
)

// applyPdeath enables Linux's PR_SET_PDEATHSIG via the spawned
// child's prctl, asking the kernel to deliver SIGKILL to the child
// if its parent thread exits. This is the §3.7 D9 (d) "best-effort
// optimization" layer — the HARD orphan-detection mechanism is
// still the pidfile + cmdline-hash check at next Start.
//
// Caveats Pdeathsig has on Linux (intentional documentation):
//   - PR_SET_PDEATHSIG triggers on the death of the spawning
//     THREAD, not the spawning PROCESS. Go's runtime may move the
//     spawning thread before the child exec's; the kernel then
//     fires PDEATHSIG even though the process still lives. This
//     is mitigated by Go locking the OS thread for SysProcAttr-
//     using forks (since Go 1.10 or thereabouts), but the
//     guarantee remains thread-level.
//   - The pidfile path catches all the cases Pdeathsig misses
//     (uses a wider-but-slower polling-on-Start model). So this
//     is purely an "optimistic fast cleanup" — if it works, great;
//     if not, the next Start's orphan-check picks up the slack.
//
// Returns void: failure to set SysProcAttr is impossible (we're
// just populating a struct). If Pdeathsig itself is rejected at
// exec time, the child still spawns successfully — Pdeathsig just
// isn't active.
func applyPdeath(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}
