'use strict';

// ProjectConnectionState mapper — Phase 1 of the syncthing-native
// UI redesign (see /Users/kari/.claude-work/plans/hidden-soaring-mist.md).
//
// PURE function. No globals, no I/O, no filesystem reads, no clocks.
// Caller assembles the input shape from listProjects + sync_state_cache
// snapshot + sync_task_tracker entries + marker filesystem check
// BEFORE invoking the mapper. Determinism + testability are the point.
//
// The renderer reads ONLY the output of this mapper. It must never
// read `project.sync.phase`, `sync.taskId`, `sync.bytesDone`, or any
// other filesync internal directly. That's the whole reason this
// module exists.
//
// ---
// FILESYNC PHASE → ProjectConnectionState MAPPING TABLE
// ---
//
// Input signals: project.source, project.existsLocal, hasIncompleteMarker,
// syncCacheEntry.phase, syncCacheEntry.progress, syncCacheEntry.error,
// activeTask.direction.
//
// Output triples: (availability, syncState, connectionIntent).
//
// 1. Provisioning bucket — source=cloud + !existsLocal + marker present
//    phase=downloading + activeTask=download → provisioning / syncing / attaching
//    phase=cancelled                           → provisioning / paused  / null
//    phase=failed | blocked                    → provisioning / error   / null
//    phase=idle (post-cancel transient)        → provisioning / paused  / null
//                                                (intent cleared because marker
//                                                 alone, no active task, no
//                                                 explicit state — treat as
//                                                 "paused awaiting user")
//
// 2. Cloud-only bucket — source=cloud + !existsLocal + no marker
//    (any phase)                               → cloud_only / idle / null
//
// 3. Connected bucket — source=cloud + existsLocal
//    phase=synced | idle                       → connected / idle     / null
//    phase=scanning | binding                  → connected / scanning / null
//    phase=syncing                             → connected / syncing  / null
//      (open-triggered live sync, direction=both)
//    phase=uploading | downloading             → connected / syncing  / null
//      (live sync continuation; downloading on
//       a connected project is a stale phase
//       and should not appear post-commit a72be93,
//       but defensively map it the same way)
//    phase=paused | cancelled                  → connected / paused / null
//    phase=failed | blocked                    → connected / error  / null
//
// 4. Local-only bucket — source=local
//    activeTask=upload + phase=uploading       → local_only / syncing / publishing
//    phase=failed | blocked                    → local_only / error   / null
//    phase=paused | cancelled                  → local_only / paused  / null
//    everything else                           → local_only / idle    / null
//      (idle local-only is the unpublished
//       project case; no chip surfaced per
//       plan §B default rule)
//
// ---
// SYNCTHING PHASE 1 — FAIL-VISIBLE
// ---
//
// syncBackend='syncthing' with no real state feed available (Phase 2
// dependency). Two branches:
//
// Branch A — localPath_exists:
//   connected / paused / null + lastError='state.syncthing.feed_unavailable'
//
// Branch B — no local mirror:
//   cloud_only / idle / null + lastError='state.syncthing.feed_unavailable'
//
// Both branches MUST NOT route through filesync mapper — that would
// invent state the syncthing workspace doesn't have.
//
// ---
// COMPLETION FORMULA (filesync mapper)
// ---
//
//   syncState === 'idle'    → 100
//   syncState === 'error'   → preserve last finite progress
//   syncState === 'paused'  → preserve last finite progress
//   syncCacheEntry.progress finite → Math.round(progress)
//   otherwise               → undefined
//
// Renderer must NEVER recompute from bytesDone/bytesTotal.
//
// ---
// CONNECTION INTENT — DURABLE-STATE DERIVATION
// ---
//
// Click handlers in main.cjs trigger durable actions (marker write,
// sync_task POST, lease request). They DO NOT write intent into the
// state model. The mapper computes intent from those durable signals:
//
//   attaching ⟺ source='cloud' AND (hasIncompleteMarker OR
//                                   activeTask.direction='download')
//   publishing ⟺ source='local' AND activeTask.direction='upload'
//
// Then the syncState clear-rules override:
//   syncState ∈ {error, paused} → intent = null
//
// This guarantees recoverability across Desktop refresh / restart.

