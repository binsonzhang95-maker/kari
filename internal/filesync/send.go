package filesync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"os"
	"sort"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

// SendSnapshot pushes every known file in the workspace to the peer
// unconditionally (force=true). Used as legacy fallback when the peer
// doesn't speak manifest. New sessions start with manifest exchange;
// this only runs if the 2s fallback timer fires.
func (e *Engine) SendSnapshot(ctx context.Context, sender Sender) error {
	snapshot, err := e.Snapshot()
	if err != nil {
		return err
	}
	paths := make([]string, 0, len(snapshot))
	for path := range snapshot {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if err := e.sendFile(ctx, sender, path, true, 0, ""); err != nil {
			return err
		}
	}
	return nil
}

// SendPath converts an absolute filesystem path to a wire-form rel and
// pushes the current content. Used by sendLoop for fsnotify events.
func (e *Engine) SendPath(ctx context.Context, sender Sender, absPath string) error {
	rel, err := e.relative(absPath)
	if err != nil {
		return nil
	}
	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return e.SendDelete(sender, rel)
		}
		return err
	}
	if info.IsDir() {
		return nil
	}
	return e.SendFile(ctx, sender, rel)
}

// SendFile pushes one file by wire-form rel path. Normal hash-equal
// short-circuit applies.
func (e *Engine) SendFile(ctx context.Context, sender Sender, rel string) error {
	return e.sendFile(ctx, sender, rel, false, 0, "")
}

// SendFileForce is the exported "skip the hash-equal short-circuit"
// entry point used by the manifest-diff path: peer's manifest told us
// they need this file, so even if our local index already has the same
// hash (it does — we just took the manifest from that very index) we
// have to send the bytes. Without this, the manifest exchange would
// degrade into a no-op for warm sessions.
func (e *Engine) SendFileForce(ctx context.Context, sender Sender, rel string) error {
	return e.sendFile(ctx, sender, rel, true, 0, "")
}

// SendFileResumable is SendFileForce plus byte-offset resume support.
// If partialBytes > 0 and partialEtag matches sha256(source[:partialBytes])
// — i.e. the peer's staging file really is the first partialBytes bytes
// of the file we're about to send — we Seek to that offset and emit
// MessageFileMeta{Offset: partialBytes}. Mismatch (source has been
// rewritten since the peer's last attempt) demotes to full retransmit
// with Offset=0 so the receiver knows to truncate and start over.
func (e *Engine) SendFileResumable(ctx context.Context, sender Sender, rel string, partialBytes int64, partialEtag string) error {
	return e.sendFile(ctx, sender, rel, true, partialBytes, partialEtag)
}

