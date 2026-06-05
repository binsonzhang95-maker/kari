package filesync

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// scanTransTmp walks the workspace for `.kari-incoming` staging files
// left over from interrupted transfers. For each, it records
// (size, sha256) in e.partials so the next Manifest() can advertise
// the resume point to the peer. Quiet on failure — missing partials
// just means a full retransmit on reconnect.
func (e *Engine) scanTransTmp() {
	_ = filepath.WalkDir(e.root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		name := filepath.Base(path)
		if !strings.HasSuffix(name, internalStagingSuffix) {
			return nil
		}
		targetAbs := strings.TrimSuffix(path, internalStagingSuffix)
		rel, rerr := filepath.Rel(e.root, targetAbs)
		if rerr != nil {
			return nil
		}
		wire := cleanRel(rel)
		hashHex, size, herr := hashFile(path)
		if herr != nil {
			return nil
		}
		e.mu.Lock()
		e.partials[wire] = Partial{Bytes: size, Etag: hashHex}
		e.mu.Unlock()
		return nil
	})
}

// gcTransTmp removes any `.kari-incoming` staging files older than
// maxAge. The receive path keeps them across reconnect (resume), but
// an abandoned workspace shouldn't accumulate them forever. Quiet on
// any stat/remove failure.
func (e *Engine) gcTransTmp(maxAge time.Duration) {
	cutoff := time.Now().Add(-maxAge)
	_ = filepath.WalkDir(e.root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(filepath.Base(path), internalStagingSuffix) {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(path)
		}
		return nil
	})
}

// Snapshot rescans the workspace, merges results into e.index, and
// returns a cloned view. It's the entry point for both Manifest()
// and SendSnapshot — anyone who needs "the current set of files".
//
// Detected deletions are promoted to tombstones so the next manifest
// exchange propagates them to the peer. This is what catches "offline
// deletes" — files removed from disk while the daemon was down. The
// combination of (a) loadIndex on engine startup (re-hydrates index
// from index.json) and (b) Snapshot's "in-index, not-on-disk → tombstone"
// pass here is what makes the cross-restart delete detection work.
//
// Root-health gate: if scan returns zero files but e.index has entries,
// we double-check that the root is actually accessible before applying
// the "everything deleted" interpretation. A network mount briefly
// dropping or a temp permission flip would otherwise look identical to
// "user deleted the whole workspace" and would propagate to the peer.
// This guard is conservative: any positive scan result (>= 1 file) is
// treated as authoritative and the missing-entries branch runs normally.
func (e *Engine) Snapshot() (map[string]FileInfo, error) {
	e.scanMu.Lock()
	defer e.scanMu.Unlock()

	files, err := e.scan()
	if err != nil {
		return nil, err
	}

	// Health check only matters when scan returned empty AND we previously
	// had entries — that's the suspicious "did everything disappear, or is
	// the disk briefly unavailable?" case. Single os.Stat suffices for the
	// common pathological inputs (root removed, network share down). It
	// won't catch the rare "mount point replaced with empty directory"
	// edge case; see plan notes.
	rootOK := true
	if len(files) == 0 {
		if st, serr := os.Stat(e.root); serr != nil || !st.IsDir() {
			rootOK = false
		}
	}

	e.mu.Lock()
	now := time.Now().UnixNano()
	addedTombs := false
	for path, info := range files {
		if old, ok := e.index[path]; ok {
			info.Version = old.Version
			// Same rationale as changedPaths: an EOL-only re-save
			// changes ModTime+Size but is logically unchanged; bumping
			// Version here would falsely advertise us as newer to peers
			// and trigger a push for content they already have.
			if !sameContent(old, info) {
				info.Version = info.ModTime
			}
		} else {
			info.Version = info.ModTime
		}
		e.index[path] = info
	}
	if rootOK {
		for path := range e.index {
			if _, ok := files[path]; !ok {
				delete(e.index, path)
				// Use now() (not the file's old mtime — we no longer have
				// it). The Version field is what DiffManifests compares
				// against the peer's live entry mtime: now() will always
				// win against any historical mtime, so the delete
				// propagates.
				e.tombstones[path] = now
				addedTombs = true
			}
		}
	}
	cloned := cloneIndex(e.index)
	e.mu.Unlock()
	// Only persist when rootOK. If root is inaccessible, persisting would
	// either silently no-op (the rootAccessible gate inside persistTombstones
	// /persistIndexNow handles that case correctly) or — without that gate
	// — recreate the workspace as an empty directory via MkdirAll, which
	// the next Snapshot would then see as "rootOK=true + scan=empty +
	// index=populated" and propagate a tombstone wave to the peer. Belt
	// and braces: gate here AND inside the persist helpers.
	if rootOK {
		if addedTombs {
			e.persistTombstones()
		}
		// Snapshot is a deliberate sync point — flush immediately so a
		// crash before the next high-frequency mutation's debounced flush
		// can't lose the post-Snapshot view of the workspace.
		e.FlushIndex()
	}
	return cloned, nil
}

