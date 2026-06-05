package syncd

// SyncTaskManager — phase 1 implementation of the daemon-side task
// lifecycle that backs Desktop's /v1/sync-tasks polling. Tasks model
// USER-INITIATED sync intents only: download / upload / open-triggered
// background sync / manual sync. Watcher / server-push / periodic
// rescans are NOT tasks — they ride on top of the always-on Session
// and surface via /v1/status fields instead.
//
// State machine: pending → running → (succeeded | failed | cancelled).
// Terminal states stay observable for terminalRetention so Desktop can
// observe the transition (it polls roughly every 1s).
//
// Barrier for succeeded (matches plan §A2):
//   - Task's workspace_id matches the currently-bound workspace.
//   - ManifestExchangedAt is non-zero (peer manifest was exchanged
//     at SOME point during this session). Pre-rewrite required the
//     exchange to happen AFTER the task started, but manifests only
//     re-exchange on session reconnect — so every task created
//     mid-session (most uploads, every open-triggered sync on a
//     long-running connection) waited forever for a fresh exchange
//     that never came.
//   - Special case: an explicit download task may succeed when the
//     peer manifest is known-empty. Empty cloud projects are valid;
//     Desktop must stop showing "downloading" forever just because
//     there are zero bytes to pull.
//   - Outbound queue empty (Status.PendingOutbound == 0).
//   - Active transfers empty (no row in Engine.Transfers() that is
//     still in-flight, i.e. Completed=false && Error="").
//   - Quiet window >= quietWindow (1s with no LastActivityAt bump).
//   - No FileStatusError row in the current transfer snapshot.
//
// Idempotency: Create with the same (workspaceID, direction) as an
// existing pending/running task returns the existing task instead of
// creating a duplicate. Desktop's renderer may re-fire downloadProject
// on a card click before the chip refresh, so duplicate POSTs are
// expected.
//
// Persistence: Phase 1 is in-memory only. Daemon restart loses tasks.
// Desktop's recoverSyncTasksFromMarkers handles the "marker present
// but no current task" case by surfacing it as cancelled — the user
// can retry. Persistence is a follow-up (release notes call this
// out).

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"sort"
	"sync"
	"time"
)

type TaskState string

const (
	TaskStatePending   TaskState = "pending"
	TaskStateRunning   TaskState = "running"
	TaskStateSucceeded TaskState = "succeeded"
	TaskStateFailed    TaskState = "failed"
	TaskStateCancelled TaskState = "cancelled"
)

type TaskDirection string

const (
	TaskDirectionUpload   TaskDirection = "upload"
	TaskDirectionDownload TaskDirection = "download"
	TaskDirectionBoth     TaskDirection = "both"
)

// SyncthingExplicitSyncOnlyError is returned by Service.CreateSyncTask
// when the bound workspace satisfies isControlOnlyBind (SyncBackend ==
// "syncthing" && StagingID == ""). Routes detect this concrete type via
// errors.As to emit a structured 409 response — matching the
// "syncthing_explicit_sync_only" code Desktop's L1 postSyncTask gate
// also returns when it short-circuits before hitting daemon.
//
// Wire contract (HTTP response body):
//
//	{"error":"syncthing_explicit_sync_only","message":"...","direction":"<dir>"}
//
// status 409 Conflict. The /v1/sync-once route MUST NOT fall back to
// TriggerSync on this error — that fallback exists for the pre-bound-
// daemon case (no workspace yet) and would re-open the file plane the
// gate just closed.
type SyncthingExplicitSyncOnlyError struct {
	Direction TaskDirection
}

func (e *SyncthingExplicitSyncOnlyError) Error() string {
	return "syncthing_explicit_sync_only: workspace is syncthing-backed and bound without staging_id; use Upload/Download buttons (staging-bound tasks) instead"
}

// quietWindow is the "no activity for N" requirement in the succeeded
// barrier. 1s matches plan §A2 #5. Var (not const) so tests can shrink.
var quietWindow = 1 * time.Second

// terminalRetention keeps succeeded/failed/cancelled tasks observable
// for one Desktop poll cycle after the transition. Desktop polls every
// ~1s; 30s is generous enough to survive a transient daemon-poll miss.
var terminalRetention = 30 * time.Second

