package filesync

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// PendingWrite is the streaming-receive counterpart to ApplyFile. Instead
// of buffering every chunk in `[][]byte` until file_done arrives — which
// was the 10 GB-RSS bug on large transfers — chunks land straight in a
// .kari-incoming staging file as they're received. Memory cost stays at
// O(ChunkSize) per inflight file, regardless of total bytes. The staging
// file also survives session disconnect, setting up byte-offset resume.
type PendingWrite struct {
	engine     *Engine
	meta       *transport.Message
	rel        string // wire form
	target     string // OS abs
	tmpPath    string
	f          *os.File
	hash       hash.Hash
	written    int64
	chunkCount int
}

// BeginReceive opens (or for resume, re-opens) the staging file for an
// inbound transfer. Returns (nil, nil) when the path should bypass the
// streaming path entirely — proposal-router targets and gitignore-matched
// paths fall back to the legacy buffered ApplyFile path in the caller.
// Errors include ErrPathEscapesRoot (fatal at the session layer) and
// any os.* error from MkdirAll/Create (non-fatal per file).
//
// Honours meta.Offset: zero means start-of-file (truncate any existing
// staging file); non-zero means resume — open in append mode and replay
// the on-disk bytes into the running hash so the eventual Commit can
// still verify against the sender's whole-file Hash.
func (e *Engine) BeginReceive(meta *transport.Message) (*PendingWrite, error) {
	rel := cleanRel(meta.Path)
	target := absFromRel(e.root, rel)
	if !isInside(e.root, target) {
		return nil, fmt.Errorf("%w: %s", ErrPathEscapesRoot, meta.Path)
	}
	// Peer should never be sending us protocol-internal paths; if it
	// somehow happens (malformed peer, bug), drop silently — applying
	// them would corrupt our own engine state.
	if isInternalStatePath(rel) {
		return nil, nil
	}
	if e.proposalRouter != nil && isProposalRel(rel) {
		return nil, nil
	}
	if e.shouldIgnore(rel, false) {
		return nil, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return nil, err
	}
	tmpPath := target + internalStagingSuffix
	h := sha256.New()
	var written int64
	var f *os.File
	var err error
	if meta.Offset > 0 {
		// Resume path: replay bytes-on-disk into the hash, then open
		// in append mode for subsequent chunks. If anything looks off
		// (file shorter than Offset, can't open, hash read fails), fall
		// through to a clean truncate-and-restart. Sender confirmed
		// the etag matched before sending Offset>0, so the prefix is
		// trusted — but be defensive against on-disk corruption.
		f, err = os.OpenFile(tmpPath, os.O_RDWR, 0o644)
		if err == nil {
			st, sterr := f.Stat()
			if sterr == nil && st.Size() >= meta.Offset {
				_, _ = f.Seek(0, io.SeekStart)
				n, rerr := io.CopyN(h, f, meta.Offset)
				if rerr == nil && n == meta.Offset {
					if _, serr := f.Seek(meta.Offset, io.SeekStart); serr == nil {
						_ = f.Truncate(meta.Offset)
						written = meta.Offset
						goto ready
					}
				}
			}
			f.Close()
		}
		// Fall-through: resume failed, start over.
		h = sha256.New()
		written = 0
	}
	f, err = os.Create(tmpPath)
	if err != nil {
		return nil, err
	}
ready:
	// Now-live partials entry will be cleared by Commit on success.
	// Surface the inbound transfer to the Workbench. Resume bit fires
	// only when we actually picked up an existing prefix.
	e.transferBegin(rel, "down", meta.Size, written > 0)
	if written > 0 {
		e.transferProgress(rel, "down", written)
	}
	return &PendingWrite{
		engine:  e,
		meta:    meta,
		rel:     rel,
		target:  target,
		tmpPath: tmpPath,
		f:       f,
		hash:    h,
		written: written,
	}, nil
}

