package filesync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/redact"
	"github.com/binsonzhang95-maker/kari/internal/transport"
)

type Stream interface {
	Send(*transport.Message) error
	Recv() (*transport.Message, error)
}

type workspaceIDProvider interface {
	WorkspaceID() string
}

type bootstrapProgressFunc = func(transport.BootstrapResult)

// downloadControlKind discriminates the two payloads carried over the
// shared downloadControlOut FIFO. Single channel means cancel and
// resume always reach the peer in the order they were enqueued, even
// though sendLoop's select normally has no order guarantee.
type downloadControlKind int

const (
	downloadControlCancel downloadControlKind = iota
	downloadControlResume
)

type downloadControl struct {
	kind          downloadControlKind
	workspaceName string
	reason        string // only meaningful for cancel
}

type Session struct {
	engine           *Engine
	stream           Stream
	pending          map[string]*pendingFile
	outbound         *outboundQueue
	mu               sync.Mutex
	onRemoteActivity func(string)
	onActivity       func()
	onManifest       func()
	onPeerManifest   func(int, string) // number of entries + repo URL in peer's manifest
	workspaceName    string
	clientID         string
	// bootstrapReq carries client → server "please git clone this
	// workspace" requests originating from the workbench UI. sendLoop
	// forwards them as MessageBootstrap envelopes. Buffered=1 because
	// concurrent bootstraps for the same workspace make no sense; the
	// daemon's HTTP layer serialises.
	bootstrapReq chan transport.BootstrapRequest
	// onBootstrapResult fires when the peer's MessageBootstrapResult
	// arrives. Service uses it to advance Status.LastBootstrap so the
	// extension can poll for completion.
	onBootstrapResult func(transport.BootstrapResult)
	// bootstrapHandler is the server-side counterpart. When non-nil
	// and recvLoop sees a MessageBootstrap, it spawns a goroutine that
	// calls this handler (which runs git clone — can take minutes).
	// The handler can emit pending progress and returns the final
	// result. Daemons leave this nil; cmd/server installs it.
	bootstrapHandler func(transport.BootstrapRequest, bootstrapProgressFunc) transport.BootstrapResult
	// bootstrapResOut carries the server's BootstrapResult back to the
	// peer. Drained by sendLoop so we never call stream.Send from two
	// goroutines at once. Buffered to absorb back-to-back results.
	bootstrapResOut chan transport.BootstrapResult
	// fallbackTimer fires manifestFallbackDelay after Hello if the
	// peer hasn't sent a MessageManifest by then. recvLoop's manifest
	// case Stop()s it so we don't run SendSnapshot redundantly on the
	// new-protocol path. Guarded by mu since Stop is called from a
	// goroutine other than the one that created it.
	fallbackTimer *time.Timer
	// listSessionsReq carries client → server requests for the list of
	// past Claude / Codex CLI sessions on the server. Buffered=1 because
	// the daemon's HTTP layer serializes one request at a time.
	listSessionsReq chan transport.ListSessionsRequest
	// listSessionsResOut carries the server's reply back to sendLoop so
	// stream.Send is never called from two goroutines at once. Buffered=4
	// just in case a slow sender lets two replies stack.
	listSessionsResOut chan transport.ListSessionsResult
	// listSessionsHandler runs server-side when MessageListSessions
	// arrives. Daemons leave it nil; cmd/server installs one. Synchronous
	// — the scan walks 3 dirs and returns in <100ms typical.
	listSessionsHandler func(transport.ListSessionsRequest) transport.ListSessionsResult
	// listSessionsWaiter is the single-slot daemon-side hand-off for the
	// next MessageListSessionsResult. Guarded by mu. Only one inflight
	// request at a time — RequestListSessions returns an error if the
	// slot is occupied (caller serializes).
	listSessionsWaiter chan transport.ListSessionsResult
	forceAllowReq      chan transport.ForceAllowRequest
	forceAllowResOut   chan transport.ForceAllowResult
	forceAllowHandler  func(transport.ForceAllowRequest) transport.ForceAllowResult
	forceAllowWaiter   chan transport.ForceAllowResult
	ptyCountUpdates    chan transport.PtyCountUpdate
	onPtyCountUpdate   func(transport.PtyCountUpdate)
	// localExecRequestOut carries server→daemon exec dispatch from
	// RouteLocalExec into sendLoop. Drained one-at-a-time so the wire
	// envelope marshal is serialised. Buffer absorbs short bursts of
	// concurrent MCP tool calls; overflow surfaces as a router error.
	localExecRequestOut chan transport.LocalExecRequest
	// localExecCancelOut carries server→daemon cancel envelopes. Sent
	// when the originating ctx is done, the bridge process exited, or
	// the user revoked the run. Best-effort; we never block on the
	// queue because a stuck cancel could wedge waiter teardown.
	localExecCancelOut chan transport.LocalExecCancel
	// localExecOutputOut carries daemon→server stdout/stderr chunks for
	// any in-flight exec. The runner's emit callback writes here;
	// sendLoop drains. Wider buffer than the others — long builds
	// produce many chunks in a row.
	localExecOutputOut chan transport.LocalExecOutput
	// localExecDoneOut carries daemon→server completion events. Exactly
	// one Done per request; small buffer is fine.
	localExecDoneOut chan transport.LocalExecDone
	// localExecHandler runs on the daemon side. nil for servers. When
	// set, recvLoop spawns a goroutine per MessageLocalExecRequest to
	// invoke it. SetLocalExecHandler must be called BEFORE Run because
	// the Hello-capability advertisement is decided once at session
	// startup; a handler installed mid-session won't be visible to the
	// peer. The emit callback is wired to localExecOutputOut so the
	// runner can stream chunks without touching the wire directly.
	localExecHandler func(ctx context.Context, req transport.LocalExecRequest, emit func(transport.LocalExecOutput)) transport.LocalExecDone
	// localExecActive tracks per-request cancel funcs on the daemon
	// side so MessageLocalExecCancel can abort the running goroutine.
	// Keyed by RequestID; entries are removed in the runner goroutine's
	// defer. mu-guarded.
	localExecActive map[string]context.CancelFunc
	// localExecWaiters lives on the server side: each in-flight
	// RouteLocalExec call registers a channel keyed by RequestID. recvLoop
	// delivers inbound Output/Done envelopes to the matching waiter and
	// closes+deletes it when Done lands. mu-guarded.
	localExecWaiters map[string]chan LocalExecEvent
	// fileStatusSyncedOut / fileStatusErrorOut serialize recvLoop's
	// per-path ack emissions through sendLoop instead of letting recvLoop
	// touch s.stream directly. Without this indirection, the gRPC
	// bidirectional stream's outbound HTTP/2 window can deadlock: a
	// long-blocked sendLoop.stream.Send (e.g. a ListSessions request
	// while the server-side handler is hung) wedges the same outbound
	// window that recvLoop's EmitStatus calls also write to, freezing
	// recvLoop on its very next ack — which stops it from draining
	// inbound, which closes the inbound flow-control window, which
	// stalls the peer's sender, which leaves a download hanging at 0
	// progress forever. Symptom observed in the wild: the wordpress /
	// kari-mobile copy downloads where active=1 from the first tick and
	// never advanced.
	//
	// Two channels because synced and error have different criticality:
	//   - synced is informational (UI feedback + sender's ackWaiter
	//     release for the UI's drop-image path). Lossy. Wide buffer,
	//     drop-on-full with an INFO log, recover via the next manifest
	//     exchange when sides re-diff.
	//   - error is a retry signal — see send.go MessageFileStatus
	//     handler; queueRetryAfterPeerError is what makes the sender
	//     re-mark dirty and re-push. Losing it means the sender thinks
	//     it succeeded and waits for the next watcher tick to notice
	//     divergence. Narrower buffer (errors should be rare), strong
	//     WARN log on drop so an operator can correlate the missing
	//     retry with later "file took a long time to appear" reports.
	//
	// Buffer sizing rationale:
	//   - synced: 128. Worst case is a burst of 128 successful inbound
	//     applies before sendLoop catches up — that's ~10s of a fast
	//     small-file stream on a single-stream link.
	//   - error: 32. Errors should be rare; 32 absorbs a brief peer-
	//     misbehaviour spike. Beyond 32 something is genuinely wrong
	//     and the WARN log fires.
	fileStatusSyncedOut chan *transport.Message
	fileStatusErrorOut  chan *transport.Message
	// downloadControlOut is a SINGLE FIFO channel carrying cancel and
	// resume control messages in caller order. Pre-fix these had
	// separate channels and sendLoop selected between them
	// non-deterministically — if an early-fired resume was still
	// queued and the user clicked cancel, the peer could observe
	// (cancel, then stale resume) and immediately re-enable outbound
	// (Codex round 5 ordering bug). Unifying into one channel makes
	// the wire order match the enqueue order exactly.
	//
	// Resume entries cause sendLoop to additionally emit a fresh
	// MessageManifest so the peer (server) can re-diff and re-enqueue
	// the files the recipient is still missing. Pre-fix resume only
	// flipped the stopped flag — the server's outbound queue had been
	// purged on cancel, so the post-resume queue was EMPTY and no
	// files ever flowed even though the task was running (Codex
	// round 5 blocking).
	//
	// Buffer 8 absorbs rapid-fire toggles; one cancel + one resume per
	// download task is the realistic upper bound.
	downloadControlOut chan downloadControl
	// outboundCtx + outboundCancel scope sendFile's per-chunk
	// cancellation independently of session lifetime. When peer sends
	// MessageCancelDownload, recvLoop calls outboundCancel(); the
	// currently-streaming sendFile aborts at its next ctx.Err() check
	// (already present in send.go's chunk loop and rollback path);
	// drainOutbound's next iteration reads a freshly-reset
	// outboundCtx so subsequent retries on a new download work
	// cleanly. sessCtx keeps heartbeat / recvLoop / unrelated
	// sendLoop cases running through the cancel — goal is to abort
	// the in-flight transfer, not tear down the session.
	// outboundCtxMu separate from mu to avoid deadlock: drainOutbound
	// reads outboundCtx on every task and we don't want to contend
	// with recvLoop's mu users on this hot path.
	//
	// outboundStopped is the sticky cancel flag set by cancelOutbound
	// and cleared only by resetOutbound (which fires on the next
	// MessageManifest from the peer). Without it, cancelOutbound's
	// fresh-ctx-on-cancel left a window where watcher-fired or
	// already-drained-batch follow-up tasks could pick up the new
	// live ctx and resume sending — Codex round 3 #1: cancel WAS not
	// sticky. Now: once stopped, drainOutbound returns nil + clears
	// the queue on every wakeup until a manifest exchange explicitly
	// resumes it. This matches the user-mental-model of "I cancelled,
	// don't push anything until I retry".
	outboundCtxMu   sync.Mutex
	outboundCtx     context.Context
	outboundCancel  context.CancelFunc
	outboundStopped bool
	// startPaused tells Run to enter stopped state immediately —
	// skip the initial MessageManifest send AND queue a Cancel to
	// the peer right away. Set by the syncd daemon when binding a
	// fresh session for a workspace whose download the user
	// previously cancelled. Cleared on the next user retry via
	// CreateSyncTask's clearDownloadPaused → next runOnce reads
	// false and starts a normal session. Guarded by mu (low-traffic
	// — set once before Run starts, never racing the outbound hot
	// path).
	startPaused bool
	// disablePauseGuard turns off applyManifestPause's empty-remote
	// uploads-paused branch. Set true by daemon for snapshot staging
	// binds where the remote dir is EXPECTED to be empty (that's the
	// whole point of the staging upload — push fresh content into a
	// clean dir). Without this flag the guard fires on every
	// snapshot upload (remote=0, local=N), pauses outbound, and the
	// 88 project files never get pushed; sync_task succeeds with
	// bytes counted from incidental .kari/ download traffic but
	// disk-side staging dir stays empty.
	// Set once before Run starts; mu-guarded for visibility ordering
	// with the recv loop's read in applyManifestPause.
	disablePauseGuard bool
	// controlOnly puts the session in OUTBOUND-suppressed mode while
	// trusting inbound from the server as authoritative. Active when set:
	//   OUTBOUND (all gated):
	//     - initial manifest send (don't advertise our possibly-stale state)
	//     - engine.Watch rescans + fallback SendSnapshot (no fsnotify push)
	//     - DiffManifest enqueue on incoming peer manifest (no
	//       toSendDeletes — the actual wipe-prevention)
	//   INBOUND (allowed — server is authoritative):
	//     - MessageFileMeta + chunks + done: new files from server
	//       flow into the working tree normally (cloud→local sync)
	//     - MessageDelete: server-authoritative delete propagates to
	//       local mirror normally (someone else deleted a file in cloud,
	//       local should reflect)
	//     - MessageTextOp: OT edits land normally
	//   INBOUND (still gated — these specifically re-arm outbound):
	//     - MessageFileStatus: peer-error → queueRetryAfterPeerError →
	//       could enqueue outbound delete. Drop to keep outbound dead.
	//     - MessageResumeDownload: would call resetOutbound, clearing
	//       the Run-entry outboundStopped flag and re-opening the outbound
	//       file plane. Drop to keep outbound dead.
	//
	// Used by the syncd daemon when a syncthing-backed workspace is bound
	// WITHOUT staging_id: legacy filesync bidirectional sync would diff
	// against an empty/marker-residue local working tree and wipe the
	// server-side materialized snapshot (the toDelete=89-after-commit
	// production bug). The wipe is ENTIRELY an outbound phenomenon —
	// daemon pushes deletes to server. Inbound from server to daemon is
	// not a wipe path: server is the cloud authority and its pushes are
	// reality (file added, file deleted, file changed). Sub-commit E
	// relaxes the original sub-commit-A paranoid "block everything both
	// directions" to "trust server, block our local fsnotify echoes."
	//
	// Must be set BEFORE Run. Mu-guarded for visibility ordering with the
	// recv loop's reads.
	controlOnly bool
	// suppressOutboundDeletes converts the session into a one-shot push
	// channel: outbound file SEND works normally, but every code path
	// that would generate a MessageDelete is gated off. Used by the
	// syncd daemon for SNAPSHOT STAGING binds (bind_kind=upload-staging /
	// download-staging) where the local staging dir is a transient
	// scratch space — Desktop deletes it after commitManifest succeeds
	// and the daemon's fsnotify watcher must NOT interpret that cleanup
	// as "user wants the server-side workspace deleted too." That was
	// the production wipe path: upload succeeds → server materializes
	// 89 files → Desktop deletes daemon's local staging → daemon
	// watcher cascades 89 MessageDelete to server → server wipes the
	// just-materialized workspace.
	//
	// Three sources of outbound deletes are gated:
	//   1. fsnotify watcher event for a missing file (SendPath →
	//      SendDelete fallback in engine/send.go) — gated in
	//      sendOutboundTask via pre-stat
	//   2. DiffManifest's toSendDeletes enqueue loop in MessageManifest
	//      handler — gated at the enqueue site
	//   3. queueRetryAfterPeerError's RetryAsDelete enqueue — gated
	//      at the enqueue site
	//
	// Inbound traffic (peer pushing files / deletes to us) is NOT
	// affected by this flag — that's control-only's domain. The two
	// flags are orthogonal: control-only is full-plane isolation,
	// suppressOutboundDeletes is a narrow outbound-delete gate for
	// sessions that LEGITIMATELY send files (snapshot upload) but
	// must never propagate local cleanups as deletes.
	//
	// Must be set BEFORE Run. Mu-guarded.
	suppressOutboundDeletes bool
	// onHandshakeAck fires the first time recvLoop accepts a MessageHello
	// from the peer. The daemon wires this to setConnected(true) so the
	// "已连接到 trans-server" event waits for a real round-trip instead of
	// firing on the lazy grpc.NewClient + NewStream path that succeeds
	// even when the server is unreachable. Mu-guarded; cleared on first
	// fire so duplicate hellos (server's handler ack + Run-init hello)
	// don't double-trigger.
	onHandshakeAck    func()
	handshakeAckFired bool
	// pauseReason explains why outbound uploads are suspended (empty
	// peer workspace, repo URL mismatch). Empty string = not paused.
	// Read by Service.Status() for surfacing in the workbench. The
	// outbound queue's own atomic flag is the actual enqueue gate; this
	// field is purely human-readable explanation. Guarded by mu.
	pauseReason string

	// recvObserver fires after each successful stream.Recv (before
	// dispatch). Wired by cmd/server's Sync handler to call
	// lease.Touch — every received message is evidence the peer is
	// still alive, which keeps the lease's 105s absolute timeout
	// from firing on an actively-communicating session. Decoupled
	// from filesync's own logic so the hook can also serve other
	// observers (status / metrics) if needed later. Mu-guarded.
	recvObserver func()
}