func (e *Engine) sendFile(ctx context.Context, sender Sender, rel string, force bool, peerPartialBytes int64, peerPartialEtag string) error {
	rel = cleanRel(rel)
	// Engine state files never cross the wire — bail before we even
	// check the index so a fast rescan doesn't spam the sendLoop.
	if isInternalStatePath(rel) {
		return nil
	}
	if e.shouldIgnore(rel, false) {
		return e.SendDelete(sender, rel)
	}
	abs := absFromRel(e.root, rel)
	info, err := statFile(e.root, rel)
	if err != nil {
		if os.IsNotExist(err) {
			return e.SendDelete(sender, rel)
		}
		return err
	}

	e.mu.Lock()
	if suppressed := e.suppressedHash[rel]; suppressed != "" && suppressed == info.Hash {
		delete(e.suppressedHash, rel)
		e.index[rel] = info
		e.mu.Unlock()
		e.markIndexDirty()
		return nil
	}
	old, hadPrev := e.index[rel]
	if !force && hadPrev && sameContent(old, info) {
		// Bytes-exact match, or EOL-only diff on a text file: don't
		// re-send. Size check would be redundant for the byte-exact
		// case and actively wrong for EOL-only (sizes differ by the
		// CR-byte count), so it's gone.
		e.mu.Unlock()
		return nil
	}
	prevTomb, hadTomb := e.tombstones[rel]
	info.Version = info.ModTime
	// Optimistic update: write the new index entry before transmission
	// starts. This stops concurrent rescans from re-queueing the same
	// path while the send is mid-flight (a 2 minute large-file transfer
	// at a 30 second rescan tick would otherwise enqueue itself 4 times).
	// If transmission fails at any point below, the rollback closure
	// puts the index back to (old, prevTomb) so the next rescan does
	// flag the file as changed and we retry.
	e.index[rel] = info
	if hadTomb {
		delete(e.tombstones, rel)
	}
	e.mu.Unlock()
	if hadTomb {
		e.persistTombstones()
	}
	e.markIndexDirty()

	rollback := func() {
		e.mu.Lock()
		if hadPrev {
			e.index[rel] = old
		} else {
			delete(e.index, rel)
		}
		if hadTomb {
			e.tombstones[rel] = prevTomb
		}
		e.mu.Unlock()
		if hadTomb {
			e.persistTombstones()
		}
		e.markIndexDirty()
		// PR2 Phase 1 commit 4: rollback closure runs on send-path
		// failure (file-open / read / chunk-encode errors). Specific
		// err isn't threaded into the closure; generic message
		// suffices to flip Desktop's project card to `failed`. Real
		// err details still land in server-side logs.
		e.transferAbort(rel, "up", "upload aborted (send error)")
	}

	file, err := os.Open(abs)
	if err != nil {
		rollback()
		return err
	}
	defer file.Close()

	// runningHash accumulates sha256 of every byte that will be on the
	// receiver's view of the file once Commit lands — both the prefix
	// the receiver already has on disk (resume path) and the chunks we
	// stream below. file_done's Hash field uses this value, NOT
	// info.Hash, so a writer racing the chunk loop on our side can no
	// longer cause a recipient-side `hash mismatch` failure: the hash
	// we claim always equals the bytes we actually sent. See receive.go
	// PendingWrite.Commit which compares its own running hash to ours.
	runningHash := sha256.New()

	// Resume protocol: peer told us they already have peerPartialBytes
	// on disk. Single-pass verify-and-fold: io.CopyN reads the prefix
	// bytes from our MAIN file handle (advancing the position to
	// peerPartialBytes so chunk reads below start at the suffix) AND
	// feeds them into runningHash. We then digest the same runningHash
	// state and compare to the peer's etag. This avoids:
	//   (a) the 2× disk read on large partials (10GB partial would
	//       otherwise be scanned twice — once to verify the etag,
	//       once to fold into the running hash);
	//   (b) the TOCTOU window where the etag-verify pass would see
	//       bytes A (matched peer's etag) but a later hash-fold pass
	//       would see bytes A' (file rewritten in between), so our
	//       file_done hash would cover prefix A' || chunks while the
	//       receiver replayed prefix A from staging — same hash-
	//       mismatch failure mode we're trying to remove.
	// On mismatch (peer's staging is stale relative to current disk,
	// or partial read fails) demote to a full retransmit: reset the
	// running hash and rewind so chunks below cover bytes 0..EOF.
	offset := int64(0)
	if peerPartialBytes > 0 && peerPartialBytes < info.Size {
		n, cerr := io.CopyN(runningHash, file, peerPartialBytes)
		if cerr == nil && n == peerPartialBytes &&
			hex.EncodeToString(runningHash.Sum(nil)) == peerPartialEtag {
			offset = peerPartialBytes
		} else {
			runningHash = sha256.New()
			if _, serr := file.Seek(0, io.SeekStart); serr != nil {
				rollback()
				return wrapSend(serr)
			}
		}
	}

	if err := sender.Send(&transport.Message{
		Type:    transport.MessageFileMeta,
		Origin:  e.origin,
		Path:    rel,
		Size:    info.Size,
		ModTime: info.ModTime,
		Hash:    info.Hash,
		Version: info.Version,
		Offset:  offset,
	}); err != nil {
		rollback()
		return wrapSend(err)
	}
	// Track the outbound transfer so the Workbench can show progress.
	// Start counter at `offset` (we skipped those bytes).
	e.transferBegin(rel, "up", info.Size, offset > 0)
	if offset > 0 {
		e.transferProgress(rel, "up", offset)
	}

	// One ChunkSize buffer reused for the lifetime of the send. Safe to
	// reuse because SecureSyncClient.Send (internal/transport/protocol.go)
	// calls encryptMessage synchronously and mustMarshal copies the
	// envelope before the underlying gRPC Send returns — so by the time
	// we loop back around to overwrite `buf`, the wire copy is already
	// taken. Previously we did `append([]byte(nil), buf[:n]...)` per
	// chunk, which doubled per-chunk allocation and was a meaningful
	// contributor to the 10 GB RSS on large-folder syncs.
	buf := make([]byte, ChunkSize)
	var chunk int64
	for {
		if err := ctx.Err(); err != nil {
			rollback()
			return err
		}
		n, readErr := file.Read(buf)
		if n > 0 {
			// Fold into runningHash BEFORE sending so a sender.Send
			// failure on this chunk still leaves runningHash in a
			// state that matches what already reached the wire (none,
			// in that case — we abort here without sending file_done).
			runningHash.Write(buf[:n])
			if err := sender.Send(&transport.Message{
				Type:       transport.MessageFileChunk,
				Origin:     e.origin,
				Path:       rel,
				ChunkIndex: chunk,
				Data:       buf[:n],
			}); err != nil {
				rollback()
				return wrapSend(err)
			}
			e.transferProgress(rel, "up", int64(n))
			chunk++
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			rollback()
			return readErr
		}
	}
	// file_done.Hash is the running hash of bytes ACTUALLY SENT (prefix
	// the receiver replays + chunks we streamed), NOT info.Hash from
	// the stat-time read. This guarantees the receiver's Commit hash
	// check always matches: their hash covers the same byte range we
	// just hashed. If the source file was rewritten between
	// statFile(line 95) and the chunk-read loop above (the
	// build-artifact churn race), info.Hash would be stale; the value
	// here is not.
	if err := sender.Send(&transport.Message{
		Type:    transport.MessageFileDone,
		Origin:  e.origin,
		Path:    rel,
		Hash:    hex.EncodeToString(runningHash.Sum(nil)),
		Version: info.Version,
	}); err != nil {
		rollback()
		return wrapSend(err)
	}
	e.transferComplete(rel, "up")
	// Tell the local UI that this file is now durably synced (the peer will
	// emit its own file_status on apply, which we'll forward as `synced`).
	// Past this point we DON'T rollback — file_done has been written to the
	// wire. If the peer subsequently fails to apply the file, recvLoop will
	// catch the FileStatusError envelope and re-mark the path dirty via
	// session.queueRetryAfterPeerError (which clears index hash so the next
	// rescan re-detects the change).
	_ = sender.Send(&transport.Message{
		Type:   transport.MessageFileStatus,
		Origin: e.origin,
		Path:   rel,
		Stream: transport.FileStatusSynced,
	})
	if isIgnoreControlFile(rel) {
		if err := e.pruneIgnoredTrackedFiles(sender); err != nil {
			return err
		}
	}
	return nil
}