/**
 * Map durable signals to ProjectConnectionState.
 *
 * @param {object} args
 * @param {object} args.project — ProjectItem-shaped: { name, path,
 *   workspaceId, workspaceName, source, existsLocal, localPath }.
 *   Renderer-visible fields only; the mapper does not read sync.phase
 *   from this object (caller passes syncCacheEntry separately to make
 *   the dependency explicit).
 * @param {object|null} args.syncCacheEntry — sync_state_cache entry
 *   for this project's key, or null if the cache has no entry yet.
 *   Shape: { phase, progress, status, error, taskId, ... }.
 * @param {boolean} args.hasIncompleteMarker — true if
 *   <localPath>/.kari-engine/desktop-download-incomplete exists.
 *   Caller is responsible for the filesystem check (mapper is pure).
 * @param {object|null} args.activeTask — sync_task_tracker entry for
 *   this workspace or null if no task is registered. Shape:
 *   { taskId, direction: 'upload'|'download'|'both', state }.
 * @param {'syncthing'|'filesync'} args.syncBackend — workspace's
 *   resolved backend.
 * @param {boolean} args.syncthingFeedAvailable — false in Phase 1
 *   (no real feed yet); true once Phase 2 lands.
 * @param {boolean} [args.mirrorDirExists] — actual on-disk presence
 *   of the project's mirror directory, independent of the filesync-
 *   flavored `project.existsLocal` flag. Caller pre-stats and passes
 *   this so the syncthing fail-visible branch can decide Branch A vs
 *   B based on real FS state — `existsLocal` is computed with
 *   filesync completion heuristics (marker / hasUserProjectContent /
 *   download-complete-marker) which can downgrade a healthy
 *   syncthing-shared mirror to existsLocal=false (codex round 4 P2
 *   pin). Filesync path ignores this and uses project.existsLocal.
 * @returns {object} ProjectConnectionState
 */
function mapProjectConnectionState(args) {
  const project = args.project || {};
  const syncCacheEntry = args.syncCacheEntry || null;
  const hasIncompleteMarker = Boolean(args.hasIncompleteMarker);
  const activeTask = args.activeTask || null;
  const syncBackend = args.syncBackend === 'syncthing' ? 'syncthing' : 'filesync';
  const mirrorDirExists = Boolean(args.mirrorDirExists);
  // Phase 4 plumbing (Phase 5 consumes): per-project snapshot of the
  // local upload scheduler's state. null = scheduler doesn't track this
  // project (non-current workspace, or no schedule call has landed yet).
  // Shape: { pending, running, backoffMs, nextAttemptAt, lastChangeAt,
  // uploadedChangeAt, lastUploadStartedAt } | null
  const desktopUpload = args.desktopUpload || null;

  const workspaceId = stringOr(project.workspaceId, '');
  const workspaceName = stringOr(project.workspaceName, stringOr(project.name, ''));
  const name = stringOr(project.name, workspaceName);
  const localPath = resolveLocalPath(project, { hasIncompleteMarker, activeTask, mirrorDirExists });

  // Syncthing path: fail-visible by default in Phase 1, with a narrow
  // bridge for user-initiated upload/download tasks (see below).
  // syncthingFeedAvailable is RESERVED for Phase 2 (real event-stream
  // mapper) and is not consulted in this branch yet.
  // Codex round 2 P2 pin: "Until a real syncthing feed mapper
  // exists, syncthing inputs should stay on the fail-visible path."
  //
  // Phase 1 bridge: user-initiated upload (uploadProject) and download
  // (downloadProject) STILL go through the filesync /v1/sync-tasks
  // lifecycle even for syncthing-backed workspaces — postSyncTask
  // registers a tracker entry and pollSyncTasks updates the cache with
  // real daemon progress. Those are REAL signals (not invented
  // filesync state), so mapSyncthingFailVisible is allowed to surface
  // them when activeTask.direction is 'upload' or 'download'. The
  // live-sync direction='both' path (openProject) genuinely depends
  // on the missing syncthing feed and stays on fail-visible.
  if (syncBackend === 'syncthing') {
    return mapSyncthingFailVisible({
      workspaceId,
      workspaceName,
      name,
      localPath,
      desktopUpload,
      // For syncthing, Branch A vs B is decided by ACTUAL local
      // mirror dir presence — filesync's existsLocal is unreliable
      // here because it requires filesync completion markers that a
      // syncthing-shared folder never writes. mirrorDirExists is
      // pre-computed by main.cjs via a direct fsp.stat. existsLocal
      // is folded in as a stricter signal (if filesync ALSO thinks
      // local is present, definitely Branch A).
      mirrorPresent: mirrorDirExists || project.existsLocal === true,
      // Passed through for the upload/download bridge above. Only
      // consulted when activeTask.direction is 'upload' or 'download';
      // otherwise ignored so syncthing live-sync state can't be
      // forged from filesync cache entries.
      syncCacheEntry,
      activeTask,
      // Authoritative "download not finalized" signal — used by the
      // download bridge to keep the chip in syncing/provisioning
      // (NOT connected/idle) until the daemon removes
      // .kari-engine/desktop-download-incomplete. Without this,
      // progress=100 or phase='synced' could prematurely flip the
      // card to openable while .kari-incoming staging renames are
      // still pending.
      hasIncompleteMarker,
    });
  }

  // Filesync mapper
  return mapFilesync({
    workspaceId,
    workspaceName,
    name,
    localPath,
    project,
    syncCacheEntry,
    hasIncompleteMarker,
    activeTask,
  });
}