// pendingFile tracks one in-flight inbound transfer. Three modes:
//   - pw != nil      : streaming. Chunks go straight to disk via
//     PendingWrite, no in-memory accumulation. Normal sync path.
//   - pw == nil + !drop : legacy buffering. Used for proposal-router
//     targets where BeginReceive returns (nil, nil) by design.
//     Chunks accumulate in `chunks` until file_done lands, then
//     ApplyFile applies them in bulk. Memory cost stays tolerable
//     because proposals are small.
//   - drop == true    : path matched .gitignore/.kariignore — chunks
//     are discarded on arrival without buffering, file_done acks
//     FileStatusSynced to silence peer's "you need this" retries,
//     and NO noteActivity (nothing committed to disk → must not
//     fool the sync-task plateau path into thinking we caught up).
//     Codex round 9 #1: pre-fix ignored paths fell through to the
//     legacy-buffered branch which appended every chunk into RAM
//     before drop, wasting bandwidth AND memory.
type pendingFile struct {
	meta   *transport.Message
	pw     *PendingWrite
	chunks [][]byte
	drop   bool
}

// SetStartPaused marks the session so that Run, before sending the
// initial manifest, will enter outboundStopped state AND queue a
// MessageCancelDownload to the peer. Must be called BEFORE Run.
// Used by the syncd daemon when re-binding a session for a
// workspace whose download the user previously cancelled — without
// this, the new session would re-send manifest, the peer would
// DiffManifest + enqueue, and a few files could leak through before
// our async QueueCancelDownload reached the peer.
func (s *Session) SetStartPaused(paused bool) {
	s.mu.Lock()
	s.startPaused = paused
	s.mu.Unlock()
}

// SetDisablePauseGuard turns off applyManifestPause's empty-remote
// guard for this session. Must be called BEFORE Run.
//
// Used by the syncd daemon for SNAPSHOT STAGING binds
// (bind_kind=upload-staging / download-staging). For those, the
// remote staging dir is EXPECTED to be empty — that's the whole
// point of the snapshot pipeline (push fresh content into a clean
// dir for atomic commit). Without this flag the pause guard at
// applyManifestPause:885 fires on every staging upload: it sees
// remote=0 + local=N → pauses outbound → no project files actually
// transfer (sync_task reports bytes from incidental .kari/ download
// traffic but never the 88 project files we wanted to push).
//
// Workspace binds (bind_kind=workspace or unset) keep the guard
// active — there the empty-remote signal really does mean "operator
// hasn't bootstrapped yet, don't blindly push to an empty cloud."
func (s *Session) SetDisablePauseGuard(disabled bool) {
	s.mu.Lock()
	s.disablePauseGuard = disabled
	s.mu.Unlock()
}

// SetControlOnly toggles control-only mode. See the controlOnly field
// doc for the full contract.
//
// CONTRACT: set ONCE, BEFORE Run. Do not toggle live.
//
// Why "before Run": Run captures the flag into a local once and uses
// it to decide whether to start the engine.Watch goroutine and the
// manifest-fallback timer. Those subsystems do not re-read the flag,
// so a setter call after Run would not stop them from spinning up.
//
// Why "do not toggle live": recvLoop reads the flag fresh in three
// places:
//   - MessageManifest: skips applyManifestPause + DiffManifest + the
//     onPeerManifest hook (pure outbound suppression — the diff would
//     enqueue outbound deletes against our possibly-stale local state).
//   - MessageFileStatus: defensive drop — peer-status-error would
//     re-arm outbound via queueRetryAfterPeerError's RetryAsDelete
//     enqueue (also gated by sub-commit C's engine-layer suppress,
//     belt-and-suspenders here).
//   - MessageResumeDownload: defensive drop — resetOutbound would
//     clear the Run-entry outboundStopped flag and re-open the
//     outbound file plane.
//
// Run-entry captured paths (Watch / fallback / initial manifest) and
// per-message paths could disagree if toggled mid-flight. Production
// sets once based on bind metadata and leaves it.
func (s *Session) SetControlOnly(v bool) {
	s.mu.Lock()
	s.controlOnly = v
	s.mu.Unlock()
}

// IsControlOnly returns the current control-only flag. Safe to call any
// time; used by Service.Status() reflection so the daemon can surface
// "control-only" in /v1/status, and by tests to assert the wire-up from
// runOnce's bind.SyncBackend+StagingID predicate.
func (s *Session) IsControlOnly() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.controlOnly
}

// SetSuppressOutboundDeletes toggles outbound-delete suppression. See
// the suppressOutboundDeletes field doc for the contract. Must be
// called BEFORE Run — the gates inside sendOutboundTask /
// MessageManifest handler / queueRetryAfterPeerError all read the flag
// dynamically, but setting it AFTER Run would leave a window where
// the existing recvLoop has already done DiffManifest + enqueued
// deletes onto outbound.
func (s *Session) SetSuppressOutboundDeletes(v bool) {
	s.mu.Lock()
	s.suppressOutboundDeletes = v
	s.mu.Unlock()
	// Forward to the engine layer so SendDelete and
	// pruneIgnoredTrackedFiles' .gitignore-prune cascade also gate
	// their wire emissions. Without this forwarding the engine's
	// own delete callsites would bypass every Session-level gate
	// (codex sub-commit-C MUST-FIX).
	if s.engine != nil {
		s.engine.SetSuppressOutboundDeletes(v)
	}
}

// IsSuppressOutboundDeletes returns the current flag. Used by tests
// and by Service.Status reflection.
func (s *Session) IsSuppressOutboundDeletes() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.suppressOutboundDeletes
}

func NewSession(engine *Engine, stream Stream) *Session {
	return &Session{
		engine:              engine,
		stream:              stream,
		pending:             map[string]*pendingFile{},
		outbound:            newOutboundQueue(),
		bootstrapReq:        make(chan transport.BootstrapRequest, 1),
		bootstrapResOut:     make(chan transport.BootstrapResult, 4),
		listSessionsReq:     make(chan transport.ListSessionsRequest, 1),
		listSessionsResOut:  make(chan transport.ListSessionsResult, 4),
		forceAllowReq:       make(chan transport.ForceAllowRequest, 1),
		forceAllowResOut:    make(chan transport.ForceAllowResult, 4),
		ptyCountUpdates:     make(chan transport.PtyCountUpdate, 8),
		localExecRequestOut: make(chan transport.LocalExecRequest, 16),
		localExecCancelOut:  make(chan transport.LocalExecCancel, 16),
		localExecOutputOut:  make(chan transport.LocalExecOutput, 64),
		localExecDoneOut:    make(chan transport.LocalExecDone, 8),
		localExecActive:     map[string]context.CancelFunc{},
		localExecWaiters:    map[string]chan LocalExecEvent{},
		fileStatusSyncedOut: make(chan *transport.Message, 128),
		fileStatusErrorOut:  make(chan *transport.Message, 32),
		downloadControlOut:  make(chan downloadControl, 8),
	}
}

// QueueCancelDownload asks the peer (sender side) to stop pushing
// files for this workspace. Caller is the daemon's CancelSyncTask
// path: after marking the task cancelled in the manager, fire this
// so the server's sendFile chunk loop aborts at the next ctx.Err()
// check and any queued outbound files are skipped.
//
// FIFO with QueueResumeDownload — both go through the same
// downloadControlOut channel so a cancel enqueued after a still-
// pending resume always reaches the peer in user-issued order.
//
// Best-effort: drops silently when full (buffer 8). One cancel per
// task is the realistic upper bound; spam-clickers will only need
// one to actually land.
func (s *Session) QueueCancelDownload(workspaceName, reason string) {
	select {
	case s.downloadControlOut <- downloadControl{
		kind:          downloadControlCancel,
		workspaceName: workspaceName,
		reason:        reason,
	}:
	default:
		log.Printf("sync send (cancel download): control queue full for %s, dropping", workspaceName)
	}
}

// QueueResumeDownload tells the peer (sender side) to re-enable
// outbound after a prior MessageCancelDownload AND triggers a fresh
// manifest exchange so the peer can re-diff and re-enqueue the files
// the recipient still needs. Pre-fix this only flipped the stopped
// flag on the peer — but the peer's outbound queue had been purged
// during cancelOutbound, so the post-resume queue stayed empty and
// no files ever flowed (Codex round 5 blocking). sendLoop's
// downloadControlOut handler does the manifest re-send atomically
// with the resume envelope so they always reach the wire in order.
//
// FIFO with QueueCancelDownload — same channel.
//
// Always-safe to fire: peer's resetOutbound + DiffManifest are both
// no-ops on a session that wasn't stopped and is already in sync.
// So the daemon's CreateSyncTask can unconditionally queue this on
// every download POST without tracking "was this a retry?".
func (s *Session) QueueResumeDownload(workspaceName string) {
	select {
	case s.downloadControlOut <- downloadControl{
		kind:          downloadControlResume,
		workspaceName: workspaceName,
	}:
	default:
		log.Printf("sync send (resume download): control queue full for %s, dropping", workspaceName)
	}
}

