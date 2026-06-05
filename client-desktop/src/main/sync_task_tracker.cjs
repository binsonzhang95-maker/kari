// sync_task_tracker — pure (no Electron) module that maps daemon
// /v1/sync-tasks state into sync_state_cache phase transitions, and
// manages the .kari-engine/desktop-download-incomplete marker for
// download tasks.
//
// Contract with the daemon (see plan §A for the full spec):
//
//   - sync-task covers user-explicit actions only: open-triggered
//     background sync, explicit download, explicit upload, manual
//     sync. Background activity (watcher, server push, periodic
//     rescan) is NOT a task; it is aggregated into the active task's
//     bytes (if any) or surfaced via /v1/status separately. As a
//     result, ANY task surfaced via /v1/sync-tasks?active=true should
//     either be in the tracker (we created it) or be a quick stray
//     left over from a previous Desktop run.
//
//   - State machine: pending → running → (succeeded | failed |
//     cancelled). Terminal states stay observable for at least one
//     daemon poll cycle so we can read them.
//
//   - succeeded is the SINGLE source of "synced". Desktop's prior
//     "sync-once returned ok → synced" and "transfer row disappeared
//     → synced" heuristics are both gone.
//
// Tracker entries hold per-task wiring needed to drive cache + marker
// transitions when the daemon reports a terminal state:
//
//   {
//     cacheKey:      string,             // sync_state_cache key
//     workspaceName: string,             // for log/diagnostic only
//     direction:     'upload'|'download'|'both',
//     markerPath:    string | null,      // download → mirror dir;
//                                        // upload → MUST be null
//                                        // (assertion-tested)
//   }
//
// The tracker does not talk to the daemon directly; the main process
// owns HTTP and feeds task records in via applyActiveTasks /
// applyTerminalTask. The tracker mutates the sync_state_cache and
// returns a list of side-effect descriptions (marker removals, task
// cancellations) the caller should apply.

'use strict';

