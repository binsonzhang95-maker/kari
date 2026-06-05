package syncd

import (
	"errors"
	"log"
	"strings"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/filesync"
)

// sync_task_service.go is the glue between Service and SyncTaskManager.
// The manager is a pure state machine; this file builds the
// BarrierSnapshot from live Service / Session state on every tick.
//
// HTTP handlers (routes.go) call:
//   - Service.CreateSyncTask         — POST /v1/sync-tasks
//   - Service.GetSyncTask            — GET  /v1/sync-tasks/:id
//   - Service.ActiveSyncTasks        — GET  /v1/sync-tasks?active=true
//   - Service.CurrentSyncTask        — GET  /v1/sync-tasks/current?workspace_name=...
//   - Service.CancelSyncTask         — POST /v1/sync-tasks/:id/cancel
//
// All read endpoints call tickSyncTasks() at entry so the returned
// state reflects the current barrier without needing a separate
// goroutine. Desktop polls every ~1s, so per-poll Tick cost is
// negligible.

// ensureSyncTasksLocked lazily creates the manager on first use.
// Service.mu MUST be held.
func (s *Service) ensureSyncTasksLocked() {
	if s.syncTasks == nil {
		s.syncTasks = NewSyncTaskManager()
	}
}

// CreateSyncTask is the entry for POST /v1/sync-tasks. Validates the
// daemon is bound, then asks the manager for a new (or idempotent)
// task and kicks the existing session via TriggerSync so the kick
// reaches engine.Watch immediately.
func (s *Service) CreateSyncTask(direction TaskDirection, initiator string) (*SyncTask, bool, error) {
	if direction == "" {
		direction = TaskDirectionBoth
	}
	s.mu.Lock()
	bound := s.bind
	s.ensureSyncTasksLocked()
	mgr := s.syncTasks
	wsName := s.workspaceName
	sess := s.activeSession
	s.mu.Unlock()
	if bound.WorkspaceID == "" {
		return nil, false, errors.New("daemon not bound to a workspace yet")
	}
	// L2 sub-commit B: refuse legacy sync tasks on a syncthing-backed
	// workspace bind without staging_id. The staging-bound upload/
	// download paths (bind_kind=upload-staging / download-staging,
	// staging_id non-empty) pass this gate cleanly — that's the whole
	// snapshot pipeline. Anything else trying to fire bidirectional
	// or legacy direction=both is exactly the wipe path; reject it
	// with the typed error so the HTTP routes can emit 409 +
	// syncthing_explicit_sync_only. Placed before mgr.Create so the
	// manager's Active/Current tables stay clean — no half-created
	// rejected tasks visible to /v1/sync-tasks?active=true polling.
	if isControlOnlyBind(bound) {
		return nil, false, &SyncthingExplicitSyncOnlyError{Direction: direction}
	}
	if initiator == "" {
		initiator = "manual"
	}
	task, created, err := mgr.Create(bound.WorkspaceID, wsName, direction, initiator)
	if err != nil {
		return nil, false, err
	}
	// For download direction: clear the daemon-side paused flag
	// FIRST, then send the resume signal to the peer so the
	// already-bound (or future-rebound) session goes back to
	// normal. The order matters: if a session rebuild races our
	// resume envelope and runs runOnce → isDownloadPaused, the
	// rebuild must see paused=false so it doesn't re-enter
	// SetStartPaused state.
	if direction == TaskDirectionDownload || direction == TaskDirectionBoth {
		s.clearDownloadPaused(wsName)
		if sess != nil {
			sess.QueueResumeDownload(wsName)
		}
	}
	// Kick the existing session so engine.Watch runs a deep rescan
	// immediately — without this, a pending task would wait for the
	// next rescan tick (default 30s) before progressing.
	_ = s.TriggerSync()
	// Run one immediate tick so Desktop sees pending→running on the
	// first poll if the session is already up.
	s.tickSyncTasks()
	if updated, ok := mgr.Get(task.TaskID); ok {
		return updated, created, nil
	}
	return task, created, nil
}

// GetSyncTask powers GET /v1/sync-tasks/:id. Ticks before reading so
// the snapshot is fresh.
func (s *Service) GetSyncTask(taskID string) (*SyncTask, bool) {
	s.mu.Lock()
	s.ensureSyncTasksLocked()
	mgr := s.syncTasks
	s.mu.Unlock()
	s.tickSyncTasks()
	return mgr.Get(taskID)
}