// Write appends a chunk to the staging file and folds it into the
// running hash. Every 64 chunks (~16 MB at 256 KB ChunkSize) it fsyncs
// so a process crash before Commit doesn't lose more than that amount
// of work — resume picks up from the next sync point.
func (pw *PendingWrite) Write(data []byte) error {
	n, err := pw.f.Write(data)
	if err != nil {
		return err
	}
	pw.hash.Write(data[:n])
	pw.written += int64(n)
	pw.chunkCount++
	pw.engine.transferProgress(pw.rel, "down", int64(n))
	if pw.chunkCount%64 == 0 {
		_ = pw.f.Sync()
	}
	return nil
}

// Commit finalises a fully-received file. Verifies the running hash
// against the sender's claimed final hash, atomically renames the
// staging file to its target, updates the engine's index and tombstones,
// and (if the file is .gitignore itself) prunes newly-ignored siblings.
// Caller MUST NOT use the PendingWrite after Commit returns; the file
// handle is closed regardless of success or failure.
func (pw *PendingWrite) Commit(finalHash string, version int64) error {
	if err := pw.f.Sync(); err != nil {
		pw.f.Close()
		return err
	}
	if err := pw.f.Close(); err != nil {
		return err
	}
	actualHash := hex.EncodeToString(pw.hash.Sum(nil))
	if actualHash != finalHash {
		return fmt.Errorf("hash mismatch for %s: want %s got %s", pw.rel, finalHash, actualHash)
	}
	// Local-newer-mtime check: peer's copy is stale, keep ours, drop staging.
	if local, err := statFile(pw.engine.root, pw.rel); err == nil && local.ModTime > pw.meta.ModTime {
		_ = os.Remove(pw.tmpPath)
		pw.engine.mu.Lock()
		pw.engine.index[pw.rel] = local
		pw.engine.mu.Unlock()
		pw.engine.markIndexDirty()
		return nil
	}
	// Capture the pre-image before the rename clobbers it; this is the
	// daemon's hook for QuickDiffProvider to show gutter diff bars on
	// what just changed. No-op on the server (nil store).
	pw.engine.snapshotPreImage(pw.rel, pw.target)
	if err := os.Rename(pw.tmpPath, pw.target); err != nil {
		return err
	}
	mtime := time.Unix(0, pw.meta.ModTime)
	_ = os.Chtimes(pw.target, mtime, mtime)
	localFileID := ""
	if st, err := os.Stat(pw.target); err == nil {
		localFileID = fileID(st)
	}
	// Re-compute NormHash from the just-renamed target so the index
	// entry carries it forward; without this, the next manifest diff
	// against a peer would have an empty NormHash on our side and
	// would fall back to byte-exact Hash comparison, defeating the
	// CRLF/LF suppression for files we just received.
	_, normHash, _, _ := computeFileHashes(pw.target, pw.rel)

	pw.engine.mu.Lock()
	pw.engine.index[pw.rel] = FileInfo{
		Path:     pw.rel,
		Size:     pw.written,
		ModTime:  pw.meta.ModTime,
		FileID:   localFileID,
		Hash:     actualHash,
		NormHash: normHash,
		Version:  version,
	}
	pw.engine.suppressedHash[pw.rel] = actualHash
	hadTomb := false
	if _, ok := pw.engine.tombstones[pw.rel]; ok {
		delete(pw.engine.tombstones, pw.rel)
		hadTomb = true
	}
	// File now lives whole on disk — clear the partials entry so the
	// next manifest doesn't keep advertising a stale resume hint.
	delete(pw.engine.partials, pw.rel)
	pw.engine.mu.Unlock()
	pw.engine.transferComplete(pw.rel, "down")
	if hadTomb {
		pw.engine.persistTombstones()
	}
	pw.engine.markIndexDirty()
	if isIgnoreControlFile(pw.rel) {
		if err := pw.engine.pruneIgnoredTrackedFiles(nil); err != nil {
			return err
		}
	}
	return nil
}