// Watch drives the outbound change stream. It emits absolute paths onto
// events whenever a file changes — either because the OS watcher saw it,
// because the periodic rescan ticker fired, or because the caller asked
// for an immediate rescan via kick. kick may be nil (server-side
// session, tests); both OS watching and ticker rescans still work
// without it.
//
// The watcher backend is platform-selected (see watcher.go): FSEvents
// on darwin to avoid kqueue's per-file FD cost, fsnotify on Linux and
// Windows where the native kernel APIs are already FD-efficient.
func (e *Engine) Watch(ctx context.Context, enqueue func(string), rescanInterval time.Duration, kick <-chan struct{}) error {
	watcher, err := newWatcher(e)
	if err != nil {
		return err
	}
	defer watcher.Close()

	if rescanInterval <= 0 {
		rescanInterval = 30 * time.Second
	}
	ticker := time.NewTicker(rescanInterval)
	defer ticker.Stop()

	// Factor the rescan + emit into a helper since both ticker.C and
	// kick trigger it identically. Centralises the log/dropping policy
	// so the kick path can't drift.
	rescan := func(mode scanMode) {
		paths, err := e.changedPathsWithMode(mode)
		if err != nil {
			log.Printf("rescan failed: %v", err)
			return
		}
		for _, path := range paths {
			if enqueue != nil {
				enqueue(filepath.Join(e.root, path))
			}
		}
	}

	watcherEvents := watcher.Events()
	watcherErrors := watcher.Errors()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case path, ok := <-watcherEvents:
			if !ok {
				return nil
			}
			// Don't echo events for the engine's own state files
			// (`.kari-engine/...`, `*.kari-incoming`). Without this,
			// persisting tombstones or doing an atomic receive-rename
			// floods the outbound queue with phantom syncs.
			if rel, rerr := e.relative(path); rerr == nil && isInternalStatePath(rel) {
				continue
			}
			if enqueue != nil {
				enqueue(path)
			}
		case err, ok := <-watcherErrors:
			if ok {
				log.Printf("watch error: %v", err)
			}
		case <-ticker.C:
			rescan(scanFast)
		case <-kick:
			// TriggerSync (or any future "force a sync" path) lands here.
			// Reading from a nil chan blocks forever, which is exactly
			// the no-op behavior we want when kick is unset.
			rescan(scanDeep)
		}
	}
}

// changedPaths returns the wire-form relative paths whose content
// (hash or size) differs from e.index since the last scan. Used by
// the rescan ticker — fsnotify drives the same emit channel with
// absolute paths, but rescan's diff is more reliable for catching
// changes the kernel filter missed (network drives, kqueue gaps).
func (e *Engine) changedPaths() ([]string, error) {
	return e.changedPathsWithMode(scanFast)
}

func (e *Engine) changedPathsDeep() ([]string, error) {
	return e.changedPathsWithMode(scanDeep)
}

func (e *Engine) changedPathsWithMode(mode scanMode) ([]string, error) {
	e.scanMu.Lock()
	defer e.scanMu.Unlock()

	current, err := e.scanWithMode(mode)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	seen := map[string]struct{}{}
	var changed []string
	for path, info := range current {
		seen[path] = struct{}{}
		old := e.index[path]
		// Size check would be redundant for byte-identical files (Hash
		// collision is the only way to disagree), but is actively wrong
		// for EOL-only diffs where CRLF↔LF intentionally changes size
		// while sameContent reports them equal. So gate purely on
		// content equivalence.
		if !sameContent(old, info) {
			changed = append(changed, path)
		}
	}
	for path := range e.index {
		if _, ok := seen[path]; !ok {
			changed = append(changed, path)
		}
	}
	return changed, nil
}