// ActiveSyncTasks powers GET /v1/sync-tasks?active=true. Empty
// workspaceID = all non-terminal tasks.
func (s *Service) ActiveSyncTasks(workspaceID string) []SyncTask {
	s.mu.Lock()
	s.ensureSyncTasksLocked()
	mgr := s.syncTasks
	s.mu.Unlock()
	s.tickSyncTasks()
	return mgr.Active(workspaceID)
}

// CurrentSyncTask powers GET /v1/sync-tasks/current?workspace_name=...
// Used by Desktop's restart-recovery path.
func (s *Service) CurrentSyncTask(workspaceName string) (*SyncTask, bool) {
	s.mu.Lock()
	s.ensureSyncTasksLocked()
	mgr := s.syncTasks
	s.mu.Unlock()
	s.tickSyncTasks()
	return mgr.Current(workspaceName)
}

// CancelSyncTask powers POST /v1/sync-tasks/:id/cancel. The manager's
// Cancel is idempotent: cancelling an already-terminal task is a
// no-op and returns the existing terminal snapshot.
//
// Phase 1 semantics (matches plan §A2): we mark the task cancelled in
// the manager and let the always-on session keep running. Partial
// files on disk are preserved by design; Desktop keeps the incomplete
// marker so the project stays un-openable until the user retries.
// Future iterations could call svc.Stop()/svc.Start() to actually
// rebuild the session; not needed for the user-visible UX in v1.
func (s *Service) CancelSyncTask(taskID, reason string) (*SyncTask, bool) {
	s.mu.Lock()
	s.ensureSyncTasksLocked()
	mgr := s.syncTasks
	sess := s.activeSession
	s.mu.Unlock()
	got, ok := mgr.Cancel(taskID, reason)
	if !ok || got == nil {
		return got, ok
	}
	// For download direction:
	//   1. Persist the paused flag on the Service so future session
	//      rebinds (reconnect, server bounce) honor the cancel and
	//      don't silently resume. (Codex round 6 blocking.)
	//   2. Tell the current peer (server) to stop pushing right now
	//      via MessageCancelDownload. Best-effort; if the peer drops
	//      this message the next session-rebind path will re-arm
	//      the cancel from #1.
	if got.Direction == TaskDirectionDownload {
		s.markDownloadPaused(got.WorkspaceName)
		if sess != nil {
			sess.QueueCancelDownload(got.WorkspaceName, reason)
		}
	}
	return got, ok
}

// tickSyncTasks builds the current BarrierSnapshot and feeds it to the
// manager. Cheap: O(running tasks). Service.mu is acquired briefly to
// read state.
func (s *Service) tickSyncTasks() {
	now := time.Now()
	s.mu.Lock()
	s.ensureSyncTasksLocked()
	mgr := s.syncTasks
	bound := s.bind
	connected := s.status.Connected
	manifestAt := s.status.ManifestExchangedAt
	lastActivityAt := s.status.LastActivityAt
	pendingOut := s.status.PendingOutbound
	peerManifestFiles := s.status.PeerManifestFiles
	sess := s.activeSession
	s.mu.Unlock()

	// Pull live transfer rows for active-count / error / aggregate
	// progress. Empty when no session is alive.
	var rows []filesync.TransferRow
	if sess != nil {
		rows = sess.EngineTransfers()
	}
	snap := buildBarrierSnapshot(now, bound.WorkspaceID, connected, manifestAt, lastActivityAt, pendingOut, peerManifestFiles, rows)
	mgr.Tick(snap)
	s.maybeAutoReleaseStagingBind()
}

// maybeAutoReleaseStagingBind implements L2 sub-commit D's auto-release
// for stuck staging binds. Called from tickSyncTasks after the manager
// has finished processing state transitions. When the bound workspace
// is a staging-bind (upload-staging / download-staging) AND its latest
// sync_task hit succeeded AND stagingFinalizeGrace has elapsed since,
// we call Stop() to release the run loop. Without this Desktop's
// failure to unbind staging post-commit leaves daemon stuck — wipe is
// still prevented by sub-commit C but the UI reports failure and
// inbound files land in a deleted staging dir.
//
// Latched via stagingFinalizeFired so we don't spam Stop() / log on
// every poll tick. Reset on Bind().
//
// Stop() is invoked in a goroutine to avoid taking the path
// tickSyncTasks → maybeAutoReleaseStagingBind → Stop → cancel-wait
// (Stop blocks the cancel func is non-blocking, but the goroutine
// keeps the contract explicit and safe).
func (s *Service) maybeAutoReleaseStagingBind() {
	s.mu.Lock()
	bound := s.bind
	running := s.running
	wsName := s.workspaceName
	mgr := s.syncTasks
	alreadyFired := s.stagingFinalizeFired
	snapshotEpoch := s.bindEpoch
	s.mu.Unlock()
	if !running || alreadyFired || mgr == nil || wsName == "" {
		return
	}
	if !isStagingBindKind(bound.BindKind) {
		return
	}
	task, ok := mgr.Current(wsName)
	if !ok || task == nil {
		return
	}
	if task.State != TaskStateSucceeded || task.FinishedAt.IsZero() {
		return
	}
	if time.Since(task.FinishedAt) < stagingFinalizeGrace {
		return
	}
	if !s.tryLatchStagingFinalize(snapshotEpoch, wsName) {
		return
	}
	log.Printf("staging bind kind=%q ws=%q task=%s succeeded %.1fs ago — auto-releasing (Desktop did not rebind to workspace path within grace)", bound.BindKind, wsName, task.TaskID, time.Since(task.FinishedAt).Seconds())
	go s.Stop()
}

