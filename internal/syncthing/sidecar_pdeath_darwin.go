//go:build darwin

package syncthing

import "os/exec"

// applyPdeath is a no-op on darwin: macOS has no kernel mechanism
// equivalent to Linux's PR_SET_PDEATHSIG that delivers a signal to
// a child when its parent dies. The pidfile + cmdline-hash
// orphan-check at next Start is the only line of defence — and
// per §3.7 D9 (d) that's a HARD cross-platform guarantee, so this
// no-op is acceptable.
//
// macOS does have PT_TRACEME / kqueue NOTE_EXIT but those are
// parent-watches-child semantics, not what we want (we need the
// CHILD to die when the parent dies). The closest workaround
// would be a goroutine in the parent that fork-detaches and
// monitors the child via kqueue, but that's strictly worse than
// just running the orphan-check at Start.
func applyPdeath(_ *exec.Cmd) {}