function mapSyncthingFailVisible(ctx) {
  const lastError = 'state.syncthing.feed_unavailable';

  // Phase 1 bridge: surface real upload/download progress driven by
  // the filesync /v1/sync-tasks lifecycle. uploadProject and
  // downloadProject register tracker entries with direction='upload'
  // or 'download'; pollSyncTasks writes the cache phase + progress.
  // These signals are real (daemon-reported), so the syncthing
  // fail-visible default would actively mislead the user — the
  // upload chip would say "paused" while bytes are flowing. The
  // 'both' direction (open-triggered live sync) is intentionally
  // excluded because it depends on the still-missing syncthing event
  // feed and would invent state.
  //
  // Direction resolution: the tracker entry is the authoritative
  // signal, but it only appears after postSyncTask returns from the
  // daemon (which can take seconds on cold bind/start). uploadProject
  // and downloadProject seed the cache phase BEFORE that slow path
  // (main.cjs:1943 downloading, main.cjs:2319 scanning, main.cjs:3367
  // uploading/downloading). Inferring direction from those phases
  // when the tracker is empty closes the visible-gap that previously
  // showed "paused/feed_unavailable" for the first 1-3 seconds after
  // the user clicked.
  const activeTask = ctx.activeTask || null;
  const taskDirection = activeTask && typeof activeTask.direction === 'string'
    ? activeTask.direction.toLowerCase()
    : '';
  const cache = ctx.syncCacheEntry || null;
  const phase = cache && typeof cache.phase === 'string' ? cache.phase : '';
  let direction = taskDirection;
  if (!direction) {
    if (phase === 'uploading' || phase === 'scanning') direction = 'upload';
    else if (phase === 'downloading') direction = 'download';
  }
  if (direction === 'upload' || direction === 'download') {
    const rawProgress = cache && Number.isFinite(cache.progress) ? cache.progress : undefined;
    const roundedProgress = typeof rawProgress === 'number'
      ? Math.max(0, Math.min(100, Math.round(rawProgress)))
      : undefined;
    const cacheError = cache && cache.error ? String(cache.error) : undefined;

    // Cache phase 'synced' means the daemon reported the task as
    // succeeded; 100% progress with an active phase means all bytes
    // are accounted for but the tracker terminal-task pass hasn't
    // landed yet (up to one daemonSnapshot tick away). For uploads
    // we can flip to idle on either signal (mirror already on disk).
    // For downloads we MUST additionally wait for the incomplete
    // marker to be removed — daemon's "task succeeded" alone is not
    // a sufficient completeness signal (see download_verify.cjs;
    // the marker is now gated behind local safety guards that prove
    // the tree isn't actively being written to). Without this gate,
    // we'd flip the card to openable while .kari-incoming staging
    // renames are still in flight or before the marker contract
    // confirms finalization.
    const isTerminallyDone =
      phase === 'synced' ||
      phase === 'idle' ||
      (typeof rawProgress === 'number' && rawProgress >= 100);
    const downloadFinalized = isTerminallyDone && !ctx.hasIncompleteMarker;

    let syncState;
    let outIntent;
    let outError;
    let outCompletion;
    let outAvailability;
    let outOpenable;
    if (phase === 'failed' || phase === 'blocked') {
      syncState = 'error';
      outIntent = null;
      outError = cacheError;
      outCompletion = roundedProgress;
      outAvailability = ctx.mirrorPresent ? 'connected' : 'provisioning';
      outOpenable = direction === 'upload' && ctx.mirrorPresent;
    } else if (phase === 'paused' || phase === 'cancelled') {
      syncState = 'paused';
      outIntent = null;
      outCompletion = roundedProgress;
      outAvailability = ctx.mirrorPresent ? 'connected' : 'provisioning';
      outOpenable = direction === 'upload' && ctx.mirrorPresent;
    } else if (phase === 'verifying' || phase === 'promoting') {
      // Phase B B8: snapshot pipeline post-transfer phases. The
      // daemon-task-succeeded transition writes 'verifying' (NOT
      // 'synced') because transport-clean is not product-level
      // completion; the actual flip happens after manifest verify +
      // (for downloads) atomic promote.
      syncState = 'syncing';
      // Direction-aware intent — matches the active-transfer branch's
      // convention (publishing for uploads, attaching for downloads).
      outIntent = direction === 'upload' ? 'publishing' : 'attaching';
      outCompletion = 100;
      if (direction === 'upload') {
        // Upload: the working tree IS the user's local mirror, intact
        // throughout the transfer + verify + commit phases. Keep
        // openable so the user can keep working in their own project
        // while the snapshot pipeline finishes the manifest-commit
        // tail; without this they'd lose access to their own files
        // for the seconds-to-minutes of post-transport processing.
        outAvailability = ctx.mirrorPresent ? 'connected' : 'provisioning';
        outOpenable = ctx.mirrorPresent;
      } else {
        // Download: mirror is being assembled/promoted; tree state
        // is in flux. Force provisioning + non-openable until promote
        // finalizes (mirrors the marker-gated branch's discipline).
        outAvailability = 'provisioning';
        outOpenable = false;
      }
    } else if (direction === 'upload' && isTerminallyDone) {
      // Upload terminal: mirror was already on disk before upload
      // started; safe to present as idle + openable.
      syncState = 'idle';
      outIntent = null;
      outCompletion = 100;
      outAvailability = 'connected';
      outOpenable = ctx.mirrorPresent;
    } else if (direction === 'download' && downloadFinalized) {
      // Download terminal AND marker removed (by verify-gated
      // marker contract in applySyncTaskSideEffects /
      // recoverSyncTasksFromMarkers). Safe to open.
      syncState = 'idle';
      outIntent = null;
      outCompletion = 100;
      outAvailability = 'connected';
      outOpenable = ctx.mirrorPresent;
    } else if (direction === 'download' && isTerminallyDone && ctx.hasIncompleteMarker) {
      // Download at 100%/synced but the marker is still on disk —
      // stay in syncing/attaching/provisioning. The marker is the
      // authoritative "safe to open" signal (gated by
      // download_verify.cjs). Showing 'idle/connected/openable' here
      // would let the user click open on a tree the marker says is
      // not yet finalized.
      syncState = 'syncing';
      outIntent = 'attaching';
      outCompletion = 100;
      outAvailability = 'provisioning';
      outOpenable = false;
    } else {
      // Active in flight: uploading / downloading / scanning /
      // binding / syncing (or transient phase='' before the first
      // cache update lands).
      syncState = 'syncing';
      outIntent = direction === 'upload' ? 'publishing' : 'attaching';
      outCompletion = typeof roundedProgress === 'number' ? roundedProgress : 0;
      outAvailability = ctx.mirrorPresent ? 'connected' : 'provisioning';
      // upload: openable=true (work-in-place while bytes flow);
      // download: openable=false (mirror incomplete).
      outOpenable = direction === 'upload' && ctx.mirrorPresent;
    }

    const availability = outAvailability;
    const openable = outOpenable;

    return {
      workspaceId: ctx.workspaceId,
      workspaceName: ctx.workspaceName,
      name: ctx.name,
      localPath: ctx.localPath || undefined,
      syncBackend: 'syncthing',
      availability,
      openable,
      syncState,
      connectionIntent: outIntent,
      completion: outCompletion,
      conflictCount: 0,
      // lastError is the cache error for failed/blocked; otherwise
      // omit feed_unavailable while a real task is in flight (we DO
      // have a feed: the sync-task poller).
      lastError: outError,
    };
  }

  if (ctx.mirrorPresent && ctx.localPath) {
    // Branch A: project is locally openable. Pre-Phase-5 this returned
    // paused + state.syncthing.feed_unavailable — accurate when nothing
    // was driving local→cloud propagation, but wrong now that the
    // desktop upload scheduler IS the feed for syncthing-backed
    // workspaces.
    //
    // Use the scheduler state (Phase 4 plumbed it through ctx) to pick
    // the right steady-state:
    //   - backoff > 0      → error + daemon_offline_dirty (we have a
    //                        dirty marker and daemon's unreachable, the
    //                        user needs to know)
    //   - running||pending → syncing + publishing (the scheduler is
    //                        actively driving an upload or about to)
    //   - all clear        → idle + state.synced (no dirty, no outage)
    //   - null             → fall back to legacy paused (non-current
    //                        workspace, or scheduler has never tracked
    //                        this project — preserves existing tests)
    const du = ctx.desktopUpload;
    let syncState = 'paused';
    let branchALastError = lastError;
    let connectionIntent = null;
    if (du) {
      if (du.backoffMs > 0) {
        syncState = 'error';
        branchALastError = 'state.sync.daemon_offline_dirty';
      } else if (du.running || du.pending) {
        syncState = 'syncing';
        branchALastError = undefined;
        connectionIntent = 'publishing';
      } else {
        syncState = 'idle';
        branchALastError = undefined;
      }
    }
    return {
      workspaceId: ctx.workspaceId,
      workspaceName: ctx.workspaceName,
      name: ctx.name,
      localPath: ctx.localPath,
      syncBackend: 'syncthing',
      availability: 'connected',
      openable: true,
      syncState,
      connectionIntent,
      completion: undefined,
      conflictCount: 0,
      lastError: branchALastError,
    };
  }
  // Branch B: cloud_only — no chip shown (syncState=idle is the
  // documented default for cloud_only per plan §B); lastError
  // surfaces via card tooltip.
  return {
    workspaceId: ctx.workspaceId,
    workspaceName: ctx.workspaceName,
    name: ctx.name,
    localPath: undefined,
    syncBackend: 'syncthing',
    availability: 'cloud_only',
    openable: false,
    syncState: 'idle',
    connectionIntent: null,
    completion: undefined,
    conflictCount: 0,
    lastError,
  };
}