// tryLatchStagingFinalize re-validates the auto-release preconditions
// under a single mu acquisition, atomically with setting the latch.
// Returns true ONLY when the daemon should stop. Used to close the
// race window codex sub-commit-D round-1 flagged: a concurrent Bind()
// between maybeAutoReleaseStagingBind's first-lock snapshot and the
// final latch+stop would otherwise let auto-release fire against a
// stale bind. bindEpoch increments on every Bind(), so an epoch
// mismatch is the canonical "interleaved Bind" signal.
//
// Extracted as a separate method so the race-detection gate can be
// tested in isolation without needing real concurrency.
func (s *Service) tryLatchStagingFinalize(snapshotEpoch uint64, wsName string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stagingFinalizeFired {
		return false
	}
	if s.bindEpoch != snapshotEpoch {
		return false
	}
	if !s.running {
		return false
	}
	if s.workspaceName != wsName {
		return false
	}
	if !isStagingBindKind(s.bind.BindKind) {
		return false
	}
	s.stagingFinalizeFired = true
	return true
}

// buildBarrierSnapshot collapses transfer rows into the aggregate
// counters the manager consumes. Extracted as a pure helper so the
// snapshot logic can be unit-tested without spinning up a Service.
//
// Active = !Completed && Error == "" && bytes still in flight.
// Lingering Completed=true rows do not count but DO contribute to
// aggregate bytes (so the task's BytesDone/BytesTotal reflects
// what just landed). Rows whose bytes have all arrived
// (BytesTotal > 0 && BytesDone >= BytesTotal) but never flipped
// Completed are also treated as not-in-flight — the engine can
// leave a row at full-bytes when the peer-side file_done never
// arrives (e.g. .gitignore no-op overwrite seen in the wild);
// without this guard the task barrier hangs forever even though
// there is genuinely nothing left to transfer.
func buildBarrierSnapshot(
	now time.Time,
	boundWS string,
	connected bool,
	manifestAt time.Time,
	lastActivity time.Time,
	pendingOutbound int,
	peerManifestFiles int,
	rows []filesync.TransferRow,
) BarrierSnapshot {
	snap := BarrierSnapshot{
		Now:                 now,
		BoundWorkspaceID:    boundWS,
		SessionConnected:    connected,
		ManifestExchangedAt: manifestAt,
		LastActivityAt:      lastActivity,
		PendingOutbound:     pendingOutbound,
		PeerManifestKnown:   !manifestAt.IsZero(),
		PeerManifestFiles:   peerManifestFiles,
	}
	for _, row := range rows {
		// Aggregate progress regardless of state — Desktop wants the
		// bytes meter to keep moving across in-flight and the linger
		// window. Direction-tagged DownloadBytes* exist so the
		// Phase K plateau-settle path can avoid using upload-row
		// progress to falsely declare a download "settled" (Codex
		// round 8 blocking).
		snap.AggregateBytesDone += row.BytesDone
		snap.AggregateBytesTotal += row.BytesTotal
		if row.Direction == "down" {
			snap.DownloadBytesDone += row.BytesDone
			snap.DownloadBytesTotal += row.BytesTotal
		}
		if row.Error != "" {
			snap.HasTransferError = true
			if snap.TransferErrorMessage == "" {
				snap.TransferErrorMessage = strings.TrimSpace(row.Error)
			}
			continue
		}
		if row.Completed {
			continue
		}
		// All bytes in but no Completed flag yet — treat as
		// not-in-flight for barrier purposes.
		if row.BytesTotal > 0 && row.BytesDone >= row.BytesTotal {
			continue
		}
		snap.ActiveTransferCount++
	}
	return snap
}
