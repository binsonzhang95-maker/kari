package filesync

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/gitutil"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

const ChunkSize = 256 * 1024

// ErrPathEscapesRoot is returned by Apply* when a peer-supplied path would
// resolve outside the workspace root after cleanRel + absFromRel. It's a
// sentinel so session-level error classification can flag it fatal —
// a peer that's sending unsafe paths is either compromised or running
// incompatible code; either way, this is not a single-file mishap.
var ErrPathEscapesRoot = errors.New("path escapes sync root")

// ErrStreamBroken wraps errors returned from sender.Send so the session
// layer can tell "the wire is dead" apart from "this one file is bad."
// Without this, sendLoop has no principled way to distinguish a single
// file fsnotify event for a deleted file (non-fatal) from a TCP reset
// mid-chunk (fatal): both surface as the same Go error type. With it,
// per-file errors get logged and skipped, while stream errors tear
// down so the daemon's reconnect loop can rebuild a fresh session.
var ErrStreamBroken = errors.New("sync stream broken")

// wrapSend marks any error returned by Sender.Send so callers up the
// stack can classify it as stream-level. We keep the original error in
// the chain (%w) so log lines still show the real reason — useful when
// debugging a hung peer or a misbehaving cmux/Caddy in front.
func wrapSend(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %w", ErrStreamBroken, err)
}

// Sender is the minimal interface engine methods need to push messages
// onto a sync stream. MemorySender in tests, SecureSyncClient in prod.
type Sender interface {
	Send(*transport.Message) error
}

// Engine is the per-workspace filesystem model and the central object
// in the filesync package. One engine lives on each side of the wire
// (client daemon and trans-server), with the same origin-agnostic logic.
//
// For a file listing of public API, see:
//
//	send.go     — SendFile, SendPath, SendSnapshot, SendDelete, EmitStatus
//	receive.go  — ApplyFile, ApplyDelete, BeginReceive (streaming receive)
//	manifest.go — FileInfo, Manifest, DiffManifest
//	watch.go    — Watch, scan, Snapshot, scanTransTmp, gcTransTmp
//	paths.go    — Path helpers (cleanRel, absFromRel, isInternalStatePath)
//	transfer.go — TransferRow + UI progress tracking
//	tombstones.go — Tombstone persistence (loadTombstones, persistTombstones)
type Engine struct {
	root           string
	origin         string
	mu             sync.Mutex
	scanMu         sync.Mutex
	index          map[string]FileInfo
	tombstones     map[string]int64
	suppressedHash map[string]string
	forceAllow     map[string]ForceAllowEntry
	proposalRouter ProposalRouter
	// partials caches staging-file state discovered at startup so the
	// next manifest can advertise byte-offset resume points to the
	// peer. Keyed by wire-form rel of the target file (not the .tmp).
	// Mutates under mu just like the other maps above.
	partials map[string]Partial
	// transfers tracks live per-file progress for the Workbench panel:
	// keyed by `<dir>:<path>` where dir is "up" (we're sending) or
	// "down" (we're receiving). Completion entries linger for 3 s so
	// the UI shows the "done" state at least one poll cycle before
	// they disappear. Mutates under mu.
	transfers map[string]*TransferRow
	// incomingHistory captures the pre-image bytes of every file an
	// inbound sync is about to overwrite or delete. Nil on the server
	// (no UI consumer); set on the daemon by SetIncomingHistoryStore so
	// the VS Code extension's QuickDiffProvider can render gutter bars.
	incomingHistory IncomingHistoryStore
	// ackWaiters lets callers block until the peer acknowledges that a
	// file we sent has been fully applied on their side. Used by the
	// drop-image-into-pty flow: PtyAttach copies the image into the
	// workspace and must not emit the remote path back to the terminal
	// until the server confirms the file landed, otherwise the CLI on
	// the remote reads a missing path. Channels close on ack.
	ackMu      sync.Mutex
	ackWaiters map[string][]chan struct{}
	// flushMu guards indexDirty/flushScheduled/flushDelay; see
	// markIndexDirty. Separate from e.mu so the debounce machinery
	// doesn't extend the hot-path index lock's critical section.
	flushMu        sync.Mutex
	indexDirty     bool
	flushScheduled bool
	// flushDelay is the debounce window for markIndexDirty. Per-engine
	// (not a package var) so concurrent test cases can override it
	// without racing the production default. Seeded to
	// defaultIndexFlushDelay in New.
	flushDelay time.Duration
	// indexWriteMu serialises the on-disk write phase of
	// persistIndexNow. Without it, two concurrent flushers (e.g. the
	// debounce goroutine racing FlushIndex) would race on the same
	// `.tmp` file path — `os.WriteFile` is not safe under concurrent
	// callers writing to the same path. Separate from e.mu and flushMu
	// because the write happens after we've already released e.mu to
	// avoid extending the index critical section across disk IO.
	indexWriteMu sync.Mutex
	// tombstonesWriteMu has the same role for persistTombstones —
	// multiple senders/receivers can hit it concurrently (e.g.
	// pruneIgnoredTrackedFiles deletes inside a loop while a parallel
	// ApplyDelete also runs), and the `.tmp` write/rename pair must
	// not interleave.
	tombstonesWriteMu         sync.Mutex
	forceAllowWriteMu         sync.Mutex
	cacheHitTotal             atomic.Uint64
	cacheMissTotal            atomic.Uint64
	deepRescanFoundDriftTotal atomic.Uint64
	watcherEventDroppedTotal  atomic.Uint64
	// suppressOutboundDeletes mirrors the Session-level flag down to
	// the engine layer so SendDelete (called from sendFile fallback
	// and from pruneIgnoredTrackedFiles' .gitignore-prune cascade)
	// can refuse to emit MessageDelete on the wire. Session.
	// SetSuppressOutboundDeletes forwards into here. Without this
	// engine-side mirror, the .gitignore-prune path discovered in
	// codex sub-commit-C review would silently bypass all four
	// Session-level gates (production wipe gap). Mu-guarded.
	suppressOutboundDeletes bool
}

