package syncd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// gitignoreMarker{Begin,End} delimit the kari-managed region inside
// the workspace .gitignore. Anything outside these markers is user
// content and we never touch it. Picked to be self-explanatory and
// distinctive enough that a grep across the org reveals every file we
// auto-maintain.
const (
	gitignoreMarkerBegin = "# >>> kari managed (do not edit) >>>"
	gitignoreMarkerEnd   = "# <<< kari managed <<<"
)

// kariManagedGitignorePatterns are the entries Kari auto-maintains in
// the workspace .gitignore. Each is a per-host engine/daemon path that
// shouldn't land in version control:
//
//   - /.kari/           drop-image uploads + review proposals (the
//                       engine intentionally syncs .kari/uploads/ over
//                       the wire so the remote PTY can see dropped
//                       images, but that's transport, not source).
//   - /.kari-engine/    engine bookkeeping — incoming-history pre-image
//                       blobs (~100 MB budget) and tombstones.json. The
//                       sync layer already refuses to push these
//                       (isInternalStatePath), so cross-machine
//                       reproducibility doesn't need them in git.
//
// Anchored with `/` so deeper subprojects that happen to use the same
// directory name don't get accidentally caught.
var kariManagedGitignorePatterns = []string{
	"/.kari/",
	"/.kari-engine/",
}

// ensureGitignoreManaged maintains the kari-managed block in the
// workspace's .gitignore. Idempotent — re-running with the same
// patterns is a no-op on disk. Returns true when the file was
// actually written, false when no change was needed; the bool lets
// the caller log "updated" without computing the diff again.
//
// Failures (read-only worktree, permission denied) are returned as
// errors; the daemon's Bind() logs them as warnings rather than
// aborting — the worktree just stays noisy in `git status`, no
// other functionality is affected.
func ensureGitignoreManaged(workspaceRoot string) (changed bool, err error) {
	if workspaceRoot == "" {
		return false, nil
	}
	path := filepath.Join(workspaceRoot, ".gitignore")
	var existing string
	raw, rerr := os.ReadFile(path)
	switch {
	case rerr == nil:
		existing = string(raw)
	case os.IsNotExist(rerr):
		// First-time create — leave existing empty.
	default:
		return false, fmt.Errorf("read .gitignore: %w", rerr)
	}

	next := mergeKariBlock(existing, kariManagedGitignorePatterns)
	if next == existing {
		return false, nil
	}
	if werr := writeFileAtomic(path, []byte(next), 0o644); werr != nil {
		return false, fmt.Errorf("write .gitignore: %w", werr)
	}
	return true, nil
}

// mergeKariBlock returns the new .gitignore content with the managed
// block either spliced in place (if the markers are already present)
// or appended (if they aren't). User content outside the markers is
// preserved verbatim. Pure function for unit testing.
func mergeKariBlock(existing string, patterns []string) string {
	block := buildKariBlock(patterns)

	beginIdx := strings.Index(existing, gitignoreMarkerBegin)
	endIdx := strings.Index(existing, gitignoreMarkerEnd)
	if beginIdx >= 0 && endIdx >= 0 && endIdx > beginIdx {
		// Splice in place. TrimRight/TrimLeft on the surrounding
		// segments collapses any extra blank lines we previously
		// emitted around the block so the file doesn't accumulate
		// growing whitespace on each rebind.
		endLineEnd := endIdx + len(gitignoreMarkerEnd)
		prefix := strings.TrimRight(existing[:beginIdx], "\n")
		suffix := strings.TrimLeft(existing[endLineEnd:], "\n")
		return joinSections(prefix, block, suffix)
	}

	// No marker yet — append. Separated from prior content by a blank
	// line so the block reads as a discrete section, not as an
	// accidental continuation of the last user pattern.
	prior := strings.TrimRight(existing, "\n")
	if prior == "" {
		return block + "\n"
	}
	return prior + "\n\n" + block + "\n"
}

func buildKariBlock(patterns []string) string {
	var b strings.Builder
	b.WriteString(gitignoreMarkerBegin)
	b.WriteByte('\n')
	for _, p := range patterns {
		b.WriteString(p)
		b.WriteByte('\n')
	}
	b.WriteString(gitignoreMarkerEnd)
	return b.String()
}

// joinSections concatenates a non-empty optional prefix, the managed
// block, and an optional suffix, separated by blank lines, with a
// single trailing newline. Each section has trailing newlines trimmed
// first so a suffix that came in with its own trailing "\n" doesn't
// produce a "\n\n" tail when we re-append our canonical single "\n".
// Empty sections are skipped so the block-at-top and block-at-bottom
// cases don't emit leading/trailing blank lines.
func joinSections(prefix, block, suffix string) string {
	var parts []string
	if prefix != "" {
		parts = append(parts, strings.TrimRight(prefix, "\n"))
	}
	parts = append(parts, strings.TrimRight(block, "\n"))
	if suffix != "" {
		parts = append(parts, strings.TrimRight(suffix, "\n"))
	}
	return strings.Join(parts, "\n\n") + "\n"
}

// writeFileAtomic writes data to path via temp file + rename so a
// concurrent reader (the engine's gitignore matcher loader, another
// editor process) never observes a half-written file. Temp file lives
// next to the target so the rename is same-filesystem and atomic.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".gitignore.tmp.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Defer cleanup so a write/close/chmod failure mid-way doesn't
	// leave the temp file orphaned. os.Remove on a non-existent path
	// is harmless.
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