// downloadStallTimeout is the max time a download task may stay
// running with no inbound file activity (LastActivityAt <= t.StartedAt)
// before we fail it with download_stall_no_inbound. Long enough for
// slow server-side scanning of a large workspace (e.g. wordpress with
// thousands of small files on a slow link), short enough that the UI
// surfaces an actual error instead of pretending success on a stuck
// task. Var (not const) so tests can shrink. Companion to the
// download-barrier check that requires at least one inbound commit
// before declaring the task succeeded — see advanceRunningLocked.
var downloadStallTimeout = 5 * time.Minute

// settleWindow is the plateau duration that lets a download task
// close even when ActiveTransferCount > 0 / PendingOutbound > 0. The
// strict barrier (queues empty + 1s quiet) is the ideal close path —
// works when the peer's workspace is static. But large projects with
// build-artifact churn (Vite / esbuild rewriting node_modules/.vite/
// + dist/ continuously) push file_meta on every rewrite; each
// rewrite resets the per-path TransferRow back to BytesDone=0, so
// ActiveTransferCount oscillates and never holds at zero. Strict
// barrier never closes → task stuck at 98% forever → user can't
// open the project even though every important file is on disk.
//
// "Download done" and "live sync caught up" are different concepts.
// settleWindow lets us declare a task done once forward progress has
// plateaued: t.BytesDone (high-water) hasn't grown for this long, so
// any continuing file_meta traffic is the peer re-pushing already-
// covered versions (churn), not delivering new content. We hand off
// the workspace to the user; the session keeps running so churn
// continues to apply in the background.
//
// 30s tuned for typical Vite/esbuild rebuild cadence (~5-15s).
// Var so tests can shrink.
var settleWindow = 30 * time.Second

// SyncTask is the wire shape. JSON tags match Desktop's
// normalizeSyncTask in src/main/main.cjs.
type SyncTask struct {
	TaskID        string        `json:"task_id"`
	WorkspaceID   string        `json:"workspace_id"`
	WorkspaceName string        `json:"workspace_name"`
	Direction     TaskDirection `json:"direction"`
	State         TaskState     `json:"state"`
	BytesDone     int64         `json:"bytes_done"`
	BytesTotal    int64         `json:"bytes_total"`
	Error         string        `json:"error,omitempty"`
	StartedAt     time.Time     `json:"started_at"`
	FinishedAt    time.Time     `json:"finished_at,omitempty"`
	Initiator     string        `json:"initiator"`
	// LastProgressAt is the wall-clock time when BytesDone last
	// crossed a new high-water mark. Drives the plateau-settle path
	// in advanceRunningLocked: Now - LastProgressAt > settleWindow
	// means forward progress has stopped, and any continuing
	// MessageFileMeta traffic is churn (peer re-pushing already-
	// covered versions of files). Not serialized — Desktop doesn't
	// need to see it directly; the settle decision happens inside
	// the daemon. Zero until the first byte-advancing tick.
	LastProgressAt time.Time `json:"-"`
}

func (t SyncTask) isTerminal() bool {
	switch t.State {
	case TaskStateSucceeded, TaskStateFailed, TaskStateCancelled:
		return true
	}
	return false
}

