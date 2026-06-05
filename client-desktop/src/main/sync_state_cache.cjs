// Per-project sync state cache. Owns the canonical phase/progress
// view that listProjects injects into ProjectItem.sync.
//
// History note: pre-rewrite this module also folded daemon
// /v1/transfer rows and derived synced via a "disappeared row → done"
// heuristic. That heuristic and the /v1/transfer plumbing were
// retired when the daemon gained an explicit /v1/sync-tasks API. The
// cache is now driven entirely by:
//
//   1. setProjectPhase() — called by main.cjs orchestration
//      (openProject / downloadProject / uploadProject) for the
//      Desktop-local scanning/binding/failed transitions BEFORE a
//      task is posted, and by sync_task_tracker.cjs once daemon
//      task state arrives.
//   2. markDaemonOffline / clearDaemonOffline — daemon-snapshot
//      health gate. 2 consecutive poll failures flip all known
//      projects to phase=blocked.
//
// The cache itself never invents synced/failed/cancelled — those
// only land via explicit setProjectPhase from a code path that has
// authority to know.
//
// Pure CJS module — no Electron dependencies. Exported as a factory
// so tests can spin up isolated instances.

'use strict';

const PHASES = Object.freeze([
  'idle',
  'scanning',
  'binding',
  'uploading',
  'downloading',
  // 'syncing' = open-triggered direction='both' background live sync.
  // Distinct from 'downloading' (first-time mirror creation) so the
  // renderer can hide stale 'downloading' on an openable project
  // while still showing real progress for live sync over an
  // already-downloaded mirror.
  'syncing',
  // 'verifying' and 'promoting' — snapshot pipeline phases (Phase B B8).
  // The snapshot pipeline's daemon-task-succeeded transition writes
  // 'verifying' (NOT 'synced') because daemon transport-clean is not
  // product-level completion; the actual flip to 'synced' happens
  // after manifest verify + (for downloads) atomic promote. UI maps
  // both phases to "syncing/attaching, completion 100, NOT openable"
  // — see project_connection_state.cjs phase mapping.
  'verifying',
  'promoting',
  'synced',
  'failed',
  'cancelled',
  'blocked',
]);

// 2 consecutive failed daemon polls flip projects to blocked.
const DAEMON_OFFLINE_THRESHOLD = 2;

// deriveProjectKey returns the cache key for one ProjectItem-shaped
// object. Cloud-backed projects key off (workspace_id, workspace_name);
// local-only projects fall back to the absolute path so they don't
// collide with cloud projects sharing the same workspaceName under a
// different activation.
function deriveProjectKey(item) {
  if (!item) return '';
  const wsName = String(item.workspaceName || item.name || '').trim();
  const wsId = String(item.workspaceId || item._workspaceId || '').trim();
  if (item.source === 'cloud' && wsId && wsName) {
    return `cloud:${wsId}|${wsName}`;
  }
  // Local-only OR cloud-without-workspace-id fallback.
  const abs = String(item.path || item.localPath || '').trim();
  if (abs) return `path:${abs}`;
  // Last-resort: name-only key. Should be rare; better than empty.
  return `name:${wsName}`;
}