// sendDownloadControl is sendLoop's downloadControlOut handler. Owns
// the stream.Send so single-writer invariant is preserved. For
// resume, also sends a fresh manifest envelope IMMEDIATELY AFTER the
// resume envelope, in the same sendLoop iteration, so the two
// messages stay adjacent on the wire and the peer's resetOutbound +
// DiffManifest run back-to-back without any other outbound
// interleaving.
//
// sessCtx is plumbed from sendLoop so the resume branch can
// resetOutbound (which needs a parent ctx for the new outboundCtx).
// Without this the LOCAL outbound stays stopped forever after a
// startPaused session: peer would push files fine but our own
// watcher-driven sends (uploads, both-direction sync) would never
// flow again until session rebuild (Codex round 7 blocking).
func (s *Session) sendDownloadControl(sessCtx context.Context, ctl downloadControl) error {
	switch ctl.kind {
	case downloadControlCancel:
		payload, err := json.Marshal(transport.CancelDownloadPayload{
			WorkspaceName: ctl.workspaceName,
			Reason:        ctl.reason,
		})
		if err != nil {
			log.Printf("sync send (cancel download): marshal: %v", err)
			return nil
		}
		return s.stream.Send(&transport.Message{
			Type:   transport.MessageCancelDownload,
			Origin: s.engine.origin,
			Data:   payload,
		})
	case downloadControlResume:
		// Build BOTH envelopes first; only commit to the wire after
		// both succeed (Codex round 6 medium). Pre-fix sent the
		// resume envelope, THEN tried Manifest() — a failure there
		// left the peer half-resumed (stopped=false but outbound
		// queue empty + no re-diff trigger), prone to silent stall
		// until the watcher's next tick. Now we either send both or
		// fail without committing to anything: caller's retry path
		// will fire QueueResumeDownload again on the next user
		// click, and the peer's stopped state is preserved.
		resumePayload, err := json.Marshal(transport.ResumeDownloadPayload{
			WorkspaceName: ctl.workspaceName,
		})
		if err != nil {
			log.Printf("sync send (resume download): marshal: %v (peer left stopped — user must retry)", err)
			return nil
		}
		manifest, merr := s.engine.Manifest()
		if merr != nil {
			log.Printf("sync send (resume manifest): %v (peer left stopped — user must retry)", merr)
			return nil
		}
		if err := s.stream.Send(&transport.Message{
			Type:   transport.MessageResumeDownload,
			Origin: s.engine.origin,
			Data:   resumePayload,
		}); err != nil {
			return err
		}
		if err := s.stream.Send(&transport.Message{
			Type:    transport.MessageManifest,
			Origin:  s.engine.origin,
			Data:    manifest,
			RepoURL: s.engine.LocalRepoURL(),
		}); err != nil {
			return err
		}
		// Local outbound was stopped (either by startPaused on a
		// rebound session, or by a recv'd MessageCancelDownload from
		// the peer). Now that we've told the peer we're resuming,
		// re-enable our own outbound too — otherwise watcher-driven
		// uploads + both-direction sync would never flow again.
		// resetOutbound is a no-op when not stopped, so this is safe
		// even on first-time downloads where there was never a pause.
		s.resetOutbound(sessCtx)
		return nil
	default:
		log.Printf("sync send: unknown download control kind %d, dropping", ctl.kind)
		return nil
	}
}

// currentOutboundCtx returns the latest outboundCtx. drainOutbound
// reads this per task so the in-flight ctx-cancel from a
// MessageCancelDownload takes effect mid-batch. Cheap — one mu
// acquire + pointer copy — so per-task polling is fine.
func (s *Session) currentOutboundCtx() context.Context {
	s.outboundCtxMu.Lock()
	ctx := s.outboundCtx
	s.outboundCtxMu.Unlock()
	return ctx
}

// isOutboundStopped reports whether cancelOutbound has been called
// and resetOutbound has not yet fired (i.e. we're between cancel and
// the next manifest exchange). drainOutbound reads this at the top
// of every iteration AND per task — if stopped, it bails without
// sending anything and clears any newly-enqueued tasks from the
// watcher.
func (s *Session) isOutboundStopped() bool {
	s.outboundCtxMu.Lock()
	stopped := s.outboundStopped
	s.outboundCtxMu.Unlock()
	return stopped
}

// initOutboundCtx is called once from Run, before sendLoop starts,
// to seed outboundCtx as a child of sessCtx. Stopped=false at start.
func (s *Session) initOutboundCtx(sessCtx context.Context) {
	s.outboundCtxMu.Lock()
	defer s.outboundCtxMu.Unlock()
	s.outboundCtx, s.outboundCancel = context.WithCancel(sessCtx)
	s.outboundStopped = false
}

// cancelOutbound is the MessageCancelDownload handler on the SENDER
// side. Sticky semantics (Codex round 3 #1):
//
//  1. Cancels the current outboundCtx — in-flight sendFile aborts
//     at its next chunk-loop ctx.Err() check.
//  2. Sets outboundStopped=true and DOES NOT install a fresh ctx.
//     drainOutbound sees the stopped flag (and the still-cancelled
//     ctx) and returns nil + clears the queue without sending.
//     Watcher/rescan events that enqueue after this point get
//     dropped at drainOutbound's next iteration — also expected,
//     because the user said "stop pushing".
//  3. Clears the currently-pending outbound queue so we don't burn
//     CPU on a stale snapshot one ctx.Err() check at a time.
//
// Resume requires an explicit resetOutbound (called by recvLoop on
// the next MessageManifest, which is the natural retry signal —
// recipient's downloadProject path re-binds + the peer re-exchanges
// manifests as part of session rebuild).
//
// Idempotent: re-calling on already-stopped state is a no-op (prev
// cancelFunc was the one-shot Go context cancel, calling it twice is
// safe; queue already empty; flag already true).
func (s *Session) cancelOutbound(reason string) {
	s.outboundCtxMu.Lock()
	prev := s.outboundCancel
	alreadyStopped := s.outboundStopped
	s.outboundStopped = true
	s.outboundCtxMu.Unlock()
	if prev != nil {
		prev()
	}
	s.outbound.clear()
	if alreadyStopped {
		return
	}
	log.Printf("sync recv: cancel_download accepted: reason=%q outbound STOPPED until next manifest reset", reason)
}

// resetOutbound clears the stopped flag and installs a fresh ctx.
// Called by recvLoop's MessageManifest case so a retry (which always
// re-exchanges manifests) re-enables sending. Idempotent and cheap
// to call on every manifest — checks the flag and only allocates a
// new ctx if a cancel had previously stopped us.
func (s *Session) resetOutbound(sessCtx context.Context) {
	s.outboundCtxMu.Lock()
	if !s.outboundStopped {
		s.outboundCtxMu.Unlock()
		return
	}
	s.outboundCtx, s.outboundCancel = context.WithCancel(sessCtx)
	s.outboundStopped = false
	s.outboundCtxMu.Unlock()
	log.Printf("sync recv: peer manifest after cancel — outbound resumed")
}

// queueFileStatus enqueues a per-path FileStatus ack for sendLoop to
// emit. Non-blocking by design: recvLoop MUST NOT block on stream.Send
// (the resulting head-of-line block on the gRPC outbound HTTP/2 window
// has been observed to deadlock the entire bidirectional stream — see
// the fileStatusSyncedOut / fileStatusErrorOut field doc).
//
// Synced acks may be silently dropped under sustained backpressure;
// the next manifest exchange re-diffs and a sender that lost an ack
// just records the file as locally-current (its index already wrote
// the new entry in Commit). Error acks are critical — they are the
// signal that drives queueRetryAfterPeerError on the sender side —
// so the error channel has its own dedicated buffer and overflow
// surfaces as a WARN-level log line so an operator can correlate
// later "file took forever to retry" reports against the drop.
//
// Always call from recvLoop (or anything in its goroutine). Never
// call from sendLoop — sendLoop drains these channels and would
// deadlock against itself if forced to enqueue while at-capacity.
func (s *Session) queueFileStatus(rel, status string) {
	msg := &transport.Message{
		Type:   transport.MessageFileStatus,
		Origin: s.engine.origin,
		Path:   rel,
		Stream: status,
	}
	if status == transport.FileStatusError {
		select {
		case s.fileStatusErrorOut <- msg:
		default:
			// Critical: dropping an error ack means the sender will
			// not run queueRetryAfterPeerError. Self-heals only when
			// the next manifest exchange catches the divergence.
			log.Printf("WARN: sync recv: fileStatusErrorOut full, DROPPING error ack for %s — sender will not retry until next manifest diff", rel)
		}
		return
	}
	select {
	case s.fileStatusSyncedOut <- msg:
	default:
		// Tolerable: synced is informational (UI ackWaiters + sender
		// index sync). Local engine.index entry was written in Commit,
		// so the next manifest exchange will report the file as in-
		// sync from our side and the sender's diff sees no change.
		log.Printf("sync recv: fileStatusSyncedOut full, dropping synced ack for %s", rel)
	}
}

// LocalExecEvent is the per-chunk signal delivered to a server-side
// RouteLocalExec waiter. Exactly one of Output / Done is non-nil. The
// channel is closed after Done is delivered, so callers can range over
// it and exit cleanly when the runner finishes.
type LocalExecEvent struct {
	Output *transport.LocalExecOutput
	Done   *transport.LocalExecDone
}

// ErrLocalExecBusy is returned by SendLocalExecRequest when the outbound
// queue is full or the request_id collides with an in-flight one. Callers
// should surface this as "desktop daemon too busy, retry" rather than
// retrying internally; a stuck queue likely means the daemon isn't
// draining and a backoff is more useful than piling on.
var ErrLocalExecBusy = errors.New("local exec request queue busy or duplicate request_id")

// SetManifestHook fires once when the session successfully exchanges a
// manifest with the peer (in either direction — sent ours, received
// theirs). Service uses this to advance Status.ManifestExchangedAt so
// the extension's "立即同步" polling can detect real exchange
// completion separately from per-file activity.
func (s *Session) SetManifestHook(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onManifest = fn
}