function mapFilesync(ctx) {
  const project = ctx.project;
  const cache = ctx.syncCacheEntry;
  const phase = cache && typeof cache.phase === 'string' ? cache.phase : 'idle';
  const progress = cache && Number.isFinite(cache.progress) ? cache.progress : undefined;
  const cacheError = cache && cache.error ? String(cache.error) : undefined;

  const existsLocal = project.existsLocal === true;
  const isCloud = project.source === 'cloud';
  const isLocal = project.source === 'local';

  // 1. Provisioning: source=cloud + !existsLocal AND (marker present
  //    OR active download task). The active-task case covers the
  //    race where the daemon already accepted a download POST and
  //    started running but the FS marker write hasn't landed yet —
  //    without this OR clause, the card would briefly fall back to
  //    cloud_only and the user could re-trigger attach against an
  //    already-running task. (Codex round 2 P2 pin.)
  const hasActiveDownload =
    ctx.activeTask && String(ctx.activeTask.direction || '').toLowerCase() === 'download';
  if (isCloud && !existsLocal && (ctx.hasIncompleteMarker || hasActiveDownload)) {
    return mapProvisioning(ctx, phase, progress, cacheError);
  }

  // 2. Cloud-only: source=cloud + !existsLocal + no marker + no active download
  if (isCloud && !existsLocal) {
    return buildState(ctx, {
      availability: 'cloud_only',
      openable: false,
      syncState: 'idle',
      connectionIntent: null,
      completion: undefined,
      lastError: undefined,
      keepLocalPath: false,
    });
  }

  // 3. Local-only: source=local
  if (isLocal && !isCloud) {
    return mapLocalOnly(ctx, phase, progress, cacheError);
  }

  // 4. Connected: source=cloud + existsLocal (most common steady state)
  if (isCloud && existsLocal) {
    return mapConnected(ctx, phase, progress, cacheError);
  }

  // 5. Defensive fallback (shouldn't fire — neither cloud nor local
  // is a malformed ProjectItem). Treat as cloud_only / idle.
  return buildState(ctx, {
    availability: 'cloud_only',
    openable: false,
    syncState: 'idle',
    connectionIntent: null,
    completion: undefined,
    lastError: undefined,
    keepLocalPath: false,
  });
}