function createSyncStateCache(options) {
  const opts = options || {};
  const nowFn = typeof opts.now === 'function' ? opts.now : () => new Date();

  // store maps projectKey → ProjectSyncState
  const store = new Map();
  // daemonOfflinePolls: consecutive failed poll count. Bump by
  // markDaemonOffline; reset by clearDaemonOffline. ≥ THRESHOLD
  // marks all known projects as blocked.
  let daemonOfflinePolls = 0;

  function isoNow() {
    return nowFn().toISOString();
  }

  function get(key) {
    return key ? store.get(key) || null : null;
  }

  function set(key, state) {
    if (!key) return;
    const merged = Object.assign(
      { phase: 'idle', progress: 0, status: '', updatedAt: isoNow() },
      store.get(key) || {},
      state,
      { updatedAt: isoNow() }
    );
    if (!PHASES.includes(merged.phase)) {
      throw new Error(`sync_state_cache: invalid phase ${JSON.stringify(merged.phase)} (allowed: ${PHASES.join('|')})`);
    }
    store.set(key, merged);
  }

  function clear(key) {
    if (key) store.delete(key);
  }

  function snapshot() {
    const out = {};
    for (const [k, v] of store) out[k] = Object.assign({}, v);
    return out;
  }

  // setProjectPhase is the canonical write API. Status defaults to a
  // phase-derived label; pass an explicit string for richer text.
  // Pass `taskId` (or null to clear) when transitioning into/out of
  // a daemon-tracked phase so renderer's abandon flow knows which
  // task to cancel.
  //
  // Progress semantics:
  //   1. When the phase carries no progress field (cancelled / failed
  //      / blocked), preserve the PREVIOUS entry's progress + bytes
  //      (Codex round 2 #2). A cancelled download keeps the diamond
  //      filled to whatever percent it reached, so the user can see
  //      "partial files are there" rather than an empty bar.
  //   2. For any phase that DOES carry a progress, clamp it to the
  //      previous progress as a lower bound — BUT ONLY when the
  //      caller is reporting on the SAME task (Codex round 2 #5).
  //      Daemon's bytes high-water doesn't guarantee a monotonic
  //      ratio (5000/10000=50% → 8500/20000=42%); intra-task clamp
  //      stops the UI bar from oscillating.
  //   3. EXCEPTION (Phase L): a fresh task overrides the clamp.
  //      Determined by (a) taskId changes, OR (b) prev phase is
  //      terminal (cancelled/failed/blocked) and new phase is an
  //      active phase (downloading/uploading/scanning/binding).
  //      Pre-fix the universal clamp let a retry after a 98%-cancel
  //      "jump to 100%" the instant the new task POSTed: tracker
  //      seeded progress=0 with the NEW taskId, cache clamped to
  //      old 98%, then high-water from churn pushed it to 100% —
  //      complete fiction, the actual barrier still hadn't closed
  //      and the project still couldn't be opened. Scoping clamp to
  //      same-task means retry honestly shows 0% → real progress.
  function setProjectPhase(key, phase, extra) {
    if (!key) return;
    const e = extra || {};
    const status = e.status != null ? String(e.status) : defaultStatusFor(phase);
    const prev = store.get(key);
    const preservesProgress = phase === 'cancelled' || phase === 'failed' || phase === 'blocked';

    // Decide whether the monotonic intra-task clamp applies. It does
    // ONLY when this write looks like another tick of the same
    // task — same taskId AND not coming out of a terminal phase.
    // Anything else (fresh task POST, retry after cancel/fail, first
    // seed of a brand new card) is treated as a clean start where
    // the caller's progress is authoritative.
    const fromTerminal = prev && (prev.phase === 'cancelled' || prev.phase === 'failed' || prev.phase === 'blocked');
    const incomingTaskId = (e.taskId && typeof e.taskId === 'string') ? e.taskId : undefined;
    const sameTask = prev && prev.taskId && incomingTaskId && prev.taskId === incomingTaskId;
    const allowMonotonicClamp = sameTask && !fromTerminal;

    let progress;
    if (e.progress != null) {
      progress = clampProgress(e.progress);
      if (allowMonotonicClamp && typeof prev.progress === 'number' && prev.progress > progress) {
        progress = prev.progress;
      }
    } else if (preservesProgress && prev && typeof prev.progress === 'number') {
      progress = prev.progress;
    } else {
      progress = phaseDefaultProgress(phase);
    }

    const merged = { phase, progress, status };
    if (e.error != null) merged.error = String(e.error);
    if (e.bytesDone != null) {
      merged.bytesDone = e.bytesDone;
    } else if (preservesProgress && prev && prev.bytesDone != null) {
      merged.bytesDone = prev.bytesDone;
    }
    if (e.bytesTotal != null) {
      merged.bytesTotal = e.bytesTotal;
    } else if (preservesProgress && prev && prev.bytesTotal != null) {
      merged.bytesTotal = prev.bytesTotal;
    }
    if (e.taskId !== undefined) {
      // Allow explicit null to clear taskId; only set non-empty string.
      if (e.taskId && typeof e.taskId === 'string') {
        merged.taskId = e.taskId;
      } else {
        merged.taskId = undefined;
      }
    }
    set(key, merged);
  }

  // markDaemonOffline tracks consecutive poll failures. ≥ THRESHOLD
  // flips every project in the cache to blocked (with a "daemon
  // 未连接" status). Caller invokes this on every failed daemon
  // poll; on success, calls clearDaemonOffline.
  function markDaemonOffline() {
    daemonOfflinePolls += 1;
    if (daemonOfflinePolls < DAEMON_OFFLINE_THRESHOLD) return false;
    for (const [k, cur] of store) {
      if (cur.phase === 'blocked' && cur.error === 'daemon_offline') continue;
      setProjectPhase(k, 'blocked', {
        status: 'daemon 未连接',
        error: 'daemon_offline',
      });
    }
    return true;
  }

  function clearDaemonOffline() {
    const wasOffline = daemonOfflinePolls >= DAEMON_OFFLINE_THRESHOLD;
    daemonOfflinePolls = 0;
    if (!wasOffline) return false;
    // Don't auto-revert to a phase — the next setProjectPhase /
    // sync_task_tracker tick will overwrite blocked with the real
    // state. Leaving entries at 'blocked' until then is safer than
    // guessing synced.
    return true;
  }

  // injectIntoProjects mutates each ProjectItem in-place setting
  // its .sync field from the cache. Items with no matching cache
  // entry get .sync = {phase:'idle', progress:0, status:'',
  // updatedAt:now} so renderer can branch without nil checks.
  function injectIntoProjects(projects, workspaceId) {
    if (!Array.isArray(projects)) return projects;
    const wsId = String(workspaceId || '').trim();
    for (const item of projects) {
      if (!item) continue;
      const probe = Object.assign({}, item);
      if (!probe.workspaceId && wsId) probe.workspaceId = wsId;
      const key = deriveProjectKey(probe);
      const state = store.get(key);
      if (state) {
        item.sync = Object.assign({}, state);
      } else if (item.existsLocal === true) {
        item.sync = {
          phase: 'synced',
          progress: 100,
          status: defaultStatusFor('synced'),
          updatedAt: isoNow(),
        };
      } else {
        item.sync = {
          phase: 'idle',
          progress: 0,
          status: '',
          updatedAt: isoNow(),
        };
      }
    }
    return projects;
  }

  return {
    deriveProjectKey,
    get,
    set,
    clear,
    snapshot,
    setProjectPhase,
    markDaemonOffline,
    clearDaemonOffline,
    injectIntoProjects,
    // Internals exposed for tests only.
    _internals: {
      get daemonOfflinePolls() {
        return daemonOfflinePolls;
      },
    },
  };
}

