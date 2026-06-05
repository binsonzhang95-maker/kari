package filesync

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

// defaultIndexFlushDelay is the production debounce window. New() seeds
// each Engine's per-instance flushDelay from this constant; tests that
// want to shrink the window touch the per-engine field, not the package
// var — this keeps concurrent test cases from racing on a shared global
// (the prior approach left a goroutine from test A still reading the
// var when test B's t.Cleanup restored it). 200ms absorbs the per-file
// send/receive bursts of an initial sync against a 10k-file workspace
// while keeping crash-loss bounded to ~one debounce window.
const defaultIndexFlushDelay = 200 * time.Millisecond

// indexFile is the on-disk shape of the persisted live-file index. Sister
// to tombstones.json: tombstones records what we've deleted, index.json
// records what we currently have. Together they let a daemon restart and
// reconstruct enough state to detect "offline deletes" — files the user
// removed from disk while the daemon was down. Without index.json,
// runOnce builds a fresh engine on every reconnect (engine.go:111) with
// an empty index, so Snapshot's "in index, not on disk → tombstone" logic
// never fires and the peer keeps pushing the deleted file back.
type indexFile struct {
	Version int                 `json:"version"`
	Entries map[string]FileInfo `json:"entries"`
}

func (e *Engine) indexPath() string {
	return filepath.Join(e.root, internalStateDirName, "index.json")
}

// loadIndex is best-effort. A missing/corrupt file just means the engine
// starts fresh — the worst case is one extra round-trip of "peer pushes
// us a file we already have" the first time we connect, which DiffManifest
// will short-circuit by hash.
func (e *Engine) loadIndex() error {
	data, err := os.ReadFile(e.indexPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var f indexFile
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	if f.Entries == nil {
		return nil
	}
	e.mu.Lock()
	for p, fi := range f.Entries {
		e.index[p] = fi
	}
	e.mu.Unlock()
	return nil
}

// markIndexDirty schedules an asynchronous flush of the index. Multiple
// rapid mutations within indexFlushDelay coalesce to a single disk write.
// This is the right entry point for per-file mutations (sendFile,
// ApplyFile, ApplyDelete, SendDelete, PendingWrite.Commit, ...) where
// calling persistIndexNow directly would turn a workspace's initial
// sync into an O(n²) JSON serialise + atomic-rename storm.
//
// Caller MUST NOT hold e.mu. The function takes flushMu briefly and
// schedules a one-shot goroutine that sleeps, then snapshots+writes.
//
// Durability bound: a crash within indexFlushDelay of a mutation loses
// the unflushed state. The recovery path is the same as if the daemon
// had crashed during sendFile itself — next reconnect's manifest
// exchange picks up the gap.
func (e *Engine) markIndexDirty() {
	e.flushMu.Lock()
	e.indexDirty = true
	if e.flushScheduled {
		e.flushMu.Unlock()
		return
	}
	e.flushScheduled = true
	delay := e.flushDelay
	e.flushMu.Unlock()
	go func() {
		time.Sleep(delay)
		e.flushMu.Lock()
		e.indexDirty = false
		e.flushScheduled = false
		e.flushMu.Unlock()
		e.persistIndexNow()
	}()
}

// FlushIndex synchronously writes the index. Use at deliberate sync
// points where the caller needs disk durability immediately — Snapshot,
// session shutdown, before a tombstone-emitting manifest exchange.
// Clearing indexDirty here is best-effort: a still-pending debounce
// goroutine may run and do a redundant (no-op-equivalent) write, which
// is cheaper than coordinating to cancel it.
func (e *Engine) FlushIndex() {
	e.flushMu.Lock()
	e.indexDirty = false
	e.flushMu.Unlock()
	e.persistIndexNow()
}

// persistIndexNow writes the current index atomically (tmp + rename).
// MUST be called with e.mu UNLOCKED — it takes a short snapshot under
// its own lock and does disk IO after releasing.
//
// Direct calls are O(map size); high-frequency call sites (sendFile,
// ApplyFile, etc) should use markIndexDirty instead, which debounces
// multiple rapid mutations into a single flush. This entry point exists
// for sync points (Snapshot, session shutdown) where the caller wants
// disk durability without delay.
//
// Root-accessible gate: silent no-op when e.root has vanished or is
// no longer a directory. Without this, MkdirAll(e.root/.kari-engine)
// would helpfully recreate the workspace as an empty directory after
// a transient mount drop — and the next Snapshot would interpret
// "empty disk + populated index" as "user deleted everything" and
// propagate tombstones to the peer.
func (e *Engine) persistIndexNow() {
	if !e.rootAccessible() {
		return
	}
	// Serialize the disk-write phase. Two concurrent flushers (e.g. the
	// debounce goroutine and a sync FlushIndex from Snapshot) would
	// otherwise race on the same `.tmp` file path. We take this lock
	// AFTER snapshotting e.index so disk IO doesn't extend the hot-path
	// index critical section.
	e.mu.Lock()
	snap := make(map[string]FileInfo, len(e.index))
	for k, v := range e.index {
		snap[k] = v
	}
	e.mu.Unlock()

	e.indexWriteMu.Lock()
	defer e.indexWriteMu.Unlock()

	dir := filepath.Dir(e.indexPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("filesync: mkdir index dir: %v", err)
		return
	}
	f := indexFile{Version: 1, Entries: snap}
	data, err := json.Marshal(f)
	if err != nil {
		log.Printf("filesync: marshal index: %v", err)
		return
	}
	tmp := e.indexPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("filesync: write index: %v", err)
		return
	}
	if err := os.Rename(tmp, e.indexPath()); err != nil {
		log.Printf("filesync: rename index: %v", err)
	}
}