function createSyncTaskTracker(options) {
  const opts = options || {};
  const cache = opts.cache;
  if (!cache || typeof cache.setProjectPhase !== 'function') {
    throw new Error('sync_task_tracker: cache (createSyncStateCache instance) required');
  }
  // Optional logger; falls back to no-op so tests stay quiet.
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {};

  // taskId → entry
  const entries = new Map();
  // cacheKey → taskId reverse index so abandonDownload / restart
  // recovery can find the active task for a given project without
  // walking entries.
  const byCacheKey = new Map();

  function register(taskId, entry) {
    if (!taskId) throw new Error('register: taskId required');
    if (!entry || !entry.cacheKey || !entry.direction) {
      throw new Error('register: cacheKey + direction required');
    }
    if (entry.direction === 'upload' && entry.markerPath != null) {
      // Upload tasks must NEVER carry a marker — uploads never touch
      // the .kari-engine/desktop-download-incomplete file. Catching
      // this at register time makes future maintenance safer than a
      // subtle "marker accidentally gets removed on upload success".
      throw new Error('register: upload entry must have markerPath=null');
    }
    // B6d/B7 — snapshot-mode entries carry the data needed for the
    // post-succeed side effects (commitSnapshotSession for upload,
    // promoteSnapshotSession for download). stagingId is required
    // (session lookup + cleanup). Identity (serverAddr + workspaceName
    // + activationCode) is required so the side-effect handler can
    // call manifest_client. Direction-specific fields (manifestId +
    // previousManifestId for upload; downloadManifestEntries for
    // download) are not asserted here — direction gates the consumer.
    if (entry.snapshotMode) {
      const required = ['stagingId', 'serverAddr', 'workspaceName', 'activationCode'];
      for (const f of required) {
        if (typeof entry[f] !== 'string' || entry[f].length === 0) {
          throw new Error('register: snapshotMode entry requires ' + f);
        }
      }
    }
    const stored = {
      cacheKey: String(entry.cacheKey),
      workspaceName: String(entry.workspaceName || ''),
      direction: String(entry.direction),
      markerPath: entry.markerPath || null,
      snapshotMode: !!entry.snapshotMode,
      // Snapshot-only fields (null for legacy entries — read sites
      // check snapshotMode before consuming).
      stagingId: entry.snapshotMode ? String(entry.stagingId) : null,
      manifestId: entry.snapshotMode ? (entry.manifestId ? String(entry.manifestId) : null) : null,
      previousManifestId: entry.snapshotMode
        ? (entry.previousManifestId === null || typeof entry.previousManifestId === 'string'
            ? entry.previousManifestId
            : null)
        : null,
      serverAddr: entry.snapshotMode ? String(entry.serverAddr) : null,
      workspaceId: entry.snapshotMode ? String(entry.workspaceId || '') : null,
      activationCode: entry.snapshotMode ? String(entry.activationCode) : null,
      manifestPosted: entry.snapshotMode ? !!entry.manifestPosted : false,
      // Download-only: manifest entries captured at prepare time so
      // verify happens against the snapshot of the server state at
      // download start (NOT against whatever the server has now).
      downloadManifestEntries: entry.snapshotMode && Array.isArray(entry.downloadManifestEntries)
        ? entry.downloadManifestEntries
        : null,
      downloadManifestAvailable: entry.snapshotMode ? !!entry.downloadManifestAvailable : false,
    };
    // Drop any prior entry for this cacheKey (e.g. retry), and
    // also clear the previous reverse mapping if the daemon reuses
    // the same taskId for another project. The daemon should key
    // idempotency by workspace_name now, but this keeps old-daemon
    // behaviour from poisoning multiple project cards.
    const prior = byCacheKey.get(stored.cacheKey);
    if (prior && prior !== taskId) entries.delete(prior);
    const previousForTask = entries.get(taskId);
    if (previousForTask && previousForTask.cacheKey !== stored.cacheKey && byCacheKey.get(previousForTask.cacheKey) === taskId) {
      byCacheKey.delete(previousForTask.cacheKey);
    }
    entries.set(taskId, stored);
    byCacheKey.set(stored.cacheKey, taskId);
  }

  function unregister(taskId) {
    const entry = entries.get(taskId);
    if (!entry) return null;
    entries.delete(taskId);
    if (byCacheKey.get(entry.cacheKey) === taskId) {
      byCacheKey.delete(entry.cacheKey);
    }
    return entry;
  }

  function getEntry(taskId) {
    return entries.get(taskId) || null;
  }

  function getEntryByCacheKey(cacheKey) {
    const id = byCacheKey.get(cacheKey);
    if (!id) return null;
    const entry = entries.get(id);
    return entry ? Object.assign({ taskId: id }, entry) : null;
  }

  function size() {
    return entries.size;
  }

  // applyActiveTasks folds a snapshot of currently-active daemon
  // tasks into the cache. Returns a list of pending side effects the
  // caller must perform asynchronously (marker removal). Tracker
  // entries are NOT removed here — terminal handling happens in
  // applyTerminalTask which the caller invokes when an entry's task
  // is no longer in the active set.
  function applyActiveTasks(activeTasks) {
    const sideEffects = [];
    if (!Array.isArray(activeTasks)) return sideEffects;
    for (const task of activeTasks) {
      if (!task || !task.taskId) continue;
      const entry = entries.get(task.taskId);
      if (!entry) {
        // Stray daemon-side task we didn't initiate (e.g. left over
        // from a previous Desktop run, or daemon emitted a task we
        // don't recognize). Cache the progress under the inferred
        // cacheKey so the UI still moves; do not own its lifecycle.
        const cacheKey = inferCacheKey(task);
        if (cacheKey) writePhaseFromTask(cacheKey, task, null);
        else warn('sync_task_tracker: stray task without inferrable cacheKey', task.taskId);
        continue;
      }
      const eff = writePhaseFromTask(entry.cacheKey, task, entry);
      if (eff) sideEffects.push(eff);
    }
    return sideEffects;
  }

  // applyTerminalTask handles a task that has reached succeeded /
  // failed / cancelled. Returns the side effect description (if any)
  // and removes the tracker entry. Caller invokes this after fetching
  // GET /v1/sync-tasks/:id for entries that disappeared from active.
  function applyTerminalTask(task) {
    if (!task || !task.taskId) return null;
    const entry = entries.get(task.taskId);
    const cacheKey = entry ? entry.cacheKey : inferCacheKey(task);
    if (!cacheKey) {
      warn('sync_task_tracker: terminal task without inferrable cacheKey', task.taskId);
      return null;
    }
    const eff = writePhaseFromTask(cacheKey, task, entry);
    if (entry) unregister(task.taskId);
    return eff;
  }

  // writePhaseFromTask is the core state-→-phase mapping. Returns a
  // side effect (marker removal) when the daemon-side completion of a
  // tracked download means the local marker can be cleared. Other
  // transitions are pure cache writes with no I/O.
  function writePhaseFromTask(cacheKey, task, entry) {
    const state = String(task.state || '').toLowerCase();
    // Owned tasks (entry != null) trust the registered direction;
    // ambient tasks (no entry) fall back to whatever daemon reports.
    // Pre-fix `task.direction || entry.direction` let a daemon-side
    // 'both' override the recovery path's forced 'download', which
    // would flip a still-incomplete first-time download into the
    // 'syncing' phase and hide it from isCloudDownloadActive.
    const direction = String((entry && entry.direction) || task.direction || '').toLowerCase();
    const bytesDone = Number(task.bytesDone || 0);
    const bytesTotal = Number(task.bytesTotal || 0);
    const progress = progressFromBytes(bytesDone, bytesTotal);
    switch (state) {
      case 'pending':
        cache.setProjectPhase(cacheKey, 'binding', { taskId: task.taskId });
        return null;
      case 'running': {
        // direction='upload' → 'uploading' chip.
        // direction='both' → 'syncing' chip (open-triggered live sync
        //   over an already-downloaded mirror — distinct from the
        //   first-time-download flow so the renderer can hide stale
        //   'downloading' on openable projects without hiding live
        //   transfer progress on the same project).
        // direction='download' → 'downloading' chip (first-time mirror
        //   creation).
        const phase = direction === 'upload' ? 'uploading' : direction === 'both' ? 'syncing' : 'downloading';
        cache.setProjectPhase(cacheKey, phase, {
          progress,
          bytesDone,
          bytesTotal,
          taskId: task.taskId,
        });
        return null;
      }
      case 'succeeded': {
        // B6d — snapshot-mode upload sessions don't immediately flip
        // to 'synced'. Daemon-succeeded only proves transport-clean;
        // we still need to call commitUploadSnapshot (server CAS via
        // previousManifestId) and cleanupSnapshot. Per plan B8 we
        // write 'verifying' here so the renderer keeps the card in
        // attaching/syncing until the side-effect handler in main.cjs
        // either flips to 'synced' (commit ok) or 'failed' (commit
        // hard failure) / leaves at 'verifying' (commit_race —
        // future retry loop will rebuild).
        if (entry && entry.snapshotMode && entry.direction === 'upload') {
          cache.setProjectPhase(cacheKey, 'verifying', {
            progress: 100,
            bytesDone: bytesTotal || bytesDone,
            bytesTotal,
            taskId: null,
          });
          return {
            kind: 'commitSnapshotSession',
            cacheKey,
            stagingId: entry.stagingId,
            manifestId: entry.manifestId,
            manifestPosted: entry.manifestPosted,
            previousManifestId: entry.previousManifestId,
            serverAddr: entry.serverAddr,
            workspaceId: entry.workspaceId,
            workspaceName: entry.workspaceName,
            activationCode: entry.activationCode,
          };
        }
        // B7 — snapshot download succeeded: daemon-succeeded only proves
        // transport-clean; we still need to verify staging against the
        // manifest (or fall back to transport-only) AND atomic-rename
        // staging→workspace. Cache flips to 'verifying' until the
        // promoteSnapshotSession side-effect completes:
        //   - promote ok → cache='synced' + complete marker written
        //   - verify_failed → cache='failed' + session terminated +
        //     staging cleaned (clean re-fetch on retry; round-1 codex
        //     Important #2)
        //   - promote_failed → cache='failed' + staging cleaned
        //   - promote_rollback_failed → cache='failed' with recoverFrom
        //     message; staging deliberately NOT cleaned (might help
        //     manual recovery)
        // markerPath stays on the FINAL workspace path; handler removes
        // it after atomic promote AND writes the complete-marker.
        if (entry && entry.snapshotMode && entry.direction === 'download') {
          cache.setProjectPhase(cacheKey, 'verifying', {
            progress: 100,
            bytesDone: bytesTotal || bytesDone,
            bytesTotal,
            taskId: null,
          });
          return {
            kind: 'promoteSnapshotSession',
            cacheKey,
            stagingId: entry.stagingId,
            // Pass through manifest entries captured at prepare time so
            // verify checks the exact server state at download-start,
            // not whatever the server has now (which may have moved
            // mid-transfer).
            downloadManifestEntries: entry.downloadManifestEntries,
            downloadManifestAvailable: entry.downloadManifestAvailable,
            markerPath: entry.markerPath,
            serverAddr: entry.serverAddr,
            workspaceId: entry.workspaceId,
            workspaceName: entry.workspaceName,
            activationCode: entry.activationCode,
          };
        }
        // Legacy filesync (or non-snapshot) succeeded — direct synced.
        cache.setProjectPhase(cacheKey, 'synced', {
          progress: 100,
          bytesDone: bytesTotal || bytesDone,
          bytesTotal,
          taskId: null,
        });
        if (entry && entry.direction === 'download' && entry.markerPath) {
          return { kind: 'removeMarker', markerPath: entry.markerPath, cacheKey };
        }
        return null;
      }
      case 'failed': {
        cache.setProjectPhase(cacheKey, 'failed', {
          status: defaultFailedStatusFor(direction),
          error: String(task.error || 'sync_task_failed'),
          taskId: null,
        });
        // B6d — snapshot-mode upload sessions also need to clean
        // the staging dir + mark the session 'failed' so the row
        // doesn't leak into crash_recovery's "needs attention" list
        // forever. Marker retention semantics for download still
        // apply unchanged (uploads have no marker).
        // B6d/B7 — snapshot-mode upload OR download cleanup. Both
        // directions need cleanupSnapshot + session→failed so the
        // row reaches terminal state.
        if (entry && entry.snapshotMode && (entry.direction === 'upload' || entry.direction === 'download')) {
          return {
            kind: 'failSnapshotSession',
            cacheKey,
            stagingId: entry.stagingId,
            direction: entry.direction,
            reason: 'task_failed: ' + String(task.error || 'sync_task_failed'),
          };
        }
        // Marker intentionally retained on failure so user can retry.
        return null;
      }
      case 'cancelled': {
        cache.setProjectPhase(cacheKey, 'cancelled', {
          status: '已取消',
          taskId: null,
        });
        // B6d/B7 — same snapshot session cleanup as on failure (both directions).
        if (entry && entry.snapshotMode && (entry.direction === 'upload' || entry.direction === 'download')) {
          return {
            kind: 'failSnapshotSession',
            cacheKey,
            stagingId: entry.stagingId,
            direction: entry.direction,
            reason: 'task_cancelled',
          };
        }
        // Marker intentionally retained for retry (abandonDownload
        // path is responsible for explicit marker removal when user
        // walks away from the project entirely).
        return null;
      }
      default:
        warn('sync_task_tracker: unknown task.state', task.taskId, state);
        return null;
    }
  }

  // inferCacheKey reconstructs the cacheKey for an ambient daemon
  // task we don't own. Matches sync_state_cache.deriveProjectKey's
  // cloud branch. Returns '' when daemon didn't send enough info.
  function inferCacheKey(task) {
    const wsId = String(task.workspaceId || '').trim();
    const wsName = String(task.workspaceName || '').trim();
    if (wsId && wsName) return `cloud:${wsId}|${wsName}`;
    return '';
  }

  return {
    register,
    unregister,
    getEntry,
    getEntryByCacheKey,
    size,
    applyActiveTasks,
    applyTerminalTask,
    // Test-only inspection helpers.
    _entries: () => new Map(entries),
    _byCacheKey: () => new Map(byCacheKey),
  };
}

function defaultFailedStatusFor(direction) {
  if (direction === 'download') return '下载失败';
  if (direction === 'upload') return '上传失败';
  return '同步失败';
}

function progressFromBytes(done, total) {
  const d = Number(done || 0);
  const t = Number(total || 0);
  if (t <= 0 || d <= 0) return 0;
  if (d >= t) return 100;
  return Math.round((d / t) * 100);
}

module.exports = {
  createSyncTaskTracker,
};