// Discard tears down a PendingWrite that won't be Commit'd — hash
// mismatch, fatal recv error, or peer aborted mid-transfer. Removes
// the staging file from disk. Use Close() instead if you want the
// staging file to survive for resume on the next session.
func (pw *PendingWrite) Discard() {
	pw.f.Close()
	_ = os.Remove(pw.tmpPath)
	// PR2 Phase 1 commit 4: Discard is hash-mismatch / fatal-recv /
	// peer-abort path. Specific error string not threaded here (would
	// require API change across 3 callers in session.go); the
	// generic placeholder is enough for Desktop to derive `failed`
	// state. Threading the underlying err is a future-PR concern.
	pw.engine.transferAbort(pw.rel, "down", "download discarded (hash mismatch / abort)")
}

// Close releases the file handle without removing the staging file.
// Called at session shutdown so the partial file survives until the
// next reconnect, where the resume protocol picks it up.
func (pw *PendingWrite) Close() {
	pw.f.Close()
}

// Path returns the wire-form relative path this write targets. Useful
// for the session layer's error logs and EmitStatus calls.
func (pw *PendingWrite) Path() string {
	return pw.rel
}

// Written returns the number of bytes written so far, mirroring what
// would land in TransferState.BytesDone.
func (pw *PendingWrite) Written() int64 {
	return pw.written
}

// ApplyDelete removes a file from disk and adds a tombstone entry so
// the next manifest can tell the peer "I deleted this."
func (e *Engine) ApplyDelete(msg *transport.Message) error {
	rel := cleanRel(msg.Path)
	abs := absFromRel(e.root, rel)
	if !isInside(e.root, abs) {
		return fmt.Errorf("%w: %s", ErrPathEscapesRoot, msg.Path)
	}
	if isInternalStatePath(rel) {
		return nil
	}
	if e.proposalRouter != nil && isProposalRel(rel) {
		return e.proposalRouter.OnProposalDelete(rel, msg.Version)
	}
	if e.shouldIgnore(rel, false) {
		return nil
	}
	deleteVersion := msg.Version
	if deleteVersion == 0 {
		deleteVersion = time.Now().UnixNano()
	}
	if newer, err := directoryContainsNewerLocalEntry(e.root, rel, deleteVersion); err != nil {
		return err
	} else if newer {
		return nil
	}
	if local, err := statFile(e.root, rel); err == nil && local.ModTime > deleteVersion {
		return nil
	}
	// Snapshot pre-image so the diff view can show the deleted content
	// as the "before" half (left pane shows old, right pane is empty).
	e.snapshotPreImage(rel, abs)
	if err := os.RemoveAll(abs); err != nil {
		return err
	}
	e.mu.Lock()
	delete(e.index, rel)
	e.tombstones[rel] = deleteVersion
	e.mu.Unlock()
	e.persistTombstones()
	e.markIndexDirty()
	return nil
}

