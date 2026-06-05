package filesync

import (
	"fmt"
	"log"
	"path/filepath"
	"strings"
)

// internalStateDirName is the workspace-root-relative directory where
// the engine parks its own bookkeeping (tombstones, etc). Distinctively
// named so it doesn't collide with anything a user would plausibly
// create — `.kari/` would have been ambiguous and PR-E1's "only
// .gitignore decides sync" intent demands we leave the obvious names
// to user content.
const internalStateDirName = ".kari-engine"

// internalStagingSuffix is the file-extension we hang on .kari-incoming
// staging files (atomic-rename targets for streaming writes). Same
// rationale as internalStateDirName — `.trans-tmp` was too easy for
// users to accidentally use.
const internalStagingSuffix = ".kari-incoming"

// isProposalRel returns true for paths inside `.kari-proposals/`, the
// hidden tree the daemon uses to route incoming changes through the
// review pipeline instead of the working copy.
func isProposalRel(rel string) bool {
	rel = filepath.ToSlash(rel)
	return rel == ".kari-proposals" || strings.HasPrefix(rel, ".kari-proposals/")
}

// isInternalStatePath reports paths the engine itself creates as part
// of the sync mechanism plus a small allow-list of editor / VCS state
// that has per-machine semantics:
//
//   - .kari-engine/...    Engine state (tombstones.json today; future
//     resume bookkeeping). Sync-it-cross-machines
//     and tombstone histories would clobber each
//     other; delete propagation would oscillate.
//   - *.kari-incoming     Receiver-side partial-file staging. Sending
//     these mid-write would push half-written
//     bytes to the peer.
//   - .git/...            Per-machine VCS state — HEAD/refs/index point
//     at different commits on each side, objects/ is
//     tens of thousands of tiny files that flood the
//     events channel.
//   - vim swap files      .<name>.swp / .swo / .swn signal "this file is
//     open in *that* vim process" — the receiving vim
//     sees the lock and refuses to open the file with
//     a stale-recovery prompt every time.
//
// This is NOT a user-tunable rule (it isn't in .gitignore). It's an
// invariant of the protocol layer — files no working pair of machines
// would ever benefit from sharing. PR-E1's "only .gitignore decides"
// governs *user content*; this predicate is orthogonal.
func isInternalStatePath(rel string) bool {
	if rel == "" {
		return false
	}
	r := filepath.ToSlash(rel)
	if r == internalStateDirName || strings.HasPrefix(r, internalStateDirName+"/") {
		return true
	}
	if r == ".git" || strings.HasPrefix(r, ".git/") {
		return true
	}
	base := filepath.Base(r)
	if strings.HasSuffix(base, internalStagingSuffix) {
		return true
	}
	if isVimSwapFile(base) {
		return true
	}
	return false
}

// isVimSwapFile recognises vim's `.<filename>.{swp,swo,swn}` lock /
// crash-recovery files. Anchored on the leading dot so we don't sweep
// up legitimate user files that just happen to end in ".swp".
func isVimSwapFile(base string) bool {
	if !strings.HasPrefix(base, ".") {
		return false
	}
	return strings.HasSuffix(base, ".swp") ||
		strings.HasSuffix(base, ".swo") ||
		strings.HasSuffix(base, ".swn")
}

// ignoreMatcher reads BOTH .gitignore AND .kariignore at the sync
// root every time it is queried. Re-reading on demand keeps the
// matcher in sync with edits the user makes to either file without
// needing a fancier reload pipeline. Either file missing is treated
// as empty; non-IsNotExist errors are logged + returned as an empty
// matcher so the engine never crashes on a malformed file (each
// edit just becomes a no-op rule until the user fixes it).
//
// .kariignore is the Kari-specific list — defaults written on first
// download cover node_modules/, .vite/, dist/ and similar build
// artifacts so large project mirrors don't pull useless churn.
// .gitignore is whatever the user already maintains for git.
func (e *Engine) ignoreMatcher() *IgnoreMatcher {
	m, err := LoadCombinedIgnoreMatcher(e.root)
	if err != nil {
		log.Printf("load ignore matchers (.gitignore + .kariignore): %v", err)
		return &IgnoreMatcher{}
	}
	return m
}