function mapProvisioning(ctx, phase, progress, cacheError) {
  const intent = deriveFilesyncIntent(ctx);
  const roundedProgress =
    typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : undefined;

  let syncState;
  let outIntent = intent;
  let outError = cacheError;
  let outCompletion;

  if (phase === 'cancelled') {
    syncState = 'paused';
    outIntent = null; // paused clears attaching per plan §C
    outError = '已暂停，保留已下载内容，可继续接入';
    outCompletion = roundedProgress; // preserve last finite
  } else if (phase === 'failed' || phase === 'blocked') {
    syncState = 'error';
    outIntent = null;
    outCompletion = roundedProgress;
  } else if (phase === 'idle') {
    // Marker present but no active task and cache says idle — treat
    // as paused-awaiting-user (e.g. daemon restarted mid-attach).
    syncState = 'paused';
    outIntent = null;
    outCompletion = roundedProgress;
  } else {
    // Active provisioning: downloading / scanning / binding / syncing
    syncState = 'syncing';
    outCompletion = typeof roundedProgress === 'number' ? roundedProgress : 0;
  }

  return buildState(ctx, {
    availability: 'provisioning',
    openable: false,
    syncState,
    connectionIntent: outIntent,
    completion: outCompletion,
    lastError: outError,
    keepLocalPath: true, // partial mirror exists
  });
}