// BarrierSnapshot is the state the Service feeds the manager on each
// tick. The manager uses it to decide pending → running and running →
// succeeded/failed transitions. Decoupling here keeps the manager
// pure (no Service or filesync deps), so tests can drive any
// scenario.
type BarrierSnapshot struct {
	// Now is the wall-clock time the tick is happening at. Injected
	// so tests can advance time deterministically.
	Now time.Time
	// BoundWorkspaceID is the daemon's currently-bound workspace_id.
	// Tasks for any other workspace stay pending (the daemon can't
	// progress them — it has only one workspace bound at a time, per
	// plan high #3).
	BoundWorkspaceID string
	// SessionConnected indicates the filesync.Session is actively
	// connected to the trans-server. Pending tasks transition to
	// running only when this is true.
	SessionConnected bool
	// ManifestExchangedAt is Status.ManifestExchangedAt — the most
	// recent moment the peer's manifest arrived. Zero before any
	// exchange happens.
	ManifestExchangedAt time.Time
	// LastActivityAt is Status.LastActivityAt — last time a real
	// file/delete moved. Quiet-window check measures (Now -
	// LastActivityAt) against quietWindow.
	LastActivityAt time.Time
	// PendingOutbound mirrors Status.PendingOutbound. Non-zero means
	// the engine still has files queued to push.
	PendingOutbound int
	// PeerManifestKnown is true once the daemon has observed a peer
	// manifest for the current session. PeerManifestFiles is meaningful
	// only when this flag is true.
	PeerManifestKnown bool
	// PeerManifestFiles mirrors Status.PeerManifestFiles. 0 means
	// the peer workspace is empty when PeerManifestKnown is true.
	PeerManifestFiles int
	// ActiveTransferCount is the number of TransferRow entries that
	// are still in-flight (Completed=false && Error=""). The Service
	// computes this before calling Tick.
	ActiveTransferCount int
	// HasTransferError is true when ANY transfer row currently has a
	// non-empty Error. The Service computes this before calling Tick.
	// Causes running tasks to transition to failed with the error
	// message attached.
	HasTransferError bool
	// TransferErrorMessage is the first non-empty error string from
	// the transfer snapshot (used for the failed task's Error field).
	TransferErrorMessage string
	// Aggregate progress for the currently-bound workspace's running
	// task. Sum of all (BytesDone, BytesTotal) across in-flight and
	// recently-completed rows in the linger window. Used as the
	// task's BytesDone/BytesTotal so Desktop's progress bar moves.
	//
	// AggregateBytesDone/Total mixes both directions and is what the
	// general barrier (used by upload + both) consumes. Download-side
	// settle logic (Phase K plateau check) MUST NOT use this because
	// a download task with an active upload row would falsely advance
	// LastProgressAt and trigger plateau-settle while no inbound has
	// happened. DownloadBytesDone/Total are the down-only subset for
	// that path (Codex round 8 blocking).
	AggregateBytesDone  int64
	AggregateBytesTotal int64
	DownloadBytesDone   int64
	DownloadBytesTotal  int64
}

// SyncTaskManager owns the task table. Safe for concurrent use.
type SyncTaskManager struct {
	mu    sync.Mutex
	tasks map[string]*SyncTask // taskID → task
	// lastCurrent records the most recent terminal task per
	// (workspace_name, direction). Used by Current() so /current can
	// still return a terminal task after eviction.
	lastCurrentByName map[string]*SyncTask // workspaceName → task (most recent, regardless of direction)
	now               func() time.Time
	idgen             func() string
}

func NewSyncTaskManager() *SyncTaskManager {
	return &SyncTaskManager{
		tasks:             map[string]*SyncTask{},
		lastCurrentByName: map[string]*SyncTask{},
		now:               time.Now,
		idgen:             defaultIDGen,
	}
}

func defaultIDGen() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return "tk_" + hex.EncodeToString(buf[:])
}