// SendDelete marks a path as removed in the local engine and pushes a
// MessageDelete to the peer so they can mirror the removal. When the
// engine is in suppress-outbound-deletes mode (staging-bind session),
// the local tombstone bookkeeping still happens — that's local engine
// state and unrelated to the wire — but the MessageDelete envelope is
// dropped. This is the engine-layer half of the contract Session.
// SetSuppressOutboundDeletes pins; without it the .gitignore-prune
// cascade and the sendFile-missing-file fallback would emit deletes
// the Session-layer gates can't see.
func (e *Engine) SendDelete(sender Sender, rel string) error {
	rel = cleanRel(rel)
	now := time.Now().UnixNano()
	e.mu.Lock()
	delete(e.index, rel)
	e.tombstones[rel] = now
	e.mu.Unlock()
	e.persistTombstones()
	e.markIndexDirty()
	if e.outboundDeletesSuppressed() {
		log.Printf("engine: SendDelete suppressed for path=%q (staging session — engine-layer gate)", rel)
		return nil
	}
	return wrapSend(sender.Send(&transport.Message{
		Type:    transport.MessageDelete,
		Origin:  e.origin,
		Path:    rel,
		Version: now,
	}))
}

// EmitStatus is a small helper Session uses to push file_status to the peer.
// Callers don't reach into transport types directly.
func (e *Engine) EmitStatus(sender Sender, rel, status string) {
	_ = sender.Send(&transport.Message{
		Type:   transport.MessageFileStatus,
		Origin: e.origin,
		Path:   cleanRel(rel),
		Stream: status,
	})
}

// statFile returns FileInfo for a wire-form relative path by stat-ing
// the corresponding OS path under e.root.
func statFile(root, rel string) (FileInfo, error) {
	abs := absFromRel(root, cleanRel(rel))
	info, err := os.Stat(abs)
	if err != nil {
		return FileInfo{}, err
	}
	rawHash, normHash, size, err := computeFileHashes(abs, rel)
	if err != nil {
		return FileInfo{}, err
	}
	return FileInfo{
		Path:     rel,
		Size:     size,
		ModTime:  info.ModTime().UnixNano(),
		FileID:   fileID(info),
		Hash:     rawHash,
		NormHash: normHash,
	}, nil
}

// hashFile returns the hex-encoded SHA-256 and byte count of a file.
func hashFile(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	h := sha256.New()
	size, err := io.Copy(h, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

// hashChunks combines a set of in-memory chunks into a single hash.
// Used by the legacy buffered ApplyFile path.
func hashChunks(chunks [][]byte) (string, int64) {
	h := sha256.New()
	var size int64
	for _, chunk := range chunks {
		n, _ := h.Write(chunk)
		size += int64(n)
	}
	return hex.EncodeToString(h.Sum(nil)), size
}
