'use strict';

// sync_scheduler — PTY-driven sync activation orchestrator.
//
// Plan T5. Wires the PTY project tracker (T4) to a pair-worker the
// caller injects (T6 wires the real syncthing pair flow). Holds the
// concurrent-folder LRU cap so a misbehaving user / runaway script
// can't spawn unbounded syncthing folders.
//
// State machine (per project):
//
//   ┌──────────┐  pty:project:active   ┌──────────┐
//   │  none    │ ────────────────────▶ │  active  │
//   └──────────┘                       └──────────┘
//        ▲                                   │
//        │  pty:project:retire (T4 cooldown)  │
//        │  OR LRU eviction                   │
//        └────────────────────────────────────┘
//
// The pair-worker contract (caller-injected) keeps the scheduler pure:
//
//   await pairWorker.activate({ projectAbsPath, projectRelPath })
//     → { ok: true, folderId } | { ok: false, code, message? }
//
//   await pairWorker.retire({ projectAbsPath, folderId })
//     → { ok: true } | { ok: false, code, message? }
//
// Scheduler tolerates pair-worker failures: a failed activate frees the
// LRU slot (so a misbehaving project doesn't block others); a failed
// retire is logged but the project still leaves the active map (we no
// longer try to sync it — config in syncthing is the caller's problem
// to reconcile out-of-band).

const { EventEmitter } = require('node:events');

const DEFAULT_MAX_CONCURRENT = 5;