// Create posts a new task or returns the existing pending/running
// task for the same (workspaceID, workspaceName, direction) tuple. The bool result
// is true when a new task was created, false when an existing one
// was reused — Desktop ignores this distinction (it stores the
// returned task_id either way) but tests assert against it.
func (m *SyncTaskManager) Create(workspaceID, workspaceName string, direction TaskDirection, initiator string) (*SyncTask, bool, error) {
	if workspaceID == "" {
		return nil, false, errors.New("workspace_id required")
	}
	if !isValidDirection(direction) {
		return nil, false, errors.New("invalid direction")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Idempotency: same workspace_id + workspace_name + overlapping
	// direction with a non-terminal task → reuse. Multiple workdirs
	// share one license workspace_id, so workspaceName MUST be part of
	// the key; otherwise two project downloads reuse one task_id and
	// Desktop's per-project marker/cache lifecycle gets corrupted.
	for _, t := range m.tasks {
		if t.WorkspaceID != workspaceID || t.WorkspaceName != workspaceName {
			continue
		}
		if t.isTerminal() {
			continue
		}
		if directionsOverlap(t.Direction, direction) {
			return cloneTask(t), false, nil
		}
	}
	now := m.now()
	task := &SyncTask{
		TaskID:        m.idgen(),
		WorkspaceID:   workspaceID,
		WorkspaceName: workspaceName,
		Direction:     direction,
		State:         TaskStatePending,
		StartedAt:     now,
		Initiator:     initiator,
	}
	m.tasks[task.TaskID] = task
	return cloneTask(task), true, nil
}

// Get returns one task by ID. Returns nil, false if unknown or evicted.
func (m *SyncTaskManager) Get(taskID string) (*SyncTask, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[taskID]
	if !ok {
		return nil, false
	}
	return cloneTask(t), true
}

// Active returns non-terminal tasks (pending + running), optionally
// filtered by workspace_id. Empty workspaceID = all.
func (m *SyncTaskManager) Active(workspaceID string) []SyncTask {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SyncTask, 0, len(m.tasks))
	for _, t := range m.tasks {
		if t.isTerminal() {
			continue
		}
		if workspaceID != "" && t.WorkspaceID != workspaceID {
			continue
		}
		out = append(out, *cloneTask(t))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// Current returns the most recent task (active OR terminal) for a
// workspace name. nil, false if none. Used by Desktop's
// recoverSyncTasksFromMarkers after a restart.
func (m *SyncTaskManager) Current(workspaceName string) (*SyncTask, bool) {
	if workspaceName == "" {
		return nil, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var best *SyncTask
	for _, t := range m.tasks {
		if t.WorkspaceName != workspaceName {
			continue
		}
		if best == nil || preferTask(t, best) {
			best = t
		}
	}
	if best != nil {
		return cloneTask(best), true
	}
	if t, ok := m.lastCurrentByName[workspaceName]; ok {
		return cloneTask(t), true
	}
	return nil, false
}

// preferTask returns true when `a` should be preferred over `b` for
// Current(): active beats terminal; among same class, more recent
// StartedAt wins.
func preferTask(a, b *SyncTask) bool {
	if a.isTerminal() != b.isTerminal() {
		return !a.isTerminal() // active wins
	}
	return a.StartedAt.After(b.StartedAt)
}

// Cancel transitions a pending or running task to cancelled. No-op on
// terminal tasks. Returns the post-cancel task snapshot, or
// (nil, false) if the task ID is unknown.
func (m *SyncTaskManager) Cancel(taskID string, reason string) (*SyncTask, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[taskID]
	if !ok {
		return nil, false
	}
	if t.isTerminal() {
		return cloneTask(t), true
	}
	prev := t.State
	now := m.now()
	t.State = TaskStateCancelled
	t.FinishedAt = now
	if reason != "" {
		t.Error = reason
	}
	// Synthesize a minimal snapshot for the log line; barrier fields
	// aren't meaningful for an explicit cancel but the elapsed/bytes
	// still are.
	logTaskTransition(t, prev, BarrierSnapshot{Now: now}, "explicit_cancel")
	m.rememberTerminalLocked(t)
	return cloneTask(t), true
}

// Tick advances state for all non-terminal tasks given a fresh
// snapshot. Should be invoked at the top of every HTTP read endpoint
// AND from any other plausible signal (timer, session event hook).
// Cheap — O(n) over the small task table.
func (m *SyncTaskManager) Tick(snap BarrierSnapshot) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tasks {
		switch t.State {
		case TaskStatePending:
			m.advancePendingLocked(t, snap)
		case TaskStateRunning:
			m.advanceRunningLocked(t, snap)
		}
	}
	m.evictExpiredLocked(snap.Now)
}

func (m *SyncTaskManager) advancePendingLocked(t *SyncTask, snap BarrierSnapshot) {
	if !snap.SessionConnected {
		return
	}
	if t.WorkspaceID != snap.BoundWorkspaceID {
		return
	}
	prev := t.State
	t.State = TaskStateRunning
	// Reset StartedAt so Desktop's elapsed-time chip measures from
	// the running window, not the pending wait. The barrier itself
	// no longer compares ManifestExchangedAt against StartedAt — see
	// advanceRunningLocked — but keeping the reset gives the
	// renderer a sensible "task age" anchor.
	t.StartedAt = snap.Now
	logTaskTransition(t, prev, snap, "session_connected")
}

func (m *SyncTaskManager) advanceRunningLocked(t *SyncTask, snap BarrierSnapshot) {
	if t.WorkspaceID != snap.BoundWorkspaceID {
		// Workspace was rebound away from us. We can't drive this
		// task to succeeded without the original session. Mark
		// cancelled so Desktop's UI unsticks; user can retry.
		prev := t.State
		t.State = TaskStateCancelled
		t.FinishedAt = snap.Now
		t.Error = "workspace_unbound"
		logTaskTransition(t, prev, snap, "workspace_unbound")
		m.rememberTerminalLocked(t)
		return
	}
	if !snap.SessionConnected {
		// Session dropped mid-task. Keep running for now; reconnect
		// loop will resume. Only flip to failed via HasTransferError
		// or explicit Cancel.
		return
	}
	// Aggregate progress, even before barrier closes. High-water mark
	// — NEVER let the displayed bytes regress. EngineTransfers()
	// aggregates the CURRENT set of in-flight + 3s-lingering rows, so
	// when a burst of small files completes and then sweeps out of the
	// linger window, the aggregate drops sharply even though the
	// download is genuinely making forward progress. Without this
	// guard the Desktop progress bar oscillates upward and downward,
	// confusing users into thinking the download is regressing.
	//
	// A truly cumulative counter (sum of all bytes ever committed
	// during this task) would be more accurate but needs new engine
	// plumbing — the high-water mark covers the user-facing pain with
	// 4 lines of code. Trade-off: if a transfer GENUINELY fails and
	// rolls back, BytesDone stays at the high mark instead of
	// reflecting the loss; that inaccuracy is invisible to users
	// versus the very visible "progress went backward" bug.
	//
	// Direction-scoped aggregate (Codex round 8 blocking): a download
	// task must NOT count upload-row bytes toward its high-water +
	// LastProgressAt. Otherwise an upload running in parallel (open-
	// triggered sync, or a both-direction task) could keep
	// LastProgressAt fresh and break plateau-settle detection.
	// download → DownloadBytes only; upload / both → AggregateBytes
	// (which includes both directions; "both" is open-triggered sync
	// that legitimately consumes either).
	tickDone := snap.AggregateBytesDone
	tickTotal := snap.AggregateBytesTotal
	if t.Direction == TaskDirectionDownload {
		tickDone = snap.DownloadBytesDone
		tickTotal = snap.DownloadBytesTotal
	}
	if tickDone > t.BytesDone {
		t.BytesDone = tickDone
		t.LastProgressAt = snap.Now
	}
	if tickTotal > t.BytesTotal {
		t.BytesTotal = tickTotal
	}

	// Barrier conditions (all required).
	if t.Direction == TaskDirectionDownload && snap.PeerManifestKnown && snap.PeerManifestFiles == 0 && snap.ActiveTransferCount == 0 {
		prev := t.State
		t.State = TaskStateSucceeded
		t.FinishedAt = snap.Now
		logTaskTransition(t, prev, snap, "empty_peer_download")
		m.rememberTerminalLocked(t)
		return
	}
	// Pre-rewrite required ManifestExchangedAt >= task.StartedAt, but
	// manifests only re-exchange on session reconnect — so every task
	// created mid-session (upload after a save, open-triggered sync
	// on an already-connected workspace) waited forever for a fresh
	// manifest that never came. "Manifest happened at some point this
	// session" is the right floor; queues + quiet window still gate
	// the actual closure below.
	if snap.ManifestExchangedAt.IsZero() {
		return
	}
	// Plateau-settle (Phase K): download direction only. The strict
	// barrier (PendingOutbound==0 + ActiveTransferCount==0 + quiet
	// window) is the IDEAL close path — works perfectly when the
	// peer's workspace is static. But large projects with continuous
	// build-artifact churn (Vite/esbuild rewriting node_modules/.vite/
	// + dist/ thousands of times per hour) keep pushing file_meta on
	// every rewrite; each rewrite resets a TransferRow back to
	// BytesDone=0, so ActiveTransferCount oscillates and never holds
	// at zero long enough for the strict barrier to close. Symptom:
	// download stuck at 98% forever, user can't open the project even
	// though every important file is already on disk.
	//
	// Semantic split: "download a snapshot of the workspace at SOME
	// recent point" is what the user is waiting for. "Live-sync stays
	// caught up to the peer" is what the always-on session does
	// AFTER the task closes. These are two different things; the
	// current task barrier was conflating them.
	//
	// settle path fires when bytes_done (high-water mark, monotonic
	// upward) has not advanced in settleWindow. Forward progress
	// stopped → any ongoing file_meta traffic is the peer re-pushing
	// already-covered versions (churn) rather than delivering new
	// content. Hand off the snapshot we have; session keeps running
	// and continues to apply post-task churn quietly in the
	// background.
	//
	// Gates against false-positive settle (Codex round 8 blocking):
	//   - direction == download: upload tasks have their own settle
	//     semantics (peer's MessageFileStatus ack chains; not in
	//     scope here)
	//   - DownloadBytesDone > 0: never settle a task that hasn't
	//     received ANY inbound bytes (separate downloadStallTimeout
	//     path handles that scenario with an explicit failure).
	//     Critically this is DOWNLOAD bytes only — upload row bytes
	//     in a both-direction task must not fake the gate open.
	//   - LastProgressAt non-zero: belt-and-suspenders for the same
	//     "received bytes" check
	//   - LastActivityAt > t.StartedAt: at least one MessageFileDone
	//     or MessageTextOp has actually COMMITTED to disk since the
	//     task started. BytesDone alone counts chunk progress; a
	//     huge file streaming chunks but never finishing Commit
	//     would advance BytesDone without writing anything to disk.
	//     LastActivityAt is bumped only on real commits (session.go
	//     noteActivity callers), so this gate forbids settling while
	//     all the apparent "progress" is in-flight, not landed.
	//   - plateau > settleWindow: 30s of NO upward movement
	//
	// Done bytes are NOT clamped to total in this path — the UI
	// shows the actual high-water (e.g. "snapshot at 97% of N").
	// The strict-close path below still force-sets BytesDone=BytesTotal
	// when it fires, signaling "everything truly caught up".
	if t.Direction == TaskDirectionDownload &&
		snap.DownloadBytesDone > 0 &&
		!t.LastProgressAt.IsZero() &&
		snap.LastActivityAt.After(t.StartedAt) &&
		snap.Now.Sub(t.LastProgressAt) > settleWindow {
		prev := t.State
		t.State = TaskStateSucceeded
		t.FinishedAt = snap.Now
		logTaskTransition(t, prev, snap, "plateau_settle")
		m.rememberTerminalLocked(t)
		return
	}
	if snap.PendingOutbound > 0 {
		return
	}
	if snap.ActiveTransferCount > 0 {
		return
	}
	// Download with non-empty peer requires AT LEAST one inbound file
	// commit since the task started (LastActivityAt > t.StartedAt)
	// before the barrier may close. Without this, the recipient sees:
	//   - manifest exchanged (peer's manifest with N>0 entries arrived)
	//   - empty outbound (nothing local to push)
	//   - no active transfer YET (server hasn't streamed any file_meta)
	//   - 1s quiet window passed (we've just been waiting on server)
	// and prematurely closes the barrier before any file arrives.
	// Real-world bug: wordpress_one (5000+ files) on slow links —
	// receiver saw "instant download" then opened the mirror to find
	// only the partial set that managed to land before the marker
	// flip. LastActivityAt is only bumped by MessageFileDone /
	// MessageTextOp (see session.go noteActivity callers), so this
	// check guarantees at least one full file has been received +
	// committed to disk before the task closes.
	//
	// If we wait too long (downloadStallTimeout) without ever seeing
	// an inbound, fail explicitly so the UI surfaces an error rather
	// than hanging "downloading…" forever. Common cause: server has
	// only tombstones for this workspace (live count==0 in practice
	// but PeerManifestFiles includes deletes), or a server-side bug
	// silently dropped the recipient's manifest.
	if t.Direction == TaskDirectionDownload && snap.PeerManifestFiles > 0 &&
		!snap.LastActivityAt.After(t.StartedAt) {
		if snap.Now.Sub(t.StartedAt) > downloadStallTimeout {
			prev := t.State
			t.State = TaskStateFailed
			t.FinishedAt = snap.Now
			t.Error = "download_stall_no_inbound"
			logTaskTransition(t, prev, snap, "stall_timeout")
			m.rememberTerminalLocked(t)
			return
		}
		return
	}
	if snap.LastActivityAt.After(snap.Now.Add(-quietWindow)) {
		// Activity within the quiet window — not yet idle.
		return
	}
	// Everything is settled (queues empty, no active transfers, quiet
	// window passed). If a transfer row STILL carries an error message
	// at this point, the engine's retry path (queueRetryAfterPeerError,
	// peer manifest re-send, 3s linger sweep) didn't clear it — it's
	// a real per-file failure rather than a transient. Fail the task
	// with that error.
	//
	// Pre-fix this check ran at the top of advanceRunningLocked and
	// fail-fast'd on any error row, including ones the engine was
	// about to retry. Real-world observation (user-reported DCAI
	// download): files actually arrived on disk, but a single
	// in-linger transferAbort row hit the 2s Desktop poll window and
	// the whole task was marked failed before the retry could
	// overwrite the row. Settling first lets transient errors heal.
	if snap.HasTransferError {
		prev := t.State
		t.State = TaskStateFailed
		t.FinishedAt = snap.Now
		t.Error = snap.TransferErrorMessage
		if t.Error == "" {
			t.Error = "transfer_error"
		}
		logTaskTransition(t, prev, snap, "transfer_error")
		m.rememberTerminalLocked(t)
		return
	}
	// Closed.
	prev := t.State
	t.State = TaskStateSucceeded
	t.FinishedAt = snap.Now
	if t.BytesTotal > 0 {
		t.BytesDone = t.BytesTotal
	}
	logTaskTransition(t, prev, snap, "barrier_closed")
	m.rememberTerminalLocked(t)
}

// logTaskTransition emits one INFO line per state change. Snapshot
// fields are included so an operator reading daemon.log can correlate
// a transition (especially failed / stall_timeout / empty_peer_download)
// with the barrier conditions that produced it. Active-tick logs are
// intentionally NOT emitted — that would flood at ~1Hz per task.
func logTaskTransition(t *SyncTask, prev TaskState, snap BarrierSnapshot, reason string) {
	elapsed := snap.Now.Sub(t.StartedAt).Truncate(time.Millisecond)
	errStr := ""
	if t.Error != "" {
		errStr = " err=" + t.Error
	}
	log.Printf(
		"sync_task: %s ws=%q dir=%s %s->%s reason=%s elapsed=%s bytes=%d/%d peer_files=%d active=%d pending_out=%d activity_after_start=%v%s",
		shortTaskID(t.TaskID),
		t.WorkspaceName,
		t.Direction,
		prev,
		t.State,
		reason,
		elapsed,
		t.BytesDone,
		t.BytesTotal,
		snap.PeerManifestFiles,
		snap.ActiveTransferCount,
		snap.PendingOutbound,
		snap.LastActivityAt.After(t.StartedAt),
		errStr,
	)
}

// shortTaskID returns the first 8 chars of a task_id (after the "tk_"
// prefix if present) for compact log output.
func shortTaskID(taskID string) string {
	const prefix = "tk_"
	id := taskID
	if len(id) > len(prefix) && id[:len(prefix)] == prefix {
		id = id[len(prefix):]
	}
	if len(id) > 8 {
		id = id[:8]
	}
	return id
}

func (m *SyncTaskManager) rememberTerminalLocked(t *SyncTask) {
	if t.WorkspaceName == "" {
		return
	}
	// Always keep the most recent terminal so /current can answer
	// after eviction.
	if existing, ok := m.lastCurrentByName[t.WorkspaceName]; ok {
		if existing.FinishedAt.After(t.FinishedAt) {
			return
		}
	}
	m.lastCurrentByName[t.WorkspaceName] = cloneTask(t)
}

func (m *SyncTaskManager) evictExpiredLocked(now time.Time) {
	for id, t := range m.tasks {
		if !t.isTerminal() {
			continue
		}
		if now.Sub(t.FinishedAt) > terminalRetention {
			delete(m.tasks, id)
		}
	}
}

// directionsOverlap defines the idempotency equivalence: equal
// directions overlap; 'both' overlaps with anything.
func directionsOverlap(a, b TaskDirection) bool {
	if a == b {
		return true
	}
	if a == TaskDirectionBoth || b == TaskDirectionBoth {
		return true
	}
	return false
}

func isValidDirection(d TaskDirection) bool {
	switch d {
	case TaskDirectionUpload, TaskDirectionDownload, TaskDirectionBoth:
		return true
	}
	return false
}

func cloneTask(t *SyncTask) *SyncTask {
	if t == nil {
		return nil
	}
	c := *t
	return &c
}