function mapConnected(ctx, phase, progress, cacheError) {
  const intent = deriveFilesyncIntent(ctx);
  const roundedProgress =
    typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : undefined;

  let syncState;
  let outIntent = intent;
  let outError = cacheError;
  let outCompletion;
  // Phase B B8: snapshot pipeline post-transfer phases are NOT openable
  // even on a "connected" mirror — the snapshot tree isn't finalized
  // until manifest verify + (for downloads) atomic promote complete.
  // Track separately from buildState's belt-and-suspenders default
  // so verifying/promoting can explicitly suppress openable while
  // every other mapConnected case stays openable.
  let openableOverride = null;

  switch (phase) {
    case 'synced':
    case 'idle':
      syncState = 'idle';
      outCompletion = 100;
      outError = undefined; // synced clears any stale error
      break;
    case 'scanning':
    case 'binding':
      syncState = 'scanning';
      outCompletion = roundedProgress;
      break;
    case 'syncing':
    case 'uploading':
    case 'downloading':
      syncState = 'syncing';
      outCompletion = roundedProgress;
      break;
    case 'verifying':
    case 'promoting':
      // Plan B8: post-transport snapshot pipeline phases. Tree isn't
      // finalized — must NOT be openable. Completion stays at 100
      // (transfer done; only verify/promote remaining).
      syncState = 'syncing';
      outIntent = 'attaching';
      outCompletion = 100;
      openableOverride = false;
      break;
    case 'paused':
    case 'cancelled':
      syncState = 'paused';
      outIntent = null;
      outCompletion = roundedProgress;
      break;
    case 'failed':
    case 'blocked':
      syncState = 'error';
      outIntent = null;
      outCompletion = roundedProgress;
      break;
    default:
      syncState = 'idle';
      outCompletion = 100;
      outError = undefined;
      break;
  }

  return buildState(ctx, {
    availability: 'connected',
    openable: openableOverride !== null ? openableOverride : Boolean(ctx.localPath),
    syncState,
    connectionIntent: outIntent,
    completion: outCompletion,
    lastError: outError,
    keepLocalPath: true,
  });
}