// createSyncScheduler returns the scheduler instance + events.
//
// Options:
//   - tracker:        T4 PtyProjectTracker instance (required)
//   - pairWorker:     { activate, retire } (required; see contract above)
//   - maxConcurrent:  hard LRU cap, default 5 (per plan T5)
//   - resolveProject: optional async (projectAbsPath) → { projectRelPath } | null.
//                     Returning null skips activation for that path —
//                     e.g. project lives outside the kari container.
//                     Default: passes projectAbsPath through unchanged
//                     as projectRelPath (caller is responsible for
//                     pre-filtering).
//   - logger:         { info(msg), warn(msg) } — defaults to console.
function createSyncScheduler({
  tracker,
  pairWorker,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  resolveProject,
  logger,
  activationRetryBaseMs = 5_000,
  activationRetryMaxMs = 60_000,
  activationRetryCodes,
  timers,
} = {}) {
  if (!tracker || !tracker.events) {
    throw new Error('sync_scheduler: tracker (T4 pty_project_tracker) is required');
  }
  if (!pairWorker || typeof pairWorker.activate !== 'function' || typeof pairWorker.retire !== 'function') {
    throw new Error('sync_scheduler: pairWorker must expose activate() + retire()');
  }
  const log = logger && typeof logger.warn === 'function'
    ? logger
    : { info: (m) => console.log('[sync-scheduler]', m), warn: (m) => console.warn('[sync-scheduler]', m) };

  const events = new EventEmitter();
  // active: Map<projectAbsPath, { folderId?, addedMs, generation }>
  const active = new Map();
  const retryTimers = new Map();
  const retryAttempts = new Map();
  let generationCounter = 0;
  let stopped = false;
  const setTimeoutFn = (timers && typeof timers.setTimeout === 'function') ? timers.setTimeout : global.setTimeout;
  const clearTimeoutFn = (timers && typeof timers.clearTimeout === 'function') ? timers.clearTimeout : global.clearTimeout;
  const retryableCodes = new Set(Array.isArray(activationRetryCodes) ? activationRetryCodes : [
    'syncthing_not_ready',
    'syncthing_no_meta',
    'request_pair_info_failed',
    'apply_pair_failed',
    'activate_threw',
  ]);

  // Default resolveProject is identity → relPath = abs path. T6 plugs in
  // a real resolver that derives projectRelPath from cfg.workspaceRoot
  // and rejects projects outside the kari container.
  const resolve = typeof resolveProject === 'function'
    ? resolveProject
    : async (projectAbsPath) => ({ projectRelPath: projectAbsPath });

  function findOldestActive() {
    let oldestPath = null;
    let oldestMs = Infinity;
    for (const [p, st] of active) {
      if (st.addedMs < oldestMs) {
        oldestMs = st.addedMs;
        oldestPath = p;
      }
    }
    return oldestPath;
  }

  function trackerStillReferences(projectAbsPath) {
    if (!tracker || typeof tracker.snapshot !== 'function') return false;
    try {
      return tracker.snapshot().some((entry) => (
        entry &&
        entry.projectRoot === projectAbsPath &&
        Number(entry.ptyCount || 0) > 0
      ));
    } catch {
      return false;
    }
  }

  function clearRetry(projectAbsPath) {
    const timer = retryTimers.get(projectAbsPath);
    if (timer) clearTimeoutFn(timer);
    retryTimers.delete(projectAbsPath);
    retryAttempts.delete(projectAbsPath);
  }

  function scheduleActivationRetry(projectAbsPath, code) {
    if (stopped || !retryableCodes.has(String(code || ''))) return;
    if (!trackerStillReferences(projectAbsPath)) return;
    if (retryTimers.has(projectAbsPath)) return;

    const attempt = retryAttempts.get(projectAbsPath) || 0;
    retryAttempts.set(projectAbsPath, attempt + 1);
    const base = Math.max(250, Number(activationRetryBaseMs) || 5_000);
    const max = Math.max(base, Number(activationRetryMaxMs) || 60_000);
    const delay = Math.min(max, base * Math.pow(2, Math.min(attempt, 4)));
    const timer = setTimeoutFn(() => {
      retryTimers.delete(projectAbsPath);
      if (stopped || active.has(projectAbsPath) || !trackerStillReferences(projectAbsPath)) return;
      log.info(`retrying activate for ${projectAbsPath} after ${code}`);
      void onActive(projectAbsPath);
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    retryTimers.set(projectAbsPath, timer);
  }

  // Guard against concurrent same-root entry. onActiveImpl checks active.has()
  // BEFORE its first await but only active.set()s AFTER pairing resolves, so two
  // parallel calls for the SAME project (e.g. bounded-parallel import jobs both
  // touching one root) could both pass that check and double-activate. The
  // in-flight set closes that window; distinct roots remain fully concurrent.
  const onActiveInflight = new Set();
  async function onActive(projectAbsPath) {
    if (onActiveInflight.has(projectAbsPath)) return;
    onActiveInflight.add(projectAbsPath);
    try {
      return await onActiveImpl(projectAbsPath);
    } finally {
      onActiveInflight.delete(projectAbsPath);
    }
  }

  async function onActiveImpl(projectAbsPath) {
    if (stopped) return;
    if (active.has(projectAbsPath)) return; // already active, idempotent
    const pendingRetry = retryTimers.get(projectAbsPath);
    if (pendingRetry) {
      clearTimeoutFn(pendingRetry);
      retryTimers.delete(projectAbsPath);
    }

    const resolved = await resolve(projectAbsPath).catch((err) => {
      log.warn(`resolveProject threw for ${projectAbsPath}: ${err && err.message ? err.message : err}`);
      return null;
    });
    if (!resolved || !resolved.projectRelPath) {
      // Not a kari-synced project — silently ignore.
      return;
    }

    // LRU eviction if at cap.
    while (active.size >= maxConcurrent) {
      const victim = findOldestActive();
      if (!victim) break;
      events.emit('sync:lru:evict', victim);
      // Retire the victim. Failure here doesn't block the new
      // activation — we've already decided to make room.
      const victimEntry = active.get(victim);
      active.delete(victim);
      const r = await pairWorker.retire({ projectAbsPath: victim, folderId: victimEntry && victimEntry.folderId }).catch((err) => ({ ok: false, code: 'retire_threw', message: String(err && err.message || err) }));
      if (!r || !r.ok) {
        log.warn(`LRU evict retire failed for ${victim}: ${(r && r.code) || 'unknown'}`);
      }
    }

    const myGen = ++generationCounter;
    active.set(projectAbsPath, { folderId: null, addedMs: Date.now(), generation: myGen });
    events.emit('sync:activating', projectAbsPath);

    const result = await pairWorker.activate({
      projectAbsPath,
      projectRelPath: resolved.projectRelPath,
    }).catch((err) => ({ ok: false, code: 'activate_threw', message: String(err && err.message || err) }));

    // Verify our generation is still the live one — concurrent retire
    // could have removed our entry. If so, the activate result is dead.
    const cur = active.get(projectAbsPath);
    if (!cur || cur.generation !== myGen) {
      // Race: this project was retired during activation. The pair-
      // worker's activate side-effect (syncthing folder created) is now
      // orphaned; fire a defensive retire so we don't leak a folder.
      if (result && result.ok && result.folderId) {
        await pairWorker.retire({ projectAbsPath, folderId: result.folderId }).catch(() => null);
      }
      return;
    }

    if (!result || !result.ok) {
      log.warn(`activate failed for ${projectAbsPath}: ${(result && result.code) || 'unknown'}`);
      // Free the LRU slot — keeping a failed entry locks the cap.
      active.delete(projectAbsPath);
      events.emit('sync:activate:failed', { projectAbsPath, code: (result && result.code) || 'unknown' });
      scheduleActivationRetry(projectAbsPath, (result && result.code) || 'unknown');
      return;
    }

    cur.folderId = result.folderId || null;
    clearRetry(projectAbsPath);
    events.emit('sync:active', projectAbsPath);
  }

  async function onRetire(projectAbsPath) {
    if (stopped) return;
    clearRetry(projectAbsPath);
    const entry = active.get(projectAbsPath);
    if (!entry) return;
    active.delete(projectAbsPath);
    events.emit('sync:retiring', projectAbsPath);
    const r = await pairWorker.retire({ projectAbsPath, folderId: entry.folderId }).catch((err) => ({ ok: false, code: 'retire_threw', message: String(err && err.message || err) }));
    if (!r || !r.ok) {
      log.warn(`retire failed for ${projectAbsPath}: ${(r && r.code) || 'unknown'}`);
    }
    events.emit('sync:retired', projectAbsPath);
  }

  // Attach the two listeners on the tracker. We bind once at
  // construction so the scheduler is a passive observer.
  const onActiveHandler = (p) => { void onActive(p); };
  const onRetireHandler = (p) => { void onRetire(p); };
  tracker.events.on('pty:project:active', onActiveHandler);
  tracker.events.on('pty:project:retire', onRetireHandler);

  function snapshot() {
    const out = [];
    for (const [projectAbsPath, st] of active) {
      out.push({
        projectAbsPath,
        folderId: st.folderId,
        addedMs: st.addedMs,
      });
    }
    return out;
  }

  // stop unsubscribes from the tracker and rejects further events.
  // By default it retires every active project; app shutdown passes
  // retire:false so Syncthing can persist per-project folder config
  // across restarts instead of rebuilding large folders every launch.
  async function stop(opts = {}) {
    if (stopped) return;
    stopped = true;
    for (const timer of retryTimers.values()) {
      clearTimeoutFn(timer);
    }
    retryTimers.clear();
    retryAttempts.clear();
    tracker.events.off('pty:project:active', onActiveHandler);
    tracker.events.off('pty:project:retire', onRetireHandler);
    const snapshotEntries = [...active.entries()];
    active.clear();
    if (opts && opts.retire === false) return;
    await Promise.all(snapshotEntries.map(async ([projectAbsPath, st]) => {
      const r = await pairWorker.retire({ projectAbsPath, folderId: st.folderId }).catch((err) => ({ ok: false, code: 'retire_threw', message: String(err && err.message || err) }));
      if (!r || !r.ok) {
        log.warn(`stop() retire failed for ${projectAbsPath}: ${(r && r.code) || 'unknown'}`);
      }
    }));
  }

  return {
    events,
    snapshot,
    stop,
    // Exposed for ops + tests; production callers should use the events
    // surface instead.
    _onActive: onActive,
    _onRetire: onRetire,
  };
}

module.exports = {
  createSyncScheduler,
  DEFAULT_MAX_CONCURRENT,
};