// shouldIgnore is intentionally just the workspace .gitignore rules. There
// are no built-in user-facing exclusions here: paths such as .git/ sync
// unless the workspace's .gitignore excludes them. (See isInternalStatePath
// for protocol-internal files that are exempt regardless of .gitignore —
// those aren't a "rule," they're files we ourselves create as part of the
// transport mechanism.)
//
// One special case: drop-image uploads under .kari/uploads/ are landed
// there by the daemon itself (PtyAttach), not the user, so a blanket
// `.kari/` line in the workspace's .gitignore must not silently swallow
// them — otherwise dragging a PNG into the remote terminal succeeds
// locally but never appears on the server.
func (e *Engine) shouldIgnore(rel string, isDir bool) bool {
	return shouldIgnoreWithMatcher(rel, isDir, e.ignoreMatcher(), e.forceAllowSnapshot())
}

// ShouldIgnoreInbound is the public file-level version of shouldIgnore,
// called by session.go's recvLoop on MessageFileMeta BEFORE BeginReceive
// so paths matched by .gitignore / .kariignore can enter drop-mode
// (chunks discarded on arrival without buffering) instead of falling
// through the legacy buffered path that accumulates every chunk in
// RAM. Codex round 9 #1: pre-fix ignored paths cost full bandwidth +
// full memory for the duration of the transfer.
func (e *Engine) ShouldIgnoreInbound(rel string) bool {
	return e.shouldIgnore(cleanRel(rel), false)
}

// isIgnoreControlFile reports whether rel is one of the workspace's
// ignore control files (.gitignore or .kariignore). Both rebuild the
// matcher set on commit, so both must trigger pruneIgnoredTrackedFiles
// to delete files whose new rules now exclude them. Pre-Phase-N only
// .gitignore was checked; users editing .kariignore would not see
// already-tracked files get cleaned up until the next full rescan
// (Codex round 9 #3).
func isIgnoreControlFile(rel string) bool {
	r := filepath.ToSlash(rel)
	return r == IgnoreFile || r == KariIgnoreFile
}

func shouldIgnoreWithMatcher(rel string, isDir bool, matcher *IgnoreMatcher, forceAllow []ForceAllowEntry) bool {
	if rel == "" || rel == "." {
		return false
	}
	if isAttachUploadRel(rel) {
		return false
	}
	if forceAllowMatches(forceAllow, rel, isDir) {
		return false
	}
	return matcher.Match(rel, isDir)
}

func shouldSkipDirWithMatcher(rel string, matcher *IgnoreMatcher, forceAllow []ForceAllowEntry) bool {
	if rel == "" || rel == "." {
		return false
	}
	if isInternalStatePath(rel) {
		return true
	}
	if isAttachUploadContainerRel(rel) {
		return false
	}
	if forceAllowShouldDescend(forceAllow, rel) {
		return false
	}
	return matcher.Match(rel, true)
}

// isAttachUploadRel reports paths that PtyAttach writes into the
// workspace so the engine can opt them out of .gitignore filtering.
func isAttachUploadRel(rel string) bool {
	r := filepath.ToSlash(rel)
	return r == ".kari/uploads" || strings.HasPrefix(r, ".kari/uploads/")
}

// isAttachUploadContainerRel reports directories that must stay walkable
// even when a broad `.kari/` ignore rule would otherwise prune the tree.
func isAttachUploadContainerRel(rel string) bool {
	r := filepath.ToSlash(rel)
	return r == ".kari" || isAttachUploadRel(r)
}

// relative resolves an absolute filesystem path into the wire-form
// relative path the rest of the engine uses. Errors when the result
// would escape the sync root.
func (e *Engine) relative(abs string) (string, error) {
	rel, err := filepath.Rel(e.root, abs)
	if err != nil {
		return "", err
	}
	rel = cleanRel(rel)
	if rel == "." || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path outside sync root: %s", abs)
	}
	return rel, nil
}

// cleanRel canonicalises a relative path into the wire form used by both
// peers: forward-slash separated, no leading slash, no "./" or "../"
// noise. Wire form must be OS-agnostic so a Windows client can sync to a
// Unix server (and vice versa) without the receiver dumping
// backslash-named files at its sync root. Use absFromRel below whenever
// the result needs to be touched by the local filesystem.
func cleanRel(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "/")
	return filepath.ToSlash(filepath.Clean(p))
}

// absFromRel joins a wire-form (forward-slash) rel onto an absolute OS
// root, converting separators back to the local OS form so filesystem
// calls don't get a literal backslash in the basename on Unix.
func absFromRel(root, rel string) string {
	return filepath.Join(root, filepath.FromSlash(rel))
}

// isInside reports whether path is contained within root, used as a
// security guard before Apply* writes peer-supplied paths to disk.
func isInside(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..")
}
