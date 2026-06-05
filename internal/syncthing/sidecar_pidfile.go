package syncthing

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// pidfileName is the per-HomeDir pidfile basename. Lives next to
// config.xml inside the syncthing state dir (§3.7 D9 (b)).
const pidfileName = "syncthing.pid"

// pidfileEntry is the parsed shape of a pidfile body. The wire
// format is one line, "<pid> <cmdline-hash>", whitespace-separated.
// cmdline-hash is sha256 over the full argv joined with NUL, taken
// first 12 hex chars. Hash defends against PID reuse: a stale
// pidfile pointing at PID N where N has since been recycled by an
// unrelated process won't match the hash, so the orphan-check
// won't kill an innocent bystander.
type pidfileEntry struct {
	PID         int
	CmdlineHash string
}

// hashCmdline returns the 12-hex-char marker used for PID-reuse
// disambiguation. Stable across runs of the same Sidecar.Start
// configuration (binary path + flags); changes if the operator
// edits any of those.
func hashCmdline(argv []string) string {
	h := sha256.Sum256([]byte(strings.Join(argv, "\x00")))
	return hex.EncodeToString(h[:6]) // 12 hex chars
}

// pidfilePath returns the canonical pidfile path for a given home.
func pidfilePath(homeDir string) string {
	return filepath.Join(homeDir, pidfileName)
}

// writePidfile atomically writes the entry to <homeDir>/syncthing.pid
// via .tmp + Rename. Per §3.7 D9 (b): write happens AFTER exec.Cmd.Start
// returns success but BEFORE the health poll, so a stale pidfile
// survives a death-during-startup and the next Start's orphan-check
// can clean up.
func writePidfile(homeDir string, entry pidfileEntry) error {
	if homeDir == "" {
		return errors.New("pidfile: empty homeDir")
	}
	if entry.PID <= 0 {
		return fmt.Errorf("pidfile: invalid pid %d", entry.PID)
	}
	if entry.CmdlineHash == "" {
		return errors.New("pidfile: empty cmdline-hash (PID-reuse defence requires non-empty)")
	}
	path := pidfilePath(homeDir)
	body := fmt.Sprintf("%d %s\n", entry.PID, entry.CmdlineHash)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o600); err != nil {
		return fmt.Errorf("pidfile: write tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("pidfile: rename %s → %s: %w", tmp, path, err)
	}
	return nil
}

// readPidfile loads the pidfile at <homeDir>/syncthing.pid. Returns
// (nil, nil) — explicitly NOT an error — if the file is missing OR
// malformed. The "no prior owner" interpretation in those cases is
// safer than failing Start, since the orphan-check downstream is
// best-effort and a corrupted pidfile means we have no reliable
// claim about a previous process anyway.
//
// Real malformed reads (filesystem errors other than not-exist) DO
// propagate so operators see them.
func readPidfile(homeDir string) (*pidfileEntry, error) {
	path := pidfilePath(homeDir)
	body, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("pidfile: read %s: %w", path, err)
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, nil
	}
	parts := strings.Fields(trimmed)
	if len(parts) != 2 {
		// Malformed — treat as no prior owner. Don't error;
		// operator-fixable scenario where they wrote junk to the
		// pidfile shouldn't break Start.
		return nil, nil
	}
	pid, err := strconv.Atoi(parts[0])
	if err != nil || pid <= 0 {
		return nil, nil
	}
	hash := parts[1]
	if len(hash) != 12 {
		// Unexpected hash width — treat as malformed.
		return nil, nil
	}
	return &pidfileEntry{PID: pid, CmdlineHash: hash}, nil
}

// removePidfile deletes the pidfile. Missing file is not an error
// (Stop on a never-started sidecar / double-Stop / orphan-check
// recovery paths all hit this). Other errors propagate.
func removePidfile(homeDir string) error {
	path := pidfilePath(homeDir)
	err := os.Remove(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("pidfile: remove %s: %w", path, err)
	}
	return nil
}

// processProbe is the tri-state result of probeProcess. Round-1
// review Blocking fix: collapsing EPERM into "gone" was unsafe
// (could let Start proceed past a marker pointing at an actually-
// alive process owned by another user). Explicit Unknown lets
// callers fail-closed on ambiguity.
type processProbe int

const (
	// processGone — process does not exist (Unix: ESRCH; Windows:
	// OpenProcess returns ERROR_INVALID_PARAMETER or GetExitCodeProcess
	// returns a non-STILL_ACTIVE code). Negative/zero pids also map
	// here defensively.
	processGone processProbe = iota
	// processAlive — process exists AND we have a handle / permission
	// to query it.
	processAlive
	// processUnknown — probe returned an error we can't definitively
	// map to either alive or gone (Unix EPERM; Windows
	// ERROR_ACCESS_DENIED). Callers fail closed: cannot proceed
	// past a marker whose state we can't verify.
	processUnknown
)