// ProposalRouter intercepts incoming changes targeting `.kari-proposals/`
// so the daemon can land them in a local pending review store rather
// than into the working tree. Optional; nil means "apply normally".
type ProposalRouter interface {
	OnProposalFile(rel string, content []byte, version int64) error
	OnProposalDelete(rel string, version int64) error
}

// SetProposalRouter installs (or removes when nil) a router. Safe to call
// before sessions start; not safe to swap mid-session.
func (e *Engine) SetProposalRouter(r ProposalRouter) {
	e.proposalRouter = r
}

// SetSuppressOutboundDeletes toggles outbound-MessageDelete suppression
// at the engine layer. Mirrors Session.SetSuppressOutboundDeletes;
// Session forwards into here. Used by staging-bind sessions so the
// .gitignore-prune cascade and SendDelete callers can't bypass the
// Session-level gates and propagate the Desktop-cleans-staging-dir
// deletion to the peer.
func (e *Engine) SetSuppressOutboundDeletes(v bool) {
	e.mu.Lock()
	e.suppressOutboundDeletes = v
	e.mu.Unlock()
}

// outboundDeletesSuppressed returns the current flag. Used by
// SendDelete and pruneIgnoredTrackedFiles at the moment they would
// otherwise emit MessageDelete.
func (e *Engine) outboundDeletesSuppressed() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.suppressOutboundDeletes
}