// SetPeerManifestHook fires when the peer's manifest arrives, passing
// the total entry count and the peer repo URL. Service uses this to set
// Status.PeerManifestFiles / Status.PeerRepoURL so the workbench can
// detect an empty server workspace and show repository identity even
// when the local .git directory is intentionally absent.
func (s *Session) SetPeerManifestHook(fn func(int, string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onPeerManifest = fn
}

// SetHandshakeAckHook installs a callback that fires once when the peer's
// first MessageHello lands and validates (matching workspace_id, no
// rejection in ServerInfo). Daemons wire setConnected(true) here so the
// UI-visible "connected" event waits for a real handshake round-trip
// rather than firing prematurely on grpc.NewClient's lazy dial — which
// otherwise produced the "已连接到 ... → sync session ended: EOF" pair
// the user reported when the underlying TCP wasn't actually up yet.
func (s *Session) SetHandshakeAckHook(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onHandshakeAck = fn
}

// fireHandshakeAckOnce invokes the handshake-ack hook (at most once per
// session). Idempotent so the duplicate hellos the server sends — one
// explicit ack from the handler, one from session.Run init — don't
// double-trigger.
func (s *Session) fireHandshakeAckOnce() {
	s.mu.Lock()
	if s.handshakeAckFired {
		s.mu.Unlock()
		return
	}
	s.handshakeAckFired = true
	hook := s.onHandshakeAck
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (s *Session) noteManifest() {
	s.mu.Lock()
	hook := s.onManifest
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (s *Session) SetRemoteActivityHook(fn func(path string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onRemoteActivity = fn
}

// SetActivityHook installs a callback that fires whenever the session
// has just transmitted or applied a real file (heartbeats and status
// echoes intentionally don't count). Used by Service to advance the
// LastActivityAt timestamp the extension polls to verify a manual
// "立即同步" actually moved bytes.
func (s *Session) SetActivityHook(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onActivity = fn
}

func (s *Session) noteActivity() {
	s.mu.Lock()
	hook := s.onActivity
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
}

// SetRecvObserver installs (or removes when nil) a callback fired
// after each successful stream.Recv inside recvLoop, BEFORE the
// message is dispatched. Used by cmd/server's Sync handler to wire
// the lease's Touch hook — every observed message is evidence the
// peer is alive, keeping the lease's 105s absolute timeout from
// firing on an active session.
//
// Fires on EVERY successful Recv, including heartbeats — the lease
// plan §3.2 spec ("收到任意 message 都 Touch") is explicit that
// heartbeats count. Fires OUTSIDE s.mu, so the observer may safely
// call into other components (including back into the session) as
// long as it itself doesn't try to re-acquire s.mu.
func (s *Session) SetRecvObserver(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recvObserver = fn
}

func (s *Session) noteRecvObserved() {
	s.mu.Lock()
	hook := s.recvObserver
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
}

// closeStreamingPending releases file handles on every in-flight
// PendingWrite without removing the .trans-tmp from disk. Called from
// Run's defer so an ungraceful session exit (network drop, ctx cancel,
// fatal recv error) leaves the partial files intact for resume on the
// next session.
func (s *Session) closeStreamingPending() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for path, p := range s.pending {
		if p != nil && p.pw != nil {
			p.pw.Close()
		}
		delete(s.pending, path)
	}
}

func (s *Session) SetWorkspaceName(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.workspaceName = name
}

// SetClientID stamps every hello envelope with a stable per-client
// identifier. The trans-server uses it to evict the previous owner of
// the same workspace_id with an in-band session_replaced envelope.
func (s *Session) SetClientID(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clientID = id
}

// SetBootstrapResultHook installs the callback that receives the
// server's reply to a MessageBootstrap. Used by Service to surface
// status into the daemon's /v1/bootstrap-status endpoint.
func (s *Session) SetBootstrapResultHook(fn func(transport.BootstrapResult)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onBootstrapResult = fn
}

func (s *Session) SetPtyCountUpdateHook(fn func(transport.PtyCountUpdate)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onPtyCountUpdate = fn
}

func (s *Session) PublishPtyCountUpdate(update transport.PtyCountUpdate) {
	if update.PtyCount < 0 {
		update.PtyCount = 0
	}
	select {
	case s.ptyCountUpdates <- update:
		return
	default:
	}
	select {
	case <-s.ptyCountUpdates:
	default:
	}
	select {
	case s.ptyCountUpdates <- update:
	default:
	}
}

// RequestBootstrap queues a bootstrap message for the next sendLoop
// iteration. Returns false if the slot is already full (caller should
// wait — concurrent bootstraps for the same workspace make no sense).
func (s *Session) RequestBootstrap(req transport.BootstrapRequest) bool {
	select {
	case s.bootstrapReq <- req:
		return true
	default:
		return false
	}
}

// EngineTransfers proxies through to engine.Transfers so the daemon's
// HTTP layer doesn't need a direct *Engine reference.
func (s *Session) EngineTransfers() []TransferRow {
	return s.engine.Transfers()
}

func (s *Session) PendingOutboundSize() int {
	if s.outbound == nil {
		return 0
	}
	return s.outbound.pendingSize()
}

// UploadsPaused reports whether outbound uploads are currently
// suppressed (by the empty-peer or repo-mismatch guards). The Service
// surfaces this through Status so the workbench can show why nothing
// is moving even though the session is connected.
func (s *Session) UploadsPaused() bool {
	if s.outbound == nil {
		return false
	}
	return s.outbound.isPaused()
}

// PauseReason returns the human-readable explanation set the last time
// uploads were paused. Empty string when uploads are flowing normally.
func (s *Session) PauseReason() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.outbound != nil && !s.outbound.isPaused() {
		return ""
	}
	return s.pauseReason
}

// applyManifestPause decides whether outbound uploads should pause
// based on the peer's manifest we just received.
//
// Historical note: there used to be a second guard that paused uploads
// whenever the peer reported zero entries while we had local files,
// forcing the user to run /v1/bootstrap (git clone) before pushing.
// That predates the snapshot manifest pipeline — a fresh-server first-
// upload is now an expected, non-destructive flow, so the empty-remote
// arm has been removed. Only the repo-URL-mismatch guard remains:
//
//	Both sides declare a repo URL (via manifest envelope's RepoURL
//	field) and they differ. Without this we would push our repo's
//	files at a server that bootstrapped a completely different repo.
//
// The guard collapses to "this side stops pushing." The peer running
// the same code reaches the symmetric conclusion. Receive direction is
// never affected — pulling content into a wrong workspace is fixable
// by re-bootstrap, mass-pushing IS the destructive direction.
func (s *Session) applyManifestPause(remote []FileInfo, remoteRepoURL string) {
	remoteFileCount := 0
	for _, r := range remote {
		if r.Deleted {
			continue
		}
		if isKariDirPath(r.Path) {
			continue
		}
		remoteFileCount++
	}

	s.mu.Lock()
	disableGuard := s.disablePauseGuard
	s.mu.Unlock()

	var reason string
	switch {
	case disableGuard:
		// Staging-bind path (set by daemon for upload-staging /
		// download-staging). Skip the repo-URL mismatch guard: a
		// repo-URL mismatch on a temporary staging dir is meaningless
		// — staging is per-session, not the canonical workspace.
		// Callers must set this before Run() so the very first
		// MessageManifest from the peer doesn't trip the guard.
		reason = ""
	case remoteRepoURL != "" && remoteFileCount > 0:
		localRepoURL := s.engine.LocalRepoURL()
		if localRepoURL != "" && localRepoURL != remoteRepoURL {
			reason = fmt.Sprintf("仓库不一致：本地 %s vs 远端 %s — 同步已暂停", localRepoURL, remoteRepoURL)
		}
	}

	s.mu.Lock()
	prevReason := s.pauseReason
	s.pauseReason = reason
	s.mu.Unlock()
	if s.outbound != nil {
		s.outbound.setPaused(reason != "")
	}
	if reason != "" && reason != prevReason {
		log.Printf("sync: uploads paused: %s", reason)
	} else if reason == "" && prevReason != "" {
		log.Printf("sync: uploads resumed (was: %s)", prevReason)
	}
}

// isKariDirPath reports whether rel lives under .kari/ — the
// user-data dir for the workspace (proposals, uploads). Excluded from
// the local/remote "is this workspace effectively empty?" count so a
// fresh workspace containing only .kari/ scaffolding is still treated
// as empty for the bootstrap-guard.
func isKariDirPath(rel string) bool {
	return rel == ".kari" || len(rel) >= 6 && rel[:6] == ".kari/"
}

func (s *Session) EngineCounters() EngineCounters {
	if s.engine == nil {
		return EngineCounters{}
	}
	return s.engine.Counters()
}

func (s *Session) AddForceAllowEntries(entries []ForceAllowEntry) (int, error) {
	return s.engine.AddForceAllowEntries(entries)
}

func (s *Session) ForceAllowEntries() []ForceAllowEntry {
	if s.engine == nil {
		return nil
	}
	return s.engine.ForceAllowEntries()
}

// WaitForUpAck registers a waiter for the peer's synced ack of rel.
// Daemon-side wrapper around engine.WaitForUpAck — kept on the session
// so callers don't need an *Engine handle. See engine doc for usage.
func (s *Session) WaitForUpAck(rel string) <-chan struct{} {
	return s.engine.WaitForUpAck(rel)
}

// SetBootstrapHandler installs the server-side git-clone handler.
// recvLoop spawns a goroutine to invoke it on each MessageBootstrap.
// The handler may call emit with Status="pending" to stream progress
// before returning the final BootstrapResult.
func (s *Session) SetBootstrapHandler(h func(transport.BootstrapRequest, bootstrapProgressFunc) transport.BootstrapResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bootstrapHandler = h
}

// SetListSessionsHandler installs the server-side scanner that walks
// the Claude / Codex data dirs and returns the session metadata list.
// Daemons leave this nil; only cmd/server installs one.
func (s *Session) SetListSessionsHandler(h func(transport.ListSessionsRequest) transport.ListSessionsResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listSessionsHandler = h
}

func (s *Session) SetForceAllowHandler(h func(transport.ForceAllowRequest) transport.ForceAllowResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forceAllowHandler = h
}

// SetLocalExecHandler installs the daemon-side runner invoked when the
// server sends a MessageLocalExecRequest. emit is called for each
// output chunk; the returned LocalExecDone is the terminal event. The
// handler must respect ctx.Done() and stop the underlying process when
// it fires — server-side cancels (bridge died, ctx expired) arrive as
// MessageLocalExecCancel and translate to ctx.Cancel here.
//
// Must be called BEFORE Run: the Hello envelope is sent at session
// startup with capabilities decided from this field, and a handler
// installed later won't make it onto the wire. Servers leave this nil
// (and consequently never advertise CapabilityLocalExec, which is what
// keeps daemon-only routing honest).
func (s *Session) SetLocalExecHandler(h func(ctx context.Context, req transport.LocalExecRequest, emit func(transport.LocalExecOutput)) transport.LocalExecDone) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.localExecHandler = h
}

// SendLocalExecRequest queues an exec request for the peer daemon and
// returns a channel that delivers output chunks plus a final Done event.
// The channel is closed after Done is delivered, so callers can range
// over it. cancel must be invoked on the caller's exit path (success,
// timeout, ctx cancel) — it removes the waiter and sends a
// MessageLocalExecCancel envelope if Done has not yet arrived.
//
// Returns ErrLocalExecBusy when the request_id collides with an
// in-flight one or when the outbound queue can't accept another
// request. Caller should NOT retry with the same request_id.
func (s *Session) SendLocalExecRequest(req transport.LocalExecRequest) (<-chan LocalExecEvent, func(), error) {
	if req.RequestID == "" {
		return nil, nil, errors.New("local exec request: missing request_id")
	}
	ch := make(chan LocalExecEvent, 32)
	s.mu.Lock()
	if _, exists := s.localExecWaiters[req.RequestID]; exists {
		s.mu.Unlock()
		return nil, nil, ErrLocalExecBusy
	}
	s.localExecWaiters[req.RequestID] = ch
	s.mu.Unlock()

	cancel := func() {
		s.mu.Lock()
		waiter, ok := s.localExecWaiters[req.RequestID]
		if ok {
			delete(s.localExecWaiters, req.RequestID)
		}
		s.mu.Unlock()
		if !ok {
			// Already cleaned up by the Done path; nothing to send.
			return
		}
		// Send cancel best-effort; never block on the queue.
		select {
		case s.localExecCancelOut <- transport.LocalExecCancel{
			RequestID: req.RequestID,
			Reason:    transport.LocalExecCancelContextExpired,
		}:
		default:
			log.Printf("sync send (local exec cancel): queue full for %s, dropping", req.RequestID)
		}
		// Close the waiter so the caller's range loop exits. Safe
		// because we just removed it from the map; recvLoop can't
		// observe it any more.
		close(waiter)
	}

	select {
	case s.localExecRequestOut <- req:
		return ch, cancel, nil
	default:
		s.mu.Lock()
		if cur, ok := s.localExecWaiters[req.RequestID]; ok && cur == ch {
			delete(s.localExecWaiters, req.RequestID)
		}
		s.mu.Unlock()
		return nil, nil, ErrLocalExecBusy
	}
}

// CleanupLocalExecWaitersFor cancels every in-flight local exec waiter
// whose RequestID is in the provided set. Used when an MCP bridge dies
// without sending a Done — RouteLocalExec callers waiting on those
// request IDs must be released with a synthetic "bridge_disconnected"
// Done so they don't block forever, and the daemon side must be told
// to abort the running process. Both effects are produced here.
func (s *Session) CleanupLocalExecWaitersFor(requestIDs []string) {
	if len(requestIDs) == 0 {
		return
	}
	s.mu.Lock()
	released := make([]chan LocalExecEvent, 0, len(requestIDs))
	cancelEnvelopes := make([]transport.LocalExecCancel, 0, len(requestIDs))
	for _, id := range requestIDs {
		if id == "" {
			continue
		}
		if waiter, ok := s.localExecWaiters[id]; ok {
			delete(s.localExecWaiters, id)
			released = append(released, waiter)
			cancelEnvelopes = append(cancelEnvelopes, transport.LocalExecCancel{
				RequestID: id,
				Reason:    transport.LocalExecCancelBridgeGone,
			})
		}
	}
	s.mu.Unlock()
	for i, waiter := range released {
		done := transport.LocalExecDone{
			RequestID:    cancelEnvelopes[i].RequestID,
			ExitCode:     -1,
			Error:        "bridge disconnected before run completed",
			DeniedReason: "", // not a denial; this is mid-flight teardown
		}
		select {
		case waiter <- LocalExecEvent{Done: &done}:
		default:
		}
		close(waiter)
	}
	for _, c := range cancelEnvelopes {
		select {
		case s.localExecCancelOut <- c:
		default:
			log.Printf("sync send (local exec cancel): queue full for %s during bridge cleanup, dropping", c.RequestID)
		}
	}
}

func (s *Session) RequestForceAllow(req transport.ForceAllowRequest) (<-chan transport.ForceAllowResult, error) {
	s.mu.Lock()
	if s.forceAllowWaiter != nil {
		s.mu.Unlock()
		return nil, errors.New("force allow request already in flight")
	}
	ch := make(chan transport.ForceAllowResult, 1)
	s.forceAllowWaiter = ch
	s.mu.Unlock()
	select {
	case s.forceAllowReq <- req:
		return ch, nil
	default:
		s.mu.Lock()
		if s.forceAllowWaiter == ch {
			s.forceAllowWaiter = nil
		}
		s.mu.Unlock()
		return nil, errors.New("force allow queue full")
	}
}

func (s *Session) ClearForceAllowWaiter() {
	s.mu.Lock()
	s.forceAllowWaiter = nil
	s.mu.Unlock()
}

// RequestListSessions queues a list-sessions request and returns a
// one-shot channel that receives the server's reply. Returns an error
// when the request slot is already occupied (caller must serialize via
// the daemon's HTTP-level lock) or when the queue is somehow full.
// Cancellation: the channel is reusable-once; if the caller times out,
// it must call ClearListSessionsWaiter before retrying so a late reply
// from the prior request doesn't land in the new one's slot.
func (s *Session) RequestListSessions(req transport.ListSessionsRequest) (<-chan transport.ListSessionsResult, error) {
	s.mu.Lock()
	if s.listSessionsWaiter != nil {
		s.mu.Unlock()
		return nil, errors.New("list sessions request already in flight")
	}
	ch := make(chan transport.ListSessionsResult, 1)
	s.listSessionsWaiter = ch
	s.mu.Unlock()
	select {
	case s.listSessionsReq <- req:
		return ch, nil
	default:
		s.mu.Lock()
		if s.listSessionsWaiter == ch {
			s.listSessionsWaiter = nil
		}
		s.mu.Unlock()
		return nil, errors.New("list sessions queue full")
	}
}

// AbortListSessions atomically retires the in-flight ListSessions
// request: clears the waiter slot AND evicts any stale request still
// sitting in the size-1 listSessionsReq buffer. Must be called as ONE
// operation under Session.mu — splitting it into "clear waiter" then
// "drain channel" has a race where:
//  1. Caller A times out; Clear runs, sees waiter==A.ch, sets nil.
//  2. Between Clear's mu.Unlock and Drain's select, caller B's
//     RequestListSessions slips in: registers waiter=B.ch, pushes
//     its request into the now-empty channel.
//  3. Caller A's Drain runs, evicts B's request from the channel.
//  4. B's request is lost; B's waiter sits forever; B's HTTP request
//     eventually times out — and then runs into the same race
//     against caller C.
//
// Holding mu across both operations guarantees a fresh enqueue from
// B happens-after this method returns or happens-before this method
// reads the channel; it cannot interleave.
//
// Side effect on a successful drain: sendLoop may already have
// pulled the stale request before mu was acquired. In that case the
// channel is empty (nothing to drain) and sendLoop will eventually
// stream.Send the stale request to the peer; the peer's reply
// arrives at recvLoop with no waiter and is silently dropped per
// the MessageListSessionsResult handler. Benign wasted round-trip.
//
// Caller (Service.ListRemoteSessions timeout / ctx.Done branch) must
// hold no other locks that the session also takes — Session.mu is
// the bottom of the lock order in this package.
func (s *Session) AbortListSessions() {
	s.mu.Lock()
	s.listSessionsWaiter = nil
	select {
	case <-s.listSessionsReq:
	default:
	}
	s.mu.Unlock()
}

// manifestFallbackDelay is how long Run waits for the peer's
// MessageManifest after we send ours. If nothing arrives by then we
// assume the peer is on a pre-manifest build and degrade to the legacy
// "push everything force=true" SendSnapshot — slower but correct. Var
// (not const) so tests can shorten it without 2s of sleep per case.
var manifestFallbackDelay = 2 * time.Second

// Run starts the bidirectional sync. kick (may be nil) lets the caller
// force an immediate rescan from outside — used by TriggerSync so the
// "立即同步" button does something more than enqueue a no-op.
//
// Lifecycle invariant: every goroutine spawned here uses sessCtx, a
// child of the caller's ctx. When Run returns (any reason — error from
// errs, sessCtx done), the deferred cancel fires and sendLoop + Watch
// see sessCtx.Done() and exit on their next select. recvLoop is blocked
// in stream.Recv() so it doesn't see ctx cancellation directly; it
// exits when the caller closes the underlying gRPC connection (daemon
// side: `defer cc.Close()` in internal/syncd/session.go; server side:
// gRPC handler return tears down the stream). Without this, the old
// pre-fix code leaked one fsnotify/FSEvents watcher + ticker per
// reconnect, which is the root cause of "starts fine, gradually stops
// syncing" reports.
func (s *Session) Run(ctx context.Context, rescanInterval time.Duration, kick <-chan struct{}) error {
	sessCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	// outboundCtx is a child of sessCtx; cancelled mid-session by
	// MessageCancelDownload, then recreated so future sends work.
	// drainOutbound reads it on every task via currentOutboundCtx().
	s.initOutboundCtx(sessCtx)
	// Honor caller-set startPaused (syncd daemon sets this when
	// re-binding a session for a workspace whose download was
	// previously cancelled). Immediately mark outboundStopped +
	// cancel the freshly-seeded outboundCtx so drainOutbound stays
	// idle; the matching MessageCancelDownload to the peer is
	// queued below, after sendLoop is up.
	s.mu.Lock()
	startPaused := s.startPaused
	controlOnly := s.controlOnly
	s.mu.Unlock()
	// control-only forces outboundStopped at session start so any
	// defensively-leaked enqueue (e.g. a stray ForceAllow path) drains
	// as no-op. Combined with the manifest-send / Watch / fallback gates
	// below this fully isolates the file plane while the control plane
	// keeps running. See controlOnly field doc.
	if startPaused || controlOnly {
		s.outboundCtxMu.Lock()
		s.outboundStopped = true
		if s.outboundCancel != nil {
			s.outboundCancel()
		}
		s.outboundCtxMu.Unlock()
	}

	errs := make(chan error, 3)
	// closeStreamingPending closes any open PendingWrite file handles at
	// session shutdown but leaves the .trans-tmp files on disk. That's
	// the contract PR-G relies on: next session's BeginReceive (with the
	// resume protocol) will pick up where this one left off, byte-offset
	// matched against the source.
	defer s.closeStreamingPending()

	// Send hello first, synchronously. It MUST be the first byte on the
	// wire — the server's AcceptSyncStream pulls one envelope and routes
	// by Type. No goroutines are running yet, so this Send has no
	// competitor for sendMu.
	hello := &transport.Message{Type: transport.MessageHello}
	if ws, ok := s.stream.(workspaceIDProvider); ok {
		hello.WorkspaceID = ws.WorkspaceID()
	}
	s.mu.Lock()
	hello.WorkspaceName = s.workspaceName
	hello.ClientID = s.clientID
	if s.onPtyCountUpdate != nil {
		hello.Capabilities = append(hello.Capabilities, transport.CapabilityPtyCountUpdate)
	}
	if s.localExecHandler != nil {
		hello.Capabilities = append(hello.Capabilities, transport.CapabilityLocalExec)
	}
	s.mu.Unlock()
	if err := s.stream.Send(hello); err != nil {
		return err
	}

	// Start recvLoop AND sendLoop BEFORE sending manifest. Two reasons:
	//
	// (a) recvLoop must drain inbound so the peer's manifest doesn't
	//     wedge HTTP/2 flow control while we're sending ours.
	//
	// (b) sendLoop must drain the outbound pending map — recvLoop fills it
	//     the moment a peer manifest arrives. The map is path-set semantics
	//     rather than a bounded FIFO, so large manifest diffs coalesce
	//     instead of overflowing and dropping paths.
	//
	// Watch is started last so that no watcher event can race into the
	// outbound queue before recvLoop has produced its first ack, keeping startup
	// deterministic.
	go func() {
		errs <- s.recvLoop(sessCtx)
	}()
	go func() {
		errs <- s.sendLoop(sessCtx)
	}()

	// Send our manifest UNLESS the session started in paused state.
	// Skipping the manifest is the cross-reconnect cancel-persistence
	// half (Codex round 6 blocking): if we'd sent it, the peer would
	// DiffManifest + enqueue + start pushing in the same RTT — even
	// our async QueueCancelDownload below couldn't catch the leak.
	// With manifest suppressed, the peer has nothing to enqueue from
	// the manifest path; only their own watcher can fire outbound,
	// which our incoming Cancel then disarms.
	//
	// Wire ordering note for the normal path: sendLoop is already
	// running; if recvLoop has handled a peer-manifest-driven
	// file_meta it may have already gone out via the outbound queue
	// before this line. That's fine — the server's recvLoop doesn't
	// require manifest to precede file_meta, only hello must come
	// first (which it did).
	switch {
	case controlOnly:
		// Suppress the initial manifest entirely. The peer will never
		// see our (empty/staging-marker) local state, so it can't
		// trigger a delete-propagation diff. NOTE: we do NOT queue
		// MessageCancelDownload here — that's specifically a download-
		// cancel semantic. Control-only's contract is outbound-only
		// inertness: inbound MessageFileMeta / MessageDelete /
		// MessageTextOp are still accepted as server-authoritative cloud
		// updates, while peer status / resume frames that can re-arm
		// outbound work are dropped in recvLoop's switch below.
		log.Printf("sync send: control-only mode for ws=%q — initial manifest suppressed, Watch + fallback skipped", s.workspaceName)
	case startPaused:
		// Queue cancel onto sendLoop now that it's running. sendLoop
		// will stream.Send the cancel envelope after the Hello
		// completes; peer's recvLoop enters cancelOutbound + sticky
		// stopped state. With manifest suppressed AND cancel landed,
		// the peer can't push anything for this workspace until our
		// next QueueResumeDownload arrives via user retry.
		s.QueueCancelDownload(s.workspaceName, "session_rebound_while_paused")
		log.Printf("sync send: session started paused for ws=%q — manifest suppressed, cancel queued", s.workspaceName)
	default:
		if manifest, err := s.engine.Manifest(); err == nil {
			_ = s.stream.Send(&transport.Message{
				Type:    transport.MessageManifest,
				Origin:  s.engine.origin,
				Data:    manifest,
				RepoURL: s.engine.LocalRepoURL(),
			})
		}
	}

	// control-only: do NOT start engine.Watch (no rescans, no enqueue)
	// and do NOT arm the manifest-fallback SendSnapshot timer (we never
	// want to bulk-push from the working tree in this mode). errs is
	// buffered enough to absorb the remaining recv/send goroutines.
	var fallbackTimer *time.Timer
	if !controlOnly {
		go func() {
			errs <- s.engine.Watch(sessCtx, s.enqueuePath, rescanInterval, kick)
		}()
		fallbackTimer = time.AfterFunc(manifestFallbackDelay, func() {
			// If the peer never replied with their manifest, fall back to
			// the legacy "send every file force=true" path. recvLoop will
			// call cancelFallback() to disarm this when manifest arrives.
			//
			// Use outboundCtx instead of sessCtx so a MessageCancelDownload
			// that arrives DURING this fallback path actually interrupts
			// it. Pre-fix the timer used sessCtx — cancel would set
			// outboundStopped + cancel outboundCtx, but the fallback
			// SendSnapshot kept iterating with the still-live sessCtx and
			// bulk-pushed the entire workspace anyway (Codex round 3 #2).
			// Also short-circuit if outbound is already stopped at the
			// moment the timer fires — covers the case where the user
			// cancelled before the fallback even kicked in.
			if s.isOutboundStopped() {
				return
			}
			outCtx := s.currentOutboundCtx()
			if outCtx.Err() != nil {
				return
			}
			_ = s.engine.SendSnapshot(outCtx, s.stream)
		})
		s.mu.Lock()
		s.fallbackTimer = fallbackTimer
		s.mu.Unlock()
	}

	select {
	case <-sessCtx.Done():
		if fallbackTimer != nil {
			fallbackTimer.Stop()
		}
		return sessCtx.Err()
	case err := <-errs:
		if fallbackTimer != nil {
			fallbackTimer.Stop()
		}
		if err == io.EOF {
			return nil
		}
		return err
	}
}

func (s *Session) sendLoop(ctx context.Context) error {
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-s.outbound.wake:
			if err := s.drainOutbound(ctx); err != nil {
				return err
			}
		case req := <-s.bootstrapReq:
			// Workbench UI asked for a server-side git clone. Encode
			// the request and let the peer reply asynchronously via
			// MessageBootstrapResult; we don't block here.
			payload, merr := json.Marshal(req)
			if merr != nil {
				log.Printf("sync send (bootstrap): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageBootstrap,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case res := <-s.bootstrapResOut:
			// Server-side handler finished a git clone and queued the
			// result here. Drain through sendLoop so we never call
			// stream.Send concurrently with another goroutine.
			payload, merr := json.Marshal(res)
			if merr != nil {
				log.Printf("sync send (bootstrap result): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageBootstrapResult,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case req := <-s.listSessionsReq:
			payload, merr := json.Marshal(req)
			if merr != nil {
				log.Printf("sync send (list sessions): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageListSessions,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case res := <-s.listSessionsResOut:
			payload, merr := json.Marshal(res)
			if merr != nil {
				log.Printf("sync send (list sessions result): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageListSessionsResult,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case req := <-s.forceAllowReq:
			payload, merr := json.Marshal(req)
			if merr != nil {
				log.Printf("sync send (force allow): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageForceAllow,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case res := <-s.forceAllowResOut:
			payload, merr := json.Marshal(res)
			if merr != nil {
				log.Printf("sync send (force allow result): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageForceAllowResult,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case update := <-s.ptyCountUpdates:
			if err := s.stream.Send(&transport.Message{
				Type:        transport.MessagePtyCountUpdate,
				WorkspaceID: update.WorkspaceID,
				PtyCount:    update.PtyCount,
			}); err != nil {
				return err
			}
		case req := <-s.localExecRequestOut:
			payload, merr := json.Marshal(req)
			if merr != nil {
				log.Printf("sync send (local exec req): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageLocalExecRequest,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case cancel := <-s.localExecCancelOut:
			payload, merr := json.Marshal(cancel)
			if merr != nil {
				log.Printf("sync send (local exec cancel): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageLocalExecCancel,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case out := <-s.localExecOutputOut:
			payload, merr := json.Marshal(out)
			if merr != nil {
				log.Printf("sync send (local exec output): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageLocalExecOutput,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case done := <-s.localExecDoneOut:
			payload, merr := json.Marshal(done)
			if merr != nil {
				log.Printf("sync send (local exec done): marshal: %v", merr)
				continue
			}
			if err := s.stream.Send(&transport.Message{
				Type:   transport.MessageLocalExecDone,
				Origin: s.engine.origin,
				Data:   payload,
			}); err != nil {
				return err
			}
		case msg := <-s.fileStatusErrorOut:
			// Error acks first so a synced flood can't starve a retry
			// signal. recvLoop's queueFileStatus guarantees these are
			// pre-marshalled *transport.Message values; we just push.
			if err := s.stream.Send(msg); err != nil {
				return err
			}
		case msg := <-s.fileStatusSyncedOut:
			if err := s.stream.Send(msg); err != nil {
				return err
			}
		case ctl := <-s.downloadControlOut:
			// Single FIFO carrying cancel + resume so the peer
			// observes them in the exact order the daemon enqueued
			// them. sendDownloadControl owns the stream.Send for the
			// envelope(s) and, for resume, also emits a fresh
			// manifest back-to-back so the peer can re-diff +
			// re-enqueue the files we still need (Codex round 5).
			// Passing ctx lets resume additionally resetOutbound
			// LOCAL state — see sendDownloadControl doc for why
			// (Codex round 7).
			if err := s.sendDownloadControl(ctx, ctl); err != nil {
				return err
			}
		case <-heartbeat.C:
			if err := s.stream.Send(&transport.Message{Type: transport.MessageHeartbeat}); err != nil {
				return err
			}
		}
	}
}

func (s *Session) enqueuePath(absPath string) {
	rel, err := s.engine.relative(absPath)
	if err != nil {
		return
	}
	if isInternalStatePath(rel) {
		return
	}
	s.outbound.enqueue(outboundTask{
		kind:        outboundSendPath,
		path:        rel,
		bypassPause: s.engine.isForceAllowed(rel, false) || isAttachUploadRel(rel),
	})
}

// drainOutbound runs in the sendLoop goroutine. sessCtx is the
// session-scope cancellation (tears the whole stream down); per-file
// outboundCtx + isOutboundStopped govern per-download cancellation
// independently. See cancelOutbound's doc for the sticky-stopped
// semantics: once cancelOutbound has fired, drainOutbound bails on
// every wakeup until resetOutbound (next MessageManifest) clears the
// flag.
func (s *Session) drainOutbound(sessCtx context.Context) error {
	for {
		if err := sessCtx.Err(); err != nil {
			return err
		}
		// Check stopped state up front. Pre-fix the post-cancel
		// follow-up tasks (still in the local drain batch OR newly
		// enqueued by watcher) would pick up a freshly-installed live
		// ctx from the prior cancelOutbound implementation and
		// happily resume sending — Codex round 3 caught this. Now we
		// drop the batch + drain whatever the queue has accumulated
		// while stopped, and return nil to keep sendLoop alive.
		if s.isOutboundStopped() {
			s.outbound.clear()
			return nil
		}
		batch := s.outbound.drain()
		if len(batch) == 0 {
			return nil
		}
		for _, task := range batch {
			if err := sessCtx.Err(); err != nil {
				return err
			}
			// Re-check stopped per task; a MessageCancelDownload can
			// race the mid-batch iteration and flip stopped while we
			// have N items still local.
			if s.isOutboundStopped() {
				// Implicitly drops the remaining batch entries. The
				// queue itself is already empty (cancelOutbound called
				// outbound.clear()); when sendLoop wakes again, the
				// stopped-state check at the top will keep us idle
				// until resetOutbound runs.
				return nil
			}
			outCtx := s.currentOutboundCtx()
			if err := outCtx.Err(); err != nil {
				// outCtx cancelled but stopped flag not (yet) set —
				// rare narrow race during cancelOutbound's
				// non-atomic prev-then-flag ordering. Skip task; next
				// iteration's top-of-loop will see stopped=true.
				continue
			}
			if err := s.sendOutboundTask(outCtx, task); err != nil {
				if errors.Is(err, context.Canceled) && sessCtx.Err() == nil {
					// Per-file outbound cancel (the in-flight file
					// hit ctx.Err in send.go's chunk loop). Continue
					// to next task; the stopped-flag check at the
					// top of the next iteration will drop the rest.
					continue
				}
				if isFatalSendError(err) {
					return err
				}
				log.Printf("sync send: %s: %v (continuing)", task.path, err)
				continue
			}
			s.noteActivity()
		}
	}
}

func (s *Session) sendOutboundTask(ctx context.Context, task outboundTask) error {
	suppressDeletes := s.IsSuppressOutboundDeletes()
	switch task.kind {
	case outboundSendPath:
		// When outbound-delete suppression is active (staging-bind
		// sessions), pre-stat the file: if it's missing, SendPath
		// would internally fall through to SendDelete (engine/send.go
		// line ~47 + ~98). For staging sessions the "file was here a
		// second ago but is now gone" event is Desktop's post-commit
		// cleanup of the local staging dir — propagating that as a
		// MessageDelete is the production wipe path. Silently skip.
		if suppressDeletes {
			abs := absFromRel(s.engine.root, task.path)
			if _, statErr := statFile(s.engine.root, task.path); statErr != nil {
				if os.IsNotExist(statErr) {
					log.Printf("sync send: outbound-delete suppressed for path=%q (staging session, file vanished locally) abs=%s", task.path, abs)
					return nil
				}
			}
		}
		return s.engine.SendPath(ctx, s.stream, absFromRel(s.engine.root, task.path))
	case outboundForcedSend:
		info := task.info
		if info.Path == "" {
			info.Path = task.path
		}
		return s.engine.SendFileResumable(ctx, s.stream, info.Path, info.PartialBytes, info.PartialEtag)
	case outboundForcedDelete:
		info := task.info
		if info.Path == "" {
			info.Path = task.path
		}
		// Outbound-delete suppression: staging-bind sessions must
		// never emit MessageDelete to the peer. This path is reached
		// from three enqueue sites (DiffManifest toSendDeletes,
		// queueRetryAfterPeerError, and any explicit caller). The
		// MessageManifest + queueRetryAfterPeerError paths are also
		// gated at the enqueue site, but this catches every other
		// caller defense-in-depth.
		if suppressDeletes {
			log.Printf("sync send: outbound MessageDelete suppressed for path=%q (staging session)", info.Path)
			return nil
		}
		return wrapSend(s.stream.Send(&transport.Message{
			Type:    transport.MessageDelete,
			Origin:  s.engine.origin,
			Path:    info.Path,
			Version: info.Version,
		}))
	default:
		return nil
	}
}

// isFatalSendError mirrors isFatalApplyError but for the outbound path.
// Stream-level failures (ErrStreamBroken from a wrapSend in engine code)
// or context cancellation must kill the loop; everything else is a
// per-file annoyance worth a log line at most.
func isFatalSendError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if errors.Is(err, ErrStreamBroken) {
		return true
	}
	return false
}

func (s *Session) recvLoop(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		msg, err := s.stream.Recv()
		if err != nil {
			return err
		}
		// Per-message Touch (PR1.2e-followup): every successful Recv
		// is evidence the peer is alive, including heartbeats. The
		// observer (typically Lease.Touch on the server side) MUST
		// be called BEFORE the type-switch, so a message type that
		// errors out below still extends the lease — the peer was
		// well enough to send a message, even if its content was
		// malformed.
		s.noteRecvObserved()
		switch msg.Type {
		case transport.MessageHeartbeat:
			continue
		case transport.MessageHello:
			// Validate before signalling connected. ServerInfo is "ok"
			// on the server's explicit handler ack; empty on the second
			// hello that comes from the peer's session.Run init —
			// anything else is a real rejection we shouldn't silently
			// swallow as a connect signal. WorkspaceID mismatch would
			// indicate a programming error or a routing bug; either
			// way it's fatal so the daemon's reconnect loop won't
			// quietly serve a wrong workspace.
			if msg.ServerInfo != "" && msg.ServerInfo != "ok" {
				return fmt.Errorf("hello rejected by peer: %s", msg.ServerInfo)
			}
			if ws, ok := s.stream.(workspaceIDProvider); ok {
				if expected := ws.WorkspaceID(); expected != "" && msg.WorkspaceID != "" && msg.WorkspaceID != expected {
					return fmt.Errorf("hello workspace_id mismatch: got %q want %q", msg.WorkspaceID, expected)
				}
			}
			s.fireHandshakeAckOnce()
			continue
		case transport.MessageManifest:
			// control-only short-circuit: this session must not engage
			// the file plane at all. Drop the peer manifest BEFORE
			// touching the fallback timer, applyManifestPause,
			// DiffManifest, the noteManifest activity hook, or the
			// onPeerManifest Status hook — every one of those is
			// file-plane state. The fallback timer is nil in
			// control-only mode (gated in Run above) so skipping its
			// disarm is correct.
			if s.IsControlOnly() {
				log.Printf("sync recv: control-only mode — incoming manifest skipped for ws=%q (peer_bytes=%d)", s.workspaceName, len(msg.Data))
				continue
			}
			// Peer told us their full state. Disarm the legacy
			// SendSnapshot fallback first — the manifest path is more
			// efficient and they're clearly on the new protocol.
			s.mu.Lock()
			t := s.fallbackTimer
			s.mu.Unlock()
			if t != nil {
				t.Stop()
			}
			// IMPORTANT (Codex round 6 high): MessageManifest does NOT
			// implicitly reset outbound. Only MessageResumeDownload
			// resets — keeping these two semantics separate prevents
			// any non-retry source (e.g. peer watcher echo, periodic
			// re-bootstrap) from silently undoing a user cancel.
			//
			// When stopped, we still parse + fire the onPeerManifest
			// hook so daemon's syncd Service has fresh
			// PeerManifestFiles for its barrier accounting. We just
			// SKIP the DiffManifest + outbound.enqueue step — any
			// enqueue would be cleared on sendLoop's next stopped-
			// check anyway, but avoiding it saves CPU and keeps the
			// "stopped means stopped" invariant strict.
			remote, perr := ParseManifest(msg.Data)
			if perr != nil {
				log.Printf("sync recv: parse manifest: %v (ignoring)", perr)
				continue
			}
			s.applyManifestPause(remote, msg.RepoURL)
			stopped := s.isOutboundStopped()
			var toSend, toDelete []FileInfo
			if !stopped {
				var derr error
				toSend, toDelete, derr = s.engine.DiffManifest(remote)
				if derr != nil {
					log.Printf("sync recv: diff manifest: %v (ignoring)", derr)
					continue
				}
				// Push diff results onto the sendLoop's path-set queue.
				// Same-path entries coalesce; send/delete are mutually
				// exclusive: the last enqueue for a path wins.
				for _, p := range toSend {
					s.outbound.enqueue(outboundTask{
						kind:        outboundForcedSend,
						path:        p.Path,
						info:        p,
						bypassPause: s.engine.isForceAllowed(p.Path, false) || isAttachUploadRel(p.Path),
					})
				}
				// Suppress outbound-delete enqueue for staging-bind
				// sessions: a snapshot upload-staging bind that sees a
				// peer manifest with files our local doesn't have
				// (because the peer is reusing a workspace name with
				// pre-existing tombstones) would otherwise enqueue 89
				// MessageDelete and wipe the peer's workspace — the
				// production wipe path. download-staging is similarly
				// not allowed to push deletes back.
				if !s.IsSuppressOutboundDeletes() {
					for _, ti := range toDelete {
						s.outbound.enqueue(outboundTask{
							kind:        outboundForcedDelete,
							path:        ti.Path,
							info:        ti,
							bypassPause: s.engine.isForceAllowed(ti.Path, false) || isAttachUploadRel(ti.Path),
						})
					}
				} else if len(toDelete) > 0 {
					log.Printf("sync recv: outbound-delete suppressed for %d paths (staging session): first=%q", len(toDelete), toDelete[0].Path)
				}
			}
			s.noteManifest()
			s.mu.Lock()
			hook := s.onPeerManifest
			s.mu.Unlock()
			if hook != nil {
				hook(len(remote), msg.RepoURL)
			}
			// One log line per peer manifest. The "stopped" flag is
			// surfaced so an operator can correlate "peer sent a
			// manifest but we didn't enqueue anything" with the
			// cancel state.
			log.Printf("sync recv: peer manifest: peer_files=%d toSend=%d toDelete=%d stopped=%v repo=%q",
				len(remote), len(toSend), len(toDelete), stopped, msg.RepoURL)
			continue
		case transport.MessageDelete:
			// Sub-commit E: inbound deletes from server are authoritative
			// (someone deleted a file in cloud, local mirror should
			// reflect). The wipe scenario was OUTBOUND-only — daemon
			// pushing deletes — and is closed by sub-commit C +
			// outbound gates in this same file. Trust server here.
			s.recordRemoteActivity(msg.Path)
			if err := s.engine.ApplyDelete(msg); err != nil {
				if isFatalApplyError(err) {
					return err
				}
				log.Printf("sync recv: apply delete %s: %v (continuing)", msg.Path, err)
				s.queueFileStatus(msg.Path, transport.FileStatusError)
				continue
			}
			// Mirror the file-write success path (line below at
			// MessageFileDone): emit FileStatusSynced so the peer's
			// ackWaiter for this path fires. Without this, an
			// uploader waiting on per-path ack to close a sync-task
			// barrier hangs forever whenever the sync contains a
			// successful delete-apply. Caught by sync-task succeeded
			// barrier work (kari-desktop daemon PR).
			s.queueFileStatus(msg.Path, transport.FileStatusSynced)
			s.noteActivity()
		case transport.MessageFileMeta:
			// Sub-commit E: inbound file pushes from server are
			// authoritative (new file added in cloud, local mirror
			// receives). The wipe scenario was OUTBOUND-only and is
			// closed by sub-commit C; trusting server-pushed files
			// here is exactly the cloud→local sync user expectation
			// for syncthing-backed workspaces.
			s.recordRemoteActivity(msg.Path)
			// Try the streaming path first. BeginReceive may return
			// (nil, nil) for paths the engine wants on the legacy
			// buffered path (proposals, gitignored). Real errors
			// flow through the same fatal/non-fatal split as ApplyFile.
			// PR2 Phase 1 commit 4 round-1 fix: discard the old
			// PendingWrite BEFORE BeginReceive starts the new one.
			// Both transferAbort (called by old.pw.Discard) and
			// transferBegin (called by BeginReceive) touch
			// engine.transfers at the same key "down:<path>". If we
			// reordered begin-then-discard, the old's abort would
			// write Error onto the FRESHLY-created new row, and
			// Desktop would derive `failed` for an in-flight
			// transfer. With discard-first the abort marks the
			// doomed old row and BeginReceive's transferBegin then
			// cleanly overwrites with a fresh row (zero-value
			// Error / abortedAt). recvLoop is serial per session,
			// so no parallel file_meta arrives for the same path
			// during the brief window between the two engine.mu
			// cycles.
			s.mu.Lock()
			old := s.pending[msg.Path]
			delete(s.pending, msg.Path)
			s.mu.Unlock()
			if old != nil && old.pw != nil {
				old.pw.Discard()
			}
			// EARLY drop-mode for ignored paths (Codex round 9 #1).
			// Skip BeginReceive entirely — its (nil, nil) return would
			// route us to the legacy-buffered branch where every chunk
			// gets appended to a [][]byte before final drop. With
			// drop-mode the chunks evaporate on arrival, peer still
			// receives a Synced ack so it doesn't re-push, and
			// noteActivity is intentionally NOT called (nothing was
			// committed; the sync-task plateau path must not mistake
			// dropped ignored bytes for forward progress).
			if s.engine.ShouldIgnoreInbound(msg.Path) {
				s.mu.Lock()
				s.pending[msg.Path] = &pendingFile{meta: msg, drop: true}
				s.mu.Unlock()
				continue
			}
			pw, err := s.engine.BeginReceive(msg)
			if err != nil {
				if isFatalApplyError(err) {
					return err
				}
				log.Printf("sync recv: begin %s: %v (continuing)", msg.Path, err)
				s.queueFileStatus(msg.Path, transport.FileStatusError)
				continue
			}
			s.mu.Lock()
			s.pending[msg.Path] = &pendingFile{meta: msg, pw: pw}
			s.mu.Unlock()
		case transport.MessageFileChunk:
			s.mu.Lock()
			p := s.pending[msg.Path]
			s.mu.Unlock()
			if p == nil {
				// Unknown path (peer raced a delete, or we already
				// dropped the file_meta due to begin-receive error).
				// Silently ignore — file_done for the same path will
				// also miss and we'll surface the issue then.
				continue
			}
			if p.drop {
				// Path was matched by .gitignore / .kariignore on
				// file_meta arrival. Discard chunks on the floor —
				// no buffer, no copy, no Write. Saves the RAM the
				// pre-fix legacy-buffered path was paying for ignored
				// files (Codex round 9 #1).
				continue
			}
			if p.pw != nil {
				if werr := p.pw.Write(msg.Data); werr != nil {
					// Disk-side write failed (no space, permission
					// flipped mid-stream, etc). Tear this file down
					// and keep the stream alive for the rest.
					p.pw.Discard()
					s.mu.Lock()
					delete(s.pending, msg.Path)
					s.mu.Unlock()
					log.Printf("sync recv: write %s: %v (continuing)", msg.Path, werr)
					s.queueFileStatus(msg.Path, transport.FileStatusError)
				}
			} else {
				// Legacy buffered path (proposal-router targets).
				s.mu.Lock()
				p.chunks = append(p.chunks, append([]byte(nil), msg.Data...))
				s.mu.Unlock()
			}
		case transport.MessageFileDone:
			s.mu.Lock()
			p := s.pending[msg.Path]
			delete(s.pending, msg.Path)
			s.mu.Unlock()
			if p == nil {
				// Either we never saw a file_meta (protocol violation)
				// or BeginReceive failed and we never added pending.
				// Treat as non-fatal: the per-meta error log already
				// said what was wrong.
				continue
			}
			if p.drop {
				// Path was matched by .gitignore / .kariignore on
				// file_meta arrival; chunks were discarded en route.
				// Ack synced so the peer marks this path as "they
				// have it" + stops re-pushing on its next manifest
				// diff. NO noteActivity — nothing was committed to
				// disk; bumping LastActivityAt would mislead the
				// sync-task plateau path into treating ignored
				// bytes as forward progress.
				s.queueFileStatus(msg.Path, transport.FileStatusSynced)
				continue
			}
			p.meta.Hash = msg.Hash
			p.meta.Version = msg.Version
			var applyErr error
			if p.pw != nil {
				applyErr = p.pw.Commit(msg.Hash, msg.Version)
				if applyErr != nil {
					p.pw.Discard()
				}
			} else {
				applyErr = s.engine.ApplyFile(p.meta, p.chunks)
			}
			if applyErr != nil {
				if isFatalApplyError(applyErr) {
					s.queueFileStatus(msg.Path, transport.FileStatusError)
					return applyErr
				}
				log.Printf("sync recv: apply file %s: %v (continuing)", msg.Path, applyErr)
				s.queueFileStatus(msg.Path, transport.FileStatusError)
				continue
			}
			s.queueFileStatus(msg.Path, transport.FileStatusSynced)
			s.noteActivity()
		case transport.MessageFileStatus:
			// control-only: ignore peer file_status. In this mode we
			// never send file_meta / file_chunk / file_delete so the
			// peer has nothing legitimate to ack about; an arriving
			// status is either a stale-bind echo or a misrouted frame.
			// queueRetryAfterPeerError on FileStatusError could enqueue
			// outbound deletes (codex review caveat) — gating here keeps
			// the queue clean and the wipe contract intact even before
			// MessageResumeDownload would (defended below) re-open
			// outbound.
			if s.IsControlOnly() {
				log.Printf("sync recv: control-only mode — dropping MessageFileStatus path=%q stream=%s", msg.Path, msg.Stream)
				continue
			}
			// Forwarded from the peer - nothing to apply locally; the wire
			// itself carries the notification to whoever is wrapping this
			// stream (the Rust client forwards it to lapce-app for the file
			// tree dot rendering).
			//
			// Two side-effects fire on inbound status from the peer:
			//   - synced: PtyAttach registers ackWaiters on the engine
			//     before triggering a sync so it can block its HTTP reply
			//     until the drop-image lands; release them here.
			//   - error: the peer couldn't apply the file/delete we sent.
			//     Route the path to the right retry queue so we don't
			//     silently drop the sync.
			if msg.Origin != s.engine.origin {
				switch msg.Stream {
				case transport.FileStatusSynced:
					s.engine.notifyUpAck(msg.Path)
				case transport.FileStatusError:
					s.queueRetryAfterPeerError(msg.Path)
				}
			}
			continue
		case transport.MessageTextOp:
			// Sub-commit E: inbound OT edits from server are
			// authoritative (collaborative edit applied in cloud,
			// local mirror should reflect). The original sub-commit-A
			// drop was paranoid — same trust-server-authority story
			// as MessageDelete + MessageFileMeta above.
			s.recordRemoteActivity(msg.Path)
			if err := s.engine.ApplyTextOp(msg); err != nil {
				if isFatalApplyError(err) {
					s.queueFileStatus(msg.Path, transport.FileStatusError)
					return err
				}
				log.Printf("sync recv: apply text op %s: %v (continuing)", msg.Path, err)
				s.queueFileStatus(msg.Path, transport.FileStatusError)
				continue
			}
			s.queueFileStatus(msg.Path, transport.FileStatusSynced)
			s.noteActivity()
		case transport.MessageBootstrapResult:
			var res transport.BootstrapResult
			if perr := json.Unmarshal(msg.Data, &res); perr != nil {
				log.Printf("sync recv: parse bootstrap result: %v", perr)
				continue
			}
			s.mu.Lock()
			hook := s.onBootstrapResult
			s.mu.Unlock()
			if hook != nil {
				hook(res)
			}
			continue
		case transport.MessageBootstrap:
			// Server side path. Daemons leave bootstrapHandler nil so
			// this is a silent no-op for them; cmd/server installs a
			// handler that runs git clone. Long-running work goes in a
			// goroutine — recvLoop must not block or heartbeats stall.
			s.mu.Lock()
			handler := s.bootstrapHandler
			s.mu.Unlock()
			if handler == nil {
				log.Printf("sync recv: MessageBootstrap ignored (no handler)")
				continue
			}
			var req transport.BootstrapRequest
			if perr := json.Unmarshal(msg.Data, &req); perr != nil {
				log.Printf("sync recv: parse bootstrap req: %v", perr)
				continue
			}
			go func(req transport.BootstrapRequest) {
				emit := func(res transport.BootstrapResult) {
					select {
					case s.bootstrapResOut <- res:
					default:
						log.Printf("sync recv: bootstrapResOut full, dropping progress for %s", redact.URL(req.GitURL))
					}
				}
				res := handler(req, emit)
				select {
				case s.bootstrapResOut <- res:
				default:
					select {
					case <-s.bootstrapResOut:
					default:
					}
					select {
					case s.bootstrapResOut <- res:
					default:
						log.Printf("sync recv: bootstrapResOut full, dropping result for %s", redact.URL(req.GitURL))
					}
				}
			}(req)
			continue
		case transport.MessageListSessions:
			// Server side. Daemons leave the handler nil; cmd/server
			// installs one. Pure I/O over a few directories — fine to
			// run inline rather than in a goroutine, but keep the
			// goroutine for symmetry with bootstrap so a slow scan
			// doesn't stall heartbeats.
			s.mu.Lock()
			lhandler := s.listSessionsHandler
			s.mu.Unlock()
			if lhandler == nil {
				log.Printf("sync recv: MessageListSessions ignored (no handler)")
				continue
			}
			var req transport.ListSessionsRequest
			if perr := json.Unmarshal(msg.Data, &req); perr != nil {
				log.Printf("sync recv: parse list sessions req: %v", perr)
				continue
			}
			go func(req transport.ListSessionsRequest) {
				res := lhandler(req)
				select {
				case s.listSessionsResOut <- res:
				default:
					log.Printf("sync recv: listSessionsResOut full, dropping result")
				}
			}(req)
			continue
		case transport.MessageListSessionsResult:
			// Daemon side. Forward to the in-flight waiter (if any).
			// A late reply with no waiter just gets dropped — that
			// happens when the daemon's HTTP handler timed out and
			// already cleared the waiter slot.
			var lres transport.ListSessionsResult
			if perr := json.Unmarshal(msg.Data, &lres); perr != nil {
				log.Printf("sync recv: parse list sessions result: %v", perr)
				continue
			}
			s.mu.Lock()
			waiter := s.listSessionsWaiter
			s.listSessionsWaiter = nil
			s.mu.Unlock()
			if waiter != nil {
				select {
				case waiter <- lres:
				default:
				}
			}
			continue
		case transport.MessageForceAllow:
			s.mu.Lock()
			handler := s.forceAllowHandler
			s.mu.Unlock()
			if handler == nil {
				log.Printf("sync recv: MessageForceAllow ignored (no handler)")
				select {
				case s.forceAllowResOut <- transport.ForceAllowResult{OK: false, Error: "force allow unsupported by peer"}:
				default:
				}
				continue
			}
			var req transport.ForceAllowRequest
			if perr := json.Unmarshal(msg.Data, &req); perr != nil {
				log.Printf("sync recv: parse force allow req: %v", perr)
				select {
				case s.forceAllowResOut <- transport.ForceAllowResult{OK: false, Error: "bad force allow request"}:
				default:
				}
				continue
			}
			res := handler(req)
			select {
			case s.forceAllowResOut <- res:
			default:
				log.Printf("sync recv: forceAllowResOut full, dropping result")
			}
			continue
		case transport.MessageForceAllowResult:
			var res transport.ForceAllowResult
			if perr := json.Unmarshal(msg.Data, &res); perr != nil {
				log.Printf("sync recv: parse force allow result: %v", perr)
				continue
			}
			s.mu.Lock()
			waiter := s.forceAllowWaiter
			s.forceAllowWaiter = nil
			s.mu.Unlock()
			if waiter != nil {
				select {
				case waiter <- res:
				default:
				}
			}
			continue
		case transport.MessagePtyCountUpdate:
			update := transport.PtyCountUpdate{
				WorkspaceID: msg.WorkspaceID,
				PtyCount:    msg.PtyCount,
			}
			if update.PtyCount < 0 {
				update.PtyCount = 0
			}
			s.mu.Lock()
			hook := s.onPtyCountUpdate
			s.mu.Unlock()
			if hook != nil {
				hook(update)
			}
			continue
		case transport.MessageLocalExecRequest:
			// Daemon side. Servers leave the handler nil — silent drop
			// keeps the wire compatible if a misbehaving peer ever sends
			// it the wrong direction.
			s.mu.Lock()
			h := s.localExecHandler
			s.mu.Unlock()
			if h == nil {
				log.Printf("sync recv: MessageLocalExecRequest ignored (no handler)")
				continue
			}
			var req transport.LocalExecRequest
			if perr := json.Unmarshal(msg.Data, &req); perr != nil {
				log.Printf("sync recv: parse local exec req: %v", perr)
				continue
			}
			if req.RequestID == "" {
				log.Printf("sync recv: local exec req missing request_id, dropping")
				continue
			}
			reqCtx, reqCancel := context.WithCancel(ctx)
			s.mu.Lock()
			if _, exists := s.localExecActive[req.RequestID]; exists {
				s.mu.Unlock()
				reqCancel()
				log.Printf("sync recv: duplicate local exec request_id %s, dropping", req.RequestID)
				continue
			}
			s.localExecActive[req.RequestID] = reqCancel
			s.mu.Unlock()
			go func(req transport.LocalExecRequest, reqCtx context.Context, reqCancel context.CancelFunc) {
				defer func() {
					s.mu.Lock()
					delete(s.localExecActive, req.RequestID)
					s.mu.Unlock()
					reqCancel()
				}()
				emit := func(o transport.LocalExecOutput) {
					o.RequestID = req.RequestID
					select {
					case s.localExecOutputOut <- o:
					case <-reqCtx.Done():
					}
				}
				done := h(reqCtx, req, emit)
				done.RequestID = req.RequestID
				select {
				case s.localExecDoneOut <- done:
				case <-ctx.Done():
				}
			}(req, reqCtx, reqCancel)
			continue
		case transport.MessageLocalExecOutput:
			// Server side. Route by RequestID to the waiter installed by
			// SendLocalExecRequest. Late chunks (after Done cleaned up
			// the waiter) are dropped silently — RouteLocalExec already
			// returned to its caller.
			var out transport.LocalExecOutput
			if perr := json.Unmarshal(msg.Data, &out); perr != nil {
				log.Printf("sync recv: parse local exec output: %v", perr)
				continue
			}
			s.mu.Lock()
			waiter := s.localExecWaiters[out.RequestID]
			s.mu.Unlock()
			if waiter == nil {
				continue
			}
			select {
			case waiter <- LocalExecEvent{Output: &out}:
			default:
				// Receiver fell behind. Block briefly so we don't lose
				// output on a momentary stall, but not forever — a stuck
				// MCP bridge must not wedge recvLoop and starve sync.
				timer := time.NewTimer(2 * time.Second)
				select {
				case waiter <- LocalExecEvent{Output: &out}:
				case <-timer.C:
					log.Printf("sync recv: local exec output waiter slow for %s, dropping chunk seq %d", out.RequestID, out.Seq)
				}
				timer.Stop()
			}
			continue
		case transport.MessageLocalExecDone:
			// Server side. Final event: deliver, then close+delete the
			// waiter so the caller's range loop exits.
			var done transport.LocalExecDone
			if perr := json.Unmarshal(msg.Data, &done); perr != nil {
				log.Printf("sync recv: parse local exec done: %v", perr)
				continue
			}
			s.mu.Lock()
			waiter := s.localExecWaiters[done.RequestID]
			delete(s.localExecWaiters, done.RequestID)
			s.mu.Unlock()
			if waiter == nil {
				continue
			}
			select {
			case waiter <- LocalExecEvent{Done: &done}:
			case <-time.After(2 * time.Second):
				log.Printf("sync recv: local exec done waiter slow for %s, dropping", done.RequestID)
			}
			close(waiter)
			continue
		case transport.MessageLocalExecCancel:
			// Daemon side. Look up the active context and cancel — the
			// runner's defer will emit a final Done so the server's
			// waiter still completes cleanly.
			var c transport.LocalExecCancel
			if perr := json.Unmarshal(msg.Data, &c); perr != nil {
				log.Printf("sync recv: parse local exec cancel: %v", perr)
				continue
			}
			s.mu.Lock()
			cancel := s.localExecActive[c.RequestID]
			s.mu.Unlock()
			if cancel != nil {
				cancel()
			}
			continue
		case transport.MessageCancelDownload:
			// Peer (the downloading recipient) cancelled an in-flight
			// download. STICKY: aborts the in-flight sendFile at its
			// next chunk-loop ctx.Err() check, purges the queued
			// outbound tasks, AND keeps outbound paused until an
			// explicit MessageResumeDownload (Codex round 3 #1).
			// Session stays alive — heartbeat, recvLoop, all
			// unrelated sendLoop cases continue.
			var payload transport.CancelDownloadPayload
			if perr := json.Unmarshal(msg.Data, &payload); perr != nil {
				log.Printf("sync recv: parse cancel download: %v", perr)
				continue
			}
			s.cancelOutbound(payload.Reason)
			continue
		case transport.MessageResumeDownload:
			// control-only: refuse to clear outboundStopped. resetOutbound
			// flips the sticky stop set by Run entry (codex review
			// MUST-FIX). Allowing it would let a peer chain Cancel+Resume
			// to re-open our file plane and then push deletes / files we
			// just blocked above — full bypass of the wipe contract.
			if s.IsControlOnly() {
				log.Printf("sync recv: control-only mode — dropping MessageResumeDownload (would clear outboundStopped)")
				continue
			}
			// Peer (the downloading recipient) started or retried a
			// download. Resume outbound if currently stopped — the
			// Desktop retry path (downloadProject → bindProjectIfPossible
			// → postSyncTask) doesn't rebuild the session or trigger a
			// fresh MessageManifest when the workspace is already
			// bound, so without this explicit signal the peer would
			// stay outbound-stopped after cancel-then-retry and the
			// retry would silently do nothing (Codex round 4).
			// Idempotent: resetOutbound is a no-op on a non-stopped
			// session.
			var payload transport.ResumeDownloadPayload
			if perr := json.Unmarshal(msg.Data, &payload); perr != nil {
				log.Printf("sync recv: parse resume download: %v", perr)
				continue
			}
			s.resetOutbound(ctx)
			continue
		case transport.MessageError:
			return fmt.Errorf("remote error: %s", msg.Error)
		default:
			return fmt.Errorf("unexpected sync message type: %s", msg.Type)
		}
	}
}

// isFatalApplyError decides whether an error returned by engine.Apply*
// should tear the entire sync stream down. The default answer is "no" —
// one chmod-000 file, one disk-full hiccup, one hash-mismatch retry
// should never erase every other in-flight file from the session. We
// escalate to fatal only for errors that indicate the stream itself
// is unrecoverable (context cancel, premature EOF surfaced from inside
// engine code) or that point at protocol-level peer misbehavior
// (ErrPathEscapesRoot — the peer is sending paths outside the sync
// root, which under non-malicious conditions can't happen).
func isFatalApplyError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if errors.Is(err, ErrPathEscapesRoot) {
		return true
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.ErrClosedPipe) {
		return true
	}
	return false
}

func (s *Session) recordRemoteActivity(path string) {
	if path == "" {
		return
	}
	s.mu.Lock()
	hook := s.onRemoteActivity
	s.mu.Unlock()
	if hook != nil {
		hook(path)
	}
}

// queueRetryAfterPeerError reroutes a peer-reported FileStatusError so the
// failed write doesn't get silently forgotten. Live files are marked dirty
// and re-enter the normal rescan path; tombstones enqueue a fresh forced
// delete into the outbound path-set queue.
func (s *Session) queueRetryAfterPeerError(rel string) {
	if rel == "" {
		return
	}
	kind, version := s.engine.ClassifyForRetry(rel)
	switch kind {
	case RetryAsLive:
		s.engine.markIndexDirty()
	case RetryAsDelete:
		// Staging sessions never propagate outbound deletes — see
		// suppressOutboundDeletes field doc. A peer error pointing
		// at a path the engine classifies as RetryAsDelete in a
		// staging session would otherwise leak the wipe path the
		// other gates close.
		if s.IsSuppressOutboundDeletes() {
			log.Printf("sync recv: queueRetryAfterPeerError suppressed delete for path=%q (staging session)", rel)
			return
		}
		s.outbound.enqueue(outboundTask{
			kind:        outboundForcedDelete,
			path:        rel,
			info:        FileInfo{Path: rel, Deleted: true, Version: version},
			bypassPause: s.engine.isForceAllowed(rel, false) || isAttachUploadRel(rel),
		})
	case RetryNoop:
		log.Printf("sync recv: peer error for unknown path %s (ignoring)", rel)
	}
}