// probeProcess is implemented per-platform in
// sidecar_process_unix.go (!windows) and sidecar_process_windows.go.
// Returns the tri-state existence of pid. Step 3 splits this from
// the step-2 single-file implementation so Windows cross-compile
// works.
//
// Callers MUST treat processUnknown as "cannot proceed" — that's
// the entire reason for keeping it distinct from processGone.

// killOrphan is implemented per-platform alongside probeProcess.
// Unix: SIGTERM → 5s grace → SIGKILL → 2s reap.
// Windows: TerminateProcess (no SIGTERM equivalent for arbitrary
// processes) → 2s reap.
// Returns nil only on confirmed processGone within the budget;
// otherwise an error the caller treats as permanent-blocked.

// waitForProcessGone is shared across platforms — it just polls
// probeProcess. Returns true ONLY on observed processGone; Alive
// and Unknown both keep polling until timeout.
func waitForProcessGone(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	t := time.NewTicker(50 * time.Millisecond)
	defer t.Stop()
	for {
		if probeProcess(pid) == processGone {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		<-t.C
	}
}

// checkOrphanOnStart is the orphan-check entry point invoked by
// Sidecar.Start before it pre-picks the port. Sequence per §3.7
// D9 (b):
//
//  1. readPidfile(homeDir)
//  2. if entry == nil: no prior owner, return nil (proceed to
//     normal Start)
//  3. probeProcess(pid):
//     - Gone     → stale marker; remove pidfile, return nil
//     - Unknown  → can't determine state (EPERM / unexpected
//                  errno); fail-closed, KEEP marker for operator
//     - Alive    → check cmdline-hash:
//       - mismatch → ambiguous: could be PID reuse by an
//                    unrelated process OR an old Kari sidecar
//                    with a different argv (binary upgrade).
//                    Killing might hit an innocent bystander;
//                    skipping risks double-sidecar-same-HomeDir.
//                    Either choice is wrong without operator
//                    context — fail-closed, KEEP marker.
//       - match    → orphan from previous Sidecar run with the
//                    same configuration; killOrphan + remove
//                    marker on success.
//
// Errors from killOrphan propagate — caller treats them as
// "refuse Start" per §3.7 D4 step 2 + D5 step 4 + §4.5 Option A
// (permanent blocked, no exit).
//
// Round-1 review Blocking fixes:
//  1. hash-mismatch: was "remove marker + proceed" (allowed
//     double-spawn on binary upgrade); now fail-closed.
//  2. probe-Unknown: was treated as Gone (allowed proceeding
//     past a marker we couldn't actually verify dead); now
//     fail-closed.
func checkOrphanOnStart(homeDir string, currentCmdlineHash string) error {
	entry, err := readPidfile(homeDir)
	if err != nil {
		return err
	}
	if entry == nil {
		return nil // no prior owner
	}
	switch probeProcess(entry.PID) {
	case processGone:
		// Stale marker; safe to remove.
		return removePidfile(homeDir)
	case processUnknown:
		// EPERM or some other ambiguous errno. We CANNOT prove the
		// process is dead; CANNOT prove it's safe to spawn alongside.
		// Keep the marker so operators can inspect it (ps + manual
		// kill, then remove the marker manually).
		return fmt.Errorf("orphan-check: pidfile pid=%d state cannot be determined (kill(pid, 0) returned ambiguous errno — likely EPERM); refusing Start to avoid double-spawn (homeDir=%s)", entry.PID, homeDir)
	}
	// processAlive past this point.
	if entry.CmdlineHash != currentCmdlineHash {
		// Ambiguous: either PID reuse by an unrelated process OR an
		// old Kari sidecar where argv changed across versions. In
		// the latter case, removing the marker + spawning would
		// give us two sidecars writing to the same HomeDir. Fail
		// closed; operator must inspect ps and manually remove
		// the pidfile if it's safe.
		return fmt.Errorf("orphan-check: pidfile pid=%d alive but cmdline-hash mismatch (recorded=%s, current=%s); refusing Start to avoid either killing an unrelated PID-reuse innocent OR double-spawning against a same-Kari sidecar from a different version. Operator must inspect ps and remove pidfile if safe (homeDir=%s)", entry.PID, entry.CmdlineHash, currentCmdlineHash, homeDir)
	}
	// Same configuration we'd be spawning — this IS our orphan.
	if err := killOrphan(entry.PID); err != nil {
		return fmt.Errorf("orphan-check: %w (homeDir=%s)", err, homeDir)
	}
	return removePidfile(homeDir)
}