// New returns a ready-to-use Engine rooted at the given absolute path.
// Best-effort restore of prior tombstone state from
// .kari-engine/tombstones.json and a sweep of stale staging files.
func New(root, origin string) (*Engine, error) {
	if root == "" {
		return nil, errors.New("sync root is required")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	e := &Engine{
		root:           root,
		origin:         origin,
		index:          map[string]FileInfo{},
		tombstones:     map[string]int64{},
		suppressedHash: map[string]string{},
		forceAllow:     map[string]ForceAllowEntry{},
		partials:       map[string]Partial{},
		transfers:      map[string]*TransferRow{},
		ackWaiters:     map[string][]chan struct{}{},
		flushDelay:     defaultIndexFlushDelay,
	}
	// Best-effort load. A missing/corrupt file just means we start with
	// no tombstones — the worst case is one extra round-trip of "send
	// file → server replies with newer delete" the first time the peer
	// notices the gap. Not fatal, and certainly not worth refusing to
	// start the engine over.
	if err := e.loadTombstones(); err != nil {
		// log.Printf is in tombstones.go which is built into this
		// package; callers don't need to know about the file.
	}
	// Same best-effort contract for index.json: if it's missing or
	// corrupt, we start with an empty index. The cost is "the next
	// manifest exchange treats every file as new" (peer responds with
	// hash-equal short-circuit), not data loss. The benefit is that
	// when present, Snapshot can detect files that disappeared while
	// the daemon was down and emit tombstones for them — the offline-
	// delete fix.
	if err := e.loadIndex(); err != nil {
		// silent, see note above
	}
	if err := e.loadForceAllow(); err != nil {
		// silent: a corrupt allowlist should not prevent sync startup.
	}
	// Scan for resumable transfers and prune old ones. Both are
	// best-effort; failures just mean we start without resume hints
	// or with a few extra stale staging files.
	e.scanTransTmp()
	e.gcTransTmp(7 * 24 * time.Hour)
	return e, nil
}

// Root returns the absolute path of the workspace directory the engine
// is syncing.
func (e *Engine) Root() string {
	return e.root
}

// LocalRepoURL returns the workspace's git remote origin URL (or the
// repo-lock URL written by server-side bootstrap), or "" if neither is
// available. Used by Session to stamp manifest envelopes with our repo
// identity so the peer can detect a wrong-repo bootstrap before mass-
// pushing files at us.
func (e *Engine) LocalRepoURL() string {
	return gitutil.WorkspaceRepoURL(e.root)
}

type EngineCounters struct {
	CacheHitTotal             uint64 `json:"cache_hit_total"`
	CacheMissTotal            uint64 `json:"cache_miss_total"`
	DeepRescanFoundDriftTotal uint64 `json:"deep_rescan_found_drift_total"`
	WatcherEventDroppedTotal  uint64 `json:"watcher_event_dropped_total"`
}

func (e *Engine) Counters() EngineCounters {
	return EngineCounters{
		CacheHitTotal:             e.cacheHitTotal.Load(),
		CacheMissTotal:            e.cacheMissTotal.Load(),
		DeepRescanFoundDriftTotal: e.deepRescanFoundDriftTotal.Load(),
		WatcherEventDroppedTotal:  e.watcherEventDroppedTotal.Load(),
	}
}

// rootAccessible reports whether e.root currently exists and is a
// directory. The persistence helpers (persistIndex, persistTombstones)
// gate themselves on this before any MkdirAll: without the check, a
// transient "root vanished" condition would race with the next
// persistIndex call, which would MkdirAll the workspace back into
// existence as an empty directory. The next Snapshot would then see
// a present-but-empty root, decide every prior file was deleted, and
// emit a wave of tombstones — wiping the workspace on the peer. The
// guard makes the persistence layer fail-closed instead.
func (e *Engine) rootAccessible() bool {
	st, err := os.Stat(e.root)
	return err == nil && st.IsDir()
}

// WaitForUpAck registers a one-shot waiter for the peer's synced ack of
// rel. The returned channel closes when notifyUpAck is called for the
// same rel (or never, if no ack ever arrives — callers must combine
// with a timeout). Register before triggering a sync to avoid the race
// where the peer's ack arrives before we registered.
func (e *Engine) WaitForUpAck(rel string) <-chan struct{} {
	ch := make(chan struct{})
	e.ackMu.Lock()
	e.ackWaiters[rel] = append(e.ackWaiters[rel], ch)
	e.ackMu.Unlock()
	return ch
}

// notifyUpAck closes and removes all waiters registered for rel. Safe
// to call when there are no waiters.
func (e *Engine) notifyUpAck(rel string) {
	e.ackMu.Lock()
	waiters := e.ackWaiters[rel]
	delete(e.ackWaiters, rel)
	e.ackMu.Unlock()
	for _, ch := range waiters {
		close(ch)
	}
}

// cloneIndex returns a shallow copy of the index map for callers that
// need a snapshot under their own lock.
func cloneIndex(in map[string]FileInfo) map[string]FileInfo {
	out := make(map[string]FileInfo, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// RetryKind tells the session layer how to re-enqueue a path the peer
// reported a FileStatusError for. Live files go through the normal
// rescan/sendFile cycle (clear hash → next changedPaths flags →
// sendLoop resends). Tombstoned paths bypass rescan since they don't
// exist on disk — they must be queued as forced deletes.
type RetryKind int

const (
	RetryNoop RetryKind = iota
	RetryAsLive
	RetryAsDelete
)

// ClassifyForRetry inspects the engine state for rel and returns how the
// session should reschedule a retry. As a side-effect, if the path is
// classified as RetryAsLive, the index hash for rel is cleared so the
// next changedPaths() / scan diff flags it as changed even when nothing
// on disk has moved.
//
// Returned int64 is the tombstone version for RetryAsDelete (so the
// session can rebuild the same FileInfo it would have sent originally),
// 0 otherwise. Caller is responsible for calling persistIndex() after
// (this function takes the lock; persistIndex also takes the lock, so
// they must not nest).
func (e *Engine) ClassifyForRetry(rel string) (RetryKind, int64) {
	rel = cleanRel(rel)
	e.mu.Lock()
	defer e.mu.Unlock()
	if cur, ok := e.index[rel]; ok {
		// Both hashes get cleared: changedPaths now uses sameContent
		// which would treat a NormHash match as "no change", so wiping
		// just Hash is no longer enough to force the resend.
		cur.Hash = ""
		cur.NormHash = ""
		e.index[rel] = cur
		return RetryAsLive, 0
	}
	if v, ok := e.tombstones[rel]; ok {
		return RetryAsDelete, v
	}
	return RetryNoop, 0
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