function defaultStatusFor(phase) {
  switch (phase) {
    case 'scanning':
      return '扫描中';
    case 'binding':
      return '绑定中';
    case 'uploading':
      return '上传中';
    case 'downloading':
      return '下载中';
    case 'syncing':
      return '同步中';
    case 'verifying':
      return '校验中';
    case 'promoting':
      return '写入项目中';
    case 'synced':
      return '已同步';
    case 'failed':
      return '同步失败';
    case 'cancelled':
      return '已取消';
    case 'blocked':
      return '已阻塞';
    case 'idle':
    default:
      return '';
  }
}

function phaseDefaultProgress(phase) {
  switch (phase) {
    case 'synced':
    case 'verifying':
    case 'promoting':
      // verifying/promoting come AFTER the transfer phase reached 100%;
      // default to 100 so a phase transition without explicit progress
      // doesn't show a regression. Plan §B8: "completion preserved at
      // 100" through verifying → promoting → synced.
      return 100;
    case 'idle':
    case 'failed':
    case 'cancelled':
    case 'blocked':
      return 0;
    default:
      return 0;
  }
}

function clampProgress(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

module.exports = {
  createSyncStateCache,
  deriveProjectKey,
  DAEMON_OFFLINE_THRESHOLD,
  PHASES,
};