// scan walks the workspace, applies the ignore matcher + internal-path
// filter, and returns a fresh FileInfo map. Uses the existing e.index
// as a hash cache: files whose (mtime, size) haven't changed reuse the
// cached hash, avoiding gigabytes of re-hashing on every rescan tick.
type scanMode int

const (
	scanFast scanMode = iota
	scanDeep
)

func (e *Engine) scan() (map[string]FileInfo, error) {
	return e.scanWithMode(scanFast)
}

func (e *Engine) scanWithMode(mode scanMode) (map[string]FileInfo, error) {
	matcher := e.ignoreMatcher()
	forceAllow := e.forceAllowSnapshot()
	// Snapshot the existing index so the walk can short-circuit hashing
	// on files whose mtime+size haven't changed. Reading the entire file
	// every 30s to recompute SHA-256 was the primary source of memory
	// churn on large workspaces — Windows reports it as a multi-hundred-MB
	// RSS because Go's GC lets the heap grow ~2x between collections.
	e.mu.Lock()
	cached := make(map[string]FileInfo, len(e.index))
	for k, v := range e.index {
		cached[k] = v
	}
	e.mu.Unlock()
	out := map[string]FileInfo{}
	// Use only .gitignore-controlled exclusions during the walk. Everything
	// else is considered syncable content.
	err := filepath.WalkDir(e.root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// If the root itself has disappeared (user deleted their
			// workspace folder, or a server-side workspace tree got
			// rm -rf'd between sessions), report an empty scan instead
			// of propagating the lstat error. Returning the error here
			// is what made trans-server spin in a reconnect loop the
			// last time this happened: every reconnect re-tripped the
			// same lstat and tore the session down before SendSnapshot
			// could even start. Empty scan + Snapshot()'s existing
			// "drop stale index entries" pass converges to "tell the
			// peer everything is gone."
			if path == e.root && os.IsNotExist(err) {
				return filepath.SkipDir
			}
			return err
		}
		if d.IsDir() {
			// Skip whole subtrees the user has excluded — saves stat
			// calls and stops fsnotify wasting time on watched-but-
			// ignored directories. Engine state (.kari-engine/) is
			// dropped on the same path so a tombstones.json write
			// doesn't trip a sync event.
			rel, rerr := e.relative(path)
			if rerr == nil && shouldSkipDirWithMatcher(rel, matcher, forceAllow) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := e.relative(path)
		if err != nil {
			return err
		}
		if isInternalStatePath(rel) || shouldIgnoreWithMatcher(rel, false, matcher, forceAllow) {
			return nil
		}
		// Cheap stat first; only re-hash when mtime or size moved.
		osInfo, err := os.Stat(path)
		if err != nil {
			return err
		}
		modTime := osInfo.ModTime().UnixNano()
		size := osInfo.Size()
		id := fileID(osInfo)
		if mode == scanFast {
			if old, ok := cached[rel]; ok && old.Hash != "" && old.ModTime == modTime && old.Size == size && sameFileID(old.FileID, id) {
				e.cacheHitTotal.Add(1)
				out[rel] = FileInfo{
					Path:     rel,
					Size:     size,
					ModTime:  modTime,
					FileID:   id,
					Hash:     old.Hash,
					NormHash: old.NormHash,
					Version:  old.Version,
				}
				return nil
			}
		}
		e.cacheMissTotal.Add(1)
		info, err := statFile(e.root, rel)
		if err != nil {
			return err
		}
		if info.FileID == "" {
			info.FileID = id
		}
		if mode == scanDeep {
			if old, ok := cached[rel]; ok && old.Hash != "" && !sameContent(old, info) && old.ModTime == info.ModTime && old.Size == info.Size && sameFileID(old.FileID, info.FileID) {
				e.deepRescanFoundDriftTotal.Add(1)
			}
		}
		out[rel] = info
		return nil
	})
	return out, err
}

func sameFileID(a, b string) bool {
	return a == "" || b == "" || a == b
}