func directoryContainsNewerLocalEntry(root, rel string, deleteVersion int64) (bool, error) {
	abs := absFromRel(root, rel)
	info, err := os.Stat(abs)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, nil
	}
	if info.ModTime().UnixNano() > deleteVersion {
		return true, nil
	}
	found := false
	err = filepath.WalkDir(abs, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == abs {
			return nil
		}
		childRel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if isInternalStatePath(cleanRel(childRel)) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.ModTime().UnixNano() > deleteVersion {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	return found, nil
}

// ApplyFile is the legacy buffered apply path. Used for proposal-
// router targets and gitignore-matched paths whose BeginReceive
// returned (nil, nil). Normal sync paths use the streaming
// PendingWrite instead.
func (e *Engine) ApplyFile(meta *transport.Message, chunks [][]byte) error {
	rel := cleanRel(meta.Path)
	target := absFromRel(e.root, rel)
	if !isInside(e.root, target) {
		return fmt.Errorf("%w: %s", ErrPathEscapesRoot, meta.Path)
	}
	// Symmetric with BeginReceive: never write peer-claimed internal
	// state into our own engine state dir — that would clobber our tombstones.
	if isInternalStatePath(rel) {
		return nil
	}
	if e.proposalRouter != nil && isProposalRel(rel) {
		var buf []byte
		for _, c := range chunks {
			buf = append(buf, c...)
		}
		return e.proposalRouter.OnProposalFile(rel, buf, meta.Version)
	}
	if e.shouldIgnore(rel, false) {
		// The peer is sending us a file our local .gitignore says to
		// skip — drop it silently so both sides stay tidy.
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}

	remote := FileInfo{
		Path:    rel,
		Size:    meta.Size,
		ModTime: meta.ModTime,
		Hash:    meta.Hash,
		Version: meta.Version,
	}

	if local, err := statFile(e.root, rel); err == nil && local.ModTime > remote.ModTime {
		e.mu.Lock()
		e.index[rel] = local
		e.mu.Unlock()
		e.markIndexDirty()
		return nil
	}

	hash, size := hashChunks(chunks)
	if hash != remote.Hash || size != remote.Size {
		return fmt.Errorf("hash mismatch for %s", rel)
	}
	// Same hook as the streaming Commit path — snapshot before truncate.
	e.snapshotPreImage(rel, target)
	file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	for _, chunk := range chunks {
		if _, err := file.Write(chunk); err != nil {
			file.Close()
			return err
		}
	}
	if err := file.Close(); err != nil {
		return err
	}
	mtime := time.Unix(0, remote.ModTime)
	_ = os.Chtimes(target, mtime, mtime)
	if st, err := os.Stat(target); err == nil {
		remote.FileID = fileID(st)
	}
	// Mirror the streaming Commit path: stamp NormHash from disk so
	// future manifest diffs against peers don't fall back to byte-
	// exact comparison just because we received over the in-memory
	// chunks path.
	_, remote.NormHash, _, _ = computeFileHashes(target, rel)

	e.mu.Lock()
	e.index[rel] = remote
	e.suppressedHash[rel] = remote.Hash
	// File is live again — clear any stale tombstone or future manifest
	// diffs would mistake this resurrection for a delete-in-progress.
	hadTomb := false
	if _, ok := e.tombstones[rel]; ok {
		delete(e.tombstones, rel)
		hadTomb = true
	}
	e.mu.Unlock()
	if hadTomb {
		e.persistTombstones()
	}
	e.markIndexDirty()
	if isIgnoreControlFile(rel) {
		if err := e.pruneIgnoredTrackedFiles(nil); err != nil {
			return err
		}
	}
	return nil
}

// pruneIgnoredTrackedFiles is called after a .gitignore update to
// remove any files whose new ignore rules now exclude them from sync.
func (e *Engine) pruneIgnoredTrackedFiles(sender Sender) error {
	matcher := e.ignoreMatcher()
	forceAllow := e.forceAllowSnapshot()
	e.mu.Lock()
	candidates := make([]string, 0, len(e.index))
	for rel := range e.index {
		if rel == IgnoreFile {
			continue
		}
		if shouldIgnoreWithMatcher(rel, false, matcher, forceAllow) {
			candidates = append(candidates, rel)
		}
	}
	e.mu.Unlock()
	sort.Strings(candidates)
	for _, rel := range candidates {
		abs := absFromRel(e.root, rel)
		if info, err := os.Stat(abs); err == nil {
			if info.IsDir() {
				continue
			}
			if err := os.Remove(abs); err != nil {
				return err
			}
		}
		e.mu.Lock()
		delete(e.index, rel)
		e.tombstones[rel] = time.Now().UnixNano()
		e.mu.Unlock()
		e.persistTombstones()
		e.markIndexDirty()
		// Same suppress contract as Engine.SendDelete — the
		// .gitignore-prune cascade is exactly the path codex sub-
		// commit-C review flagged as bypassing the Session-level
		// gates. Local tombstone bookkeeping above still runs;
		// only the wire-side MessageDelete is dropped.
		if sender != nil && !e.outboundDeletesSuppressed() {
			if err := sender.Send(&transport.Message{
				Type:    transport.MessageDelete,
				Origin:  e.origin,
				Path:    rel,
				Version: time.Now().UnixNano(),
			}); err != nil {
				return wrapSend(err)
			}
		}
	}
	return nil
}