function mapLocalOnly(ctx, phase, progress, cacheError) {
  const intent = deriveFilesyncIntent(ctx);
  const roundedProgress =
    typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : undefined;

  let syncState = 'idle';
  let outIntent = intent;
  let outError;
  let outCompletion;

  if (phase === 'uploading' || phase === 'syncing') {
    syncState = 'syncing';
    outCompletion = typeof roundedProgress === 'number' ? roundedProgress : 0;
  } else if (phase === 'failed' || phase === 'blocked') {
    syncState = 'error';
    outIntent = null;
    outError = cacheError;
    outCompletion = roundedProgress;
  } else if (phase === 'paused' || phase === 'cancelled') {
    syncState = 'paused';
    outIntent = null;
    outCompletion = roundedProgress;
  }
  // else: idle - leave default

  return buildState(ctx, {
    availability: 'local_only',
    openable: true,
    syncState,
    connectionIntent: outIntent,
    completion: outCompletion,
    lastError: outError,
    keepLocalPath: true,
  });
}

function deriveFilesyncIntent(ctx) {
  // attaching: cloud project AND (marker OR active download task).
  if (ctx.project.source === 'cloud') {
    const hasMarker = ctx.hasIncompleteMarker;
    const hasActiveDownload =
      ctx.activeTask && String(ctx.activeTask.direction || '').toLowerCase() === 'download';
    if (hasMarker || hasActiveDownload) return 'attaching';
  }
  // publishing: ANY project with an active upload task. Codex round 3
  // P2 pin — the original "pure-local only" gate dropped the intent
  // as soon as uploadProject's upload-intent created the server
  // workspace row (project then flips source='cloud' before the
  // sync_task is observed). active-upload-direction uniquely
  // identifies the publish flow because postSyncTask uses direction
  // 'upload' only for uploadProject; openProject's live sync uses
  // 'both' and downloadProject uses 'download'.
  const hasActiveUpload =
    ctx.activeTask && String(ctx.activeTask.direction || '').toLowerCase() === 'upload';
  if (hasActiveUpload) return 'publishing';
  return null;
}

function buildState(ctx, fields) {
  return {
    workspaceId: ctx.workspaceId,
    workspaceName: ctx.workspaceName,
    name: ctx.name,
    localPath: fields.keepLocalPath ? ctx.localPath || undefined : undefined,
    syncBackend: 'filesync',
    availability: fields.availability,
    openable: fields.openable,
    syncState: fields.syncState,
    connectionIntent: fields.connectionIntent,
    completion: fields.completion,
    conflictCount: 0,
    lastError: fields.lastError,
  };
}

function resolveLocalPath(project, hints) {
  if (project.localPath) return String(project.localPath);
  if (project.source === 'local' && project.path) return String(project.path);
  if (project.source === 'cloud' && project.path) {
    // Connected cloud project (existsLocal=true) → mirror lives at path.
    if (project.existsLocal === true) return String(project.path);
    if (hints) {
      // Provisioning case: marker present OR active download task means
      // a (possibly partial) mirror dir exists on disk even though
      // existsLocal=false. listServerProjects sets localPath='' for
      // existsLocal=false rows, so the mapper has to recover the
      // mirror path from project.path. Codex round 2 P2 pin.
      const hasMarker = Boolean(hints.hasIncompleteMarker);
      const hasActiveDownload =
        hints.activeTask &&
        String(hints.activeTask.direction || '').toLowerCase() === 'download';
      if (hasMarker || hasActiveDownload) return String(project.path);
      // Syncthing Branch A: filesync's existsLocal would be false on
      // a healthy syncthing-shared mirror because no filesync
      // completion markers exist. mirrorDirExists is the real FS
      // signal — surface project.path so the syncthing fail-visible
      // path produces openable=true. Codex round 4 P2 pin.
      if (hints.mirrorDirExists) return String(project.path);
    }
  }
  return undefined;
}

function stringOr(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

module.exports = {
  mapProjectConnectionState,
  // Exported for testing only.
  _internals: {
    deriveFilesyncIntent,
    resolveLocalPath,
  },
};
