package syncd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
)

// freshDownloadMarker is the relative path inside a workspace root
// that kari-desktop creates the instant it kicks off a fresh cloud
// download. Presence == "this bind is the daemon side of a download
// that hasn't completed yet"; absence == "user has a local project
// they uploaded themselves, or a previously-completed mirror." The
// marker survives until the download barrier closes (sync_task
// succeeded) which removes it. See kari-desktop
// src/main/main.cjs:markerPathFor for the producing side.
//
// We use this as the gate for WriteDefaultKariIgnoreIfMissing so the
// daemon ONLY writes a default .kariignore on the first download of
// a cloud project. Local projects + already-downloaded mirrors must
// NOT silently gain a daemon-authored ignore list — that would
// retroactively stop syncing dist/build/etc. for users who had been
// uploading them deliberately (Codex round 9 #2).
const freshDownloadMarker = ".kari-engine/desktop-download-incomplete"

// IsFreshDownloadBind returns true when the workspace root carries
// the desktop fresh-download marker. Stat-only — no allocations on
// the no-op path. Errors other than IsNotExist are treated as
// "we can't tell, err on the side of NOT writing default" so a
// transient FS hiccup never silently rewrites a user's project.
func IsFreshDownloadBind(root string) bool {
	if root == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(root, freshDownloadMarker))
	return err == nil
}

// defaultKariIgnoreContent is the conservative default written into
// a workspace's .kariignore the FIRST TIME the daemon binds a
// workspace that doesn't already have one. Conservative scope per
// product direction:
//
//   - Skip dependency caches: node_modules, .pnpm-store, .yarn/cache.
//     These are the #1 source of download bloat for JS/TS projects
//     and the #1 source of fsevents churn during sync (every IDE +
//     language server touches them constantly).
//   - Skip framework dev caches: .vite, .next, .nuxt. Same reason —
//     dev servers rewrite these on every hot-reload.
//   - Skip build artifacts: dist, build, coverage. Small false-
//     positive risk (some projects might legitimately want a built
//     dist on a peer), but the user can edit .kariignore to remove
//     these lines and re-sync.
//   - Skip macOS/Spotlight noise: .DS_Store, .cache.
//
// Anything beyond this list (e.g. *.log, __pycache__, target/) is
// the USER's call to add. We err on the side of "syncs too much
// rather than too little" — if a project relied on a synced
// generator output, silent omission would be a worse bug than a
// slightly slow sync the first time around.
//
// The header comment is part of the file body so a user opening
// .kariignore in their editor sees WHY it exists + how to override.
const defaultKariIgnoreContent = `# Kari sync ignore list.
# This file controls what Kari syncs between machines. Same syntax
# as .gitignore. Edit and re-sync to take effect.
#
# Defaults below were written by Kari on first download to avoid
# syncing dependency caches and build artifacts (the #1 cause of
# stuck downloads on large projects). Remove any line you DO want
# synced.

node_modules/
.pnpm-store/
.yarn/cache/
.vite/
.next/
.nuxt/
dist/
build/
coverage/
.cache/
.DS_Store
`

// WriteDefaultKariIgnoreIfMissing writes defaultKariIgnoreContent to
// `<root>/.kariignore` ONLY when the file does not already exist.
// User-edited files are never overwritten — first-write-wins. Also
// no-op when root is empty or not a writable directory.
//
// Called from runOnce after the workspace bind completes and before
// session.Run sends the initial manifest, so the very first peer
// manifest exchange already sees the defaults in place (recipient's
// shouldIgnore filters incoming node_modules/etc files on apply).
//
// Returns (true, nil) on a fresh write, (false, nil) when the file
// already existed (the more common path on subsequent binds), and
// (false, err) on real IO errors. Caller logs errors but should NOT
// fail the bind on them — having the daemon refuse to sync because
// it couldn't write a default ignore list would be a worse UX than
// just running without the optimization.
func WriteDefaultKariIgnoreIfMissing(root string) (bool, error) {
	if root == "" {
		return false, nil
	}
	info, err := os.Stat(root)
	if err != nil {
		return false, fmt.Errorf("stat workspace root %q: %w", root, err)
	}
	if !info.IsDir() {
		return false, fmt.Errorf("workspace root %q is not a directory", root)
	}
	path := filepath.Join(root, filesync.KariIgnoreFile)
	// O_EXCL: atomic "create only if missing". An existing file at
	// the path — including one the user just edited a second ago —
	// makes this fail with os.ErrExist, which we handle as "the
	// user already has one, leave it alone".
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("create %s: %w", path, err)
	}
	defer f.Close()
	if _, err := f.WriteString(defaultKariIgnoreContent); err != nil {
		return false, fmt.Errorf("write %s: %w", path, err)
	}
	return true, nil
}
