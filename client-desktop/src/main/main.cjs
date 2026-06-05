const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell, crashReporter } = require('electron');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// --- Pin app identity + userData FIRST ------------------------------------
// Electron derives userData/logs from the app name. The name isn't unified
// until app.setName(APP_DISPLAY_NAME) far below, but crashReporter.start and
// the getPath('logs') in the crash block immediately after resolve a path
// FIRST — locking userData to the package.json name ("kari-desktop") in both
// `electron .` dev AND the packaged build (whose copied package.json also
// says "kari-desktop") before setName runs. That silently split config across
// ~/Library/Application Support/{Kari,kari-desktop}, so an activation done in
// one build "disappeared" in another. Pin both explicitly and EARLY (appData
// is name-independent, so this is deterministic regardless of call order).
try {
  app.setName('Kari');
  // Single-tenant OSS build keeps its own app-data dir so it never shares
  // (or clobbers) a commercial "Kari" install's config on the same machine.
  app.setPath('userData', path.join(app.getPath('appData'), 'kari-oss'));
} catch {
  // best-effort; falls back to Electron's default name resolution
}

// --- Crash capture (diagnostic) -------------------------------------------
// A background SIGABRT (libuv/native abort) left no trace because the main
// process console/stderr isn't persisted. Capture three things so the next
// crash records its actual reason:
//   1. crashReporter → native minidumps (main + helpers) under userData/Crashpad
//      — the only thing that captures a native abort's stack.
//   2. main.log ← console + uncaught JS errors + unhandled rejections.
//   3. child/render-process-gone events.
try {
  crashReporter.start({ companyName: 'Kari', productName: 'Kari', uploadToServer: false });
} catch (err) {
  console.warn('[crash] crashReporter.start failed:', err && err.message ? err.message : err);
}
(function setupMainCrashLog() {
  try {
    let logDir;
    try { logDir = app.getPath('logs'); } catch { logDir = path.join(os.homedir(), 'Library', 'Logs', 'Kari'); }
    fs.mkdirSync(logDir, { recursive: true });
    const stream = fs.createWriteStream(path.join(logDir, 'main.log'), { flags: 'a' });
    const write = (tag, parts) => { try { stream.write(`[${new Date().toISOString()}] ${tag} ${parts.map((p) => (typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })())).join(' ')}\n`); } catch {} };
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => { write(level.toUpperCase(), args); return orig(...args); };
    }
    process.on('uncaughtException', (e) => write('UNCAUGHT', [e && e.stack ? e.stack : e]));
    process.on('unhandledRejection', (r) => write('UNHANDLED_REJECTION', [r && r.stack ? r.stack : r]));
    app.on('child-process-gone', (_e, details) => write('child-process-gone', [details]));
    app.on('render-process-gone', (_e, _wc, details) => write('render-process-gone', [details]));
  } catch (err) {
    console.warn('[crash] main log capture setup failed:', err && err.message ? err.message : err);
  }
})();
// --------------------------------------------------------------------------

// Per-project sync state cache. Owns the canonical phase/progress
// view that listProjects injects into ProjectItem.sync. Writes
// happen from main.cjs orchestration (scanning/binding/failed before
// a task is posted) and from sync_task_tracker (once daemon task
// state arrives). See sync_state_cache.cjs for the full contract.
const { createSyncStateCache } = require('./sync_state_cache.cjs');
// Daemon /v1/sync-tasks state → cache phase translator + marker
// cleanup. The tracker is the single authoritative source for
// synced; pre-rewrite Desktop heuristics (sync-once-ok and
// disappeared transfer rows) are gone.
const { createSyncTaskTracker } = require('./sync_task_tracker.cjs');
// Mobile pairing — bearer-protected pair-code / pair-status calls to
// the local trans-server, with /api/local-token as the same-machine
// guard. Surfaced to the renderer via the mobile:* IPC channels below.
// Cloud project must be downloaded before it can be opened. Marker
// helpers live in project_guards.cjs so listServerProjects,
// downloadProject, the daemon-snapshot poll, and the abandon flow
// all read/write the same .kari-engine/desktop-download-incomplete
// file.
const {
  isCloudOnlyNotDownloaded,
  isCloudDownloadInProgress,
  cloudNotDownloadedResponse,
  projectMetaSufficient,
  hasIncompleteMarker,
  hasDownloadCompleteMarker,
  writeIncompleteMarker,
  writeDownloadCompleteMarker,
  markerPathFor,
  removeIncompleteMarker,
  removeDownloadCompleteMarker,
  mirrorPathFromMarkerPath,
} = require('./project_guards.cjs');
// PR2 Phase 1 commit 6: pure helpers for uploadProject. Extracted
// so tests can run them without Electron's runtime.
const {
  directoryByteSize,
  deriveClientId,
  shouldUseSnapshotDownload,
  shouldUseSnapshotUpload,
  targetInsideSource,
} = require('./upload_helpers.cjs');
// Download finalization safety guards (reviewer P0 #0). Gates every
// removeIncompleteMarker call site on a local-quiescence check so
// daemon's "task succeeded" alone can't strip the marker while
// staging files are mid-rename or another task is still active.
const {
  checkDownloadSafeToFinalize,
  logBytesUsedDiagnostic,
} = require('./download_verify.cjs');
const {
  isAuthRequiredCloneFailure,
  makeServerCloneError,
} = require('./server_clone_error.cjs');
const { prepareCloneLocalTarget } = require('./clone_local_target.cjs');
// Syncthing-native Phase 1: pure backend-agnostic project state mapper.
// listProjects attaches the mapper output as project.connectionState;
// renderer reads ONLY from connectionState going forward.
const { mapProjectConnectionState } = require('./project_connection_state.cjs');
// Daemon HTTP helpers — extracted from main.cjs so the
// sync-tasks-missing detection has a real test surface (see
// daemon_http.test.cjs).
const { createDaemonHttp, isDaemonEndpointMissing } = require('./daemon_http.cjs');
const {
  buildDaemonControlBindRequest,
  daemonControlBindKey,
  kariSyncdAddrFor,
} = require('./daemon_control_bind.cjs');
const { toggleWindowZoom } = require('./window_controls.cjs');
const {
  isMissingAppConfigTableError,
  shouldUseLegacyConfigFallback,
} = require('./config_load_policy.cjs');
// Sync-verify poll loop — gates commit/promote behind daemon's
// /v1/sync-verify "transport really quiesced" check. See
// sync_verify_client.cjs for the outcome contract.
const { pollSyncVerify } = require('./sync_verify_client.cjs');
// Diff Viewer commit 1: pure helpers for the read-only Changes feed.
const {
  MAX_PATCH_BYTES_PER_FILE,
  parseUnifiedDiff,
  synthesizeUntrackedPatch,
  statusFromPorcelain,
  applyWorkspaceCap,
} = require('./git_diff.cjs');
// File-tree sync visibility (plan: docs/superpowers/plans/2026-05-25-file-tree-sync-visibility.md)
//   - sync_override_store: project-scoped "always sync this path" overrides
//   - snapshot_session_store: durable per-session metadata for snapshot pipeline
//   - sync_mode_store: per-project + global default lightweight/full mode
//   - ignore_evaluator: hard-ignore front predicate + override claw-back
//   - file_tree_children: lazy directory listing IPC helper
//   - file_tree_sync_disposition: pure classifier for cloud-vs-local node state
const { createSyncOverrideStore } = require('./sync_override_store.cjs');
const { createSyncModeStore } = require('./sync_mode_store.cjs');
const { buildIgnoreMatcher, isHardIgnored: isHardIgnoredRel } = require('./ignore_evaluator.cjs');
const { listFileTreeChildren } = require('./file_tree_children.cjs');
const { createManifestClient, computeOverrideAnchorsInManifest } = require('./manifest_client.cjs');
const {
  isSyncthingBackend,
  shouldUseLegacyManifestForFileTree,
} = require('./sync_backend_helpers.cjs');
const { writeStignoreFile } = require('./stignore_writer.cjs');
const {
  isTenantClientInviteToken,
  tenantClientRegisterBody,
  tenantClientActivationConfig,
} = require('./tenant_client_activation.cjs');
// Phase 1.1 (syncthing migration): child-process manager. Spawns the
// bundled syncthing binary on app start, stops it on app quit. The
// resulting deviceId / apiKey / guiAddress feed Phase 1.2 (pair-after-
// activation) + Phase 1.3 (folder + .stignore wiring).
const syncthingProcess = require('./syncthing_process.cjs');
// Phase 2 (syncthing migration): /rest/events long-poll subscriber.
// Folds events into a derived per-folder/per-peer state cache that
// the renderer reads via the syncthing:state IPC. Started right
// after the child becomes healthy, stopped before child shutdown.
const syncthingEventSub = require('./syncthing_event_subscriber.cjs');
// Phase 1.2(b) (syncthing migration): pair-after-activation client.
// requestPairInfo POSTs the desktop's syncthing device_id to the
// server's /api/v1/syncthing/pair-info and gets back the server's
// device_id + canonical folder_id; applyPairInfoLocally then runs
// the local PutDevice + PutFolder.
const syncthingPair = require('./syncthing_pair.cjs');
const syncthingClientModule = require('./syncthing_client.cjs');
const {
  mapSyncthingProjectConnectionState,
  projectUsesSyncthingState,
  syncthingProjectIsActive,
} = require('./syncthing_project_state.cjs');
const { loadSyncthingProjectSnapshot } = require('./syncthing_status_snapshot.cjs');
const projectSize = require('./project_size.cjs');
// PTY-driven concurrent sync (plan T4-T6). Tracker watches PTY
// lifecycle, scheduler runs the pair-worker on tracker events. Wiring
// adapts the pair-worker contract to the existing syncthing_pair +
// syncthing_client primitives. workspace:select and the legacy
// schedulePairAfterActivation call sites are gated by
// ENABLE_PTY_DRIVEN_SYNC (true by default once T6 lands) so a regression
// can be rolled back without redeploying.
const { createPtyProjectTracker } = require('./pty_project_tracker.cjs');
const { createSyncScheduler } = require('./sync_scheduler.cjs');
const { createSyncSchedulerWiring } = require('./sync_scheduler_wiring.cjs');
const { createProjectImportQueue } = require('./project_import_queue.cjs');
const { createProjectImportQueueStore } = require('./project_import_queue_store.cjs');
const { projectRelPathFromRootBase, resolveJobRelPathOrThrow } = require('./project_rel_path.cjs');
const {
  queuedUploadSnapshotState,
  queuedUploadSnapshotComplete,
  queuedUploadSnapshotFatal,
} = require('./queued_upload_snapshot.cjs');
const { storageBaseDirForAdoptedProjectPath } = require('./project_import_adoption.cjs');
const { findAdoptableIdleSyncthingProject } = require('./project_import_adoption_runtime.cjs');
const {
  decideExistingImportTarget,
  queuedImportMatchesWorkspace,
} = require('./project_import_target.cjs');

const ENABLE_PTY_DRIVEN_SYNC = String(process.env.KARI_DISABLE_PTY_SYNC || '').trim() !== '1';
let ptyProjectTracker = null;
let syncSchedulerSingleton = null;
let syncSchedulerBootSweepPromise = Promise.resolve();
let projectImportQueueSingleton = null;
// PTY-driven sync follow-up: a project being "open in the UI" should
// keep it actively syncing even without a real PTY. We register a
// virtual handle in the tracker so the project's ptyCount is non-zero
// while it's the focused project. Closing the project view OR opening
// a different one swaps the handle to the new project; a pinned real
// PTY continues to hold the previous project's count above zero so it
// keeps syncing in the background (the explicit pin use case).
let currentUiActiveProjectAbsPath = null;
const UI_ACTIVE_HANDLE_PREFIX = 'ui-active:';

async function setUiActiveProject(projectAbsPath) {
  if (!ptyProjectTracker) return;
  const resolved = projectAbsPath ? path.resolve(String(projectAbsPath)) : '';
  if (resolved === currentUiActiveProjectAbsPath) return;
  if (currentUiActiveProjectAbsPath) {
    ptyProjectTracker.unregisterPty(UI_ACTIVE_HANDLE_PREFIX + currentUiActiveProjectAbsPath);
  }
  currentUiActiveProjectAbsPath = resolved || null;
  if (currentUiActiveProjectAbsPath) {
    // registerForProject (not registerPty) skips the cwd→walkUp lookup.
    // The caller already knows the project root; we don't need the
    // tracker's .kariignore/.kari heuristic. Direct registration also
    // lets a freshly-bound workspace (only .kari-engine/ inside) start
    // syncing immediately on first open.
    ptyProjectTracker.registerForProject(
      UI_ACTIVE_HANDLE_PREFIX + currentUiActiveProjectAbsPath,
      currentUiActiveProjectAbsPath,
    );
  }
}

// kickInitialSyncForImport registers a virtual "import-sync" handle in
// the PTY tracker so the scheduler activates the just-imported project's
// folder and starts pushing files up to consoleZ immediately — without
// requiring the user to open the project first.
//
// Lifetime: scheduled to auto-unregister after INITIAL_SYNC_HOLD_MS (30
// min by default) — long enough for the initial bulk upload of typical
// projects. If a real PTY or setUiActiveProject fires for the same root
// before the timeout, those handles independently keep ptyCount above
// zero so the sync continues seamlessly; the import-sync handle's
// retirement just removes one of several refs. After unregister, the
// tracker's normal cooldown applies (10 min) before the folder retires.
//
// Re-importing the same path resets the timer rather than stacking
// handles. The handle key is unique per project root so multiple
// imports run concurrently with their own timers.
const IMPORT_SYNC_HANDLE_PREFIX = 'import-sync:';
const INITIAL_SYNC_HOLD_MS = 30 * 60 * 1000;
const importSyncHoldTimers = new Map();
const CONTAINER_WORKSPACE_HANDLE_PREFIX = 'container-workspace:';
let containerWorkspacePairInFlight = null;
let containerWorkspacePairRegisteredKey = '';
// ensurePtyDrivenSync constructs the PTY tracker + sync scheduler +
// renderer-event bridge if they aren't already wired. Idempotent —
// safe to call from both the boot path and from workspace-switch
// resets. The boot cleanup only deletes legacy workspace-level folder
// entries; per-project folders are intentionally preserved across app
// restarts so large customer workspaces do not rebuild from cloud on
// every launch.
function ensurePtyDrivenSync() {
  if (!ENABLE_PTY_DRIVEN_SYNC) return;
  if (ptyProjectTracker && syncSchedulerSingleton) return;
  try {
    ptyProjectTracker = createPtyProjectTracker({});
    const wiring = createSyncSchedulerWiring({
      loadStoredConfig,
      decryptActivationCode,
      defaultProjectsRoot,
      startSyncthingChild,
      syncthingProcess,
      syncthingPair,
      syncthingClient: syncthingClientModule,
      writeStignoreFile,
      getEffectiveSyncMode,
      getIncludeSetForProject,
    });
    const pairWorker = {
      activate: async (...args) => {
        await syncSchedulerBootSweepPromise.catch(() => {});
        return wiring.pairWorker.activate(...args);
      },
      retire: wiring.pairWorker.retire,
    };
    syncSchedulerSingleton = createSyncScheduler({
      tracker: ptyProjectTracker,
      pairWorker,
      resolveProject: wiring.resolveProject,
    });
    // Plan T7: bridge scheduler events to the renderer so the top-bar
    // ⇄ N badge can react to project activations / retirements /
    // forced LRU evictions. We push the full snapshot on every change
    // so the renderer never has to maintain its own derived state.
    const broadcastSyncState = () => {
      if (!syncSchedulerSingleton) return;
      broadcastRenderer('sync:state', { active: syncSchedulerSingleton.snapshot() });
    };
    for (const evt of ['sync:active', 'sync:retired', 'sync:activate:failed', 'sync:lru:evict']) {
      syncSchedulerSingleton.events.on(evt, broadcastSyncState);
    }
    // Boot legacy sweep — fire-and-forget so the scheduler is usable
    // immediately. Only drops the old two-segment workspace-level
    // folder shape. New per-project folders are durable local sync
    // config and must survive app restarts.
    syncSchedulerBootSweepPromise = (async () => {
      let meta = null;
      for (let i = 0; i < 60; i++) {
        meta = syncthingProcess && typeof syncthingProcess.getRunningMeta === 'function'
          ? syncthingProcess.getRunningMeta()
          : null;
        if (meta && meta.guiAddress && meta.apiKey) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!meta || !meta.guiAddress || !meta.apiKey) {
        console.warn('[sync-scheduler] T8 sweep skipped: syncthing meta unavailable after 30s');
        return;
      }
      try {
        const r = await syncthingPair.sweepLegacyWorkspaceFolders({
          creds: { guiAddress: meta.guiAddress, apiKey: meta.apiKey },
        });
        if (r && r.ok && r.removed && r.removed.length > 0) {
          console.log(`[sync-scheduler] legacy boot sweep removed ${r.removed.length} kari folder(s):`,
            r.removed.map((x) => `${x.folderId} (${x.shape})`).join(', '));
        } else if (r && r.ok) {
          console.log('[sync-scheduler] legacy boot sweep: 0 folders to clean');
        } else {
          console.warn('[sync-scheduler] legacy boot sweep returned not-ok:', r && r.reason);
        }
      } catch (err) {
        console.warn('[sync-scheduler] legacy boot sweep failed:', err && err.message ? err.message : err);
      }
    })();
  } catch (err) {
    console.warn('[sync-scheduler] init failed; PTY-driven sync disabled this session:', err && err.message ? err.message : err);
    ptyProjectTracker = null;
    syncSchedulerSingleton = null;
  }
}

// resetSyncStateOnWorkspaceChange tears down every piece of in-memory
// + on-disk sync state that belonged to the previous activation, so a
// fresh activation starts from a known-clean baseline. Called from the
// activation:submit handler when cfg.workspaceId actually changes;
// re-activations of the same workspace skip the reset to avoid
// churning still-valid syncthing folders.
//
// Order matters:
//   1. Clear virtual UI-active + import-sync handles so the tracker
//      stops believing the old workspace's projects are "live."
//   2. Clear the tracker — drops every real PTY handle reference too.
//      The native PTYs themselves stay running (terminals.delete is
//      NOT called); their cwds are about to move to .archive/ as part
//      of archiveStaleProjectDirsOnWorkspaceChange, at which point the
//      process exits on its own and unregisterPty is a no-op against
//      already-cleared state.
//   3. Stop the scheduler — issues pairWorker.retire for every active
//      project so the syncthing folders are deleted via REST cleanly.
//   4. Final sweepKariFoldersOnBoot — belt-and-braces for any folder
//      that scheduler didn't have in its active map (e.g. orphans
//      from a prior crashed shutdown that the scheduler observed
//      mid-cleanup).
//   5. Re-init scheduler + tracker for the new workspace.
async function resetSyncStateOnWorkspaceChange(reason) {
  console.log('[workspace-switch] resetting sync state:', reason);
  await setUiActiveProject(null).catch(() => {});
  for (const timer of importSyncHoldTimers.values()) {
    clearTimeout(timer);
  }
  importSyncHoldTimers.clear();
  let prevTracker = ptyProjectTracker;
  let prevScheduler = syncSchedulerSingleton;
  ptyProjectTracker = null;
  syncSchedulerSingleton = null;
  syncSchedulerBootSweepPromise = Promise.resolve();
  containerWorkspacePairRegisteredKey = '';
  containerWorkspacePairInFlight = null;
  if (prevScheduler && typeof prevScheduler.stop === 'function') {
    await Promise.race([
      prevScheduler.stop(),
      new Promise((r) => setTimeout(r, 5000)),
    ]).catch(() => {});
  }
  if (prevTracker && typeof prevTracker.clear === 'function') {
    prevTracker.clear();
  }
  try {
    const meta = syncthingProcess && typeof syncthingProcess.getRunningMeta === 'function'
      ? syncthingProcess.getRunningMeta()
      : null;
    if (meta && meta.guiAddress && meta.apiKey) {
      const r = await syncthingPair.sweepKariFoldersOnBoot({
        creds: { guiAddress: meta.guiAddress, apiKey: meta.apiKey },
      });
      if (r && r.ok && r.removed && r.removed.length > 0) {
        console.log(`[workspace-switch] sweep removed ${r.removed.length} folder(s)`);
      }
    }
  } catch (err) {
    console.warn('[workspace-switch] post-activation sweep failed:', err && err.message ? err.message : err);
  }
  // Re-init scheduler + tracker so the next openProject / PTY signal
  // can build fresh state under the new workspaceId. ensurePtyDrivenSync
  // is idempotent + cheap; the boot-time wiring will fast-path when
  // the singletons reappear at next call.
  ensurePtyDrivenSync();
}

function kickInitialSyncForImport(projectAbsPath) {
  if (!ptyProjectTracker) return;
  const resolved = projectAbsPath ? path.resolve(String(projectAbsPath)) : '';
  if (!resolved) return;
  const handle = IMPORT_SYNC_HANDLE_PREFIX + resolved;
  const prevTimer = importSyncHoldTimers.get(resolved);
  if (prevTimer) clearTimeout(prevTimer);
  ptyProjectTracker.registerForProject(handle, resolved);
  const timer = setTimeout(() => {
    importSyncHoldTimers.delete(resolved);
    if (ptyProjectTracker) ptyProjectTracker.unregisterPty(handle);
  }, INITIAL_SYNC_HOLD_MS);
  if (typeof timer.unref === 'function') timer.unref();
  importSyncHoldTimers.set(resolved, timer);
}

// Lazy singletons — initialized on first use so app.getPath('userData')
// has been resolved (it's only safe after app.whenReady). All store
// state lives at <userData>/{sync_overrides,snapshot_sessions,sync_modes}.json.
//
// The factories use atomic .tmp+rename writes and per-store mutation
// serializers so concurrent IPC calls don't race the underlying files.
let _syncOverrideStore = null;
let _syncModeStore = null;
let _manifestClient = null;
function syncOverrideStore() {
  if (!_syncOverrideStore) {
    _syncOverrideStore = createSyncOverrideStore({
      filePath: path.join(app.getPath('userData'), 'sync_overrides.json'),
    });
  }
  return _syncOverrideStore;
}
function syncModeStore() {
  if (!_syncModeStore) {
    _syncModeStore = createSyncModeStore({
      filePath: path.join(app.getPath('userData'), 'sync_modes.json'),
    });
  }
  return _syncModeStore;
}
function manifestClient() {
  if (!_manifestClient) {
    _manifestClient = createManifestClient({});
  }
  return _manifestClient;
}

// Top-level wrappers — every plan code sample uses bare names like
// addOverride(...) / findActiveByIdentity(...) / getEffectiveSyncMode(...)
// without per-callsite store instance qualification. Wrappers below
// resolve to the singletons above so the plan snippets are copy-pastable
// and method names stay consistent with the plan (file-tree round-5 P0).
async function addOverride(args) { return syncOverrideStore().addOverride(args); }
async function removeOverride(args) { return syncOverrideStore().removeOverride(args); }
async function markOverrideCommitted(args) { return syncOverrideStore().markOverrideCommitted(args); }
async function dryRunAddOverride(args) { return syncOverrideStore().dryRunAddOverride(args); }
async function getIncludeSetForProject(args) { return syncOverrideStore().getIncludeSetForProject(args); }
async function getPendingOverrideSetForProject(args) { return syncOverrideStore().getPendingOverrideSetForProject(args); }
async function getEffectiveSyncMode(args) { return syncModeStore().getEffectiveSyncMode(args); }
async function getGlobalDefaultSyncMode() { return syncModeStore().getGlobalDefaultSyncMode(); }
async function setGlobalDefaultSyncMode(mode) { return syncModeStore().setGlobalDefaultSyncMode(mode); }
async function getProjectSyncMode(args) { return syncModeStore().getProjectSyncMode(args); }
async function setProjectSyncMode(args, mode) { return syncModeStore().setProjectSyncMode(args, mode); }
async function clearProjectSyncMode(args) { return syncModeStore().clearProjectSyncMode(args); }

// Crash recovery wrappers (B10). Used by the boot-time sweep (one
// console.warn line per leftover) and by the renderer-driven cleanup
// IPC.
function stagingRoot() {
  return path.join(app.getPath('userData'), 'staging');
}
// Phase 0 (syncthing migration): snapshot session store + crash scan
// removed; syncthing reconciliation replaces them in Phase 1.3.
async function scanCrashStateNow() { return { nonTerminalSessions: [], orphanStagingDirs: [] }; }
async function cleanupOrphanStaging() { return { ok: false, reason: 'disabled' }; }

// Per-workspace refresh serialization (round-1 codex #1+#2). Multiple
// near-simultaneous mutations (e.g. setProjectMode → click "always sync")
// would otherwise interleave their refresh chains: refresh A reads
// state at T0, refresh B reads state at T1, B writes at T2, A writes
// at T3 → .stignore reflects A's older read. Serializing per workspace
// guarantees the LAST refresh trigger always sees the latest store
// state by the time its read fires.
const stignoreRefreshMutex = new Map();
function workspaceMutexKey(cfg) {
  return [
    String(cfg.serverAddr || ''),
    String(cfg.workspaceId || ''),
    String(cfg.workspaceName || ''),
    String(cfg.workspaceRoot || ''),
  ].join('|');
}

// Refresh {workspaceRoot}/.stignore for the currently-bound workspace.
// Idempotent + best-effort: logs but doesn't throw on failure (daemon's
// prior .stignore is the fallback). Skips quietly when:
//   - no workspace is bound (cfg.workspaceRoot empty)
//   - workspace is filesync-backed (.stignore is a Syncthing concept)
//   - workspaceRoot doesn't exist on disk (project not yet downloaded)
//
// Called by bindAndStartDaemon (before /v1/bind so daemon's Syncthing
// reads the correct filter on first scan) and by every state mutation
// that affects the effective ignore set: addOverride / removeOverride
// / markOverrideCommitted / setProjectSyncMode / clearProjectSyncMode.
//
// NOT declared `async` (round-3 codex #1): an async function wraps
// its return value in a NEW outer promise, so the caller would receive
// a different promise object than the `next` we store in the mutex
// — breaking the bind-time eject's identity check. This function
// returns the stored promise directly so eject can compare references.
function refreshStignoreForCurrentWorkspace(cfg) {
  if (!cfg) return Promise.resolve({ ok: false, reason: 'missing_cfg' });
  if (!cfg.workspaceRoot) return Promise.resolve({ ok: false, reason: 'no_workspace' });
  if (!isSyncthingBackend(cfg)) return Promise.resolve({ ok: false, reason: 'not_syncthing_backend' });
  // Serialize per workspace so concurrent refreshes don't race on
  // shared .stignore (round-1 codex #1+#2). Reads of effective mode +
  // override set + .stignore content happen INSIDE the mutex so each
  // chain sees the latest committed state.
  const key = workspaceMutexKey(cfg);
  const prev = stignoreRefreshMutex.get(key) || Promise.resolve();
  const next = prev.catch(() => null).then(() => doRefreshStignore(cfg));
  // Cleanup: when this refresh finishes, drop the mutex slot iff our
  // promise is still the latest (otherwise a newer refresh has chained
  // off us and owns the slot).
  next.finally(() => {
    if (stignoreRefreshMutex.get(key) === next) {
      stignoreRefreshMutex.delete(key);
    }
  });
  stignoreRefreshMutex.set(key, next);
  return next;
}

async function doRefreshStignore(cfg) {
  try {
    await fsp.access(cfg.workspaceRoot);
  } catch {
    return { ok: false, reason: 'workspace_root_missing' };
  }
  const identity = {
    serverAddr: cfg.serverAddr,
    workspaceId: cfg.workspaceId,
    workspaceName: cfg.workspaceName,
  };
  const mode = await getEffectiveSyncMode(identity).catch(() => 'lightweight');
  const includeOverrides = await getIncludeSetForProject(identity).catch(() => new Set());
  const result = await writeStignoreFile({
    projectRoot: cfg.workspaceRoot,
    mode,
    includeOverrides,
  });
  if (!result.ok && result.reason !== 'workspace_root_missing') {
    console.warn('[stignore_writer] refresh failed:', result.reason, result.error || '');
  }
  return result;
}

// Phase 4.6: refreshStignoreForBind was the bind-time race wrapper
// around refreshStignoreForCurrentWorkspace. With bindAndStartDaemon
// retired, nothing needs the timeout race — sync mode / override
// mutations write .stignore directly (no daemon round-trip).
// Phase 0 (syncthing migration): snapshot session lookups no-op until
// syncthing replaces the upload-intent flow.
async function findActiveByIdentity() { return null; }
async function findActiveByScope() { return null; }

// Manifest client wrappers. The classifier consumes a Set<string> of
// relPaths the latest committed manifest contains; getManifestPaths is
// the thin convenience over fetchLatestManifest.
//
// IDENTITY CONTRACT — server-first architecture (mgmt unreachable
// must NOT break sync):
//   {
//     serverAddr: cfg.serverAddr,         // HTTP base + cache + auth-hash
//     workspaceId: cfg.workspaceId,       // cache isolation
//     workspaceName: cfg.workspaceName,   // HTTP path + cache
//     activationCode: decryptActivationCode(cfg),  // auth + auth-hash
//   }
//
// managementUrl is DELIBERATELY NOT in this tuple. mgmt only owns
// account/auth/activation; the sync data plane (workdirs, manifests,
// staging, verify) is owned by the user's server. Self-hosted /
// intranet deployments may have mgmt unreachable; sync must keep
// working as long as serverAddr + activationCode are valid.
async function getManifestPaths(fullIdentity) {
  return manifestClient().getManifestPaths(fullIdentity);
}
// Returns the full manifest result ({ok, manifestId, paths, entries,
// fetchedAt, reason}) — callers that need manifest_id (e.g. for
// markOverrideCommitted) use this; callers that only need the path
// Set use getManifestPaths above.
async function fetchLatestManifest(fullIdentity) {
  return manifestClient().fetchLatestManifest(fullIdentity);
}
function invalidateManifestCache(fullIdentity) {
  manifestClient().invalidate(fullIdentity);
}

// Auto-commit pending overrides whose anchor's content has landed in
// the cloud manifest (FT-Task-MC2). Closes the "always_sync persists
// → next regular sync uploads → override stays pending forever" loop
// WITHOUT needing FT-Task-6's path-scoped upload pipeline: when the
// next files:listChildren refresh fetches a manifest containing the
// anchor's files, we flip pending → committed automatically.
//
// Works regardless of HOW the upload happened (legacy filesync flow,
// future path-scoped flow, manual sync trigger). The check is cheap
// (one Set scan per pending anchor) and the caller gates on the
// manifestResult's `fromCache` flag so cache-hit IPCs don't redo the
// per-anchor markOverrideCommitted serializer writes (round-2 codex
// #1 on FT-Task-MC2 — was previously fired on every IPC; idempotent
// but wasteful at scale).
async function autoCommitPendingOverridesFromManifest({
  identity,        // override store identity (server, ws, name)
  manifestId,      // string from fetchLatestManifest result
  manifestPaths,   // Set<string> from fetchLatestManifest result
  pendingOverrides, // Set<string> from getPendingOverrideSetForProject
}) {
  if (!manifestId || !manifestPaths || manifestPaths.size === 0) return;
  if (!pendingOverrides || pendingOverrides.size === 0) return;
  const committed = computeOverrideAnchorsInManifest(manifestPaths, pendingOverrides);
  if (committed.size === 0) return;
  // Flip each anchor sequentially via the store's mutation serializer.
  // markOverrideCommitted is idempotent — if a concurrent call already
  // flipped the row, the second one is a no-op.
  for (const anchor of committed) {
    try {
      await markOverrideCommitted({ ...identity, relPath: anchor, manifestId });
    } catch (e) {
      // Best-effort: a single anchor failing shouldn't block the rest.
      // The next refresh will retry. (Common failure: identity went
      // INCOMPLETE between the listChildren start and this call —
      // e.g. user logged out mid-render.)
      console.warn('autoCommitPendingOverridesFromManifest: failed for ' + anchor, e);
    }
  }
}

// Phase 0 (syncthing migration): cancelSnapshotSession is now a no-op
// because the snapshot session store has been deleted. Once syncthing
// owns the data plane in Phase 1.3 there are no client-issued
// "snapshot" sessions to cancel — folder reconcile + .stversions on the
// server side is the new abandon surface.
async function cancelSnapshotSession(_sessionId, _reason) { return { ok: false, found: false, reason: 'snapshot_disabled' }; }

// Dispatcher for files:pathAction. Splits the three menu actions:
//
//   - force_upload_once: one-shot path-scoped snapshot upload that
//     bypasses the lightweight denylist for THIS path only. No store
//     mutation — the override is transient.
//   - always_sync_path: dryRun first (detect dominating / covered /
//     hard-ignore), surface to renderer for confirm dialog when
//     wouldDominate is non-empty. On confirm (replaceChildren:true)
//     persist + trigger path-scoped snapshot upload.
//   - stop_always_syncing: cancel in-flight path-scoped session
//     (atomic via cancelIfNonTerminal) THEN remove the override row.
//     If the session committed between our cancel attempt and removal,
//     surface override_already_committed so the user knows the cloud
//     copy still exists.
//
// The path-scoped snapshot upload (uploadProjectPathOverride) is a
// FT-Task-6 deliverable; this dispatcher stubs the upload trigger with
// a documented placeholder code until that lands. The cancel /
// removeOverride flow is fully functional because cancelIfNonTerminal +
// removeOverride exist today (FT-PRE-A + FT-Task-2b).
async function runPathScopedSyncAction({ action, root, abs, relPath, cfg, identity, payload }) {
  if (action === 'always_sync_path') {
    // 1. Dry-run first to detect dominating-anchor case. If the user
    //    is adding a BROADER anchor that would shadow N existing
    //    narrower overrides, return code='would_dominate' with the
    //    list — the renderer surfaces a confirm dialog, and on
    //    confirm re-issues this IPC with replaceChildren:true.
    //
    // On the renderer's confirm re-fire (replaceChildren:true), we
    // STILL run dry-run (round-1 codex #3 — over-broad consent risk).
    // The renderer also passes `expectedDominated: string[]` (the
    // exact list it showed in the confirm dialog). If the current
    // dominated set diverges from expectedDominated (new dominated
    // rows appeared, or some were independently removed), reject with
    // a fresh `would_dominate` so the user can re-confirm the new
    // list. This prevents "user clicks confirm on {A,B} dialog,
    // {C} appears in-between, we silently delete A+B+C."
    const wantReplace = !!(payload && payload.replaceChildren);
    const expectedDominated = (payload && Array.isArray(payload.expectedDominated))
      ? payload.expectedDominated.slice().sort()
      : null;
    const dryRun = await dryRunAddOverride({ ...identity, relPath });
    if (dryRun.wouldRejectHardIgnore) {
      return { ok: false, code: 'hard_ignored' };
    }
    if (dryRun.wouldBeCoveredBy) {
      return {
        ok: false,
        code: 'COVERED_BY_ANCESTOR_OVERRIDE',
        ancestor: dryRun.wouldBeCoveredBy,
        interp: { ancestor: dryRun.wouldBeCoveredBy },
      };
    }
    if (dryRun.wouldDominate.length > 0) {
      const currentSorted = dryRun.wouldDominate.slice().sort();
      const setsEqual = expectedDominated
        && currentSorted.length === expectedDominated.length
        && currentSorted.every((v, i) => v === expectedDominated[i]);
      if (!wantReplace || !setsEqual) {
        // Either first-time prompt (!wantReplace) OR re-fire confirm
        // with a stale expected set. Surface the CURRENT dominated
        // list so the renderer can re-show the dialog with accurate
        // contents. Renderer should reset its in-flight replace
        // confirmation on every would_dominate response.
        return {
          ok: false,
          code: 'would_dominate',
          wouldDominate: currentSorted,
          interp: { count: currentSorted.length },
        };
      }
      // wantReplace AND sets match — confirmed consent for the exact
      // dominated list the user saw. Proceed.
    }
    // 2. Persist project-scoped override (replaceChildren=true if
    //    renderer confirmed the dominating-anchor dialog).
    try {
      await addOverride({ ...identity, relPath, replaceChildren: wantReplace });
    } catch (err) {
      // Race condition: dry-run said no domination, but a concurrent
      // addOverride landed between dry-run and our add → store throws
      // DOMINATES_EXISTING_OVERRIDES with err.wouldDominate attached.
      // The outer try/catch only extracts code+message, dropping the
      // payload (round-1 codex #2). Re-shape into the dispatcher's
      // would_dominate response so the renderer can re-show the dialog.
      if (err && err.code === 'DOMINATES_EXISTING_OVERRIDES' && Array.isArray(err.wouldDominate)) {
        return {
          ok: false,
          code: 'would_dominate',
          wouldDominate: err.wouldDominate,
          interp: { count: err.wouldDominate.length },
        };
      }
      if (err && err.code === 'COVERED_BY_ANCESTOR_OVERRIDE' && err.ancestor) {
        return {
          ok: false,
          code: 'COVERED_BY_ANCESTOR_OVERRIDE',
          ancestor: err.ancestor,
          interp: { ancestor: err.ancestor },
        };
      }
      throw err;  // unhandled → outer try/catch produces {ok:false, code}
    }
    // 3. FT-Task-6 placeholder: trigger path-scoped snapshot upload
    //    so the user sees red/yellow → green within seconds of the
    //    click. Until the upload pipeline lands, return a
    //    documented stub code. The override row IS persisted, so the
    //    next time a normal sync runs the path will be included.
    return { ok: true, persisted: true, code: 'upload_pending_ft_task_6' };
  }

  if (action === 'force_upload_once') {
    // Stub until FT-Task-6 wires uploadProjectPathOverride. The
    // intent: one-shot snapshot of ONLY this path's subtree, bypass
    // lightweight denylist for the duration; no store mutation. For
    // now surface a clear placeholder code so the renderer can show
    // "feature pending" rather than a silent no-op.
    return { ok: false, code: 'upload_pending_ft_task_6' };
  }

  if (action === 'stop_always_syncing') {
    // Cancel-then-remove order matters. If an in-flight path-scoped
    // session is still uploading for THIS anchor, we MUST cancel it
    // before removing the store row — otherwise the snapshot continues
    // and commits a manifest containing the just-retracted path.
    // findActiveByScope is the 5-tuple lookup that matches the SAME
    // anchor (parallel sessions for different anchors are allowed).
    const inFlight = await findActiveByScope({
      ...identity,
      direction: 'upload-path-scoped',
      scopeRelPath: relPath,
    }).catch(() => null);
    let cancelledSessionId = null;
    if (inFlight) {
      // cancelSnapshotSession + cancelIfNonTerminal under the store's
      // serializer — if the session committed between our findActive
      // and the cancel, alreadyTerminal=true with committedManifestId set
      // surfaces the race.
      const cancelResult = await cancelSnapshotSession(inFlight.id, 'cancelled_by_user_remove_override');
      if (cancelResult && cancelResult.alreadyTerminal && cancelResult.committedManifestId) {
        // Lost the race — the session committed. Leave the override
        // row in place so the user can decide what to do next.
        return { ok: false, code: 'override_already_committed' };
      }
      if (cancelResult && cancelResult.found && !cancelResult.alreadyTerminal) {
        cancelledSessionId = inFlight.id;
      }
    }
    try {
      const result = await removeOverride({ ...identity, relPath });
      return { ok: true, removed: !!(result && result.removed) };
    } catch (removeErr) {
      // Partial-failure observability (round-1 codex #4): we
      // successfully cancelled the upload session AND wiped its staging
      // dir, but the override-row removal failed (transient disk error,
      // INCOMPLETE_IDENTITY if pairing flipped mid-operation, etc.).
      // Retry is safe — findActiveByScope will now return null because
      // the session is terminal, so the retry will go straight to
      // removeOverride. But surface the gap clearly in logs so operators
      // can correlate "user clicked Stop, session is gone, override row
      // is stale" reports.
      if (cancelledSessionId) {
        console.warn('[files:pathAction] stop_always_syncing: session ' + cancelledSessionId
          + ' was cancelled but override row removal failed; retry expected',
          { relPath, error: String((removeErr && removeErr.message) || removeErr) });
      }
      throw removeErr;
    }
  }

  // Unreachable — the IPC handler already validated the action enum.
  return { ok: false, code: 'invalid_action' };
}

// Path-escape guard for path-scoped IPC. Stricter than
// assertInsideWorkspace (which is lexical-only): also runs realpath()
// so a symlink whose target escapes the workspace is rejected at the
// IPC boundary. The path-scoped upload flow is the only caller that
// follows up with file IO under user-supplied paths, so this stronger
// check lives here rather than in the existing helper. (file-tree
// visibility round-4 P2.)
async function assertInsideWorkspaceRealpath(root, target) {
  const lexical = assertInsideWorkspace(root, target);  // lexical guard first
  try {
    const realRoot = await fsp.realpath(root);
    const realTarget = await fsp.realpath(lexical);
    const rel = path.relative(realRoot, realTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const err = new Error('路径不在项目目录内');
      err.code = 'path_escapes_workspace';
      throw err;
    }
    return realTarget;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Target doesn't exist (e.g. the user is trying to override a
      // path that was just deleted). Fall back to the lexical-only
      // result — the caller will hit a separate "no syncable files"
      // error downstream.
      return lexical;
    }
    throw err;
  }
}

// Single-tenant OSS build uses its OWN daemon port (46331, not the
// commercial 46321) so it never reuses a stale/commercial kari-syncd that
// is bound to a different server — the daemon is a detached process that
// survives app restarts, so a shared port silently cross-binds.
const DAEMON_ADDR = process.env.KARI_SYNCD_ADDR || '127.0.0.1:46331';
const DAEMON_BASE = process.env.KARI_SYNCD_URL || `http://${DAEMON_ADDR}`;
// Single-tenant OSS: there is no cloud management URL. Kept as an empty
// constant so the few remaining references (defaultConfig) resolve harmlessly.
const DEFAULT_MANAGEMENT_URL = '';

// Phase 0 (syncthing migration): external-editor watcher + snapshot
// upload scheduler removed. Syncthing's own folder scan will pick up
// external-editor changes once Phase 1.3 wires the folder.
function startAutoSnapshotWatcher(_workspaceRoot) { /* no-op until syncthing folder bind lands */ }
function stopAutoSnapshotWatcher() { /* no-op */ }

const APP_DISPLAY_NAME = 'Kari';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo']);
// Storage Location Boundary (locked product rule):
//   - User picks a `storageBaseDir` (e.g. /Volumes/D, ~/Documents, default
//     userData). This is NOT the project root — Kari Desktop creates its
//     own controlled container directory underneath.
//   - The container is always named `KARI_CONTAINER_DIR` (kari-drive),
//     so the actual projectsRoot = `<storageBaseDir>/kari-drive/`.
//   - Projects ONLY live inside this container:
//        <storageBaseDir>/kari-drive/project-a/
//        <storageBaseDir>/kari-drive/project-b/
//   - We NEVER drop projects directly into the user-chosen
//     storageBaseDir. User mental model: "I tell Kari where to store
//     things; Kari manages the layout inside." Operator mental model:
//     this is a container DIRECTORY, not a single-file disk image
//     (no FUSE / dmg / zip / sqlite blob).
//
// Default storageBaseDir = Electron userData (kari-desktop owns it).
// Macro paths:
//   macOS:   ~/Library/Application Support/kari-desktop/kari-drive/
//   Windows: %APPDATA%/kari-desktop/kari-drive/
//   Linux:   ~/.config/kari-desktop/kari-drive/
//
// Kari-owned project storage container. Intentionally a VISIBLE directory
// (no leading dot, no OS hidden flag) so users can find it in Finder/Explorer.
// UI still calls this boundary "Kari 存储" and does not expose the folder name.
const KARI_CONTAINER_DIR = 'kari-drive';

let mainWindow = null;
let configCache = null;
let ptyModule = null;
let runtimeCache = null;
let daemonProc = null;
let quitAfterDaemonStop = false;
// Phase 4.6: lastMirrorBindAttempt was the cooldown for legacy
// daemon-bind retries; obsolete with syncthing-managed binding.
// Daemon watchdog state (Phase 3). daemonStopReason discriminates the
// reason a kari-syncd process exited:
//   'user_quit' — app quit, manual stop, intentional replace → do NOT
//                 auto-restart; that defeats the user's intent.
//   'crash'     — anything else (segfault, OOM, kill -9, panic). The
//                 watchdog should respawn unless crash-loop guard
//                 fires.
//   null        — daemon has not exited (running or never started).
// crashTimestamps is a sliding-window list of epoch-ms crash times;
// when 5 land within 60s the watchdog enters a 5min cooldown
// (crashCooldownUntil) before allowing another spawn.
let daemonStopReason = null;
let crashTimestamps = [];
let crashCooldownUntil = 0;
let daemonRespawnTimer = null;
// daemonSpawnInFlight serializes concurrent ensureDaemonRunning
// callers so we never end up with two kari-syncd processes racing
// for port 46321 (scheduler health probe + startup auto-bind +
// exit-listener respawn timer + manual IPC can all race).
let daemonSpawnInFlight = null;
let daemonControlBindInFlight = null;
let daemonControlBindLastKey = '';
const {
  recordCrash: recordDaemonCrash,
  shouldEnterCooldown: daemonShouldCooldown,
  computeCooldownUntil: daemonComputeCooldown,
  canSpawnNow: daemonCanSpawnNow,
  DEFAULT_RESPAWN_DELAY_MS: DAEMON_RESPAWN_DELAY_MS,
} = require('./daemon_watchdog_policy.cjs');
// Phase 0 (syncthing migration): snapshot upload scheduler removed.
// Syncthing's own folder watch + index pipeline replaces it in Phase 1.3.
// Stub that returns inert handles so the few remaining callers (which
// will be deleted as soon as their full call chain is rewritten) keep
// compiling without doing anything.
function ensureUploadScheduler() {
  return {
    schedule: async () => ({ ok: false, code: 'scheduler_disabled' }),
    runNow: async () => ({ ok: false, code: 'scheduler_disabled' }),
    onWorkspaceBind: async () => undefined,
    getState: () => null,
  };
}

// Ephemeral live import progress, keyed by job id. NOT persisted — re-derived
// when a job re-runs. Merged into the queue broadcast so the renderer can show
// "scanning NN%" / sync % instead of a bare spinner.
const importProgressById = new Map();

function importJobsWithProgress(jobs) {
  return publicProjectImportJobs(jobs).map((job) => {
    const progress = importProgressById.get(job.id);
    return progress ? { ...job, progress } : job;
  });
}

function ensureProjectImportQueue() {
  if (projectImportQueueSingleton) return projectImportQueueSingleton;
  const store = createProjectImportQueueStore({ dbPath: configDbPath() });
  projectImportQueueSingleton = createProjectImportQueue({
    store,
    // Bounded parallelism: process 2–3 imports at once (Syncthing syncs many
    // folders concurrently; claims stay serialized so rows aren't double-grabbed).
    concurrency: Math.max(1, Number(process.env.KARI_IMPORT_QUEUE_CONCURRENCY || 2)),
    processJob: processQueuedProjectImport,
    onChange: (jobs, event) => {
      // Drop progress for jobs that are no longer active (succeeded/failed).
      const activeIds = new Set((Array.isArray(jobs) ? jobs : []).map((j) => j && j.id));
      for (const id of [...importProgressById.keys()]) {
        if (!activeIds.has(id)) importProgressById.delete(id);
      }
      const payload = { jobs: importJobsWithProgress(jobs) };
      if (event && event.failedJob) {
        payload.failedJob = publicProjectImportJobs([event.failedJob])[0] || null;
      }
      broadcastRenderer('projects:importQueue', payload);
    },
    onProgress: (jobId, progress) => {
      // Just stash progress; the queue's ordered emitChange (triggered right
      // after this) broadcasts the active set with progress merged in (see
      // onChange below). Doing a separate async snapshot+broadcast here raced
      // the success broadcast and left the UI stuck on "migrating".
      importProgressById.set(String(jobId), progress);
    },
    logger: {
      warn: (msg) => console.warn('[project-import-queue]', msg),
    },
  });
  return projectImportQueueSingleton;
}

function publicProjectImportJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => ({
    id: String(job.id || ''),
    sourcePath: String(job.sourcePath || ''),
    workspaceName: String(job.workspaceName || ''),
    state: String(job.state || ''),
    attempts: Number(job.attempts || 0),
    createdAt: String(job.createdAt || ''),
    updatedAt: String(job.updatedAt || ''),
    error: String(job.error || ''),
  })).filter((job) => job.id);
}

async function enqueueProjectImport(projectPath) {
  const sourcePath = path.resolve(String(projectPath || ''));
  if (!sourcePath) return { ok: false, code: 'missing_path', error: '缺少 projectPath。' };
  const cfg = await loadStoredConfig();
  if (!cfg.activated) return { ok: false, code: 'not_activated', error: '请先激活。' };
  const stat = await fsp.stat(sourcePath).catch(() => null);
  if (!stat) return { ok: false, code: 'source_not_found', error: '路径不存在。' };
  if (!stat.isDirectory()) return { ok: false, code: 'source_not_directory', error: '选择的路径不是目录。' };
  const workspaceName = cleanWorkspaceName(path.basename(sourcePath)) || 'workspace';
  const job = await ensureProjectImportQueue().enqueue({
    sourcePath,
    workspaceName,
    payload: {
      sourcePath,
      workspaceName,
      enqueuedWorkspaceId: cfg.workspaceId || '',
      enqueuedAt: new Date().toISOString(),
    },
  });
  return { ok: true, queued: true, job: publicProjectImportJobs([job])[0], workspaceName, path: sourcePath };
}

async function processQueuedProjectImport(job, stage = {}) {
  const sourcePath = String((job && job.payload && job.payload.sourcePath) || job.sourcePath || '');
  const cfg = await loadStoredConfig();
  if (!queuedImportMatchesWorkspace(job && job.payload, cfg)) {
    throw new Error('queued import belongs to a different workspace');
  }
  const result = await importLocalProject(sourcePath, {
    resumeExistingCurrentTarget: Number(job && job.attempts || 0) > 1,
  });
  if (!result || !result.ok) {
    // Prefix the machine code so the renderer can soften known-benign outcomes
    // (e.g. re-importing an already-present project) instead of showing a
    // scary "import failed". The code is stable/non-localized; the human
    // detail follows it.
    const code = (result && result.code) || '';
    const detail = (result && result.error) || code || 'import failed';
    const err = new Error(code ? `${code}: ${detail}` : detail);
    err.result = result;
    throw err;
  }
  await waitForQueuedProjectUpload(result, stage).catch((err) => {
    console.warn('[project-import-queue] upload wait failed:', err && err.message ? err.message : err);
    throw err;
  });
}

const terminals = new Map();
// Process-lifetime per-project sync state cache. Survives
// projects:list reloads; cleared only on app quit / activation reset.
const syncStateCache = createSyncStateCache();
// Sync-task tracker. The cache + tracker pair together replace the
// pre-rewrite pendingDownloads Map and reconcilePendingDownloads
// sweep: registration happens in openProject/downloadProject/
// uploadProject; pollSyncTasks (run from daemonSnapshot) drives
// state transitions; abandonDownload tears entries down on user
// cancel.
const syncTaskTracker = createSyncTaskTracker({
  cache: syncStateCache,
  warn: (...args) => console.warn('[sync_task_tracker]', ...args),
});
// Daemon version detection: null=unknown, true=has /v1/sync-tasks,
// false=missing (old daemon). uploadProject/downloadProject refuse
// when false; openProject of already-downloaded cloud projects still
// works (no sync started, but Files view loads).
let daemonSyncTaskSupported = null;
// Cooldown timestamp (ms epoch). Set when postSyncTask sees a 404/405
// from /v1/sync-tasks; while Date.now() < this value, postSyncTask
// short-circuits with `daemon_too_old` instead of re-POSTing. After
// the cooldown elapses postSyncTask is allowed to probe again (a
// single 404 no longer permanently sticks the gate for the session).
// 5xx / timeout responses do NOT touch this — those are transient
// and bubble up as `sync_task_failed` so the renderer can show the
// real error. Set to 0 when daemon comes back online (cleared via
// daemonSyncTaskSupportStatus or daemon replacement).
let daemonSyncTaskCooldownUntil = 0;
// Cooldown window (ms). Long enough to avoid hammering an obviously-
// broken endpoint, short enough that an in-flight daemon upgrade
// completes before the user gets stuck.
const DAEMON_SYNC_TASK_COOLDOWN_MS = 60_000;
// Marker-file recovery runs once per daemon session: after the
// first successful pollSyncTasks, walk cloud projects with the
// incomplete marker and reconcile them via GET /v1/sync-tasks/current.
let daemonRecoveryDone = false;
// Last observed daemon-side active sync-task count. The renderer uses
// DaemonStatus.transferCount to decide whether to poll projects every
// second; this must include ambient daemon tasks, not only tasks
// registered by this Desktop process.
let activeSyncTaskCount = 0;
const terminalBacklogs = new Map();
const detachedTerminalWindows = new Map();
// Terminal IDs the user "pinned" via the detached-window pin button.
// Pin protects against AUTOMATIC kills (project back-out): stopTerminal
// no-ops for pinned IDs unless opts.force is set. Explicit destructive
// flows (Stop button click, logout, app quit) pass force:true to bypass.
const pinnedTerminals = new Set();
// Terminal IDs currently owned by a renderer pane in the main project
// view. App.tsx pushes this set whenever its `panes` state changes; a
// detached window reads it to decide whether clicking its window-close
// button means "re-dock to existing pane" or "no pane to dock back to,
// so this is the only home for this PTY → stop + close".
let activeTerminalPanes = new Set();
const MAX_TERMINAL_BACKLOG = 512 * 1024;
const KARI_MCP_OSC_PREFIX = '\x1b]777;kari-mcp-session;';
const KARI_MCP_WAIT_MS = 1500;

app.setName(APP_DISPLAY_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId('com.kari.desktop');
}

function legacyConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function configDbPath() {
  return path.join(app.getPath('userData'), 'config.sqlite');
}

function appIconPath(fileName = 'icon.png') {
  const candidates = [
    path.join(app.getAppPath(), 'build', fileName),
    path.join(process.resourcesPath || '', fileName),
    path.join(process.resourcesPath || '', 'build', fileName),
    path.join(__dirname, '..', '..', 'build', fileName)
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function applyDockIdentity() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const iconPath = appIconPath('icon.png');
  if (!iconPath) return;
  try {
    app.dock.setIcon(iconPath);
  } catch (err) {
    console.warn('failed to set Dock icon:', err && err.message ? err.message : err);
  }
}

function defaultConfig() {
  return {
    activated: false,
    appVersion: app.getVersion(),
    managementUrl: DEFAULT_MANAGEMENT_URL,
    machineLabel: os.hostname(),
    serverAddr: '',
    workspaceId: '',
    workspaceName: 'workspace',
    clientId: '',
    workspaceRoot: '',
    workspaceSyncBackend: 'syncthing',
    projectsRoot: '',
    hasActivationCode: false,
    serverId: '',
    frp: null,
    capabilities: null,
    tenantClientId: '',
    hasTenantClientToken: false,
    defaultTerminalMode: 'remote',
    daemonUrl: DAEMON_BASE,
    vscodeImportDisabled: false
  };
}

function publicConfig(stored) {
  const cfg = { ...defaultConfig(), ...(stored || {}) };
  cfg.appVersion = app.getVersion();
  cfg.activationCodeHint = maskSecret(stored && stored.activationCodePlain || '');
  delete cfg.activationCodeEnc;
  delete cfg.activationCodePlain;
  delete cfg.tenantClientTokenEnc;
  delete cfg.tenantClientTokenPlain;
  cfg.hasActivationCode = Boolean(stored && stored.activationCodePlain);
  cfg.hasTenantClientToken = Boolean(stored && stored.tenantClientTokenPlain);
  cfg.daemonUrl = DAEMON_BASE;
  return cfg;
}

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 5) return `${text.slice(0, 1)}*****`;
  return `${text.slice(0, 2)}*****${text.slice(-3)}`;
}

function normalizeManagementUrl(value) {
  const text = String(value || DEFAULT_MANAGEMENT_URL).trim().replace(/\/+$/, '');
  return text || DEFAULT_MANAGEMENT_URL;
}

async function loadStoredConfig() {
  if (configCache) return configCache;
  let shouldPersist = false;
  const sqliteResult = await readSqliteConfigResult();
  if (sqliteResult.error) {
    console.warn('[config] sqlite config read failed; refusing legacy fallback:', sqliteResult.error.message);
    throw sqliteResult.error;
  }
  let stored = sqliteResult.stored;
  if (!stored && shouldUseLegacyConfigFallback({
    sqliteExists: sqliteResult.exists,
    sqliteReadFailed: false,
    sqliteStored: stored,
  })) {
    stored = await readLegacyJsonConfig();
    shouldPersist = Boolean(stored);
  }
  configCache = normalizeStoredConfig(stored);
  if (!configCache.clientId) {
    configCache.clientId = machineClientId();
    shouldPersist = true;
  }
  if (shouldPersist) {
    await writeStoredConfig(configCache).catch(() => null);
  }
  return configCache;
}

async function readSqliteConfig() {
  const result = await readSqliteConfigResult();
  if (result.error) throw result.error;
  return result.stored;
}

async function readSqliteConfigResult() {
  const dbPath = configDbPath();
  if (!fs.existsSync(dbPath)) return { exists: false, stored: null, error: null };
  // Retry transient lock/busy errors. config.sqlite is shared with the import-
  // queue store; a contended read must NOT throw (loadStoredConfig would throw
  // and config:get would then report the app as de-activated even though the
  // stored config is valid). WAL makes this rare; this is the backstop.
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const raw = await sqliteValue(dbPath, 'select value from AppConfig where id=1;');
      return { exists: true, stored: raw ? JSON.parse(raw) : null, error: null };
    } catch (err) {
      if (isMissingAppConfigTableError(err)) {
        return { exists: true, stored: null, error: null };
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = String(lastErr.message || '').toLowerCase();
      if (!(msg.includes('locked') || msg.includes('busy'))) break; // non-transient → stop
      await sleep(150 * (attempt + 1));
    }
  }
  return { exists: true, stored: null, error: lastErr };
}

async function readLegacyJsonConfig() {
  try {
    const raw = await fsp.readFile(legacyConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeStoredConfig(raw) {
  const cfg = { ...defaultConfig(), ...(raw || {}) };
  cfg.managementUrl = normalizeManagementUrl(cfg.managementUrl);
  if (typeof cfg.activationCode === 'string' && !cfg.activationCodePlain) cfg.activationCodePlain = cfg.activationCode;
  if (typeof cfg.tenantClientToken === 'string' && !cfg.tenantClientTokenPlain) cfg.tenantClientTokenPlain = cfg.tenantClientToken;
  if (cfg.activated && !cfg.activationCodePlain && raw && raw.activationCodeEnc) cfg.activated = false;
  delete cfg.activationCode;
  delete cfg.activationCodeEnc;
  delete cfg.tenantClientToken;
  delete cfg.tenantClientTokenEnc;
  return cfg;
}

// Serialize config writes. saveStoredConfig is a read-modify-write on the
// shared configCache; with bounded-parallel imports two calls can overlap and
// the later writer would clobber the earlier's fields (lost update). Chaining
// makes each call observe the previous one's committed cache.
let saveConfigChain = Promise.resolve();
function saveStoredConfig(next) {
  const run = saveConfigChain.then(() => saveStoredConfigInner(next));
  saveConfigChain = run.then(() => undefined, () => undefined);
  return run;
}
async function saveStoredConfigInner(next) {
  const current = configCache || await loadStoredConfig();
  configCache = normalizeStoredConfig({ ...current, ...(next || {}), updatedAt: new Date().toISOString() });
  await writeStoredConfig(configCache);
  return publicConfig(configCache);
}

// replaceStoredConfig is a CLEAN replace — drops the current cached
// state and starts from defaultConfig() before applying `next`. Used
// for activation transitions where we MUST NOT inherit stale fields
// (serverAddr, workspaceId, tenantClientToken, frp, capabilities,
// hasActivationCode, etc.) from a prior activation against a
// different mgmt deployment. Without this, switching mgmt (e.g.
// migrating from legacy mgmt hosts to the hosted console) would carry
// the OLD tenantClientToken into the new session — the new mgmt
// can't validate that token, every authenticated call 401s with
// "manifest_post_failed: unauthorized auth rejected by server"
// (exact symptom reported by the user). Reactivation requires a
// clean slate, period.
async function replaceStoredConfig(next) {
  configCache = normalizeStoredConfig({ ...defaultConfig(), ...(next || {}), updatedAt: new Date().toISOString() });
  await writeStoredConfig(configCache);
  return publicConfig(configCache);
}

async function writeStoredConfig(cfg) {
  try {
    await writeSqliteConfig(cfg);
    return;
  } catch {}
  await writeLegacyJsonConfig(cfg);
}

async function writeLegacyJsonConfig(cfg) {
  const filePath = legacyConfigPath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fsp.chmod(filePath, 0o600).catch(() => null);
}

async function writeSqliteConfig(cfg) {
  const dbPath = configDbPath();
  const updatedAt = String(cfg.updatedAt || new Date().toISOString());
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  const sql = [
    // WAL set here (a write whose stdout is not parsed) so readers and writers
    // on the shared config.sqlite don't block each other — without polluting
    // any parsed read. Persistent + idempotent.
    'PRAGMA journal_mode=WAL;',
    'create table if not exists AppConfig (id integer primary key check (id = 1), value text not null, updated_at text not null);',
    `insert into AppConfig(id, value, updated_at) values(1, ${sqliteString(JSON.stringify(cfg))}, ${sqliteString(updatedAt)}) on conflict(id) do update set value=excluded.value, updated_at=excluded.updated_at;`
  ].join('\n');
  await sqliteExec(dbPath, sql);
  await fsp.chmod(dbPath, 0o600).catch(() => null);
}

async function loadOrImportConfig() {
  // Silent VS Code auto-import was resurrecting stale workspace_id /
  // server_addr / management_url from the legacy VS Code Kari extension
  // state on every fresh-config launch — even when the user had moved
  // to the new mgmt deployment. Result: Desktop appeared activated but
  // bound to the old mgmt with a workspace that no longer exists,
  // producing silent 401s on upload. Explicit import is still available
  // via `config:importVSCode` IPC; only the silent fallback is removed.
  return loadStoredConfig();
}

function machineClientId() {
  const src = `${os.hostname()}|${os.userInfo().username}|kari-desktop`;
  return `desktop-${crypto.createHash('sha256').update(src).digest('hex').slice(0, 20)}`;
}

function plainActivationSecret(value) {
  const text = String(value || '');
  if (!text) return {};
  return { activationCodePlain: text };
}

function decryptActivationCode(cfg) {
  // Bearer-auth resolver. Both legacy activation codes (TC-...) and
  // new tenant-client tokens (kc_...) are valid Authorization Bearer
  // values against mgmt + trans-server's upstream validation — server
  // discriminates by token-prefix. Returning whichever is set lets
  // every existing upload/download caller (which all hit
  // `Authorization: Bearer ${decryptActivationCode(cfg)}`) work in
  // tenant-client mode without per-callsite changes.
  // Priority: legacy activation code first (back-compat for installs
  // that still hold one); fall back to tenant client token for
  // tenant-only deployments where mgmt issued no activation code.
  if (cfg && cfg.activationCodePlain) return cfg.activationCodePlain;
  if (cfg && cfg.tenantClientTokenPlain) return cfg.tenantClientTokenPlain;
  return '';
}

function decryptTenantClientToken(cfg) {
  return cfg && cfg.tenantClientTokenPlain || '';
}

// isSyncthingBackend(cfg) is imported from sync_backend_helpers.cjs
// so the predicate can be unit-tested without Electron's runtime.
// Phase B B11 — gate legacy filesync triggers (/v1/sync-once,
// /v1/force-upload) for syncthing-backed workspaces to avoid racing
// with Syncthing's own scan/watch. See the helper module's docstring
// for the full rationale.

async function importVSCodeKariConfig(options = {}) {
  const stateDb = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb');
  const settingsPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  const stateRaw = await sqliteValue(stateDb, "select value from ItemTable where key='kari.kari-extension';");
  if (!stateRaw) throw new Error('未找到 VS Code Kari 插件状态');
  const state = JSON.parse(stateRaw);
  const secretRaw = await sqliteValue(stateDb, "select value from ItemTable where key like 'secret://%kari.kari-extension%kari.licenseKey%';");
  let activationCode = '';
  if (secretRaw) {
    try {
      activationCode = readPlainVSCodeSecret(secretRaw);
    } catch {}
  }
  if (!activationCode) {
    activationCode = await activationCodeFromVSCodeTerminalHistory(stateDb);
  }
  if (!activationCode) throw new Error('无法解密 VS Code Kari 插件激活码');
  const settings = await readJsonFile(settingsPath).catch(() => ({}));
  const current = await loadStoredConfig();
  const frp = parseJsonMaybe(state['kari.frpConfig']) || parseJsonMaybe(state['kari.frpStatus']) || null;
  const capabilities = state['kari.lastCapabilities'] || null;
  const workspaceRoot = options.preserveWorkspace && current.workspaceRoot ? current.workspaceRoot : '';
  return saveStoredConfig({
    activated: true,
    managementUrl: normalizeManagementUrl(settings['kari.managementUrl']),
    machineLabel: String(settings['kari.machineLabel'] || '').trim() || os.hostname(),
    clientId: String(state['kari.clientId'] || current.clientId || machineClientId()).trim(),
    serverAddr: String(state['kari.serverAddr'] || '').trim(),
    workspaceId: String(state['kari.workspaceId'] || '').trim(),
    workspaceName: current.workspaceName || 'workspace',
    workspaceRoot,
    serverId: String(state['kari.serverId'] || '').trim(),
    frp,
    capabilities,
    vscodeImportDisabled: false,
    ...plainActivationSecret(activationCode)
  });
}

function readPlainVSCodeSecret(raw) {
  const text = String(raw || '').trim();
  if (text.startsWith('TC-')) return text;
  const parsed = JSON.parse(text);
  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed.value === 'string') return parsed.value;
  if (parsed && typeof parsed.data === 'string') return parsed.data;
  if (parsed && Array.isArray(parsed.data)) {
    const decoded = Buffer.from(parsed.data).toString('utf8').trim();
    if (decoded.startsWith('TC-')) return decoded;
  }
  return '';
}

async function activationCodeFromVSCodeTerminalHistory(stateDb) {
  const raw = await sqliteValue(stateDb, "select value from ItemTable where key='terminal.history.entries.commands';").catch(() => '');
  if (!raw) return '';
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  for (const entry of entries) {
    const command = String(entry && entry.key || '');
    const match = command.match(/--license\s+(['"])(TC-[^'"]+)\1/) || command.match(/--license\s+(TC-\S+)/);
    if (match) return match[2] || match[1] || '';
  }
  return '';
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

function sqliteValue(dbPath, sql) {
  return sqliteExec(dbPath, sql).then((stdout) => String(stdout || '').trim());
}

function sqliteExec(dbPath, sql) {
  return new Promise((resolve, reject) => {
    // Use the SILENT `.timeout` dot-command, NOT `PRAGMA busy_timeout=...;` —
    // a PRAGMA echoes its result ("5000") to stdout, which corrupts callers
    // that parse the output (sqliteValue → JSON.parse of the config row). That
    // echo was the real cause of the app appearing de-activated on launch.
    // (journal_mode=WAL is set via write-only SQL in writeSqliteConfig so it
    // never pollutes a parsed read.)
    cp.execFile('sqlite3', ['-batch', '-noheader', '-cmd', '.timeout 5000', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout || '');
    });
  });
}

function sqliteString(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

async function logoutActivation() {
  const current = await loadStoredConfig();
  // Logout = give up the whole session, so pinned PTYs go too.
  for (const id of [...terminals.keys()]) stopTerminal(id, { force: true });
  stopAutoSnapshotWatcher();
  await postDaemon('/v1/reverse-proxy/stop', {}, 2500).catch(() => null);
  await postDaemon('/v1/shutdown', {}, 1200).catch(() => null);
  return saveStoredConfig({
    activated: false,
    managementUrl: DEFAULT_MANAGEMENT_URL,
    serverAddr: '',
    workspaceId: '',
    workspaceName: current.workspaceName || 'workspace',
    workspaceRoot: current.workspaceRoot || '',
    serverId: '',
    frp: null,
    capabilities: null,
    tenantClientId: '',
    hasTenantClientToken: false,
    activationCodePlain: '',
    tenantClientTokenPlain: '',
    vscodeImportDisabled: true
  });
}

function createWindow() {
  const iconPath = appIconPath();
  applyDockIdentity();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#090b0f',
    title: APP_DISPLAY_NAME,
    frame: false,
    icon: iconPath || undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const broadcastWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('window:state', {
        fullscreen: Boolean(mainWindow.isFullScreen && mainWindow.isFullScreen()),
        maximized: Boolean(mainWindow.isMaximized && mainWindow.isMaximized()),
        platform: process.platform,
      });
    } catch {}
  };
  mainWindow.on('enter-full-screen', broadcastWindowState);
  mainWindow.on('leave-full-screen', broadcastWindowState);
  mainWindow.on('maximize', broadcastWindowState);
  mainWindow.on('unmaximize', broadcastWindowState);
}

function rendererEntryURL(query) {
  const search = new URLSearchParams(query || {}).toString();
  if (process.env.VITE_DEV_SERVER_URL) {
    return `${process.env.VITE_DEV_SERVER_URL}${search ? `?${search}` : ''}`;
  }
  return null;
}

function loadRendererEntry(win, query) {
  const url = rendererEntryURL(query);
  if (url) {
    return win.loadURL(url);
  }
  return win.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'), { query });
}

function createDetachedTerminalWindow(id, title) {
  const existing = detachedTerminalWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.setTitle(title || 'Terminal');
    existing.webContents.send('terminal:detached-title', { id, title: title || 'Terminal' });
    existing.show();
    existing.focus();
    return { ok: true, existing: true };
  }
  const win = new BrowserWindow({
    width: 820,
    height: 560,
    minWidth: 420,
    minHeight: 260,
    resizable: true,
    backgroundColor: '#070604',
    title: title || 'Terminal',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  detachedTerminalWindows.set(id, win);
  win.on('closed', () => {
    detachedTerminalWindows.delete(id);
    broadcastRenderer('terminal:detached-closed', { id });
  });
  void loadRendererEntry(win, { detachedTerminal: id, title: title || 'Terminal' });
  return { ok: true, existing: false };
}

function broadcastRenderer(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function shakeWindow(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const offsets = [-12, 10, -8, 6, -3, 0];
  offsets.forEach((dx, index) => {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.setBounds({ ...bounds, x: bounds.x + dx, y: bounds.y }, false);
      }
    }, index * 55);
  });
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME });
  applyDockIdentity();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    applyDockIdentity();
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Phase 1.1 (syncthing migration): spawn the bundled syncthing child
  // process. Home dir is <userData>/syncthing-config/, bootstrap via
  // syncthing -generate on first launch. The BEP listener is loopback-
  // only; remote server reachability goes through the SOCKS5 proxy on
  // cfg.serverAddr. Health-poll waits up to 15s before declaring the
  // child up. Fire-and-forget — failures log but don't block the window.
  startSyncthingChild().then((result) => {
    // Legacy mode pairs the stored workspace directly. PTY-driven sync
    // ensures the local container exists and registers the workspace
    // mirror. Run this even when the first syncthing health check timed
    // out: slow machines can take longer than the initial child-start
    // window, and the scheduler retry loop will finish the sync config
    // once syncthing is actually reachable.
    if (!result || !result.ok) {
      console.warn('[syncthing] startup recovery will retry stored sync setup after initial start result:', result && (result.reason || result.error) || 'unknown');
    }
    schedulePairForStoredConfig('startup');
  }).catch((err) => {
    console.warn('[syncthing] startup failed:', err && err.message ? err.message : err);
    schedulePairForStoredConfig('startup:after-start-error');
  });
  // Plan T6: mount the PTY-driven sync orchestration. tracker observes
  // PTY lifecycle (registerPty/unregisterPty wired into createTerminal
  // + onExit below). scheduler drives the pair flow when a project goes
  // active and DeleteFolder when it retires after cooldown.
  if (ENABLE_PTY_DRIVEN_SYNC) {
    ensurePtyDrivenSync();
  }
  void ensureProjectImportQueue().start().catch((err) => {
    console.warn('[project-import-queue] startup failed:', err && err.message ? err.message : err);
  });
  // Syncthing owns file sync. kari-syncd still provides the control
  // plane used by MCP local_shell_exec, so bind it in daemon
  // control-only mode when a stored syncthing workspace exists.
  void ensureDaemonControlSessionForStoredConfig('startup');
});

// Production bug observed 2026-05-28: closing the Kari window left
// the syncthing child running because syncthing.stop() was fire-and-
// forget without event.preventDefault(). The kari-syncd branch
// already had the proper preventDefault → wait → app.quit() pattern;
// extended here so syncthing gets the same shutdown gate.
let quitInProgress = false;
app.on('before-quit', async (event) => {
  if (quitInProgress) return;
  quitInProgress = true;
  event.preventDefault();
  // Plan T6: detach the in-memory scheduler before stopping Syncthing,
  // but keep per-project folder config on normal app quit. Deleting it
  // here makes large workspaces rebuild/rescan from cloud every launch.
  // Workspace switch and project deletion still retire folders through
  // their explicit cleanup paths.
  if (syncSchedulerSingleton) {
    await Promise.race([
      syncSchedulerSingleton.stop({ retire: false }).catch((err) => {
        console.warn('[sync-scheduler] stop failed:', err && err.message ? err.message : err);
      }),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  }
  for (const id of [...terminals.keys()]) stopTerminal(id, { force: true });
  // Block the actual exit while we cleanly tear down the two managed
  // children. Both stops are idempotent; both have their own internal
  // grace-then-SIGKILL handling. We deliberately stop the syncthing
  // event subscriber first so it isn't requesting events against a
  // dying server. (event.preventDefault is already called at the top
  // of this handler.)
  quitAfterDaemonStop = true;
  syncthingEventSub.stop();
  // Run both stops in parallel — they're independent processes. Wait
  // for both to fully exit before app.quit() so neither child is
  // orphaned. 4s total cap: each stop has a 2s SIGTERM grace then
  // SIGKILL, so worst-case is 2s + a little overhead.
  const stopSyncthing = syncthingProcess.stop('app_quit').catch((err) => {
    console.warn('[syncthing] stop failed:', err && err.message ? err.message : err);
  });
  const stopDaemon = (daemonProc && !daemonProc.killed)
    ? stopOwnedDaemon('app quit').catch((err) => {
        console.warn('[daemon] stopOwnedDaemon failed:', err && err.message ? err.message : err);
      })
    : Promise.resolve();
  Promise.allSettled([stopSyncthing, stopDaemon]).finally(() => {
    console.log('[before-quit] all managed children stopped, calling app.quit()');
    app.quit();
  });
});

app.on('window-all-closed', () => {
  // Kari Desktop is a single-window app; closing the window should
  // close the app on macOS too, otherwise the owned daemon stays alive
  // invisibly after the customer thinks Kari is closed.
  app.quit();
});

function registerIpc() {
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return toggleWindowZoom(win);
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:state', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { fullscreen: false, maximized: false, platform: process.platform };
    return {
      fullscreen: Boolean(win.isFullScreen && win.isFullScreen()),
      maximized: Boolean(win.isMaximized && win.isMaximized()),
      platform: process.platform,
    };
  });
  ipcMain.handle('config:get', async () => {
    try {
      return publicConfig(await loadOrImportConfig());
    } catch {
      return publicConfig(configCache || normalizeStoredConfig(null));
    }
  });
  ipcMain.handle('config:importVSCode', async () => publicConfig(await importVSCodeKariConfig({ preserveWorkspace: true })));
  ipcMain.handle('config:logout', async () => logoutActivation());
  ipcMain.handle('runtime:status', async () => ensureRuntime());
  // Plan T7: top-bar sync badge data source. Returns the live scheduler
  // snapshot for the initial render; subsequent updates arrive on the
  // 'sync:state' broadcast channel (wired in app.whenReady above).
  // When PTY-driven sync is disabled (rollback flag set) the response
  // is { enabled: false } so the renderer can hide the badge entirely.
  ipcMain.handle('sync:snapshot', async () => {
    if (!syncSchedulerSingleton) {
      return { enabled: false, active: [] };
    }
    return { enabled: true, active: syncSchedulerSingleton.snapshot() };
  });
  // Phase 1.1 (syncthing migration): expose the running syncthing
  // child's meta so the renderer can show device id, gui address, and
  // up/down state. apiKey is redacted to first+last 4 chars — full key
  // never leaves main process.
  ipcMain.handle('syncthing:status', async () => {
    const meta = syncthingProcess.getRunningMeta();
    if (!meta) return { running: false };
    const ak = String(meta.apiKey || '');
    return {
      running: true,
      pid: meta.pid,
      guiAddress: meta.guiAddress,
      deviceId: meta.deviceId,
      listenPort: meta.listenPort,
      apiKeyPreview: ak.length > 8 ? ak.slice(0, 4) + '…' + ak.slice(-4) : '****',
    };
  });
  // Phase 1.2 (dev / manual pair): until consoleZ ships the
  // pair-after-activation endpoint, this IPC lets DevTools pair the
  // local syncthing child with a known server. Gated to dev builds
  // (NODE_ENV=development OR explicit KARI_SYNCTHING_DEV_PAIR=1) so a
  // packaged-build XSS / renderer compromise can't share an arbitrary
  // local folder with an attacker-controlled peer. Production pair
  // flow lands in Phase 1.2(b) via the mgmt pair endpoint.
  //
  // folderPath is also constrained to live inside one of the trusted
  // roots (storage container, workspaceRoot, or KARI_PROJECTS_ROOT
  // override) so even a compromised dev shell can't request
  // /etc/passwd be shared.
  ipcMain.handle('syncthing:devPair', async (_event, payload) => {
    const devModeEnabled = process.env.NODE_ENV === 'development'
      || process.env.KARI_SYNCTHING_DEV_PAIR === '1';
    if (!devModeEnabled) {
      return { ok: false, code: 'dev_only', error: 'syncthing:devPair is disabled in this build. Set KARI_SYNCTHING_DEV_PAIR=1 to enable.' };
    }
    const meta = syncthingProcess.getRunningMeta();
    if (!meta) return { ok: false, code: 'syncthing_not_running' };
    const sc = require('./syncthing_client.cjs');
    const creds = { guiAddress: meta.guiAddress, apiKey: meta.apiKey };
    const serverDeviceId = String(payload && payload.serverDeviceId || '').trim();
    const serverAddresses = Array.isArray(payload && payload.serverAddresses)
      ? payload.serverAddresses
      : [];
    const folderId = String(payload && payload.folderId || '').trim();
    const folderPath = String(payload && payload.folderPath || '').trim();
    if (!serverDeviceId || !folderId || !folderPath) {
      return { ok: false, code: 'missing_args', need: 'serverDeviceId + folderId + folderPath' };
    }
    // Restrict folderPath to known-safe roots. cfg.workspaceRoot is
    // the active workspace; defaultProjectsRoot(cfg) is the container
    // root. Either must contain (or equal) the requested path.
    const cfg = await loadStoredConfig().catch(() => null);
    const trustedRoots = [];
    if (cfg && cfg.workspaceRoot) trustedRoots.push(path.resolve(String(cfg.workspaceRoot)));
    try { trustedRoots.push(path.resolve(defaultProjectsRoot(cfg || {}))); } catch {}
    const absFolderPath = path.resolve(folderPath);
    const insideTrustedRoot = trustedRoots.some((root) => root && (absFolderPath === root || absFolderPath.startsWith(root + path.sep)));
    if (!insideTrustedRoot) {
      return { ok: false, code: 'untrusted_folder_path', error: 'folderPath must live inside the active workspace or storage container', trustedRoots };
    }
    const deviceResult = await sc.putDevice(creds, sc.buildDevicePayload({
      deviceId: serverDeviceId,
      name: 'kari-server',
      addresses: serverAddresses.length > 0 ? serverAddresses : ['dynamic'],
    }));
    if (!deviceResult.ok) {
      return { ok: false, code: 'put_device_failed', status: deviceResult.status, body: deviceResult.body, deviceResult };
    }
    // Phase 1.3 (codex round 3 P2 fix): write .stignore BEFORE PutFolder.
    // PutFolder activates the folder; if .stignore doesn't exist yet,
    // syncthing's first scan reads no ignore rules and starts
    // advertising / uploading node_modules / dist / etc to the peer
    // before mode-store catches up. Writing first eliminates the
    // first-scan race entirely.
    let stignoreResult = { ok: false, reason: 'not_attempted' };
    try {
      const identity = (cfg && cfg.serverAddr && cfg.workspaceId && cfg.workspaceName)
        ? { serverAddr: cfg.serverAddr, workspaceId: cfg.workspaceId, workspaceName: cfg.workspaceName }
        : null;
      const mode = identity ? await getEffectiveSyncMode(identity).catch(() => 'lightweight') : 'lightweight';
      const includeOverrides = identity ? await getIncludeSetForProject(identity).catch(() => new Set()) : new Set();
      stignoreResult = await writeStignoreFile({
        projectRoot: absFolderPath,
        mode,
        includeOverrides,
      });
      if (!stignoreResult.ok && stignoreResult.reason !== 'workspace_root_missing') {
        console.warn('[syncthing:devPair] writeStignoreFile failed:', stignoreResult.reason, stignoreResult.error || '');
      }
    } catch (err) {
      console.warn('[syncthing:devPair] stignore step threw:', String(err && err.message || err));
    }
    const folderResult = await sc.putFolder(creds, sc.buildFolderPayload({
      folderId,
      label: String(payload && payload.folderLabel || folderId),
      folderPath: absFolderPath,
      deviceIds: [meta.deviceId, serverDeviceId],
      sendreceive: payload && payload.sendreceive !== false,
    }));
    if (!folderResult.ok) {
      return { ok: false, code: 'put_folder_failed', status: folderResult.status, body: folderResult.body, folderResult, stignoreResult };
    }
    return { ok: true, deviceResult, folderResult, stignoreResult };
  });
  // Phase 1.3 (folder peering inspection). Returns the syncthing
  // /rest/system/connections snapshot — useful to verify "did we pair
  // OK" + per-folder /rest/db/status.
  ipcMain.handle('syncthing:connections', async () => {
    const meta = syncthingProcess.getRunningMeta();
    if (!meta) return { ok: false, code: 'syncthing_not_running' };
    const sc = require('./syncthing_client.cjs');
    return sc.getConnections({ guiAddress: meta.guiAddress, apiKey: meta.apiKey });
  });
  ipcMain.handle('syncthing:dbStatus', async (_event, folderId) => {
    const meta = syncthingProcess.getRunningMeta();
    if (!meta) return { ok: false, code: 'syncthing_not_running' };
    if (!folderId) return { ok: false, code: 'missing_folder_id' };
    const sc = require('./syncthing_client.cjs');
    return sc.getDbStatus({ guiAddress: meta.guiAddress, apiKey: meta.apiKey }, String(folderId));
  });
  // Phase 2: synchronous snapshot of the event subscriber's derived
  // state cache. The renderer subscribes to `syncthing:state`
  // broadcasts via window.kari.onSyncthingState; this IPC is the
  // first-paint read.
  ipcMain.handle('syncthing:state', async () => syncthingEventSub.getState());
  ipcMain.handle('daemon:ensure', async () => {
    const result = await ensureDaemonRunning();
    void ensureDaemonControlSessionForStoredConfig('daemon:ensure');
    return result;
  });
  ipcMain.handle('daemon:bindStart', async () => ensureDaemonControlSessionForStoredConfig('daemon:bindStart', { force: true }));

  ipcMain.handle('activation:submit', async (_event, payload) => {
    // Single-tenant: the user types the server address + the shared secret
    // directly. There is no management URL / cloud resolve / tenant registration
    // — the secret IS the activation_code the daemon and PTY use, and the
    // workspace_id is generated locally (stable across re-activation).
    const serverAddr = String(payload.serverAddr || '').trim();
    const activationCode = String(payload.activationCode || '').trim();
    const machineLabel = String(payload.machineLabel || '').trim() || os.hostname();
    const clientId = String(payload.clientId || '').trim() || machineClientId();
    if (!serverAddr) throw new Error('Server address is required.');
    if (!activationCode) throw new Error('Shared secret is required.');

    // Capture the previous workspaceId BEFORE replaceStoredConfig drops
    // it. If activation lands on a new workspace_id, archiveStaleProjectDirs
    // moves the local mirror dirs from the old workspace into
    // <projectsRoot>/.archive/ so the new "brand-new workspace" really
    // looks brand-new in the welcome page (no leftover local-only
    // project cards from prior activations).
    const prevCfgForArchive = await loadStoredConfig().catch(() => null);
    const prevWorkspaceIdForArchive = prevCfgForArchive ? String(prevCfgForArchive.workspaceId || '').trim() : '';

    // Reuse the existing workspace_id when re-activating against the SAME
    // server (keeps the synced tree stable); otherwise mint a fresh one.
    let workspaceId = '';
    if (prevCfgForArchive
        && String(prevCfgForArchive.serverAddr || '').trim() === serverAddr
        && String(prevCfgForArchive.workspaceId || '').trim()) {
      workspaceId = String(prevCfgForArchive.workspaceId).trim();
    } else {
      workspaceId = 'ws-' + crypto.randomBytes(10).toString('hex');
    }
    const workspaceName = String(payload.workspaceName || 'workspace').trim() || 'workspace';

    const next = await replaceStoredConfig({
      activated: true,
      machineLabel,
      clientId,
      serverAddr,
      workspaceId,
      workspaceName,
      workspaceSyncBackend: 'syncthing',
      vscodeImportDisabled: true,
      ...plainActivationSecret(activationCode),
    });
    await archiveStaleProjectDirsOnWorkspaceChange(next, prevWorkspaceIdForArchive).catch((err) => {
      console.warn('archiveStaleProjectDirs failed:', err);
    });
    const nextWorkspaceId = String(next.workspaceId || '').trim();
    if (prevWorkspaceIdForArchive && nextWorkspaceId && prevWorkspaceIdForArchive !== nextWorkspaceId) {
      await resetSyncStateOnWorkspaceChange(
        `activation switched ${prevWorkspaceIdForArchive} → ${nextWorkspaceId}`,
      ).catch((err) => {
        console.warn('resetSyncStateOnWorkspaceChange failed:', err && err.message ? err.message : err);
      });
    }
    await ensureLocalWorkspaceContainer(next).catch((err) => {
      console.warn('[activation] ensureLocalWorkspaceContainer failed:', err && err.message ? err.message : err);
      return null;
    });
    schedulePairAfterActivation({ cfg: next, activationCode });
    void ensureContainerWorkspacePairForStoredConfig('activation:oss');
    return { ok: true, config: next, message: 'activated' };
  });


  ipcMain.handle('workspace:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Kari 项目目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const root = path.resolve(result.filePaths[0]);
    const current = await loadStoredConfig();
    const projectsRoot = defaultProjectsRoot(current);
    if (current.activated && !isInsideProjectsRoot(projectsRoot, root)) {
      const importName = cleanWorkspaceName(path.basename(root)) || 'workspace';
      return {
        canceled: false,
        path: root,
        needsImport: true,
        importName,
        projectsRoot,
        targetPath: mirrorPathForWorkspaceName(projectsRoot, importName),
      };
    }
    const cfg = await saveStoredConfig({
      workspaceRoot: root,
      workspaceName: path.basename(root) || 'workspace',
      workspaceSyncBackend: 'syncthing',
    });
    // Phase 4 follow-up: workspace:select changes the active workspaceRoot
    // (the picker just picked a different dir inside .kari-drive). Without
    // re-firing pair, syncthing's folder.path stays pinned at the
    // previous workspace and the just-selected project won't sync.
    // Fire-and-forget — pair failures log but don't fail the select.
    try {
      const fullCfg = await loadStoredConfig().catch(() => null);
      const code = fullCfg ? decryptActivationCode(fullCfg) : '';
      if (code) {
        console.log('[workspace:select] firing schedulePairAfterActivation for workspaceRoot=', root);
        schedulePairAfterActivation({ cfg, activationCode: code });
        void ensureDaemonControlSessionForStoredConfig('workspace:select', { force: true });
      } else {
        console.warn('[syncthing-pair] workspace:select skipped pair: no activation code in stored config');
      }
    } catch (err) {
      console.warn('[syncthing-pair] workspace:select pair trigger threw:', err && err.message ? err.message : err);
    }
    const tree = await scanWorkspace(root);
    return { canceled: false, path: root, tree, config: cfg, bind: { ok: true, skipped: true, reason: 'syncthing pair scheduled' } };
  });

  // Storage Location Boundary: user picks where Kari's container dir
  // (hidden .kari-drive) lives. Persists into cfg.storageBaseDir; the
  // derived projectsRoot updates automatically on next defaultProjectsRoot
  // call. We do NOT mkdir the container here — the next operation that
  // needs it (listProjects / uploadProject / downloadProject) will run
  // mkdir(projectsRoot, {recursive:true}) on demand.
  //
  // Refuses targets that look like Kari's runtime dirs (userData itself
  // / current hidden Kari storage container) — picking those would create
  // nested Kari storage dirs.
  ipcMain.handle('storage:summary', async () => storageSummary());

  ipcMain.handle('storage:selectBaseDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Kari 存储位置（Kari 会创建隐藏内部目录）',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const picked = path.resolve(result.filePaths[0]);
    // Guard: don't allow picking a path that already IS or sits inside
    // the current hidden Kari storage container. Otherwise we'd nest .kari-drive/
    // inside Kari storage forever.
    const current = await loadStoredConfig();
    const currentRoot = defaultProjectsRoot(current);
    const pickedWithSep = picked + path.sep;
    const containerWithSep = currentRoot + path.sep;
    if (picked === currentRoot || pickedWithSep.startsWith(containerWithSep)) {
      return {
        ok: false,
        canceled: false,
        code: 'storage_base_inside_container',
        error: '请选择 Kari 内部存储之外的目录作为存储位置。',
      };
    }
    const next = await saveStoredConfig({ storageBaseDir: picked });
    const newProjectsRoot = defaultProjectsRoot(next);
    return {
      ok: true,
      canceled: false,
      storageBaseDir: picked,
      projectsRoot: newProjectsRoot,
      config: next,
    };
  });

  ipcMain.handle('projects:list', async () => listProjects());
  ipcMain.handle('projects:deleteLocal', async (_event, project, confirmName) => deleteLocalProject(project || null, String(confirmName || '')));
  ipcMain.handle('projects:deleteCloud', async (_event, project, confirmName) => deleteCloudProject(project || null, String(confirmName || '')));
  ipcMain.handle('projects:open', async (_event, projectPath, project) => openProject(projectPath, project || null));
  // Renderer calls this when the user navigates back to the project
  // list. Drops the UI-active virtual handle on the previously-open
  // project so the scheduler can retire it after the cooldown if no
  // real PTYs (pinned or otherwise) are still alive for it.
  ipcMain.handle('projects:closeUi', async () => {
    await setUiActiveProject(null);
    return { ok: true };
  });
  // PR2 Phase 1 commit 5 round-fix: explicit download path for
  // cloud-only-not-downloaded projects. openProject above guards
  // against opening them; this handler is the only legitimate way
  // to materialize a local mirror dir for such a project.
  ipcMain.handle('projects:download', async (_event, projectPath, project) =>
    downloadProject(projectPath, project || null)
  );
  // PR2 Phase 1 commit 6: local→cloud self-service upload. Validates
  // + size-checks + calls trans-server's upload-intent + binds daemon
  // + triggers sync.
  //
  // Phase 4: when the upload targets the currently-bound workspace AND
  // syncthing backend, route through scheduler.runNow so the
  // dirty-marker race + single-flight + backoff state machine stays
  // consistent. Manual upload of a NEW local project (not yet the bound
  // workspace) still goes through uploadProject directly — the
  // scheduler is per-current-workspace and doesn't track unbound paths.
  ipcMain.handle('projects:upload', async (_event, projectPath, project) => {
    try {
      const cfg = await loadStoredConfig().catch(() => null);
      const sameRoot = cfg && cfg.workspaceRoot && projectPath
        && path.resolve(String(projectPath)) === path.resolve(cfg.workspaceRoot);
      if (sameRoot && isSyncthingBackend(cfg)) {
        return await ensureUploadScheduler().runNow('manual', cfg.workspaceRoot);
      }
    } catch (err) {
      console.warn('[projects:upload] scheduler.runNow route skipped:', err && err.message ? err.message : err);
    }
    return uploadProject(projectPath, project || null);
  });
  // Cancel an in-flight or stuck download. Stops the daemon task
  // (best-effort) and flips the cache phase to 'cancelled'. The
  // incomplete marker is INTENTIONALLY kept so existsLocal stays
  // false and the open-guard keeps firing; partial files in the
  // mirror dir are preserved for incremental retry.
  ipcMain.handle('projects:abandon-download', async (_event, project) =>
    abandonDownload(project || null)
  );
  // B6d Important #2 escape hatch — operator-callable cancel for a
  // snapshot upload session that's stuck in 'verifying' (commit_race)
  // or any other non-terminal state without an active task. Calls the
  // existing cancelSnapshotSession helper which: cancelIfNonTerminal
  // → cleanupSnapshot → returns the previous state. Renderer wires this
  // to a "取消上传" affordance on cards stuck at 'verifying'/'syncing'
  // when the user reports the card hasn't moved. Returns the
  // cancelIfNonTerminal result shape so the renderer can distinguish
  // found / already-terminal / cancelled.
  // Renderer-facing wrapper around snapshot:cancelSession: takes a
  // ProjectItem, looks up the active upload snapshot session for that
  // project, and cancels it. Used by the WelcomeProjectCard ✕ button
  // when the card represents an UPLOAD stuck in verifying/syncing
  // (counterpart to projects:abandon-download which handles cloud-
  // download cancels). Returns the same shape as snapshot:cancelSession
  // so the renderer has one parser for both paths.
  ipcMain.handle('projects:cancelSnapshotUpload', async (_event, project) => {
    if (!project || typeof project !== 'object') {
      return { ok: false, code: 'bad_request', error: '缺少 project 信息。' };
    }
    const cfg = await loadStoredConfig();
    const wsName = cleanWorkspaceName(project.workspaceName || project.name || '');
    if (!wsName) {
      return { ok: false, code: 'invalid_workspace_name', error: '无法解析 workspace name。' };
    }
    if (!cfg.serverAddr || !cfg.workspaceId) {
      return { ok: false, code: 'missing_identity', error: '缺少 server/workspace 标识。' };
    }
    // findActiveByIdentity returns the non-terminal session row (if
    // any) for the (serverAddr, workspaceId, workspaceName) key. For
    // uploads this is the row we want; for downloads the same lookup
    // would find a download session — guard on direction so we don't
    // accidentally cancel a download via this UPLOAD-specific IPC
    // (downloads go through projects:abandon-download).
    // Phase 0 (syncthing migration): snapshot session store deleted.
    // Syncthing's sync loop has no client-side cancellable session;
    // surface that to callers so the UI can fall back to "stop folder
    // share" UX in Phase 2 instead of waiting forever.
    return { ok: false, code: 'sync_disabled', error: '同步通道升级中（syncthing 接入），暂无可取消的快照会话。' };
  });
  ipcMain.handle('snapshot:cancelSession', async (_event, stagingId, reason) => {
    if (typeof stagingId !== 'string' || stagingId.length === 0) {
      return { ok: false, code: 'missing_staging_id', error: 'stagingId required' };
    }
    try {
      const result = await cancelSnapshotSession(
        stagingId,
        typeof reason === 'string' && reason.length > 0 ? reason : 'cancelled_by_user_ipc',
      );
      return { ok: true, result };
    } catch (err) {
      return { ok: false, code: 'cancel_threw', error: String(err && err.message || err) };
    }
  });
  // External local directories are imported into the Kari-managed
  // projects root before upload. The original directory is left
  // untouched; subsequent sync binds to the imported copy.
  ipcMain.handle('projects:dismissDiscovered', async (_event, projectPath) =>
    dismissDiscoveredProject(String(projectPath || '')));
  ipcMain.handle('projects:importAndUpload', async (_event, projectPath) =>
    importAndUploadProject(projectPath)
  );
  ipcMain.handle('projects:importQueueSnapshot', async () => {
    const jobs = await ensureProjectImportQueue().snapshot();
    return { ok: true, jobs: importJobsWithProgress(jobs) };
  });
  ipcMain.handle('projects:clone', async (_event, payload) => cloneProject(payload));

  ipcMain.handle('files:list', async () => {
    const cfg = await loadStoredConfig();
    if (!cfg.workspaceRoot) return emptyTree('');
    return scanWorkspace(cfg.workspaceRoot);
  });

  // File-tree sync visibility: lazy per-directory listing replacing the
  // global 5000-node truncation. Each node carries a SyncDisposition
  // derived from the same ignore_evaluator the snapshot walker uses, so
  // the cloud icons in the file tree never disagree with what the next
  // sync would actually upload.
  ipcMain.handle('files:listChildren', async (_event, request) => {
    // Wrap in try/catch (round-1 codex #5) so matcher/listing throws
    // surface as a clean error shape instead of raw Electron IPC rejects.
    // The empty-workspace path returns a structured empty result;
    // unexpected throws return {error}. listFileTreeChildren itself
    // also returns empty on ENOENT/ENOTDIR for the dirPath.
    try {
    const cfg = await loadStoredConfig();
    if (!cfg.workspaceRoot) {
      return {
        root: '',
        dirPath: '',
        nodes: [],
        hasMore: false,
        summary: {
          included: 0,
          partiallyIncluded: 0,
          pendingUpload: 0,
          excluded: 0,
          hardIgnored: 0,
          localOnly: 0,
          cloudOnly: 0,
          conflict: 0,
        },
      };
    }
    const root = path.resolve(cfg.workspaceRoot);
    // Allow request.dirPath === root for the natural "list the root"
    // call site (round-1 codex #1). assertInsideWorkspace rejects
    // rel === '' so we have to permit it explicitly here. Any other
    // path goes through the lexical inside-workspace check.
    let dirPath;
    if (request && request.dirPath) {
      const candidate = path.resolve(String(request.dirPath));
      if (candidate === root) {
        dirPath = root;
      } else {
        dirPath = assertInsideWorkspace(root, request.dirPath);
      }
    } else {
      dirPath = root;
    }
    // Hydrate per-project override sets. Both calls degrade to empty
    // gracefully when the project hasn't been paired yet (pre-activation).
    const identity = {
      serverAddr: cfg.serverAddr,
      workspaceId: cfg.workspaceId,
      workspaceName: cfg.workspaceName,
    };
    const [overrideIncludes, pendingOverrides] = await Promise.all([
      getIncludeSetForProject(identity).catch(() => new Set()),
      getPendingOverrideSetForProject(identity).catch(() => new Set()),
    ]);
    // Build the ignore matcher with the SAME includeOverrides Set the
    // classifier sees, so the matcher's "would this be ignored" verdict
    // and the classifier's "what disposition does this paint" can't drift.
    const mode = await getEffectiveSyncMode(identity).catch(() => 'lightweight');
    const matcher = await buildIgnoreMatcher({
      projectRoot: root,
      mode,
      includeOverrides: overrideIncludes,
    });
    let manifestPaths = new Set();
    if (shouldUseLegacyManifestForFileTree(cfg)) {
      // Manifest path set drives the classifier's cloud_only / local_only /
      // override-stale-committed dispositions (FT-Task-MC). Hydrated via
      // GET {serverAddr}/api/v2/workdirs/{workspaceName}/latest-manifest
      // with Bearer auth, per-(server,ws,name,authHash) cached with 30s TTL.
      // Syncthing-backed workspaces deliberately skip this legacy snapshot
      // manifest: Syncthing's folder state is the sync truth, and a stale
      // manifest would paint false local_only/cloud_only badges.
      const manifestResult = await fetchLatestManifest({
        serverAddr: cfg.serverAddr,
        workspaceId: cfg.workspaceId,
        workspaceName: cfg.workspaceName,
        activationCode: decryptActivationCode(cfg),
      }).catch(() => null);
      manifestPaths = (manifestResult && manifestResult.paths) || new Set();

      // Auto-commit pending overrides whose anchor's content has landed
      // in the cloud manifest (FT-Task-MC2). This is legacy filesync-only;
      // Syncthing uses the live folder state instead of snapshot manifests.
      if (manifestResult && manifestResult.ok && manifestResult.manifestId
          && !manifestResult.fromCache) {
        // Fire-and-forget: don't block the IPC on the auto-commit pass.
        autoCommitPendingOverridesFromManifest({
          identity,
          manifestId: manifestResult.manifestId,
          manifestPaths,
          pendingOverrides,
        }).catch((e) => {
          console.warn('auto-commit pass failed:', e);
        });
      }
    }
    return await listFileTreeChildren({
      root,
      dirPath,
      cursor: request && request.cursor,
      limit: request && request.limit,
      filter: request && request.filter,
      manifestPaths,
      isIgnored: matcher,
      hardIgnored: new Set(),  // unused — classifier delegates to isHardIgnored
      overrideIncludes,
      pendingOverrides,
    });
    } catch (err) {
      console.error('files:listChildren error:', err);
      // Return a structured empty result with error attached so the
      // renderer can render an empty tree + error toast instead of an
      // opaque IPC reject.
      return {
        root: '',
        dirPath: '',
        nodes: [],
        hasMore: false,
        summary: {
          included: 0,
          partiallyIncluded: 0,
          pendingUpload: 0,
          excluded: 0,
          hardIgnored: 0,
          localOnly: 0,
          cloudOnly: 0,
          conflict: 0,
        },
        error: String((err && err.message) || err),
      };
    }
  });

  // File-tree path-scoped actions. Three actions only (plan §"Context
  // menu"): force_upload_once / always_sync_path / stop_always_syncing.
  //
  // Top-level try/catch converts store throws (INCOMPLETE_IDENTITY,
  // HARD_IGNORE_IMMUTABLE, COVERED_BY_ANCESTOR_OVERRIDE, etc.) into
  // {ok:false, code:<thrown-code>} so the renderer's i18n mapper can
  // produce locale-correct strings instead of surfacing raw Electron
  // 'Error invoking remote method ...' rejects (file-tree plan round-5).
  ipcMain.handle('files:pathAction', async (_event, payload) => {
    try {
      const cfg = await loadStoredConfig();
      if (!cfg.workspaceRoot) return { ok: false, code: 'no_workspace' };
      const root = path.resolve(cfg.workspaceRoot);
      // Realpath check — defense against symlink-traversal exfiltration
      // via direct IPC. The renderer is partially-trusted but extensions
      // / automation could send any path; the lexical check alone would
      // miss a symlink whose target escapes the workspace.
      const abs = await assertInsideWorkspaceRealpath(root, payload && payload.path);
      const relPath = path.relative(root, abs).replace(/\\/g, '/');
      const action = String(payload && payload.action || '');
      if (!['force_upload_once', 'always_sync_path', 'stop_always_syncing'].includes(action)) {
        return { ok: false, code: 'invalid_action' };
      }
      // Hard-ignore guard. The override store re-checks at write time
      // (defense in depth), but surfacing the user-facing error code
      // here gives the renderer a clean string to show instead of the
      // store's internal throw.
      if (isHardIgnoredRel(relPath)) {
        return { ok: false, code: 'hard_ignored' };
      }
      const identity = {
        serverAddr: cfg.serverAddr,
        workspaceId: cfg.workspaceId,
        workspaceName: cfg.workspaceName,
      };
      const result = await runPathScopedSyncAction({ action, root, abs, relPath, cfg, identity, payload });
      // B12 integration: refresh .stignore after any successful
      // path-action that changed the override set. always_sync_path
      // adds; stop_always_syncing removes; force_upload_once is
      // currently stubbed (no state mutation). Fire-and-forget — the
      // refresh is idempotent on no-op (skipped:'unchanged') so even
      // for stubbed actions the cost is one file stat.
      if (result && result.ok) {
        void refreshStignoreForCurrentWorkspace(cfg).catch((err) => {
          console.warn('[stignore_writer] refresh after pathAction failed:', err);
        });
      }
      return result;
    } catch (e) {
      const code = (e && e.code) ? String(e.code) : 'ipc_internal_error';
      console.error('files:pathAction error:', e);
      return { ok: false, code, error: String((e && e.message) || e) };
    }
  });

  // Sync mode IPC (Phase B B9). Two scopes:
  //   - Global default: shown in Settings, applies to every project
  //     that doesn't have its own override.
  //   - Per-project override: shown in the project card menu,
  //     overrides the global default for that project only.
  // Both stored in sync_mode_store; the matcher / .stignore writer
  // consume the effective mode via getEffectiveSyncMode.
  ipcMain.handle('sync:getMode', async () => {
    try {
      const cfg = await loadStoredConfig();
      const identity = (cfg.workspaceRoot && cfg.workspaceId && cfg.workspaceName) ? {
        serverAddr: cfg.serverAddr,
        workspaceId: cfg.workspaceId,
        workspaceName: cfg.workspaceName,
      } : null;
      const [defaultMode, projectMode, effectiveMode] = await Promise.all([
        getGlobalDefaultSyncMode(),
        identity ? getProjectSyncMode(identity).catch(() => null) : Promise.resolve(null),
        identity ? getEffectiveSyncMode(identity).catch(() => 'lightweight') : Promise.resolve(null),
      ]);
      return {
        ok: true,
        defaultMode,
        projectMode,         // null = inherits default
        effectiveMode,       // null = no project bound
        identityComplete: !!identity,
      };
    } catch (e) {
      console.error('sync:getMode error:', e);
      return { ok: false, code: 'ipc_internal_error', error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('sync:setGlobalMode', async (_event, payload) => {
    try {
      const mode = String(payload && payload.mode || '');
      await setGlobalDefaultSyncMode(mode);
      // B12 integration: refresh .stignore for the currently-bound
      // workspace if its effective mode changes via the global default
      // (only applies when the project has NO own override). No-op for
      // filesync. Fire-and-forget — best-effort.
      const cfg = await loadStoredConfig();
      void refreshStignoreForCurrentWorkspace(cfg).catch((err) => {
        console.warn('[stignore_writer] refresh after setGlobalMode failed:', err);
      });
      return { ok: true };
    } catch (e) {
      console.error('sync:setGlobalMode error:', e);
      const code = (e && e.code) ? String(e.code) : 'ipc_internal_error';
      return { ok: false, code, error: String((e && e.message) || e) };
    }
  });
  // Crash recovery IPC (Phase B B10). Used by a future "残留 staging /
  // recovery" panel in the renderer. Both handlers structured-clone-safe.
  ipcMain.handle('recovery:scan', async () => {
    try {
      const state = await scanCrashStateNow();
      return { ok: true, ...state };
    } catch (e) {
      console.error('recovery:scan error:', e);
      return { ok: false, code: 'ipc_internal_error', error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('recovery:cleanupOrphan', async (_event, payload) => {
    try {
      const absPath = String(payload && payload.absPath || '');
      if (!absPath) return { ok: false, code: 'missing_args' };
      const result = await cleanupOrphanStaging(absPath);
      if (!result.ok) return { ok: false, code: result.reason || 'cleanup_failed' };
      return { ok: true };
    } catch (e) {
      console.error('recovery:cleanupOrphan error:', e);
      return { ok: false, code: 'ipc_internal_error', error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('sync:setProjectMode', async (_event, payload) => {
    try {
      const cfg = await loadStoredConfig();
      // Include serverAddr in the early-return check (round-1 codex #1
      // finding): sync_mode_store.normalizeKeyParts requires all three
      // identity fields. Skipping the pre-flight on serverAddr would
      // let the handler reach the store's normalizeKeyParts throw and
      // bubble as an opaque ipc_internal_error.
      if (!cfg.serverAddr || !cfg.workspaceId || !cfg.workspaceName) {
        return { ok: false, code: 'no_workspace' };
      }
      const identity = {
        serverAddr: cfg.serverAddr,
        workspaceId: cfg.workspaceId,
        workspaceName: cfg.workspaceName,
      };
      const mode = payload && payload.mode;
      if (mode === null || mode === undefined || mode === '') {
        // Empty mode = clear the override; project falls back to global default.
        await clearProjectSyncMode(identity);
        // B12 integration: refresh .stignore for the current workspace
        // since the effective mode changed.
        void refreshStignoreForCurrentWorkspace(cfg).catch((err) => {
          console.warn('[stignore_writer] refresh after clearProjectMode failed:', err);
        });
        return { ok: true, cleared: true };
      }
      await setProjectSyncMode(identity, String(mode));
      // NOTE (round-1 codex #2): no manifest cache invalidation here.
      // The cached manifest paths set is mode-INDEPENDENT (it's the
      // authoritative list of what's in the cloud, not what the local
      // matcher would include). buildIgnoreMatcher is rebuilt on every
      // listChildren call from the current effective mode, so the
      // change picks up on the next IPC without needing a cache flush.
      // B12 integration: refresh .stignore for the current workspace.
      void refreshStignoreForCurrentWorkspace(cfg).catch((err) => {
        console.warn('[stignore_writer] refresh after setProjectMode failed:', err);
      });
      return { ok: true };
    } catch (e) {
      console.error('sync:setProjectMode error:', e);
      const code = (e && e.code) ? String(e.code) : 'ipc_internal_error';
      return { ok: false, code, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('files:read', async (_event, filePath) => {
    const cfg = await loadStoredConfig();
    const absolute = assertInsideWorkspace(cfg.workspaceRoot, filePath);
    const stat = await fsp.stat(absolute);
    if (!stat.isFile()) throw new Error('不是文件');
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 5MB，暂不在内置编辑器打开。');
    const content = await fsp.readFile(absolute, 'utf8');
    const gitBase = await readGitBaseForFile(cfg.workspaceRoot, absolute);
    return {
      path: absolute,
      relPath: path.relative(cfg.workspaceRoot, absolute),
      content,
      size: stat.size,
      language: languageFromPath(absolute),
      baseContent: gitBase.baseContent,
      baseKind: gitBase.baseKind,
      gitStatus: gitBase.gitStatus,
      gitBadge: gitBase.gitBadge
    };
  });

  // Drop a list of OS paths (files and/or folders) into a destination
  // directory inside the bound workspace. Used by the file-tree drop
  // target: user drags a Finder/Explorer item onto a tree directory,
  // renderer sends { destAbsDir, sourcePaths }, we recursive-copy
  // each into destAbsDir/<basename>.
  //
  // Validation:
  //   - destAbsDir must equal workspaceRoot or be inside it. (We
  //     allow == workspaceRoot here, unlike assertInsideWorkspace
  //     which is for file reads/writes and requires strict descent.)
  //   - each src must be an absolute path that exists.
  //   - src must NOT be the workspace root itself or an ancestor of
  //     it (would self-recurse during fs.cp).
  //   - dst pre-existing: skip rather than overwrite, return reason
  //     'exists' so the renderer can show the user.
  ipcMain.handle('files:importFromDisk', async (_event, payload) => {
    const destAbsDir = String(payload?.destAbsDir || '');
    const sourcePaths = Array.isArray(payload?.sourcePaths) ? payload.sourcePaths : [];
    if (!sourcePaths.length) return { ok: false, error: '没有需要导入的文件' };
    const cfg = await loadStoredConfig();
    if (!cfg.workspaceRoot) return { ok: false, error: '未选择项目目录' };
    const root = path.resolve(cfg.workspaceRoot);
    const dest = path.resolve(destAbsDir);
    if (dest !== root) {
      const rel = path.relative(root, dest);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, error: 'dest 不在项目目录内' };
      }
    }
    const destStat = await fsp.stat(dest).catch(() => null);
    if (!destStat || !destStat.isDirectory()) {
      return { ok: false, error: 'dest 不是目录' };
    }
    const copied = [];
    const skipped = [];
    for (const raw of sourcePaths) {
      const src = path.resolve(String(raw || ''));
      if (!src) {
        skipped.push({ src: raw, reason: 'empty' });
        continue;
      }
      // Self-recursion guard: src equals root or is an ancestor of
      // root means the copy would walk into the destination tree.
      if (src === root || targetInsideSource(src, root)) {
        skipped.push({ src, reason: 'self_or_ancestor' });
        continue;
      }
      const stat = await fsp.stat(src).catch(() => null);
      if (!stat) {
        skipped.push({ src, reason: 'not_found' });
        continue;
      }
      const dst = path.join(dest, path.basename(src));
      const existed = await fsp.stat(dst).catch(() => null);
      if (existed) {
        skipped.push({ src, reason: 'exists' });
        continue;
      }
      try {
        await fsp.cp(src, dst, { recursive: true, errorOnExist: true });
        copied.push({ src, dst });
      } catch (err) {
        skipped.push({ src, reason: 'copy_failed: ' + (err && err.message ? err.message : err) });
      }
    }
    // Trigger sync to propagate the new files to cloud.
    //  - filesync-backed workspaces: kick /v1/sync-once. Daemon's
    //    existing rescan tick would eventually pick the files up, but
    //    this trims the user-visible latency.
    //  - syncthing-backed workspaces: daemon is in control-only mode
    //    (L2 sub-commit A) which blocks outbound auto-sync; the
    //    snapshot pipeline is the only way to push. Fire uploadProject
    //    so the cloud reflects the drop without the user having to
    //    click Upload manually. Best-effort — log on failure but don't
    //    fail the import (local fs.cp already landed).
    // L2 sub-commit A: syncthing-backed workspace defers cloud
    // propagation to auto-snapshot Phase 2's debounce loop. Per-drop
    // eager uploadProject calls combined with the fs.watch poll-fire
    // loop to produce an upload storm (every dropped file → full
    // snapshot upload → fs.watch sees the server's manifest update →
    // another fire); a burst of saved/dropped files now coalesces
    // into one upload via daemon's 3s debounce + 30s min-interval.
    if (copied.length) {
      if (!isSyncthingBackend(cfg)) {
        postDaemon('/v1/sync-once', {}, 5000).catch(() => null);
      } else {
        // Phase 4: scheduler instead of daemon notify. The scheduler's
        // backoff handles a daemon-offline import without losing the
        // dirty state, which the prior notify-only path could not.
        // Await so the dirty marker is durable BEFORE this IPC returns —
        // a crash between IPC return and marker write would lose the
        // dirty state. ~10ms latency is the documented Phase 2 trade-off.
        await ensureUploadScheduler().schedule('import', cfg.workspaceRoot, dest).catch((err) => {
          console.warn('[files:importFromDisk] scheduler.schedule failed:', err && err.message ? err.message : err);
        });
      }
    }
    return { ok: true, copied, skipped };
  });

  // Renderer-side: file node fires HTML5 dragstart, calls this with
  // the absolute path. We hand off to Electron's webContents.startDrag
  // so the OS gets a proper drag-source. ipcMain.on (not handle)
  // because the OS drag must start very soon after the user's
  // mouse-down — any async hop closes the window.
  //
  // app.getFileIcon would be nice for per-extension fidelity but it
  // returns a Promise; by the time the icon resolves the dragstart
  // window has elapsed. The cached app icon (one resize at first
  // drag, reused thereafter) keeps startDrag synchronous.
  // File-tree right-click DELETE: remove the path locally + trigger
  // snapshot Upload so the cloud mirror reflects the deletion.
  // Daemon's control-only mode (sub-commit A) blocks outbound auto-
  // sync, so we MUST kick a snapshot upload after the local rm —
  // otherwise the file would stay on cloud forever.
  //
  // Safety: assertInsideWorkspace refuses paths outside the bound
  // workspace root, AND refuses workspaceRoot itself (no
  // "delete the whole project" via this endpoint — use the
  // projects:deleteLocal flow for that).
  ipcMain.handle('files:deleteNode', async (_event, absPath) => {
    const cfg = await loadStoredConfig();
    if (!cfg.workspaceRoot) return { ok: false, error: '未选择项目目录' };
    let target;
    try {
      target = assertInsideWorkspace(cfg.workspaceRoot, absPath);
    } catch (err) {
      return { ok: false, error: 'path_outside_workspace: ' + (err && err.message ? err.message : err) };
    }
    if (path.resolve(target) === path.resolve(cfg.workspaceRoot)) {
      return { ok: false, error: 'cannot_delete_workspace_root' };
    }
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      return { ok: false, error: 'not_found' };
    }
    try {
      // recursive:true so dirs work too; force:true tolerates races
      // where another process removes the path mid-call.
      await fsp.rm(target, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: 'rm_failed: ' + (err && err.message ? err.message : err) };
    }
    // Phase 4: route through the local upload scheduler. The scheduler
    // handles debounce + MIN_INTERVAL + single-flight + daemon-offline
    // backoff, so a burst of delete/save/paste no longer needs the
    // active-task guard or the direct-fire branch. Await so the dirty
    // marker is durable BEFORE this IPC returns (crash-safety).
    let upload = { ok: true, scheduled: false };
    if (isSyncthingBackend(cfg)) {
      await ensureUploadScheduler().schedule('delete', cfg.workspaceRoot, target).catch((err) => {
        console.warn('[files:deleteNode] scheduler.schedule failed:', err && err.message ? err.message : err);
      });
      upload = { ok: true, scheduled: true };
    }
    return {
      ok: true,
      deleted: target,
      wasDir: stat.isDirectory(),
      upload,
    };
  });

  // File-tree right-click PASTE: copy source (file or dir) into the
  // target directory + trigger snapshot Upload. The renderer holds
  // the source path in component state (its "internal clipboard");
  // this IPC just performs the fs op + sync.
  //
  // Safety: both source and target dir must be inside the workspace;
  // refuse if target dir already has an entry with the source's name
  // (no silent overwrite — caller should rename first).
  ipcMain.handle('files:pasteNode', async (_event, sourceAbsPath, targetDirAbsPath) => {
    const cfg = await loadStoredConfig();
    if (!cfg.workspaceRoot) return { ok: false, error: '未选择项目目录' };
    let source;
    let targetDir;
    try {
      source = assertInsideWorkspace(cfg.workspaceRoot, sourceAbsPath);
      targetDir = assertInsideWorkspace(cfg.workspaceRoot, targetDirAbsPath);
    } catch (err) {
      return { ok: false, error: 'path_outside_workspace: ' + (err && err.message ? err.message : err) };
    }
    const targetDirStat = await fsp.stat(targetDir).catch(() => null);
    if (!targetDirStat || !targetDirStat.isDirectory()) {
      return { ok: false, error: 'target_not_directory' };
    }
    if (source === targetDir || targetInsideSource(source, targetDir)) {
      // Pasting a dir into itself or a descendant would self-recurse.
      return { ok: false, error: 'self_or_descendant' };
    }
    const sourceStat = await fsp.stat(source).catch(() => null);
    if (!sourceStat) return { ok: false, error: 'source_not_found' };
    const dst = path.join(targetDir, path.basename(source));
    const existed = await fsp.stat(dst).catch(() => null);
    if (existed) return { ok: false, error: 'target_exists' };
    try {
      await fsp.cp(source, dst, { recursive: true, errorOnExist: true });
    } catch (err) {
      return { ok: false, error: 'cp_failed: ' + (err && err.message ? err.message : err) };
    }
    // Phase 4: same scheduler-based pattern as files:deleteNode.
    let upload = { ok: true, scheduled: false };
    if (isSyncthingBackend(cfg)) {
      await ensureUploadScheduler().schedule('paste', cfg.workspaceRoot, dst).catch((err) => {
        console.warn('[files:pasteNode] scheduler.schedule failed:', err && err.message ? err.message : err);
      });
      upload = { ok: true, scheduled: true };
    }
    return {
      ok: true,
      pasted: dst,
      wasDir: sourceStat.isDirectory(),
      upload,
    };
  });

  // Right-click "Show in Finder" — reveal the path in the OS file
  // browser. shell.showItemInFolder opens the parent dir with the
  // child highlighted (macOS Finder, Windows Explorer, common
  // Linux file managers). Workspace boundary is enforced so the
  // renderer can't reveal arbitrary disk paths.
  ipcMain.handle('files:showInFinder', async (_event, absPath) => {
    const cfg = await loadStoredConfig();
    if (!cfg.workspaceRoot) return { ok: false, error: '未选择项目目录' };
    let target;
    try {
      target = assertInsideWorkspace(cfg.workspaceRoot, absPath);
    } catch (err) {
      return { ok: false, error: 'path_outside_workspace' };
    }
    try {
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.on('files:startDrag', (event, absPath) => {
    startFileDragForSender(event.sender, absPath);
  });
  ipcMain.on('files:startDragSync', (event, absPath) => {
    event.returnValue = startFileDragForSender(event.sender, absPath);
  });

  ipcMain.handle('files:save', async (_event, filePath, content) => {
    const cfg = await loadStoredConfig();
    const absolute = assertInsideWorkspace(cfg.workspaceRoot, filePath);
    await fsp.writeFile(absolute, String(content), 'utf8');
    // Syncthing-backed workspaces are in control-only mode; the daemon
    // doesn't auto-push file writes. The local upload scheduler picks
    // up the save (debounce + MIN_INTERVAL + single-flight + daemon-
    // offline backoff coalesce bursts of saves into one upload and
    // survive daemon outages). Filesync-backed workspaces still kick
    // the daemon via /v1/sync-once so the change uploads without
    // waiting for the rescan tick.
    let sync = { ok: true };
    let syncQueued = false;
    if (isSyncthingBackend(cfg)) {
      syncQueued = true;
      await ensureUploadScheduler().schedule('save', cfg.workspaceRoot, absolute).catch((err) => {
        console.warn('[files:save] scheduler.schedule failed:', err && err.message ? err.message : err);
      });
    } else {
      sync = await postDaemon('/v1/sync-once', {}, 5000);
    }
    const stat = await fsp.stat(absolute);
    const gitBase = await readGitBaseForFile(cfg.workspaceRoot, absolute);
    return {
      ok: true,
      synced: sync.ok,
      syncQueued,
      syncError: sync.ok ? '' : sync.error,
      file: {
        path: absolute,
        relPath: path.relative(cfg.workspaceRoot, absolute),
        content: String(content),
        size: stat.size,
        language: languageFromPath(absolute),
        baseContent: gitBase.baseContent,
        baseKind: gitBase.baseKind,
        gitStatus: gitBase.gitStatus,
        gitBadge: gitBase.gitBadge
      }
    };
  });

  ipcMain.handle('daemon:status', async () => daemonSnapshot());
  ipcMain.handle('sessions:list', async (_event, forceRefresh) => listRemoteSessions(Boolean(forceRefresh)));
  ipcMain.handle('sessions:rename', async (_event, payload) => renameSessionAlias(payload || {}));
  // Mobile pairing removed in the single-tenant OSS build (it relied on the
  // cloud management endpoints /api/mobile/*).

  ipcMain.handle('terminal:create', async (_event, req) => createTerminal(req));
  ipcMain.handle('terminal:write', async (_event, id, data) => {
    const t = terminals.get(id);
    if (t) t.write(String(data || ''));
  });
  ipcMain.handle('terminal:resize', async (_event, id, cols, rows) => {
    const key = String(id || '');
    const t = terminals.get(key);
    const nextCols = Math.max(2, Number(cols) || 2);
    const nextRows = Math.max(2, Number(rows) || 2);
    if (t && typeof t.resize === 'function') {
      t.resize(nextCols, nextRows);
      broadcastRenderer('terminal:resized', { id: key, cols: nextCols, rows: nextRows });
    }
  });
  ipcMain.handle('terminal:stop', async (_event, id, opts) => stopTerminal(id, opts || {}));
  // Pin/unpin: pinned terminal IDs survive automatic project-exit kills.
  // The state lives only in main; the detached window queries on load to
  // reflect its button's true on/off.
  ipcMain.handle('terminal:setPinned', async (_event, id, pinned) => {
    const key = String(id || '');
    if (!key) return { ok: false, pinned: false };
    // Refuse pinning unknown terminal IDs so stale pins don't accumulate
    // (e.g., renderer races where the terminal already exited).
    if (pinned && !terminals.has(key)) return { ok: false, pinned: false };
    if (pinned) pinnedTerminals.add(key);
    else pinnedTerminals.delete(key);
    return { ok: true, pinned: pinnedTerminals.has(key) };
  });
  ipcMain.handle('terminal:isPinned', async (_event, id) => pinnedTerminals.has(String(id || '')));
  // Renderer (App.tsx) reports which terminal IDs currently have a pane
  // in the project view. main relays to every window via broadcast so
  // detached PTY windows can show "return to dock" vs "close & stop".
  ipcMain.handle('view:setActiveTerminals', async (_event, ids) => {
    const next = new Set((ids || []).map((v) => String(v)));
    activeTerminalPanes = next;
    broadcastRenderer('view:active-terminals', { ids: [...next] });
    return { ok: true };
  });
  ipcMain.handle('view:hasActivePane', async (_event, id) => activeTerminalPanes.has(String(id || '')));
  ipcMain.handle('terminal:snapshot', async (_event, id) => ({
    id,
    data: terminalBacklogs.get(id) || '',
    alive: terminals.has(id)
  }));
  ipcMain.handle('terminal:detach', async (_event, id, title) => createDetachedTerminalWindow(String(id || ''), String(title || 'Terminal')));
  ipcMain.handle('terminal:focusDetached', async (_event, id) => {
    const win = detachedTerminalWindows.get(String(id || ''));
    if (win && !win.isDestroyed()) {
      const alreadyFocused = win.isFocused();
      win.show();
      if (alreadyFocused) return { ok: true, focused: true };
      win.focus();
      win.flashFrame(true);
      shakeWindow(win);
      setTimeout(() => {
        if (!win.isDestroyed()) win.flashFrame(false);
      }, 900);
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle('terminal:closeDetached', async (_event, id) => {
    const win = detachedTerminalWindows.get(String(id || ''));
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
  });
  ipcMain.handle('git:summary', async () => gitSummary());
  ipcMain.handle('git:workingTreeStatus', async () => {
    const cfg = await loadStoredConfig();
    if (!cfg.workspaceRoot) return { isGit: false, statuses: {} };
    return gitWorkingTreeStatusForRoot(cfg.workspaceRoot);
  });
  ipcMain.handle('git:bootstrap', async (_event, payload) => gitBootstrap(payload));
  // Diff Viewer commit 1: read-only `Changes` surface. Summary
  // collects per-file metadata + small patches; gitFileDiff lazy-
  // loads one file's full patch when summary capped it.
  ipcMain.handle('git:diffSummary', async () => gitDiffSummary());
  ipcMain.handle('git:fileDiff', async (_event, relPath) => gitFileDiff(relPath));
  ipcMain.handle('files:forceUpload', async (_event, paths) => {
    // Convert thrown Errors into structured {ok:false, code, error}
    // so the renderer can branch on the typed code (round-1 codex #2
    // on B11 — ipcMain.handle's error propagation drops custom .code
    // properties; renderer only sees error.message).
    try {
      const data = await forceUpload(paths);
      return { ok: true, data };
    } catch (err) {
      const code = (err && err.code) ? String(err.code) : 'force_upload_failed';
      return { ok: false, code, error: String((err && err.message) || err) };
    }
  });
  // Clipboard-image fast path: read directly via Electron's native
  // clipboard.readImage() in main instead of hopping to kari-syncd's
  // /v1/clipboard-image (which shells out to osascript — 300–800 ms on
  // macOS Sequoia thanks to TCC). The on-disk PNG path then flows into
  // the existing kari CLI sniffer → pty-attach upload pipeline
  // unchanged.
  ipcMain.handle('clipboard:image', async () => readClipboardImageLocal());
  // Direct-upload bypass for the Cmd+V → cloud-PTY image-paste flow.
  // Reads the image via Electron, POSTs the raw bytes to ConsoleZ's
  // /api/v1/pty/clipboard-paste, returns the server-side absolute path
  // the kari CLI sniffer should forward verbatim to the remote PTY.
  // Skips syncthing entirely — one HTTP RTT instead of a full BEP
  // scan+transfer+ack round-trip.
  ipcMain.handle('clipboard:pasteImage', async () => clipboardPasteImageDirect());
  ipcMain.handle('pty:attach', async (_event, localPath) => postDaemon('/v1/pty-attach', { local_path: localPath }, 60000));
  ipcMain.handle('reverse:rotate', async () => rotateFRPWithActivationCode());
  ipcMain.handle('reverse:start', async () => reverseProxyAction('start'));
  ipcMain.handle('reverse:refresh', async () => reverseProxyAction('refresh'));
  ipcMain.handle('reverse:stop', async () => reverseProxyAction('stop'));
  ipcMain.handle('reverse:copy', async () => copyReverseProxyInfo());
  ipcMain.handle('capabilities:get', async () => getCapabilities());
  ipcMain.handle('models:get', async () => getModelKeys());
  ipcMain.handle('settings:update', async (_event, payload) => saveStoredConfig(payload || {}));
  ipcMain.handle('usage:read', async (_event, payload) => readUsageSnapshot(payload || {}));
}

// readUsageSnapshot aggregates `~/.kari/usage-hourly.json` for the
// Settings → Usage page. The on-disk format is `<hour_ms>|<model>:
// total_tokens` (a flat object, written by kari-usage-agent). For now
// only `total` is available; the `in`/`out` split is stubbed as null
// and the renderer displays `—` until usage-agent learns to record
// upstream/downstream separately.
async function readUsageSnapshot(payload) {
  const range = normalizeUsageRange(payload && payload.range);
  const filePath = path.join(os.homedir(), '.kari', 'usage-hourly.json');
  let buckets = {};
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    buckets = JSON.parse(raw) || {};
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      console.warn('usage:read: failed to read usage-hourly.json:', err && err.message);
    }
  }
  const cutoff = usageRangeCutoff(range);
  const totals = { deepseek: 0, kimi: 0 };
  for (const [k, v] of Object.entries(buckets)) {
    const sep = k.indexOf('|');
    if (sep < 0) continue;
    const ts = Number(k.slice(0, sep));
    const model = k.slice(sep + 1);
    if (!(model in totals)) continue;
    if (Number.isFinite(cutoff) && ts < cutoff) continue;
    const n = Number(v);
    if (Number.isFinite(n)) totals[model] += n;
  }
  return {
    deepseek: { total: totals.deepseek, in: null, out: null },
    kimi: { total: totals.kimi, in: null, out: null },
    asOf: Date.now(),
    range
  };
}

function normalizeUsageRange(value) {
  switch (value) {
    case 'month':
    case 'week':
    case 'today':
    case 'all':
      return value;
    default:
      return 'month';
  }
}

// usageRangeCutoff returns the lower bound in unix ms; entries with
// hour-bucket timestamp < cutoff are excluded. `all` returns -Infinity
// so the entire history flows through. Cutoffs follow local clock so
// "今天" / "本周" / "本月" line up with what the user sees on their
// wall calendar, not UTC midnight.
function usageRangeCutoff(range) {
  if (range === 'all') return -Infinity;
  const now = new Date();
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (range === 'week') {
    // ISO-ish: week starts Monday. Sunday = 0 in JS, so map 0 → 6.
    const dow = (now.getDay() + 6) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).getTime();
  }
  // month
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

// Phase 1.2(b) (syncthing migration): shared post-activation pair
// helper. Both the legacy /api/resolve branch and the tenant-client
// branch of activation:submit fire this fire-and-forget. Failures
// log but never fail activation — the user can keep working on the
// legacy filesync data plane until syncthing finishes provisioning.
//
// Sanitizes the workspace-name-derived folder path: when cfg
// already has workspaceRoot we use it (it's already inside
// projectsRoot); when it's absent we build a path from workspaceName
// and assert the result stays under defaultProjectsRoot(cfg) so a
// malicious workspace_name like "../escape" can't make syncthing
// share an out-of-container directory (codex round-4 P1).
function schedulePairAfterActivation({ cfg, activationCode } = {}) {
  // Plan T6: PTY-driven sync owns all per-project pair calls. The
  // legacy workspace-level pair invoked from activation:submit,
  // workspace:select, importLocalProject, etc. would race the
  // scheduler and create a duplicate folder. Skip when the scheduler
  // is mounted; rollback via KARI_DISABLE_PTY_SYNC=1.
  if (ENABLE_PTY_DRIVEN_SYNC) {
    console.log('[syncthing-pair] skipped: PTY-driven sync (T6) owns pair calls; legacy schedule disabled');
    return;
  }
  void (async () => {
    try {
      if (!cfg || !cfg.serverAddr || !cfg.workspaceName || !cfg.workspaceId) {
        console.warn('[syncthing-pair] skipped: missing serverAddr/workspaceName/workspaceId on activation');
        return;
      }
      if (!activationCode) {
        console.warn('[syncthing-pair] skipped: no activation code available for pair-info call');
        return;
      }
      const startResult = await startSyncthingChild({ cfg, activationCode, restartIfProxyChanged: true });
      if (!startResult || !startResult.ok) {
        console.warn('[syncthing-pair] skipped: syncthing child not ready for SOCKS5 proxy', startResult && startResult.reason || '');
        return;
      }
      const meta = syncthingProcess.getRunningMeta();
      if (!meta || !meta.deviceId) {
        console.warn('[syncthing-pair] skipped: syncthing child not running after proxy check');
        return;
      }
      // T3 interim: pair-info now requires project_path. Until the sync
      // scheduler (plan T5/T6) drives pair calls per-PTY-project, the
      // schedulePairAfterActivation flow still operates at the workspace
      // level — pass cfg.workspaceName as the project_path placeholder so
      // the server's missing_project_path 400 doesn't break the existing
      // workspace:select trigger. Resulting folder_path is
      //   <syncDir>/<wsid>/<workspaceName>/<workspaceName>
      // — visibly redundant but functional. T5/T6 replaces this caller
      // with per-project scheduler invocations and the redundancy goes
      // away.
      const pairResult = await syncthingPair.requestPairInfo({
        serverAddr: cfg.serverAddr,
        activationCode,
        desktopDeviceId: meta.deviceId,
        workspaceName: cfg.workspaceName,
        projectRelPath: cfg.workspaceName,
        desktopAddresses: [],
      });
      if (!pairResult.ok) {
        console.warn('[syncthing-pair] requestPairInfo failed:', pairResult.code, pairResult.message || '');
        return;
      }
      // Compute the local folder path. Prefer cfg.workspaceRoot if it
      // exists (it's already inside projectsRoot via earlier guards).
      // Otherwise join projectsRoot + sanitized workspaceName and
      // verify containment via targetInsideSource. Reject if the
      // resulting path escapes the container — workspaceName is
      // operator-supplied via /api/resolve so we treat it as
      // untrusted at this layer.
      const projectsRoot = defaultProjectsRoot(cfg);
      let localFolderPath = cfg.workspaceRoot;
      if (!localFolderPath) {
        const cleanName = cleanWorkspaceName(cfg.workspaceName);
        if (!cleanName) {
          console.warn('[syncthing-pair] skipped: workspaceName failed sanitization');
          return;
        }
        localFolderPath = path.join(projectsRoot, cleanName);
      }
      const absFolderPath = path.resolve(localFolderPath);
      if (!targetInsideSource(projectsRoot, absFolderPath)) {
        console.warn('[syncthing-pair] skipped: derived folder path is outside Kari container:', absFolderPath);
        return;
      }
      // Pre-write .stignore so syncthing's first scan doesn't ship
      // node_modules/dist before mode-store catches up (codex
      // round-4 P2). Best-effort.
      const identity = {
        serverAddr: cfg.serverAddr,
        workspaceId: cfg.workspaceId,
        workspaceName: cfg.workspaceName,
      };
      const mode = await getEffectiveSyncMode(identity).catch(() => 'lightweight');
      const includeOverrides = await getIncludeSetForProject(identity).catch(() => new Set());
      const apply = await syncthingPair.applyPairInfoLocally({
        creds: { guiAddress: meta.guiAddress, apiKey: meta.apiKey },
        localDeviceId: meta.deviceId,
        pairInfo: pairResult.body,
        folderPath: absFolderPath,
        stignoreWriter: writeStignoreFile,
        stignoreArgs: { mode, includeOverrides },
      });
      if (!apply.ok) {
        console.warn('[syncthing-pair] applyPairInfoLocally failed:', apply.code);
        // Codex round-6 P2 fix: do NOT run the stale-folder sweep when
        // applyPairInfoLocally failed. The new folder isn't in place
        // yet — sweeping every other kari1_ws-* folder would leave the
        // user with no working syncthing share at all on a transient
        // PutDevice/PutFolder error.
        return;
      }
      console.log('[syncthing-pair] paired with', String(pairResult.body.server_device_id || '').slice(0, 12) + '... folder=' + pairResult.body.folder_id);
      // Phase 4.5: user just switched to a different workspace. Any
      // other kari1_ws-* folders still present in the local syncthing
      // config are from past activations and will keep generating
      // peer-disconnected / path-missing events forever. Best-effort
      // sweep — runs ONLY after the new folder is verified in place
      // (apply.ok === true), so we never strand the user with no
      // folder if the new pair failed.
      try {
        await syncthingPair.unshareOtherKariFolders({
          creds: { guiAddress: meta.guiAddress, apiKey: meta.apiKey },
          keepFolderId: pairResult.body.folder_id,
        });
      } catch (err) {
        console.warn('[syncthing-pair] unshareOtherKariFolders threw:', String(err && err.message || err));
      }
    } catch (err) {
      console.warn('[syncthing-pair] threw:', String(err && err.message || err));
    }
  })();
}

let syncthingSubCredsKey = '';
function ensureSyncthingEventSubscriber(meta) {
  if (!meta || !meta.guiAddress || !meta.apiKey) return;
  const credsKey = `${meta.guiAddress}|${meta.apiKey}`;
  // Re-bind when the creds change, not just when the subscriber is down. A
  // syncthing restart (re-activation, regenerated api key, new gui port) leaves
  // the subscriber polling the OLD creds — every poll then fails, peers go
  // empty, and the status bar shows "disconnected" even though syncthing is
  // actually connected. Restart on a creds change so the projection tracks the
  // live child.
  if (syncthingEventSub.isRunning() && syncthingSubCredsKey === credsKey) return;
  if (syncthingEventSub.isRunning()) syncthingEventSub.stop();
  syncthingSubCredsKey = credsKey;
  syncthingEventSub.start({
    guiAddress: meta.guiAddress,
    apiKey: meta.apiKey,
    onUpdate: (state) => {
      broadcastRenderer('syncthing:state', state);
    },
  });
}

function schedulePairForStoredConfig(reason = 'startup') {
  void (async () => {
    try {
      const cfg = await loadStoredConfig();
      const activationCode = decryptActivationCode(cfg);
      if (!cfg || !cfg.serverAddr || !cfg.workspaceId || !cfg.workspaceName || !activationCode) {
        console.log(`[syncthing-pair] ${reason}: stored config incomplete; startup pair skipped`);
        return;
      }
      if (ENABLE_PTY_DRIVEN_SYNC) {
        ensurePtyDrivenSync();
        await ensureLocalWorkspaceContainer(cfg).catch((err) => {
          console.warn(`[syncthing-pair] ${reason}: ensureLocalWorkspaceContainer failed:`, err && err.message ? err.message : err);
          return null;
        });
        await ensureContainerWorkspacePairForStoredConfig(reason);
        return;
      }
      console.log(`[syncthing-pair] ${reason}: scheduling stored workspace pair`);
      schedulePairAfterActivation({ cfg, activationCode });
    } catch (err) {
      console.warn(`[syncthing-pair] ${reason}: stored pair scheduling failed:`, String(err && err.message || err));
    }
  })();
}

// Phase 1.1 (syncthing migration): bootstrap + spawn the syncthing
// child. Returns the same shape as syncthingProcess.start so callers
// can grab pid/guiAddress/apiKey/deviceId. In the single-port model,
// cfg.serverAddr + activationCode also derive the SOCKS5 proxy URL
// injected into Syncthing's environment.
async function startSyncthingChild({ cfg = null, activationCode = null, restartIfProxyChanged = false } = {}) {
  const runtime = await ensureRuntime();
  const binary = runtime.syncthingPath;
  if (!binary) {
    console.warn('[syncthing] no bundled binary found; skipping spawn');
    return { ok: false, reason: 'binary_missing' };
  }
  const fullCfg = cfg || await loadStoredConfig().catch(() => null);
  // Single-tenant: the server's Syncthing is directly reachable
  // (tcp://host:22000), so the client connects straight to the advertised
  // server_addresses — no SOCKS5 tunnel through a cloud mux.
  const proxyUrl = '';
  const running = syncthingProcess.getRunningMeta();
  if (running) {
    if (restartIfProxyChanged && String(running.proxyUrl || '') !== String(proxyUrl || '')) {
      console.log('[syncthing] restarting child to apply SOCKS5 proxy endpoint');
      syncthingEventSub.stop();
      await syncthingProcess.stop('proxy_changed');
    } else {
      ensureSyncthingEventSubscriber(running);
      return { ok: true, ...running, alreadyRunning: true };
    }
  }
  const homeDir = path.join(app.getPath('userData'), 'syncthing-config');
  // Optional loopback-only BEP listen port override for tests. Without
  // it we choose an ephemeral loopback port; Desktop no longer exposes
  // or advertises 0.0.0.0:22000 because server reachability is through
  // ConsoleZ's SOCKS5 mux on cfg.serverAddr.
  const listenPortEnv = String(process.env.KARI_SYNCTHING_LISTEN_PORT || '').trim();
  const parsedListenPort = listenPortEnv ? Number(listenPortEnv) : null;
  const listenPort = Number.isFinite(parsedListenPort) && parsedListenPort > 0 ? parsedListenPort : undefined;
  const result = await syncthingProcess.start({ homeDir, binary, listenPort, proxyUrl });
  if (!result.ok) {
    console.warn('[syncthing] start failed:', result.reason || 'unknown', result.stderrTail ? '\n  stderr-tail: ' + result.stderrTail.slice(-200) : '');
    return result;
  }
  console.log('[syncthing] started pid=' + result.pid + ' gui=' + result.guiAddress + ' device=' + (result.deviceId || '').slice(0, 12) + '... listen=' + result.listenAddress + ' proxy=' + (proxyUrl ? 'on' : 'off'));
  // Phase 2: kick off the event subscriber against the freshly-started
  // child. Updates are debounced via webContents.send batching by
  // broadcastRenderer so the renderer doesn't get hammered.
  ensureSyncthingEventSubscriber(result);
  return result;
}

async function ensureRuntime() {
  if (runtimeCache) return runtimeCache;
  const label = platformLabel();
  const paths = {
    syncdPath: await resolveRuntimeBinary('kari-syncd', process.env.KARI_SYNCD_PATH, label),
    kariPath: await resolveRuntimeBinary('kari', process.env.KARI_CLI_PATH, label),
    frpcPath: await resolveRuntimeBinary('frpc', process.env.KARI_FRPC_PATH, label, true),
    syncthingPath: await resolveRuntimeBinary('syncthing', process.env.KARI_SYNCTHING_PATH, label, true),
    opencodePath: await resolveOptionalCliBinary('opencode', 'KARI_OPENCODE_PATH')
  };
  runtimeCache = {
    platform: label,
    daemonBase: DAEMON_BASE,
    ...paths,
    ok: Boolean(paths.syncdPath && paths.kariPath),
    missing: [
      !paths.syncdPath ? 'kari-syncd' : '',
      !paths.kariPath ? 'kari' : '',
      !paths.syncthingPath ? 'syncthing' : ''
    ].filter(Boolean)
  };
  return runtimeCache;
}

function platformLabel() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'win32' && a === 'x64') return 'windows-x64';
  if (p === 'win32' && a === 'arm64') return 'windows-arm64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  return `${p}-${a}`;
}

function binExt() {
  return process.platform === 'win32' ? '.exe' : '';
}

async function resolveRuntimeBinary(name, override, label, optional = false) {
  const ext = binExt();
  const candidates = [];
  if (override) candidates.push(override);
  const appPath = app.getAppPath();
  const resourcesPath = process.resourcesPath || '';
  candidates.push(
    path.join(appPath, 'bundled-runtime', label, `${name}${ext}`),
    path.join(appPath, '..', 'bundled-runtime', label, `${name}${ext}`),
    path.join(resourcesPath, 'bundled-runtime', label, `${name}${ext}`),
    path.join(appPath, 'bin', `${name}${ext}`),
    path.join(appPath, '..', 'bin', `${name}${ext}`),
    path.join(os.homedir(), '.kari', 'runtime', 'dev', `${name}${ext}`)
  );
  const fromPath = findOnPath(`${name}${ext}`);
  if (fromPath) candidates.push(fromPath);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  if (optional) return '';
  return '';
}

async function resolveOptionalCliBinary(name, envName) {
  const override = process.env[envName];
  const bundled = await resolveRuntimeBinary(name, override, platformLabel(), true);
  return bundled || (override ? findOnPath(override) : findOnPath(name));
}

function findOnPath(executable) {
  if (!executable) return '';
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    try {
      if (fs.existsSync(executable)) return executable;
    } catch {}
    return '';
  }
  const extra = process.platform === 'win32'
    ? []
    : [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.bun', 'bin'),
        path.join(os.homedir(), '.cargo', 'bin')
      ];
  const parts = [...String(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extra];
  const names = executableNames(executable);
  for (const dir of parts) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) return full;
      } catch {}
    }
  }
  return '';
}

function executableNames(name) {
  if (process.platform !== 'win32' || path.extname(name)) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

// ensureDaemonRunning keeps kari-syncd alive for non-file-sync
// services (clipboard-image / pty-attach / reverse-proxy / MCP
// local_shell_exec). Syncthing owns file sync; when a workspace is
// syncthing-backed we bind kari-syncd only in control-only mode so it
// can register the local-exec control channel without resurrecting the
// legacy upload/download task plane.
async function ensureDaemonRunning() {
  if (daemonSpawnInFlight) return daemonSpawnInFlight;
  daemonSpawnInFlight = (async () => {
    try {
      const runtime = await ensureRuntime();
      const health = await getDaemon('/healthz', 800);
      if (health.ok) {
        return { ok: true, base: DAEMON_BASE, alreadyRunning: true, runtime };
      }
      const decision = daemonCanSpawnNow({
        now: Date.now(),
        daemonStopReason,
        crashCooldownUntil,
        hasCustomDaemonUrl: hasCustomDaemonUrl(),
      });
      if (!decision.ok) {
        if (decision.reason === 'external_daemon') {
          const probe = await getDaemon('/healthz', 700);
          return { ok: probe.ok, base: DAEMON_BASE, external: true, runtime };
        }
        return { ok: false, base: DAEMON_BASE, reason: decision.reason, until: decision.until, runtime };
      }
      if (!runtime.syncdPath) {
        return { ok: false, base: DAEMON_BASE, error: 'kari-syncd binary not found', runtime };
      }
      if (daemonProc && !daemonProc.killed) {
        return waitForDaemon(runtime);
      }
      return startManagedDaemon(runtime);
    } finally {
      daemonSpawnInFlight = null;
    }
  })();
  return daemonSpawnInFlight;
}

async function ensureDaemonControlSessionForStoredConfig(reason = 'startup', opts = {}) {
  if (daemonControlBindInFlight) {
    if (!opts.force) return daemonControlBindInFlight;
    await daemonControlBindInFlight.catch(() => null);
  }
  daemonControlBindInFlight = (async () => {
    const cfg = await loadStoredConfig().catch(() => null);
    const activationCode = decryptActivationCode(cfg);
    const runtimeResult = await ensureDaemonRunning();
    if (!runtimeResult || !runtimeResult.ok) {
      console.warn(`[daemon-control] ${reason}: kari-syncd not ready; local_shell_exec remains unavailable`, runtimeResult && (runtimeResult.error || runtimeResult.reason) || '');
      return { ok: false, reason: 'daemon_not_ready' };
    }
    const req = buildDaemonControlBindRequest(cfg, {
      activationCode,
      fallbackClientId: machineClientId(),
      frpcPath: runtimeResult.runtime && runtimeResult.runtime.frpcPath || '',
      rescanSeconds: opts.rescanSeconds,
    });
    if (!req) {
      return { ok: false, skipped: true, reason: 'incomplete_or_not_syncthing' };
    }
    const key = daemonControlBindKey(req);
    if (!opts.force && key && key === daemonControlBindLastKey) {
      const status = await getDaemon('/v1/status', 1000);
      if (
        status.ok &&
        status.data &&
        status.data.running === true &&
        status.data.connected === true &&
        String(status.data.workspace_id || '') === String(req.workspace_id || '')
      ) {
        return { ok: true, skipped: true, alreadyBound: true };
      }
    }
    await refreshStignoreForCurrentWorkspace(cfg).catch((err) => {
      console.warn('[daemon-control] .stignore refresh before control bind failed:', String(err && err.message || err));
    });
    const bind = await postDaemon('/v1/bind', req, 10000);
    if (!bind.ok) {
      console.warn(`[daemon-control] ${reason}: /v1/bind failed:`, bind.status || '', bind.error || '');
      return { ok: false, code: 'bind_failed', status: bind.status, error: bind.error };
    }
    const started = await postDaemon('/v1/start', {}, 10000);
    if (!started.ok) {
      console.warn(`[daemon-control] ${reason}: /v1/start failed:`, started.status || '', started.error || '');
      return { ok: false, code: 'start_failed', status: started.status, error: started.error };
    }
    daemonControlBindLastKey = key;
    console.log(`[daemon-control] ${reason}: kari-syncd control-only session bound for workspace=${req.workspace_id} client=${req.client_id}`);
    return { ok: true };
  })().finally(() => {
    daemonControlBindInFlight = null;
  });
  return daemonControlBindInFlight;
}

function hasCustomDaemonUrl() {
  return Boolean(process.env.KARI_SYNCD_URL || process.env.KARI_SYNCD_ADDR);
}

// Codex round-6 P2 fix: restored — stopDaemonIfBoundToProject still
// calls this on local-project-delete to release a stale daemon bind.
// POSTs /v1/shutdown and polls /healthz until the daemon is gone.
async function shutdownDaemonOnPort(reason) {
  await postDaemon('/v1/shutdown', { reason }, 1000).catch(() => null);
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const health = await getDaemon('/healthz', 400);
    if (!health.ok) return true;
  }
  return false;
}

function startManagedDaemon(runtime) {
  daemonStopReason = null;
  daemonProc = cp.spawn(runtime.syncdPath, ['--addr', DAEMON_ADDR], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  const proc = daemonProc;
  proc.once('exit', () => {
    if (daemonProc !== proc) return;
    daemonProc = null;
    daemonControlBindLastKey = '';
    if (daemonStopReason === 'user_quit') return;
    daemonStopReason = 'crash';
    const now = Date.now();
    crashTimestamps = recordDaemonCrash(crashTimestamps, now);
    if (daemonShouldCooldown(crashTimestamps)) {
      crashCooldownUntil = daemonComputeCooldown(now);
      console.warn('[daemon-watchdog] kari-syncd crashed', crashTimestamps.length,
        'times within window; cooling down until', new Date(crashCooldownUntil).toISOString());
      return;
    }
    console.warn('[daemon-watchdog] kari-syncd exited; scheduling respawn in', DAEMON_RESPAWN_DELAY_MS, 'ms');
    if (daemonRespawnTimer) clearTimeout(daemonRespawnTimer);
    daemonRespawnTimer = setTimeout(() => {
      daemonRespawnTimer = null;
      ensureDaemonRunning().catch((err) => {
        console.warn('[daemon-watchdog] respawn attempt failed:', err && err.message ? err.message : err);
      });
    }, DAEMON_RESPAWN_DELAY_MS);
  });
  return waitForDaemon(runtime);
}

async function stopOwnedDaemon(reason) {
  const proc = daemonProc;
  if (!proc || proc.killed) return false;
  // Mark BEFORE issuing the shutdown so the exit listener correctly
  // skips respawn even if the kill races with the listener fire.
  daemonStopReason = 'user_quit';
  if (daemonRespawnTimer) {
    clearTimeout(daemonRespawnTimer);
    daemonRespawnTimer = null;
  }
  await postDaemon('/v1/shutdown', { reason }, 800).catch(() => null);
  const exited = await waitForProcessExit(proc, 1500);
  if (!exited && !proc.killed) {
    if (process.platform === 'win32' && proc.pid) {
      // Windows: proc.kill() = TerminateProcess on the immediate
      // child only. kari-syncd may have spawned helper subprocesses
      // (or the OS holds file handles via its descendants); taskkill
      // /T /F tears down the whole tree so the .exe isn't left
      // locked, which would break the next electron-builder run.
      try {
        cp.execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { timeout: 5_000, windowsHide: true, stdio: 'ignore' });
      } catch {}
    } else {
      try {
        proc.kill();
      } catch {}
    }
    await waitForProcessExit(proc, 500);
  }
  if (daemonProc === proc) daemonProc = null;
  daemonControlBindLastKey = '';
  return true;
}

function waitForProcessExit(proc, timeoutMs) {
  if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.off('exit', onExit);
    };
    proc.once('exit', onExit);
  });
}

async function waitForDaemon(runtime) {
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    const health = await getDaemon('/healthz', 700);
    if (health.ok) return { ok: true, base: DAEMON_BASE, alreadyRunning: false, runtime };
  }
  return { ok: false, base: DAEMON_BASE, error: 'kari-syncd did not become ready', runtime };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Phase B B5: bind decoupled from cfg.workspaceRoot.
//
// Optional args (all default to the legacy behavior for back-compat
// with the daemon:bindStart IPC callers that pass nothing):
//   bindRoot       — physical path to bind. Defaults to cfg.workspaceRoot.
//                    For path-scoped upload/download flows (B6/B7), this
//                    points at a staging dir under <userData>/staging/
//                    instead of the user's workspace — keeps cfg.workspaceRoot
//                    pointing at the user-visible workspace throughout.
//   bindKind       — 'workspace' (default) | 'upload-staging' | 'download-staging'.
//                    Daemon ignores unknown values; new builds use it to
//                    create per-session Syncthing folder ids
//                    (kari-upload-<sid> / kari-download-<sid>) instead of
//                    mutating the workspace's existing folder.
//   stagingId      — required iff bindKind != 'workspace'. UUID from the
//                    snapshot_session_store row that owns this stage.
//                    Daemon uses it as the Syncthing folder id suffix +
//                    as the lookup key for /v1/sync-verify.
//   workspaceName  — LOGICAL workspace name. Required for staging binds
//                    (the bindRoot is a staging path with a UUID basename
//                    that the daemon can't infer logical identity from);
//                    defaults to cfg.workspaceName for plain workspace binds.
//
// All new fields are extra JSON keys on /v1/bind. Daemon builds that
// pre-date the field set ignore them and behave as before (the legacy
// `workspace_root` + `sync_backend` keys still drive their flow).
function emptyTree(root) {
  return { root, nodes: [], fileCount: 0, directoryCount: 0, totalBytes: 0, truncated: false, isGit: false, gitRoot: '' };
}

async function listProjects() {
  let cfg = await loadStoredConfig();
  const root = defaultProjectsRoot(cfg);
  if (cfg.projectsRoot !== root) {
    await saveStoredConfig({ projectsRoot: root });
    cfg = await loadStoredConfig();
  }
  if (ENABLE_PTY_DRIVEN_SYNC && cfg.activated && cfg.workspaceId && cfg.workspaceName) {
    void ensureContainerWorkspacePairForStoredConfig('projects:list');
  }
  const workspaceRootExists = cfg.workspaceRoot
    ? await fsp.stat(cfg.workspaceRoot).then((s) => s.isDirectory()).catch(() => false)
    : false;
  // Phase 4.6: ensureMirrorSyncBound retired (called bindAndStartDaemon).
  // Syncthing handles workspace bind directly via pair-info at activation
  // time; nothing here needs to wake the daemon.
  // Single-tenant OSS: there is no cloud project catalog on the server.
  // Projects are local folders the user opens; we never fetch a server-side
  // project list (karid has no such endpoint). Leave cloudProjects null so
  // listProjects falls through to the local-only path, and cloudError empty
  // so the UI shows no "cloud list unavailable" banner.
  let cloudProjects = null;
  let cloudError = '';
  const cloudProjectNames = new Set((cloudProjects || []).map((project) => project.workspaceName || project.name).filter(Boolean));
  // Phase #3 lazy-init: any local mirror dir that the server tells us
  // is "ours" (workspaceName ∈ cloudProjectNames) but doesn't yet
  // carry a workspace.json ownership tag gets one stamped here. This
  // covers two backfill paths:
  //   - downloadProject mirror dirs created before Phase #3 landed.
  //   - importLocalProject runs where the tag write failed
  //     (best-effort fsp.writeFile is fire-and-forget).
  // Without this backfill, listLocalProjects's strict "missing tag =
  // not mine" filter would hide all the user's actual cloud-bound
  // mirrors. We don't backfill the inverse direction (a dir that
  // ISN'T in cloud listings) — that's exactly the multi-activation
  // orphan the filter is designed to keep out.
  if (cfg.workspaceId && cloudProjectNames.size > 0) {
    await Promise.all(
      Array.from(cloudProjectNames).map(async (name) => {
        const absolute = path.join(root, name);
        const exists = await fsp.stat(absolute).then((s) => s.isDirectory()).catch(() => false);
        if (!exists) return;
        const existing = await readWorkspaceOwnershipTag(absolute);
        if (existing && existing.workspaceId === cfg.workspaceId) return;
        // Codex finding (Phase #3 review): the backfill MUST NOT
        // overwrite a tag whose workspaceId is already set but
        // differs from cfg.workspaceId. That happens when two
        // activations both name a project the same thing (e.g. both
        // have an "app" workdir); without this guard, activation B's
        // listProjects call would steal activation A's local mirror
        // by rewriting the tag. Leave the existing tag in place and
        // log; the user has to resolve the collision (rename one
        // side, or manually clear the directory).
        if (existing && existing.workspaceId && existing.workspaceId !== cfg.workspaceId) {
          console.warn(
            '[listProjects] ownership backfill skipped for', name,
            '— tag already owned by', existing.workspaceId,
            '(current activation is', cfg.workspaceId + ')'
          );
          return;
        }
        await writeWorkspaceOwnershipTag(absolute, cfg.workspaceId).catch((err) => {
          console.warn('[listProjects] ownership backfill failed for', name, ':', err && err.message ? err.message : err);
        });
      })
    );
  }
  const currentProject = await currentProjectItem(root, cfg, cloudProjectNames).catch(() => null);
  const localProjects = await listLocalProjects(root, cfg, cloudProjectNames);
  const localCandidates = currentProject ? [currentProject, ...localProjects] : localProjects;
  const projects = cloudProjects ? mergeCloudProjects(cloudProjects, localCandidates) : uniqueProjects(localCandidates);
  const sorted = sortProjects(projects);
  const schedulerActiveProjectPaths = new Set();
  if (ENABLE_PTY_DRIVEN_SYNC && syncSchedulerSingleton && typeof syncSchedulerSingleton.snapshot === 'function') {
    for (const entry of syncSchedulerSingleton.snapshot()) {
      if (entry && entry.projectAbsPath) {
        schedulerActiveProjectPaths.add(path.resolve(entry.projectAbsPath));
      }
    }
  }
  // PR2 Phase 1 commit 5: inject the cache into every ProjectItem.sync.
  // Cache misses get an idle stub so renderer can branch without
  // nil checks. workspaceId argument lets the cache key cloud
  // projects correctly even when the project row itself doesn't
  // carry a workspaceId field.
  syncStateCache.injectIntoProjects(sorted, cfg.workspaceId || '');
  // Attach ProjectConnectionState to every
  // project row. Renderer reads ONLY from project.connectionState
  // going forward; legacy project.sync.* fields are kept on the wire
  // for one release for back-compat.
  //
  // Syncthing-backed rows are now mapped from Syncthing itself:
  // local config folder + db/status + db/completion against the
  // server device. They do not read sync_state_cache, sync_task_tracker,
  // desktopUpload, or the old fail-visible syncthing branch.
  //
  // Filesync rows still use the legacy mapper inputs:
  //   - workspaceId: fill from cfg if the row lacked it (cloud rows
  //     from listServerProjects don't carry workspaceId per-row;
  //     codex round 2 P2 pin).
  //   - hasIncompleteMarker: FS check of <path>/.kari-engine/
  //     desktop-download-incomplete. Local-source rows are filtered
  //     to never have a marker by listLocalProjects, so the check is
  //     functionally a no-op for them.
  //   - syncCacheEntry: same cache entry that was injected above.
  //   - activeTask: tracker lookup; covers the marker-not-yet-written
  //     race where a download POST is in flight but the FS write
  //     hasn't landed (codex round 2 P2 pin).
  const hasSyncthingProject = sorted.some((project) => project && project.syncBackend === 'syncthing')
    || String(cfg.workspaceSyncBackend || '').toLowerCase() === 'syncthing';
  // T6 follow-up: each project gets its own per-project syncthing folder
  // (folderIdFor wsid+projectRelPath). Compute a snapshot per project so
  // the UI doesn't pin the whole workspace's connectionState on one
  // workspace-level folder that no longer exists. Map keyed by absolute
  // project path so the project-loop below can look up its own entry.
  const syncthingSnapshotByProjectPath = new Map();
  // Single legacy snapshot is kept for KARI_DISABLE_PTY_SYNC=1 rollback +
  // for projects whose path falls outside projectsRoot (we can't derive a
  // projectRelPath there).
  let legacySyncthingSnapshot = null;
  if (hasSyncthingProject) {
    const meta = syncthingProcess.getRunningMeta();
    const projectsRoot = defaultProjectsRoot(cfg);
    const containerRoot = projectsRoot ? path.resolve(projectsRoot) : '';
    if (ENABLE_PTY_DRIVEN_SYNC && containerRoot) {
      // Per-project snapshots in parallel — N HTTP calls, typically 2-3.
      await Promise.all(sorted.map(async (project) => {
        if (!project || !project.path) return;
        const target = path.resolve(project.path);
        if (target !== containerRoot && !target.startsWith(containerRoot + path.sep)) return;
        const rel = path.relative(containerRoot, target);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
        const projectRelPath = rel.split(path.sep).join('/');
        const snap = await loadSyncthingProjectSnapshot({ cfg, meta, projectRelPath }).catch((err) => ({
          ok: false,
          code: 'syncthing_snapshot_failed',
          error: String(err && err.message || err),
        }));
        if (snap) syncthingSnapshotByProjectPath.set(target, snap);
      }));
    } else {
      legacySyncthingSnapshot = await loadSyncthingProjectSnapshot({ cfg, meta }).catch((err) => ({
        ok: false,
        code: 'syncthing_snapshot_failed',
        error: String(err && err.message || err),
      }));
    }
  }
  const syncthingFolderPath = legacySyncthingSnapshot && legacySyncthingSnapshot.folderPath
    ? legacySyncthingSnapshot.folderPath
    : '';
  await Promise.all(
    sorted.map(async (project) => {
      if (!project.workspaceId && cfg.workspaceId) {
        project.workspaceId = cfg.workspaceId;
      }
      // mirrorDirExists: real FS dir check, independent of filesync's
      // existsLocal heuristic. Syncthing uses this as the local
      // openability signal; filesync still receives it for its legacy
      // connected/provisioning guards.
      const mirrorDirExists = project.path
        ? await fsp.stat(project.path).then((s) => s.isDirectory()).catch(() => false)
        : false;
      // Per-project snapshot (T6 follow-up): a syncthing-backed project
      // is "active" iff its own folder exists in syncthing. Under PTY-
      // driven sync this is true only for projects with a live PTY
      // (scheduler installed the folder); under the legacy rollback
      // path it's true for the single workspace-level folder.
      const perProjectSnapshot = project.path
        ? (syncthingSnapshotByProjectPath.get(path.resolve(project.path)) || null)
        : null;
      const projectHasOwnFolder = !!(perProjectSnapshot && perProjectSnapshot.folder);
      const projectHasSchedulerActivity = project.path
        ? schedulerActiveProjectPaths.has(path.resolve(project.path))
        : false;
      // Under PTY-driven sync the "active" signal IS projectHasOwnFolder
      // OR scheduler activity before the folder exists. The latter
      // covers the visible "activating" window after a fast project click:
      // scheduler has accepted the project, but pair-info / PutFolder has
      // not finished yet. The legacy syncthingProjectIsActive
      // check matched cfg.workspaceRoot regardless of whether sync was
      // actually running, which caused the welcome page's "current"
      // project to flash "syncing 0%" on every boot (no snapshot yet,
      // mapSyncthingProjectConnectionState falls into the publishing/
      // provisioning branch and sits there until the user opens the
      // project). Keep the legacy fallback ONLY for the rollback path.
      const activeForCurrentSyncthingFolder = ENABLE_PTY_DRIVEN_SYNC
        ? (projectHasOwnFolder || projectHasSchedulerActivity)
        : (projectHasOwnFolder
          || syncthingProjectIsActive({
            project,
            cfgWorkspaceName: cfg.workspaceName || '',
            cfgWorkspaceRoot: cfg.workspaceRoot || '',
            folderPath: syncthingFolderPath,
          }));
      if (projectUsesSyncthingState({
        project,
        cfgWorkspaceSyncBackend: cfg.workspaceSyncBackend || '',
        activeForCurrentFolder: activeForCurrentSyncthingFolder,
      })) {
        project.syncBackend = 'syncthing';
        if (project.path && mirrorDirExists) {
          project.localBytes = await directorySyncthingSyncableFileBytes(
            project.path,
            cfg,
            project.workspaceName || cfg.workspaceName || project.name || ''
          ).catch(() => project.localBytes || 0);
        }
        // Prefer the per-project snapshot; fall back to the legacy
        // workspace-level snapshot when in rollback mode.
        const snapshotForMapper = perProjectSnapshot || (activeForCurrentSyncthingFolder ? legacySyncthingSnapshot : null);
        project.connectionState = mapSyncthingProjectConnectionState({
          project,
          workspaceId: cfg.workspaceId || project.workspaceId || '',
          workspaceName: project.workspaceName || cfg.workspaceName || project.name || '',
          mirrorDirExists,
          activeForCurrentFolder: activeForCurrentSyncthingFolder,
          snapshot: snapshotForMapper,
        });
        return;
      }
      const cacheKey = syncStateCache.deriveProjectKey(project);
      const syncCacheEntry = cacheKey ? syncStateCache.get(cacheKey) : null;
      const activeTask = cacheKey ? syncTaskTracker.getEntryByCacheKey(cacheKey) : null;
      const hasMarker = project.path
        ? await hasIncompleteMarker(project.path).catch(() => false)
        : false;
      const syncBackend = 'filesync';
      const desktopUpload = project.path
        ? ensureUploadScheduler().getState(project.path)
        : null;
      project.connectionState = mapProjectConnectionState({
        project,
        syncCacheEntry,
        hasIncompleteMarker: hasMarker,
        activeTask,
        syncBackend,
        syncthingFeedAvailable: false,
        mirrorDirExists,
        desktopUpload,
      });
    })
  );
  return { root, workspaceId: cfg.workspaceId || '', cloudError, projects: sorted };
}

async function listLocalProjects(root, cfg, cloudProjectNames = new Set()) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const currentRoot = cfg.workspaceRoot ? path.resolve(cfg.workspaceRoot) : '';
  const currentWorkspaceId = String(cfg.workspaceId || '').trim();
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    if (cloudProjectNames.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    try {
      const stat = await fsp.stat(absolute);
      if (await hasIncompleteMarker(absolute)) continue;
      if (!(await hasUserProjectContent(absolute))) continue;
      // Phase #3 ownership filter + discovery. A local-only dir is
      // attributed by its .kari-engine/workspace.json tag:
      //   - tag matches cfg.workspaceId → include (this activation's
      //     unpublished local work)
      //   - tag exists but ≠ cfg.workspaceId → skip (belongs to a
      //     different activation; multi-activation isolation, see
      //     "看不到其他激活码项目" thread)
      //   - tag MISSING → this is the "adopt-orphan affordance": surface
      //     it as a `discovered` local-only card so the user can click
      //     Upload. Upload calls importLocalProject, which writes the
      //     tag + enqueues the import. We deliberately DON'T backfill a
      //     tag here (that stays cloud-confirmed-only, see the backfill
      //     in listProjects) — an untagged orphan is indistinguishable
      //     on disk from a different activation's leftover until the
      //     user explicitly claims it by uploading.
      const ownership = await readWorkspaceOwnershipTag(absolute);
      let discovered = false;
      if (!currentWorkspaceId) {
        // Pre-activation: cfg.workspaceId is empty, so there's no
        // "current activation" to attribute against. Show everything;
        // the filter only applies once an activation is bound.
      } else if (!ownership) {
        // Fail closed. readWorkspaceOwnershipTag returns null for BOTH
        // "no tag file" and "tag file present but unreadable/malformed".
        // Only the former is a true orphan we can surface as discovered;
        // the latter could be another activation's leftover whose tag
        // merely failed to parse, so it MUST stay hidden (isolation).
        const tagPath = path.join(absolute, '.kari-engine', 'workspace.json');
        const tagFileExists = await fsp.stat(tagPath).then(() => true).catch(() => false);
        if (tagFileExists) {
          console.warn('[listProjects] hiding dir with unreadable ownership tag:', entry.name);
          continue;
        }
        // The user explicitly dismissed this discovered orphan — keep it
        // hidden (the dir is untouched on disk; deleting the marker
        // un-dismisses it).
        if (await hasDiscoveryIgnoredMarker(absolute)) continue;
        discovered = true;
      } else if (ownership.workspaceId !== currentWorkspaceId) {
        continue;
      }
      projects.push({
        name: entry.name,
        path: absolute,
        workspaceName: entry.name,
        remoteWorkdir: cfg.workspaceId ? `${cfg.workspaceId}/${entry.name}` : entry.name,
        source: 'local',
        existsLocal: true,
        discovered,
        isGit: await isGitDirectory(absolute),
        modifiedAt: stat.mtime.toISOString(),
        current: currentRoot === path.resolve(absolute),
        localBytes: await directoryFileBytes(absolute).catch(() => 0),
        remoteBytes: 0
      });
    } catch {}
  }
  return sortProjects(projects);
}

async function hasUserProjectContent(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => !['.kari', '.kari-engine', '.gitignore', '.stfolder', '.stignore', '.DS_Store'].includes(entry.name))) {
    return true;
  }
  return false;
}

async function listServerProjects(root, cfg) {
  if (!cfg.activated || !cfg.serverAddr || !cfg.workspaceId) return null;
  const result = await fetchServerWorkdirs();
  if (!result || !Array.isArray(result.workdirs)) return null;
  const currentRoot = cfg.workspaceRoot ? path.resolve(cfg.workspaceRoot) : '';
  const seen = new Set();
  const projects = [];
  for (const row of result.workdirs) {
    const workspaceName = cleanWorkspaceName(row && (row.workspace_name || row.workspaceName || row.name));
    if (!workspaceName || seen.has(workspaceName)) continue;
    // Hide snapshot-pipeline staging directories from the project
    // list. trans-server's workspace_dirs registry records every
    // workspace_name the daemon binds to — including the transient
    // upload-<uuid>(-<date>) names B5/B6c staging binds use. Before
    // the C-2 materialize lands and renames them onto the canonical
    // workspace dir, those upload-* rows briefly surface in
    // /api/workdirs and the UI shows a UUID-looking card next to the
    // real project. The basename pattern is stable (set in
    // upload_snapshot_pipeline.cjs:157 as `upload-${stagingId}`),
    // so a simple prefix filter is enough. Download-staging follows
    // the same shape if it ever surfaces here; cover both.
    if (workspaceName.startsWith('upload-') || workspaceName.startsWith('download-')) {
      continue;
    }
    seen.add(workspaceName);
    const mirrorPath = mirrorPathForWorkspaceName(root, workspaceName);
    const stat = await fsp.stat(mirrorPath).catch(() => null);
    // Round-1 review fix #2: existsLocal must require BOTH dir-exists
    // AND no .kari-download-incomplete marker. Dir-only check is
    // unsafe — a leftover empty/partial mirror would silently flip
    // existsLocal=true and elide the openProject guard. The marker
    // is written by downloadProject at mkdir time and only removed
    // after daemonSnapshot confirms the sync has completed (either
    // transfer rows have drained OR daemon's last_sync_at advanced).
    const dirExists = Boolean(stat && stat.isDirectory());
    const marked = dirExists ? await hasIncompleteMarker(mirrorPath) : false;
    const hasContent = dirExists ? await hasUserProjectContent(mirrorPath) : false;
    const downloadComplete = dirExists ? await hasDownloadCompleteMarker(mirrorPath) : false;
    const existsLocal = dirExists && !marked && (hasContent || downloadComplete);
    // Syncthing-native Phase 1: surface the server-side per-workspace
    // sync_backend tag so the ProjectConnectionState mapper can route
    // syncthing-backed workspaces to fail-visible instead of through
    // the filesync mapper (codex round 3 P2 pin). Default to filesync
    // when the field isn't present (older servers, mid-migration).
    const rawSyncBackend = String(row.sync_backend || row.syncBackend || '').toLowerCase();
    const syncBackend = rawSyncBackend === 'syncthing' ? 'syncthing' : 'filesync';
    projects.push({
      name: workspaceName,
      path: mirrorPath,
      workspaceName,
      remoteWorkdir: String(row.remote_workdir || row.remoteWorkdir || `${cfg.workspaceId}/${workspaceName}`),
      source: 'cloud',
      existsLocal,
      isGit: existsLocal ? await isGitDirectory(mirrorPath) : false,
      modifiedAt: projectModifiedAt(row, stat),
      current: currentRoot === path.resolve(mirrorPath) || (!currentRoot && cfg.workspaceName === workspaceName),
      localPath: existsLocal ? mirrorPath : '',
      repoUrl: String(row.repo_url || row.repoURL || ''),
      remoteBytes: Number(row.bytes_used || row.bytesUsed || 0),
      localBytes: existsLocal ? await directoryFileBytes(mirrorPath).catch(() => 0) : 0,
      syncBackend,
    });
  }
  return sortProjects(projects);
}

async function currentProjectItem(projectsRoot, cfg, cloudProjectNames = new Set()) {
  const absolute = cfg.workspaceRoot ? path.resolve(cfg.workspaceRoot) : '';
  if (!absolute) return null;
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat || !stat.isDirectory()) return null;
  if (await hasIncompleteMarker(absolute)) return null;
  const workspaceName = cleanWorkspaceName(cfg.workspaceName || path.basename(absolute)) || 'workspace';
  const insideProjectsRoot = targetInsideSource(projectsRoot, absolute);
  if (insideProjectsRoot && !(await hasUserProjectContent(absolute))) return null;
  if (cloudProjectNames.has(workspaceName) && insideProjectsRoot) return null;
  return {
    name: workspaceName,
    path: absolute,
    workspaceName,
    remoteWorkdir: cfg.workspaceId ? `${cfg.workspaceId}/${workspaceName}` : workspaceName,
    source: 'local',
    existsLocal: true,
    isGit: await isGitDirectory(absolute),
    modifiedAt: stat.mtime.toISOString(),
    current: true,
    repoUrl: await repoURLForWorkspace(absolute).catch(() => '')
  };
}

function uniqueProjects(projects) {
  const byKey = new Map();
  for (const project of projects) {
    if (!project || !project.path) continue;
    const key = project.workspaceName || project.name || path.resolve(project.path);
    const prev = byKey.get(key);
    if (!prev || project.current || (!prev.existsLocal && project.existsLocal)) {
      byKey.set(key, project);
    }
  }
  return [...byKey.values()];
}

function mergeCloudProjects(cloudProjects, localProjects) {
  const localByName = new Map();
  for (const project of localProjects) {
    if (!project || !project.path) continue;
    const key = project.workspaceName || project.name;
    if (!key) continue;
    const prev = localByName.get(key);
    if (!prev || project.current || (!prev.existsLocal && project.existsLocal)) {
      localByName.set(key, project);
    }
  }
  const used = new Set();
  const merged = cloudProjects.map((project) => {
    const key = project.workspaceName || project.name;
    const local = key ? localByName.get(key) : null;
    if (key) used.add(key);
    if (!local) return project;
    const cloudExistsLocal = Boolean(project.existsLocal);
    return {
      ...project,
      localPath: cloudExistsLocal ? project.localPath || (local.existsLocal ? local.path : '') : '',
      existsLocal: cloudExistsLocal,
      isGit: cloudExistsLocal ? Boolean(project.isGit || local.isGit) : Boolean(project.isGit),
      current: cloudExistsLocal ? Boolean(project.current || local.current) : false,
      modifiedAt: project.modifiedAt && project.modifiedAt !== new Date(0).toISOString() ? project.modifiedAt : local.modifiedAt
    };
  });
  for (const project of localProjects) {
    const key = project.workspaceName || project.name;
    if (key && used.has(key)) continue;
    merged.push(project);
  }
  return uniqueProjects(merged);
}

function sortProjects(projects) {
  return [...projects].sort((a, b) => Number(b.current) - Number(a.current) || b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
}

function projectModifiedAt(row, stat) {
  if (stat && stat.mtime) return stat.mtime.toISOString();
  const ts = Number(row && (row.last_seen_at || row.lastSeenAt || row.created_at || row.createdAt)) || 0;
  if (ts > 0) return new Date(ts * 1000).toISOString();
  return new Date(0).toISOString();
}

// Phase 4.6: ensureMirrorSyncBound + bindProjectIfPossible deleted —
// they were thin wrappers around bindAndStartDaemon for the legacy
// filesync flow. Syncthing pair-info now owns workspace binding.

async function openProject(projectPath, projectMeta = null) {
  // Syncthing-native Phase 1c2: revalidate openable claims from IPC.
  // The renderer may pass a projectMeta whose connectionState says
  // openable=true even though the local mirror has since been
  // removed off-process. Guards in project_guards.cjs are pure and
  // trust the input; without this stat check, isCloudOnlyNotDownloaded
  // would return false and openProject would mkdir an empty mirror,
  // re-creating the very bug listProjects was designed to detect.
  // Codex round 7 P2 pin.
  if (projectMeta && projectMeta.connectionState && projectMeta.connectionState.openable === true) {
    const checkPath = projectMeta.connectionState.localPath || projectMeta.localPath || projectPath;
    if (checkPath) {
      const stat = await fsp.stat(checkPath).catch(() => null);
      const dirOk = Boolean(stat && stat.isDirectory());
      if (!dirOk) {
        // Strip the stale connectionState so the guards fall back to
        // existsLocal-based logic for THIS call. listProjects will
        // re-derive a fresh connectionState on the next tick.
        projectMeta = { ...projectMeta, connectionState: undefined };
      }
    }
  }
  // PR2 Phase 1 commit 5 round-fix (new product boundary): cloud-only
  // projects that haven't been downloaded yet CANNOT be opened.
  // Desktop is not an IDE — there's no point dropping the user into a
  // Files view over an empty mirror dir. The guard MUST fire before
  // any path resolution that could mkdir the mirror; otherwise an
  // empty leftover would flip existsLocal=true on the next
  // listProjects and silently elide the guard for subsequent clicks.
  //
  // Predicate + response shape live in project_guards.cjs so the
  // pure logic can be tested without dragging Electron globals.
  if (isCloudDownloadInProgress(projectMeta)) {
    return {
      ok: false,
      code: 'cloud_project_downloading',
      error: '项目正在下载中，完成后才能打开。',
    };
  }
  if (isCloudOnlyNotDownloaded(projectMeta)) {
    return cloudNotDownloadedResponse();
  }
  const cfg = await loadStoredConfig();
  const projectsRoot = defaultProjectsRoot(cfg);
  // Round-2 review fix #2 (defensive): even when isCloudOnlyNotDownloaded
  // returned false, projectMeta may have been null/undefined OR may
  // lack the `source` field needed to decide. Renderer always sets it
  // post-PR2, but the IPC surface accepts callers (older renderers,
  // tests, future tools) that pass `path` alone. Cross-check against
  // the cloud projects list — if the path/name corresponds to a cloud
  // project that hasn't been downloaded, fire the guard. Failure to
  // list (offline / daemon down) falls through to legacy behavior
  // (open whatever the path resolves to) since we can't make a
  // judgment without the cloud truth.
  if (!projectMetaSufficient(projectMeta) && cfg.activated) {
    const cloudProjects = await listServerProjects(projectsRoot, cfg).catch(() => null);
    if (Array.isArray(cloudProjects)) {
      const resolvedPath = path.resolve(projectPath);
      const probeName = cleanWorkspaceName(
        (projectMeta && projectMeta.workspaceName) ||
          (projectMeta && projectMeta.name) ||
          path.basename(resolvedPath)
      );
      const match = cloudProjects.find((cp) => {
        if (samePath(cp.path, resolvedPath) || samePath(cp.localPath, resolvedPath)) return true;
        if (probeName && cleanWorkspaceName(cp.workspaceName) === probeName) return true;
        return false;
      });
      // Marker is the canonical truth (listServerProjects bakes it
      // into existsLocal); the explicit `!== true` mirrors the
      // fail-closed predicate.
      if (match && match.existsLocal !== true) {
        return cloudNotDownloadedResponse();
      }
    }
  }
  const root = await resolveOpenableProjectPath(projectsRoot, projectPath);
  await fsp.mkdir(root, { recursive: true });
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new Error('项目路径不是目录');

  const classification = await classifyOpenProject(projectsRoot, root, projectMeta, cfg);
  const workspaceName = classification.workspaceName || cleanWorkspaceName(path.basename(root)) || 'workspace';
  // PR2 Phase 1 commit 5: derive cache key for this project so we can
  // write phase transitions during the open sequence. The cache
  // injectIntoProjects helper uses the same derivation rules.
  const cacheKey = syncStateCache.deriveProjectKey({
    source: classification.cloudBacked ? 'cloud' : 'local',
    workspaceId: cfg.workspaceId || '',
    workspaceName,
    path: root,
  });
  syncStateCache.setProjectPhase(cacheKey, 'binding');

  // Reviewer rule: workspaceSyncBackend must be re-written per open
  // (not inherited from the previous workspace's cfg). For local-only
  // projects classification.syncBackend is 'filesync' by default,
  // which is also the safe choice — no daemon-side syncthing routing
  // happens if the workspace isn't actually backed by syncthing.
  // Single-tenant OSS: every workspace is syncthing-backed (the only backend),
  // so opening a project never downgrades it to the legacy filesync plane.
  const openSyncBackend = 'syncthing';
  const next = await saveStoredConfig({
    workspaceRoot: root,
    projectsRoot,
    workspaceName,
    workspaceSyncBackend: openSyncBackend,
  });
  // PTY-driven sync follow-up: register a virtual UI-active handle in
  // the tracker so opening the project starts its sync immediately,
  // without waiting for a real PTY. The handle stays registered until
  // openProject fires for a different path or project:closeUi IPC
  // explicitly clears it (e.g., renderer's "back to projects").
  // Pinned PTYs in the previously-active project continue to hold
  // ITS ptyCount above zero so it keeps syncing concurrently.
  void setUiActiveProject(root);
  // {workspaceName, workspaceRoot}. Without a fresh pair, the local
  // syncthing child stays pointed at the previous workspace's path and
  // the just-opened project never sees server changes. Fire pair-info
  // now (cloud-backed only — local-only projects don't have a server
  // peer). Fire-and-forget: pair failures log but don't fail the open.
  const bind = classification.cloudBacked
    ? { ok: true, skipped: true, reason: 'kari-syncd retired; syncthing pair scheduled' }
    : { ok: true, skipped: true, localOnly: true, reason: '本地项目已打开，未上传到云端。' };
  if (classification.cloudBacked) {
    // Codex round-7 P1 fix: saveStoredConfig returns publicConfig()
    // which strips activationCodePlain. Decrypt off the full cached
    // config instead (loadStoredConfig returns the in-memory cache
    // with secrets intact).
    const fullCfg = await loadStoredConfig().catch(() => null);
    const openActivationCode = fullCfg ? decryptActivationCode(fullCfg) : '';
    if (openActivationCode) {
      schedulePairAfterActivation({ cfg: next, activationCode: openActivationCode });
      void ensureDaemonControlSessionForStoredConfig('openProject', { force: true });
    } else {
      console.warn('[syncthing-pair] openProject skipped pair: no activation code in stored config');
    }
  }
  // PR2 Phase 1 commit 5 Medium-fix-anchor (round-1 review of orig
  // PR2 plan): bind failure MUST flow into ProjectItem.sync, not just
  // a top-level notice. Cache the failed phase here so the next
  // projects:list refresh picks it up; renderer reload survives.
  if (bind && !bind.ok) {
    syncStateCache.setProjectPhase(cacheKey, 'failed', {
      status: '绑定失败',
      error: String(bind.error || bind.reason || 'bind failed'),
    });
  } else if (bind && bind.skipped && !classification.cloudBacked) {
    // Local-only project: leave at idle (no auto-sync expected).
    syncStateCache.setProjectPhase(cacheKey, 'idle', {
      status: bind.reason || '',
    });
  }

  // Background sync for already-downloaded cloud projects. The
  // pre-rewrite eager `setProjectPhase('synced')` on sync-once-ok
  // is GONE — synced is now decided by sync_task_tracker once the
  // daemon reports succeeded. The Files view loads regardless of
  // task outcome; the card chip reflects progress live.
  //
  // CRITICAL DATA-SAFETY GATE: syncthing-backed workspaces MUST NOT
  // auto-fire direction='both' on open. The daemon treats that as a
  // bidirectional sync against a peer with a possibly-stale version
  // vector, and we have a confirmed user report of local source
  // files being deleted (recoverable only via `git checkout`) when
  // the peer's "absence" of files got mis-applied as `apply delete`
  // events locally (daemon log: many `sync recv: apply delete ...`
  // lines coinciding with the data loss). Phase 2 will replace this
  // with the syncthing event feed; until then, the user triggers
  // sync explicitly via the sync button — auto-sync on open is the
  // dangerous path. DO NOT re-enable this branch for syncthing
  // without coordination with the daemon team on folder mode
  // (sendreceive vs receiveonly) and version-vector handshake.
  let sync = { ok: false, skipped: true, reason: bind && bind.reason ? bind.reason : '项目未绑定云端同步。' };
  if (
    classification.cloudBacked &&
    bind &&
    bind.ok &&
    classification.syncBackend !== 'syncthing'
  ) {
    const taskResult = await postSyncTask({
      direction: 'both',
      initiator: 'open',
      cacheKey,
      workspaceName,
      // openProject background sync touches an already-downloaded
      // mirror dir; no marker is involved.
      markerPath: null,
    });
    if (taskResult.ok) {
      sync = { ok: true, taskId: taskResult.taskId };
    } else if (taskResult.code === 'daemon_too_old') {
      // Old daemon: still let user enter Files (read-only browse).
      // Card chip stays idle/synced from cache; no live progress.
      sync = { ok: false, skipped: true, code: 'daemon_too_old', reason: '已打开项目；当前 daemon 不支持后台同步，请升级。' };
    } else {
      sync = { ok: false, code: taskResult.code, error: taskResult.error };
      syncStateCache.setProjectPhase(cacheKey, 'failed', {
        status: '同步启动失败',
        error: String(taskResult.error || taskResult.code || 'sync_task_failed'),
      });
    }
  } else if (classification.cloudBacked && bind && bind.ok && classification.syncBackend === 'syncthing') {
    // Syncthing path: bind succeeded, mirror is on disk, user can
    // work. We intentionally do NOT POST direction='both' (see the
    // data-safety comment above). Leave the cache phase at 'binding':
    // listProjects maps syncthing rows from scheduler/syncthing state,
    // and clearing this too early creates a visible idle gap while
    // pair-info / PutFolder is still running.
    sync = {
      ok: true,
      skipped: true,
      code: 'syncthing_open_sync_disabled',
      reason: 'syncthing 已绑定；自动双向同步已禁用，请用同步按钮显式触发上传/下载。',
    };
  }
  const tree = await scanWorkspace(root);
  return { ok: true, path: root, tree, config: next, bind, sync };
}

// downloadProject is the ONLY action that may create a local mirror
// directory for a cloud-only project. openProject refuses to mkdir
// for not-yet-downloaded cloud projects; this function is the
// explicit dual: user-confirmed, task-tracked, refresh-on-completion.
//
// Behaviour:
//   1. Validate projectMeta is a cloud project; reject otherwise.
//   2. Cache phase=downloading at entry.
//   3. Resolve mirror dir, mkdir it, write the .kari-engine/desktop-
//      download-incomplete marker so listProjects reports
//      existsLocal=false until completion.
//   4. Save Desktop config (workspaceRoot / workspaceName).
//   5. Bind daemon to the workspace.
//   6. POST /v1/sync-tasks direction=download and register the
//      returned task_id with sync_task_tracker (markerPath=<mirror>/.kari-engine/desktop-download-incomplete).
//   7. Cache phase stays 'downloading' until pollSyncTasks sees the
//      task reach succeeded — at which point the marker is removed
//      and phase becomes 'synced'. Failure / cancel leave the marker
//      in place so the user can retry or abandon.
//
// Does NOT auto-open the project after success — the user must
// click the now-local card again to enter Files (matches the product
// boundary "first-download / verification must complete before open").

function projectDisplayName(project) {
  return String(project && (project.workspaceName || project.name) || '').trim();
}

function confirmationMatchesProject(project, confirmName) {
  const expected = projectDisplayName(project);
  return expected && String(confirmName || '') === expected;
}

async function deleteLocalProject(projectMeta = null, confirmName = '') {
  const cfg = await loadStoredConfig();
  const projectsRoot = defaultProjectsRoot(cfg);
  const name = projectDisplayName(projectMeta);
  if (!confirmationMatchesProject(projectMeta, confirmName)) {
    return { ok: false, code: 'confirmation_mismatch', error: 'confirm_name must exactly match project name' };
  }
  const rawPath = String(projectMeta && (projectMeta.localPath || projectMeta.path) || '');
  if (!rawPath) return { ok: false, code: 'missing_path', error: 'project local path missing' };
  const absolute = path.resolve(rawPath);
  if (!targetInsideSource(projectsRoot, absolute)) {
    return { ok: false, code: 'outside_storage', error: 'project path is outside Kari storage' };
  }
  // Phase 0 (syncthing migration): no snapshot sessions to gate on.
  // Syncthing's folder reconciler tolerates the directory disappearing —
  // a subsequent rescan emits an error event for the missing path, which
  // Phase 2 surfaces in the UI.
  const daemonStop = await stopDaemonIfBoundToProject(absolute, 'delete local project');
  if (!daemonStop.ok) {
    return daemonStop;
  }
  const bytesDeleted = await directoryFileBytes(absolute).catch(() => 0);
  // PTY-driven sync (T6) cleanup: tear down the syncthing folder for
  // this project BEFORE rm'ing the directory. Without this the folder
  // is still in syncthing-home's config pointing at a now-missing
  // path, the next scan tick reports `path missing`, and the entry
  // sticks around until sweepKariFoldersOnBoot at next launch — which
  // also means a re-create of a same-named project re-binds to the
  // stale entry instead of getting a clean one.
  //
  // Order: clear PTY handles + virtual handles first (so tracker
  // emits pty:project:retire which the scheduler observes), THEN call
  // the scheduler's onRetire directly as a belt-and-braces in case
  // the project wasn't tracked at all (manual delete of an idle
  // project that nobody opened this session). Both paths are
  // idempotent — no-ops cancel cleanly.
  try {
    if (currentUiActiveProjectAbsPath === absolute) {
      currentUiActiveProjectAbsPath = null;
    }
    if (ptyProjectTracker) {
      ptyProjectTracker.unregisterPty(UI_ACTIVE_HANDLE_PREFIX + absolute);
      ptyProjectTracker.unregisterPty(IMPORT_SYNC_HANDLE_PREFIX + absolute);
      const timer = importSyncHoldTimers.get(absolute);
      if (timer) {
        clearTimeout(timer);
        importSyncHoldTimers.delete(absolute);
      }
      // clearForProject emits pty:project:retire — scheduler picks
      // up the event and calls pairWorker.retire, which deletes the
      // local syncthing folder via the REST API.
      ptyProjectTracker.clearForProject(absolute);
    }
    if (syncSchedulerSingleton && typeof syncSchedulerSingleton._onRetire === 'function') {
      // Direct call covers the "project was never tracked" path: a
      // project the user only ever browsed in the welcome page, never
      // opened, never PTY'd. clearForProject above would no-op, but
      // the syncthing folder could still exist from a prior session
      // / legacy filesync migration. _onRetire is a no-op when
      // active[projectAbsPath] is empty, so this is safe.
      await syncSchedulerSingleton._onRetire(absolute).catch((err) => {
        console.warn('[deleteLocalProject] scheduler retire failed:', err && err.message ? err.message : err);
      });
    }
  } catch (err) {
    // Cleanup failures must NOT block the rm — a stuck syncthing
    // folder is recoverable (sweepKariFoldersOnBoot will eat it), an
    // un-deleted local copy that the user explicitly asked to remove
    // is not.
    console.warn('[deleteLocalProject] sync cleanup non-fatal:', err && err.message ? err.message : err);
  }
  await fsp.rm(absolute, { recursive: true, force: true });
  if (samePath(cfg.workspaceRoot, absolute)) {
    await saveStoredConfig({
      workspaceRoot: '',
      workspaceName: 'workspace',
      workspaceSyncBackend: 'filesync',
    });
  }
  syncStateCache.clear(syncStateCache.deriveProjectKey({
    path: absolute,
    source: projectMeta && projectMeta.source,
    workspaceId: cfg.workspaceId,
    workspaceName: name,
  }));
  return { ok: true, workspaceName: name, path: absolute, bytesDeleted };
}

async function stopDaemonIfBoundToProject(projectPath, reason) {
  const absolute = path.resolve(String(projectPath || ''));
  const status = await getDaemon('/v1/status', 1200);
  if (!status.ok) {
    return { ok: true, stoppedDaemon: false, reason: 'daemon_offline' };
  }
  const boundRoot = status.data && status.data.workspace_root
    ? path.resolve(String(status.data.workspace_root))
    : '';
  if (!boundRoot || !samePath(boundRoot, absolute)) {
    return { ok: true, stoppedDaemon: false };
  }
  const stopped = await shutdownDaemonOnPort(reason || 'delete local project');
  if (!stopped) {
    return {
      ok: false,
      code: 'daemon_stop_failed',
      error: 'daemon is still bound to this project; refusing to delete local copy to avoid syncing an empty tree to the cloud',
    };
  }
  daemonSyncTaskSupported = null;
  return { ok: true, stoppedDaemon: true };
}

async function deleteCloudProject(projectMeta = null, confirmName = '') {
  const cfg = await loadStoredConfig();
  const activationCode = decryptActivationCode(cfg);
  const name = projectDisplayName(projectMeta);
  if (!confirmationMatchesProject(projectMeta, confirmName)) {
    return { ok: false, code: 'confirmation_mismatch', error: 'confirm_name must exactly match project name' };
  }
  if (!cfg.serverAddr || !activationCode) {
    return { ok: false, code: 'no_server_config', error: 'missing serverAddr or activation code' };
  }
  const response = await fetch(`${kariServerBaseUrl(cfg.serverAddr)}/api/workdirs/delete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${activationCode}`
    },
    body: JSON.stringify({ workspace_name: name, confirm_name: confirmName })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      code: String(body.code || body.error || `http_${response.status}`),
      error: String(body.error || body.message || response.statusText || 'delete cloud project failed'),
      body
    };
  }
  const localPath = String(projectMeta && (projectMeta.localPath || projectMeta.path) || '');
  if (localPath) {
    syncStateCache.clear(syncStateCache.deriveProjectKey({
      path: localPath,
      source: 'cloud',
      workspaceId: cfg.workspaceId,
      workspaceName: name,
    }));
  }
  return { ok: true, workspaceName: name, body };
}

// B7 — snapshot download pipeline branch for syncthing-backed
// workspaces. Wraps download_snapshot_pipeline.prepareDownloadSnapshot
// + B5 staging bind + sync-task post into one user-facing flow that
// mirrors the legacy downloadProject's return shape so the renderer
// doesn't need a branch.
//
// Lifecycle (closed by tracker integration in applySyncTaskSideEffects):
//   prepare → bind→staging → sync-task → [daemon transfers] →
//   tracker-succeeded → promoteDownloadSnapshot (verify+atomic-rename) →
//   removeIncompleteMarker + writeDownloadCompleteMarker → cache='synced' →
//   session 'done'
//
// What's deferred (matches B6 deferrals):
//   - /v1/sync-verify polling between succeeded and promote (Phase C
//     daemon work). Today: trust daemon-succeeded as the verify-and-
//     promote trigger.
//   - Explicit-confirm UI when manifest unavailable (today: auto-promote
//     with verifyStrength='transport-only' — same UX semantic as legacy
//     filesync download).
//   - Re-bind to user-visible workspace after promote (syncthing-backed
//     deliberately stays unbound per plan Round 2 P1 #4; Phase D
//     protected-both is the path that re-enables background sync).
async function downloadProjectViaSnapshot() { return { ok: false, code: 'sync_disabled', error: 'syncthing migration in progress (Phase 0)' }; }
async function downloadProject() { return { ok: false, code: 'sync_disabled', error: '下载暂未接入新的同步通道（syncthing 接入中）。' }; }
async function ensureProjectsRoot(projectsRoot) {
  const root = path.resolve(projectsRoot);
  if (path.basename(root) === KARI_CONTAINER_DIR) {
    const legacyVisibleRoot = path.join(path.dirname(root), 'Kari Drive');
    const rootExists = fs.existsSync(root);
    if (!rootExists && fs.existsSync(legacyVisibleRoot)) {
      // Try to move legacy visible "Kari Drive/" into the new hidden
      // ".kari-drive/" name. Same-FS: atomic rename. Cross-FS: EXDEV
      // → catch creates an empty new dir, but we MUST log so an
      // operator debugging missing-projects can find the legacy
      // contents still sitting at legacyVisibleRoot. Silent catch
      // was hiding cross-volume data loss.
      try {
        await fsp.rename(legacyVisibleRoot, root);
      } catch (err) {
        console.warn(
          '[kari storage] legacy "Kari Drive" → ".kari-drive" rename failed; legacy data remains at',
          legacyVisibleRoot,
          '— error:',
          err && err.message ? err.message : err
        );
        await fsp.mkdir(root, { recursive: true });
      }
    } else if (rootExists && fs.existsSync(legacyVisibleRoot)) {
      // Both exist (e.g. earlier migration crashed after partial
      // copy). New is authoritative; the visible legacy is orphaned
      // but we don't auto-delete — operator might want to manually
      // verify contents first.
      console.warn(
        '[kari storage] both new ".kari-drive" and legacy "Kari Drive" exist at',
        path.dirname(root),
        '— using new; legacy remains untouched for manual cleanup.'
      );
    }
  }
  await fsp.mkdir(root, { recursive: true });
  await hideStorageContainer(root);
  return root;
}

async function hideStorageContainer(_projectsRoot) {
  // No-op: the storage container is intentionally VISIBLE now (see
  // KARI_CONTAINER_DIR). Kept as a stub so call sites stay unchanged.
}

async function directoryFileBytes(root) {
  try {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  let total = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(child).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  }
  await walk(root);
  return total;
}

async function directorySyncthingSyncableFileBytes(root, cfg, workspaceName) {
  const name = cleanWorkspaceName(workspaceName || (cfg && cfg.workspaceName) || path.basename(root)) || 'workspace';
  const identity = cfg && cfg.serverAddr && cfg.workspaceId && name
    ? { serverAddr: cfg.serverAddr, workspaceId: cfg.workspaceId, workspaceName: name }
    : null;
  const mode = identity
    ? await getEffectiveSyncMode(identity).catch(() => 'lightweight')
    : 'lightweight';
  const includeOverrides = identity
    ? await getIncludeSetForProject(identity).catch(() => new Set())
    : new Set();
  const matcher = await buildIgnoreMatcher({
    projectRoot: root,
    mode,
    includeOverrides,
  });
  return projectSize.directorySyncableFileBytes({ root, ignoreMatcher: matcher });
}

async function countProjectDirs(root) {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

async function storageSummary() {
  const cfg = await loadStoredConfig();
  const projectsRoot = defaultProjectsRoot(cfg);
  const storageBaseDir = cfg && cfg.storageBaseDir
    ? path.resolve(String(cfg.storageBaseDir))
    : app.getPath('userData');
  let bytesUsed = 0;
  let projectCount = 0;
  let error = '';
  try {
    bytesUsed = await directoryFileBytes(projectsRoot);
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      error = String(err && err.message ? err.message : err);
    }
  }
  try {
    projectCount = await countProjectDirs(projectsRoot);
  } catch (err) {
    if (!error) error = String(err && err.message ? err.message : err);
  }
  return {
    storageBaseDir,
    projectsRoot,
    bytesUsed,
    projectCount,
    ...(error ? { error } : {}),
  };
}

async function dirExistsNonEmpty(dir) {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return true;
    const entries = await fsp.readdir(dir);
    return entries.length > 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

// Thin wrapper: resolve against the current config's default projects root.
// The base-explicit core + the throwing resolver live in project_rel_path.cjs
// so they are unit-testable without booting Electron.
function projectRelPathFromRoot(cfg, projectRoot) {
  return projectRelPathFromRootBase(defaultProjectsRoot(cfg), projectRoot);
}

async function waitForQueuedProjectUpload(importResult, stage = {}) {
  const projectRoot = importResult && importResult.path ? path.resolve(importResult.path) : '';
  if (!projectRoot) return;
  const cfg = await loadStoredConfig();
  let uploadMarked = false;
  async function markUploadStarted() {
    if (uploadMarked) return;
    uploadMarked = true;
    if (stage && typeof stage.markUploading === 'function') {
      await stage.markUploading();
    }
  }
  if (!isSyncthingBackend(cfg)) {
    await markUploadStarted();
    await postDaemon('/v1/sync-once', {}, 5000).catch(() => null);
    return;
  }
  // Resolve the project against the JOB'S OWN base (importResult.projectsRoot),
  // not the global config — parallel jobs from different bases must stay
  // independent. Fall back to the config default only when the job carries no
  // base.
  const jobProjectsRoot = importResult && importResult.projectsRoot
    ? path.resolve(String(importResult.projectsRoot))
    : defaultProjectsRoot(cfg);
  // FATAL on an unresolved rel-path, never a silent success: a project not
  // under its kari-drive base can never have its sync confirmed. The old
  // `if (!projectRelPath) return;` marked the job succeeded without any proof.
  const projectRelPath = resolveJobRelPathOrThrow(jobProjectsRoot, projectRoot);
  if (ENABLE_PTY_DRIVEN_SYNC) {
    ensurePtyDrivenSync();
    if (syncSchedulerSingleton && typeof syncSchedulerSingleton._onActive === 'function') {
      await syncSchedulerSingleton._onActive(projectRoot).catch((err) => {
        console.warn('[project-import-queue] scheduler activate failed:', err && err.message ? err.message : err);
      });
    }
  }

  const startedAt = Date.now();
  const timeoutMs = Number(process.env.KARI_IMPORT_QUEUE_UPLOAD_TIMEOUT_MS || 30 * 60 * 1000);
  // Wall-clock grace before a persistent notSharing is declared fatal — covers
  // the transient window right after (re)pairing before the peer accepts.
  // Measured by elapsed time, NOT event/loop count, so dropped events can't
  // defer the failure.
  const notSharingGraceMs = Number(process.env.KARI_IMPORT_QUEUE_NOTSHARING_GRACE_MS || 15000);
  let scanRequested = false;
  let lastState = '';
  let eventCursor = 0;
  let notSharingSince = 0;
  let scanPercent = null;       // latest from FolderScanProgress wake events
  let lastProgressKey = '';     // throttle: only emit on a real change
  while (Date.now() - startedAt < timeoutMs) {
    // Re-read running meta EVERY iteration — a syncthing restart rotates the
    // gui address / api key, and a stale creds would strand both the snapshot
    // and the event wake.
    const meta = syncthingProcess && typeof syncthingProcess.getRunningMeta === 'function'
      ? syncthingProcess.getRunningMeta()
      : null;
    const snapshot = await loadSyncthingProjectSnapshot({ cfg, meta, projectRelPath }).catch((err) => ({
      ok: false,
      code: 'snapshot_threw',
      error: String(err && err.message || err),
    }));
    lastState = queuedUploadSnapshotState(snapshot);
    if (snapshot && snapshot.ok && snapshot.folder) {
      await markUploadStarted();
      if (!scanRequested) {
        scanRequested = true;
        const creds = { guiAddress: meta.guiAddress, apiKey: meta.apiKey };
        await syncthingClientModule.scanFolder(creds, snapshot.folderId).catch((err) => {
          console.warn('[project-import-queue] syncthing scan failed:', err && err.message ? err.message : err);
        });
      }
    }
    // Emit live progress (throttled): scan% during scanning, completion%
    // during transfer. Best-effort — never affects the success decision.
    if (stage && typeof stage.onProgress === 'function' && snapshot && snapshot.ok) {
      const phase = snapshot.dbStatus ? String(snapshot.dbStatus.state || '') : '';
      const pct = snapshot.completion ? Number(snapshot.completion.completion) : NaN;
      const progress = {
        phase: phase === 'scanning' ? 'scanning' : (Number.isFinite(pct) && pct >= 100 ? 'idle' : 'syncing'),
        scanPercent: phase === 'scanning' ? scanPercent : null,
        completion: Number.isFinite(pct) ? pct : null,
        needBytes: snapshot.completion ? Number(snapshot.completion.needBytes || 0) : 0,
        needItems: snapshot.completion ? Number(snapshot.completion.needItems || 0) : 0,
        state: phase,
      };
      const key = `${progress.phase}:${progress.completion}:${progress.scanPercent}`;
      if (key !== lastProgressKey) {
        lastProgressKey = key;
        stage.onProgress(progress);
      }
    }
    // SUCCESS comes only from the snapshot, never from an event.
    if (queuedUploadSnapshotComplete(snapshot)) return;
    // Fast-fail on a PERSISTENT notSharing (peer never accepted the folder).
    if (queuedUploadSnapshotFatal(snapshot) === 'peer_not_sharing_folder') {
      if (!notSharingSince) notSharingSince = Date.now();
      else if (Date.now() - notSharingSince >= notSharingGraceMs) {
        throw new Error('queued import failed: peer_not_sharing_folder (' + lastState + ')');
      }
    } else {
      notSharingSince = 0;
    }
    // Wait for a relevant event (≤5s) instead of a fixed sleep; the timeout is
    // also the periodic re-snapshot fallback. Fresh creds from this iteration.
    const wakeCreds = meta && meta.guiAddress && meta.apiKey
      ? { guiAddress: meta.guiAddress, apiKey: meta.apiKey }
      : null;
    if (wakeCreds) {
      const wake = await waitForSyncthingQueueWake({ creds: wakeCreds, since: eventCursor, timeoutSec: 5 });
      if (wake.lastEventId) eventCursor = wake.lastEventId;
      // Pull the latest scan progress for this folder out of the wake batch
      // (db/status carries no scan bytes — only FolderScanProgress does).
      const folderId = snapshot && snapshot.folderId ? String(snapshot.folderId) : '';
      for (const e of wake.events) {
        if (e && e.type === 'FolderScanProgress' && e.data && String(e.data.folder) === folderId) {
          const total = Number(e.data.total || 0);
          const current = Number(e.data.current || 0);
          if (total > 0) scanPercent = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
        }
      }
    } else {
      await sleep(1000);
    }
  }
  throw new Error('queued import upload timed out: ' + lastState);
}

// queuedUploadSnapshot{State,Complete,Fatal} live in queued_upload_snapshot.cjs
// (pure + unit-tested). Imported at the top of this module.

// Events are WAKEUPS ONLY — never the success signal. waitForSyncthingQueueWake
// long-polls /rest/events (filtered to the relevant types) for up to timeoutSec
// and returns the highest event id seen. A ≤5s timeout doubles as the periodic
// fallback so a dropped/empty event stream degrades to polling, never a stall.
const QUEUED_UPLOAD_WAKE_EVENTS = [
  'StateChanged', 'FolderCompletion', 'FolderSummary', 'FolderScanProgress',
  'LocalIndexUpdated', 'RemoteIndexUpdated', 'ItemFinished', 'FolderErrors',
  'PendingFoldersChanged', 'DeviceConnected', 'DeviceDisconnected',
];
async function waitForSyncthingQueueWake({ creds, since, timeoutSec = 5 } = {}) {
  if (!creds) return { ok: false, events: [], lastEventId: Number(since || 0) };
  const r = await syncthingClientModule.getEvents(creds, {
    since: Number(since || 0),
    timeoutSec,
    events: QUEUED_UPLOAD_WAKE_EVENTS,
  }).catch((err) => ({ ok: false, error: String(err && err.message || err) }));
  const events = r && r.ok && Array.isArray(r.body) ? r.body : [];
  const lastEventId = events.reduce((m, e) => Math.max(m, Number(e && e.id || 0)), Number(since || 0));
  return { ok: Boolean(r && r.ok), events, lastEventId };
}

// adoptionRuntimeDeps binds the real Syncthing/FS I/O for the injectable
// findAdoptableIdleSyncthingProject unit (project_import_adoption_runtime.cjs).
function adoptionRuntimeDeps() {
  return {
    isSyncthingBackend,
    getRunningMeta: () => (syncthingProcess && typeof syncthingProcess.getRunningMeta === 'function'
      ? syncthingProcess.getRunningMeta()
      : null),
    getFolders: (creds) => syncthingClientModule.getFolders(creds),
    getDbStatus: (creds, folderId) => syncthingClientModule.getDbStatus(creds, folderId),
    statIsDirectory: async (p) => {
      const s = await fsp.stat(p).catch(() => null);
      return !!(s && s.isDirectory());
    },
    hasUserProjectContent: (p) => hasUserProjectContent(p),
    readWorkspaceOwnershipTag: (p) => readWorkspaceOwnershipTag(p),
  };
}

async function importLocalProject(projectPath, options = {}) {
  console.log('[importLocalProject] CALLED projectPath=', projectPath);
  if (!projectPath) {
    return { ok: false, code: 'missing_path', error: '缺少 projectPath。' };
  }
  const cfg = await loadStoredConfig();
  if (!cfg.activated) {
    return { ok: false, code: 'not_activated', error: '请先激活。' };
  }
  const source = path.resolve(projectPath);
  let stat;
  try {
    stat = await fsp.stat(source);
  } catch (err) {
    return { ok: false, code: 'source_not_found', error: String(err && err.message ? err.message : err) };
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'source_not_directory', error: '选择的路径不是目录。' };
  }

  const projectsRoot = defaultProjectsRoot(cfg);
  await ensureProjectsRoot(projectsRoot);
  const workspaceName = cleanWorkspaceName(path.basename(source)) || 'workspace';
  let target = mirrorPathForWorkspaceName(projectsRoot, workspaceName);
  let adoptedExistingTarget = false;
  let adoptedSyncthingFolder = null;

  // Cross-base adoption: a previous activation may have left an idle, fully
  // synced mirror of this same project under a DIFFERENT <base>/kari-drive/<name>.
  // Adopt it (re-pair under the current workspace id) instead of re-copying.
  // Restricted to kari-drive-shaped, ownership-tagged, idle folders (see
  // project_import_adoption.cjs). Best-effort: any failure falls back to a
  // normal copy.
  let currentFolderId = '';
  try {
    const rel = path.relative(path.resolve(projectsRoot), path.resolve(target)).split(path.sep).join('/');
    currentFolderId = syncthingPair.folderIdFor({ workspaceId: cfg.workspaceId, projectRelPath: rel });
  } catch {}
  const adoptable = currentFolderId
    ? await findAdoptableIdleSyncthingProject({ cfg, workspaceName, currentFolderId, currentTargetPath: target }, adoptionRuntimeDeps())
        .catch((err) => ({ ok: false, code: 'adoption_threw', error: String(err && err.message || err) }))
    : { ok: false, code: 'no_current_folder_id' };
  if (adoptable && adoptable.ok && adoptable.path) {
    target = adoptable.path;
    adoptedExistingTarget = true;
    adoptedSyncthingFolder = adoptable.folder || null;
    console.log('[importLocalProject] adopting idle cross-base kari mirror:', target);
  }

  if (!samePath(source, target)) {
    // Storage Location Boundary guard via pure helper (see
    // upload_helpers.cjs:targetInsideSource for the predicate
    // + tests). Catches "user picks ~/ or /Volumes/D as the import
    // source" cases where Kari storage lives inside the very
    // directory the user is trying to copy from — fs.cp would
    // either fail mid-walk, blow up disk by self-recursion, or
    // copy huge amounts of unrelated data. Fail fast.
    if (targetInsideSource(path.resolve(source), path.resolve(target))) {
      // Source path is shown (user picked it; that's fine) but the
      // internal target path is omitted from the surface — the
      // "Kari 存储" phrasing keeps the user-visible vocabulary
      // aligned with Settings UI without leaking .kari-drive.
      return {
        ok: false,
        code: 'import_target_inside_source',
        error:
          '不能从「' +
          source +
          '」导入：Kari 存储在它的内部。请选择具体的项目目录，而不是它的上级。',
        sourcePath: source,
        workspaceName,
      };
    }
    // When findAdoptableIdleSyncthingProject already chose this target, the
    // adoption decision is made — skip the decideExistingImportTarget gate so a
    // tag-less / legacy adopted folder isn't rejected as `import_target_exists`.
    const targetExistsNonEmpty = !adoptedSyncthingFolder && await dirExistsNonEmpty(target);
    if (targetExistsNonEmpty) {
      const ownership = await readWorkspaceOwnershipTag(target);
      const decision = decideExistingImportTarget({
        targetExistsNonEmpty,
        currentWorkspaceId: cfg.workspaceId,
        ownershipWorkspaceId: ownership && ownership.workspaceId,
        resumeExistingCurrentTarget: options && options.resumeExistingCurrentTarget,
      });
      if (decision.action === 'adopt') {
        adoptedExistingTarget = true;
      } else if (decision.action === 'resume') {
        adoptedExistingTarget = true;
      } else {
        // Don't leak the internal `.kari-drive/...` path in the
        // user-facing error string. Renderer surfaces `result.error`
        // verbatim; only `workspaceName` is safe to show.
        return {
          ok: false,
          code: 'import_target_exists',
          error: `Kari 内部已存在同名项目「${workspaceName}」。请改名后重试，或在项目列表里直接打开它。`,
          workspaceName,
        };
      }
    }
    try {
      if (adoptedExistingTarget) {
        console.log('[importLocalProject] adopting hidden existing target for current workspace:', target);
      } else {
        await fsp.mkdir(target, { recursive: true });
        await fsp.cp(source, target, {
          recursive: true,
          dereference: false,
          force: false,
          errorOnExist: false,
        });
      }
    } catch (err) {
      return {
        ok: false,
        code: 'import_failed',
        error: String(err && err.message ? err.message : err),
        targetPath: target,
        workspaceName,
      };
    }
  }

  // Phase #3: workspace-id ownership tag. Multi-activation users
  // re-activate against different workspace_id values (= different
  // tenant accounts / different licenses) and expect the project list
  // to show only the currently-bound activation's projects. Without
  // this marker, listLocalProjects can't tell whether a top-level
  // .kari-drive/<name> dir is "mine (current activation)" or "left
  // over from a prior activation." Write a per-project ownership tag
  // alongside the existing .kari-engine state so subsequent
  // listProjects calls can filter.
  await writeWorkspaceOwnershipTag(target, cfg.workspaceId).catch((err) => {
    console.warn('[import] workspace ownership tag write failed:', err && err.message ? err.message : err);
  });

  const project = {
    name: workspaceName,
    path: target,
    localPath: target,
    workspaceName,
    source: 'local',
    existsLocal: true,
    current: false,
    isGit: await isGitDirectory(target),
  };
  console.log('[importLocalProject] reached pair block, target=', target, 'workspaceName=', workspaceName);
  // Phase 4 follow-up: importing a folder makes it the new active
  // workspace. Save the workspaceRoot/workspaceName + fire the
  // pair-info flow so syncthing's folder.path moves to this new
  // dir. Without this the previously-paired folder.path stays
  // stuck on the prior workspaceRoot and the drag-imported content
  // never reaches the server. Fire-and-forget; pair failures log
  // but don't fail the import.
  let nextCfg = cfg;
  try {
    // For a cross-base adopted folder, also repoint storageBaseDir to the
    // adopted base so the project list scan + the upload-wait's rel-path
    // resolve against the right container. (active-workspace decoupling under
    // parallelism is Phase 5; here we keep the existing workspaceRoot write.)
    const adoptedStorageBaseDir = adoptedSyncthingFolder
      ? storageBaseDirForAdoptedProjectPath(target)
      : '';
    nextCfg = await saveStoredConfig({
      workspaceRoot: target,
      workspaceName,
      workspaceSyncBackend: 'syncthing',
      ...(adoptedStorageBaseDir ? { storageBaseDir: adoptedStorageBaseDir } : {}),
    });
    console.log('[importLocalProject] saveStoredConfig OK, nextCfg workspaceRoot=', nextCfg && nextCfg.workspaceRoot);
  } catch (err) {
    console.warn('[import] saveStoredConfig for new workspaceRoot failed:', err && err.message ? err.message : err);
  }
  try {
    const fullCfg = await loadStoredConfig().catch(() => null);
    const code = fullCfg ? decryptActivationCode(fullCfg) : '';
    console.log('[importLocalProject] pair-trigger fullCfg loaded=', !!fullCfg, 'has activationCode=', !!code, 'cfg has activationCodePlain=', !!(fullCfg && fullCfg.activationCodePlain));
    if (code) {
      console.log('[importLocalProject] firing schedulePairAfterActivation for cfg.workspaceRoot=', nextCfg && nextCfg.workspaceRoot, 'workspaceId=', nextCfg && nextCfg.workspaceId);
      schedulePairAfterActivation({ cfg: nextCfg, activationCode: code });
    } else {
      console.warn('[syncthing-pair] importLocalProject skipped pair: no activation code in stored config');
    }
  } catch (err) {
    console.warn('[syncthing-pair] importLocalProject pair trigger threw:', err && err.message ? err.message : err);
  }
  // PTY-driven sync follow-up: drag-import doesn't open a PTY and
  // doesn't go through openProject, so the scheduler would never fire
  // for this project — the imported files sit in <projectsRoot>/<name>/
  // forever without ever uploading. Register a virtual import-sync
  // handle so the scheduler activates the per-project folder right
  // now, runs pair-info, and starts pushing files up. Auto-unregisters
  // after INITIAL_SYNC_HOLD_MS so it doesn't pin a slot in the LRU
  // forever.
  kickInitialSyncForImport(target);
  return { ok: true, path: target, workspaceName, projectsRoot, project, imported: !samePath(source, target) && !adoptedExistingTarget, adoptedExistingTarget, sourcePath: source, config: nextCfg };
}

// Phase #3: per-project workspace-id ownership marker.
//
// File: <projectRoot>/.kari-engine/workspace.json
// Shape: { "version": 1, "workspaceId": "ws-...", "stampedAt": ISO }
//
// Written by importLocalProject (drag-import + selectWorkspace import
// branch) and by downloadProject's mirror-bind path (so freshly
// downloaded cloud projects also carry the tag). Read by
// listLocalProjects to decide whether a local-only directory belongs
// to the currently-bound activation. A missing tag means "legacy /
// pre-Phase #3 project" — UI treats those as not belonging to any
// activation (= hidden from the list) unless the user explicitly
// adopts them via the Settings → Local-only dirs panel (not in this
// patch).
async function writeWorkspaceOwnershipTag(projectRoot, workspaceId) {
  if (!projectRoot || !workspaceId) return;
  const engineDir = path.join(projectRoot, '.kari-engine');
  await fsp.mkdir(engineDir, { recursive: true });
  const tag = {
    version: 1,
    workspaceId: String(workspaceId),
    stampedAt: new Date().toISOString(),
  };
  const tagPath = path.join(engineDir, 'workspace.json');
  // Atomic write: temp + rename so a crash mid-write doesn't leave a
  // half-baked JSON that would parse-fail in readWorkspaceOwnershipTag.
  // Each write uses a unique tmp suffix because listProjects fires the
  // backfill across all cloud-known dirs via Promise.all (re-entrant
  // calls overlap during HMR / rapid refresh). A shared `${tagPath}.tmp`
  // races: writer A writes tmp, B writes tmp (overwrites), A renames
  // (success), B renames (ENOENT — A took the tmp). Per-call suffix
  // gives each writer its own file.
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = `${tagPath}.${suffix}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(tag, null, 2) + '\n', 'utf8');
  try {
    await fsp.rename(tmp, tagPath);
  } catch (err) {
    // Best-effort cleanup so we don't leave the tmp behind when rename
    // fails (e.g. a parallel write already moved a sibling tmp into
    // place and the FS errored on a now-impossible rename).
    await fsp.unlink(tmp).catch(() => null);
    throw err;
  }
}

// Discovered-orphan dismiss marker.
//
// File: <projectRoot>/.kari-engine/discovery-ignored
//
// An untagged orphan under the active base's kari-drive is surfaced as a
// "discovered" local-only card (see listLocalProjects). The user can
// dismiss it — hide it from the list WITHOUT deleting anything on disk —
// by dropping this marker. listLocalProjects skips a discovered (untagged)
// dir that carries it. Uploading it instead stamps an ownership tag and
// moves it out of the discovered branch, so the marker becomes moot; a
// power user can delete the marker file to un-dismiss.
async function hasDiscoveryIgnoredMarker(projectRoot) {
  if (!projectRoot) return false;
  return fsp
    .stat(path.join(projectRoot, '.kari-engine', 'discovery-ignored'))
    .then(() => true)
    .catch(() => false);
}

// Resolve a renderer-supplied projectPath to a real, in-container directory
// that may carry a dismiss marker — or reject it. assertInsideProjectsRoot is
// a LEXICAL check only (path.relative on resolved strings), so on its own a
// symlinked dir inside kari-drive could pass it and then have files written
// through the link OUTSIDE the container. We canonicalize both root and
// target with realpath and re-check containment on the real paths, and refuse
// a target that is itself a symlink. Returns { ok, target } or { ok:false, code }.
async function resolveDismissibleDir(projectsRoot, projectPath) {
  let lexical;
  try {
    lexical = assertInsideProjectsRoot(projectsRoot, projectPath);
  } catch {
    return { ok: false, code: 'outside_projects_root' };
  }
  let realRoot;
  let lst;
  try {
    realRoot = await fsp.realpath(projectsRoot);
    lst = await fsp.lstat(lexical);
  } catch {
    return { ok: false, code: 'not_found' };
  }
  if (lst.isSymbolicLink()) return { ok: false, code: 'symlink_rejected' };
  if (!lst.isDirectory()) return { ok: false, code: 'not_a_directory' };
  let realTarget;
  try {
    realTarget = await fsp.realpath(lexical);
  } catch {
    return { ok: false, code: 'not_found' };
  }
  const rel = path.relative(realRoot, realTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'outside_projects_root' };
  }
  return { ok: true, target: realTarget };
}

async function dismissDiscoveredProject(projectPath) {
  const cfg = await loadStoredConfig().catch(() => null);
  if (!cfg) return { ok: false, code: 'no_config', error: '未找到配置。' };
  const projectsRoot = defaultProjectsRoot(cfg);
  const resolved = await resolveDismissibleDir(projectsRoot, projectPath);
  if (!resolved.ok) {
    const errors = {
      outside_projects_root: '路径不在项目目录内。',
      not_found: '目录不存在。',
      symlink_rejected: '不支持软链接目录。',
      not_a_directory: '不是目录。',
    };
    return { ok: false, code: resolved.code, error: errors[resolved.code] || '无法忽略该目录。' };
  }
  const target = resolved.target;
  // Don't write through a symlinked .kari-engine or marker either (defense in
  // depth — a planted link inside an otherwise-legit dir could redirect/clobber).
  const engineDir = path.join(target, '.kari-engine');
  const engineLst = await fsp.lstat(engineDir).catch(() => null);
  if (engineLst && engineLst.isSymbolicLink()) {
    return { ok: false, code: 'engine_symlink_rejected', error: '.kari-engine 不是普通目录。' };
  }
  const markerPath = path.join(engineDir, 'discovery-ignored');
  const markerLst = await fsp.lstat(markerPath).catch(() => null);
  if (markerLst && markerLst.isSymbolicLink()) {
    return { ok: false, code: 'marker_symlink_rejected', error: 'marker 异常。' };
  }
  try {
    // Residual TOCTOU: a local attacker could swap `target` for a symlink
    // between the checks above and these writes. Accepted — this is a
    // single-user desktop app and the main process runs as the same OS
    // user who would have to win that race (they already have the user's
    // filesystem access), and Node has no atomic O_NOFOLLOW mkdir.
    await fsp.mkdir(engineDir, { recursive: true });
    await fsp.writeFile(
      markerPath,
      JSON.stringify({ version: 1, ignoredAt: new Date().toISOString() }) + '\n',
      'utf8',
    );
  } catch (err) {
    return { ok: false, code: 'write_failed', error: String(err && err.message ? err.message : err) };
  }
  return { ok: true, path: target };
}

async function readWorkspaceOwnershipTag(projectRoot) {
  if (!projectRoot) return null;
  const tagPath = path.join(projectRoot, '.kari-engine', 'workspace.json');
  try {
    const raw = await fsp.readFile(tagPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.workspaceId === 'string') {
      return { workspaceId: parsed.workspaceId, stampedAt: parsed.stampedAt || '' };
    }
  } catch {}
  return null;
}

async function importAndUploadProject(projectPath) {
  return enqueueProjectImport(projectPath);
}
async function uploadProjectViaSnapshot() { return { ok: false, code: 'sync_disabled', error: 'syncthing migration in progress (Phase 0)' }; }
async function uploadProject() { return { ok: false, code: 'sync_disabled', error: '上传暂未接入新的同步通道（syncthing 接入中）。' }; }
async function classifyOpenProject(projectsRoot, root, projectMeta, cfg) {
  const meta = projectMeta && typeof projectMeta === 'object' ? projectMeta : null;
  const localName = cleanWorkspaceName(meta?.workspaceName || meta?.name || path.basename(root)) || 'workspace';
  const cfgSyncthingForRoot =
    String(cfg && cfg.workspaceSyncBackend || '').toLowerCase() === 'syncthing'
    && cfg.workspaceRoot
    && samePath(cfg.workspaceRoot, root);
  // syncBackend defaults to 'filesync' when unknown so the open-flow
  // bidirectional sync stays enabled for the legacy path. Syncthing-
  // backed workspaces explicitly opt OUT of that auto-sync (see the
  // data-loss gate in openProject) so we MUST identify them here when
  // the signal is available — both directly from projectMeta and via
  // the server's per-workspace sync_backend tag in listServerProjects.
  const metaSyncBackend = String(meta?.syncBackend || '').toLowerCase() === 'syncthing' ? 'syncthing' : '';
  if (meta && meta.source === 'cloud') {
    return {
      cloudBacked: true,
      workspaceName: localName,
      syncBackend: metaSyncBackend || (cfgSyncthingForRoot ? 'syncthing' : 'filesync'),
    };
  }
  const cloudProjects = cfg.activated ? await listServerProjects(projectsRoot, cfg).catch(() => null) : null;
  if (Array.isArray(cloudProjects)) {
    const rootPath = path.resolve(root);
    for (const project of cloudProjects) {
      const cloudName = cleanWorkspaceName(project.workspaceName || project.name || '');
      if (!cloudName) continue;
      if (cloudName === localName || samePath(project.path, rootPath) || samePath(project.localPath, rootPath)) {
        const serverSyncBackend = String(project.syncBackend || '').toLowerCase() === 'syncthing' ? 'syncthing' : 'filesync';
        const syncBackend = serverSyncBackend === 'syncthing' || (cfgSyncthingForRoot && cloudName === cleanWorkspaceName(cfg.workspaceName || ''))
          ? 'syncthing'
          : 'filesync';
        return { cloudBacked: true, workspaceName: cloudName, syncBackend };
      }
    }
  }
  return { cloudBacked: false, workspaceName: localName, syncBackend: 'filesync' };
}

async function resolveOpenableProjectPath(projectsRoot, projectPath) {
  const cfg = await loadStoredConfig();
  if (cfg.workspaceRoot && samePath(cfg.workspaceRoot, projectPath)) {
    return path.resolve(projectPath);
  }
  const existing = await fsp.stat(projectPath).catch(() => null);
  if (existing && existing.isDirectory()) {
    return path.resolve(projectPath);
  }
  try {
    return assertInsideProjectsRoot(projectsRoot, projectPath);
  } catch (err) {
    const cloudProjects = cfg.activated ? await listServerProjects(projectsRoot, cfg).catch(() => null) : null;
    if (cloudProjects && cloudProjects.some((project) => samePath(project.path, projectPath))) {
      return path.resolve(projectPath);
    }
    throw err;
  }
}

async function cloneProject(payload) {
  const cfg = await loadStoredConfig();
  const projectsRoot = defaultProjectsRoot(cfg);
  await ensureProjectsRoot(projectsRoot);
  const gitUrl = String(payload && payload.gitUrl || payload && payload.git_url || '').trim();
  if (!gitUrl) throw new Error('git clone URL 不能为空');
  const name = cleanWorkspaceName(String(payload && payload.name || '').trim()) || deriveProjectNameFromGitURL(gitUrl);
  const target = mirrorPathForWorkspaceName(projectsRoot, name);
  const credentials = extractCredentials(payload);
  let bootstrap;
  try {
    bootstrap = await requestServerClone(gitUrl, name, credentials);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    // Auth-required failure path: the renderer's cloneProject
    // callback shows a username/password dialog and retries with
    // credentials filled in. Do NOT mkdir / saveStoredConfig on
    // this branch — that would leave a stale empty workspace that
    // would later confuse listLocalProjects.
    const failure = err && err.cloneFailure ? err.cloneFailure : { code: 'clone_failed', error: message };
    if (isAuthRequiredCloneFailure(message, failure.bootstrap)) {
      return { ok: false, code: 'auth_required', error: message, gitUrl, workspaceName: name };
    }
    return {
      ok: false,
      code: failure.code || 'clone_failed',
      error: failure.error || message,
      ...(failure.bootstrap ? { bootstrap: failure.bootstrap } : {}),
    };
  }
  const localTarget = await prepareCloneLocalTarget(projectsRoot, target, name);
  if (!localTarget.ok) return localTarget;
  // Reviewer rule (matches openProject + downloadProject): rewrite
  // workspaceSyncBackend per open so a previously-active syncthing
  // workspace doesn't leak its sync_backend into this fresh clone via
  // saveStoredConfig's merge. Git clones are local-only at create
  // time — they're filesync-backed by definition (no server-side
  // workspace_dirs row exists yet to declare otherwise). B11 codex #1
  // surfaced the pre-existing bug: without the explicit reset, the
  // subsequent bindProjectIfPossible() would post sync_backend:'syncthing'
  // to the daemon for a brand-new filesync workspace.
  const next = await saveStoredConfig({
    workspaceRoot: target,
    projectsRoot,
    workspaceName: name,
    workspaceSyncBackend: 'filesync',
  });
  // Phase 4.6: bindProjectIfPossible + /v1/sync-once both retired with
  // kari-syncd. Cloned project sync happens via syncthing pair-info at
  // the next activation.
  const bind = { ok: true, skipped: true, reason: 'kari-syncd retired (syncthing migration)' };
  const tree = await scanWorkspace(target);
  return { ok: true, path: target, tree, config: next, bind, bootstrap, localTarget };
}

// extractCredentials pulls username + password from a clone payload.
// Empty strings are treated as "not provided" so the caller's
// "first try without auth, then prompt" flow doesn't accidentally
// send empty Basic auth.
function extractCredentials(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  if (!username && !password) return null;
  return { username, password };
}

// embedCredentialsInGitURL mirrors the daemon-side pattern in
// cmd/kari-syncd/routes.go (the /v1/bootstrap handler embeds creds
// into the URL using net/url.UserPassword). Doing the same here so
// trans-server's /api/workdirs/clone inherits credentials through
// the URL without needing a separate field in its request body.
//
// Returns the original URL unchanged when the URL is not parseable
// or has no host — the server will fail in a recognizable way which
// keeps the failure surface narrow.
function embedCredentialsInGitURL(rawURL, credentials) {
  if (!credentials || (!credentials.username && !credentials.password)) return rawURL;
  try {
    const parsed = new URL(rawURL);
    if (credentials.username) {
      parsed.username = encodeURIComponent(credentials.username);
    }
    if (credentials.password) {
      parsed.password = encodeURIComponent(credentials.password);
    }
    return parsed.toString();
  } catch {
    return rawURL;
  }
}

async function requestServerClone(gitUrl, workspaceName, credentials) {
  const cfg = await loadStoredConfig();
  const activationCode = decryptActivationCode(cfg);
  if (!cfg.serverAddr || !activationCode) throw new Error('缺少 serverAddr 或 activation code');
  // Embed credentials into the URL before handing it to the server.
  // Matches the daemon's /v1/bootstrap pattern so trans-server's
  // git-clone subprocess sees auth via the URL the same way the
  // workbench would. Server logs are expected to scrub user-info
  // out of the URL on its end.
  const effectiveURL = embedCredentialsInGitURL(gitUrl, credentials);
  const response = await fetch(`${kariServerBaseUrl(cfg.serverAddr)}/api/workdirs/clone`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${activationCode}`
    },
    body: JSON.stringify({
      git_url: effectiveURL,
      workspace_name: workspaceName,
      flatten: true
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw makeServerCloneError(body, response.statusText);
  }
  // 200 OK can still carry an auth-failed bootstrap result. Treat
  // bootstrap.error as the source of truth when present so the
  // renderer's retry path fires on those too.
  const bootstrap = body.bootstrap || { ok: true, status: 'server_clone_submitted' };
  if (bootstrap && bootstrap.error) {
    throw makeServerCloneError({ bootstrap }, bootstrap.error);
  }
  return bootstrap;
}

async function fetchServerWorkdirs() {
  const cfg = await loadStoredConfig();
  const activationCode = decryptActivationCode(cfg);
  if (!cfg.serverAddr || !activationCode) return null;
  const response = await fetch(`${kariServerBaseUrl(cfg.serverAddr)}/api/workdirs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${activationCode}`
    },
    body: JSON.stringify({
      limit: 500
    })
  });
  if (!response.ok) throw new Error(await httpErrorMessage(response));
  return response.json();
}

// PR2 Phase 1 commit 6: trans-server-side self-service upload-intent
// call. Mirrors the fetchServerWorkdirs auth + URL plumbing (activation
// code bearer + serverAddr base). Returns a structured result:
//   - { ok: true, body }          on 200
//   - { ok: false, status, code, body, error } on 4xx (mgmt's structured error)
//   - { ok: false, status, error } on network / 5xx (no structured body)
//   - { ok: false, code: 'server_unavailable', ... } on 404 (server doesn't
//     have the endpoint — pre-PR2 trans-server build)
async function callUploadIntent() { return { ok: false, status: 0, body: { code: 'sync_disabled' } }; }
async function requestCloudBootstrap(gitUrl) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    const res = await postDaemon('/v1/bootstrap', { git_url: gitUrl }, 10000);
    if (res.ok) return { ok: true, data: res.data };
    last = res.error || 'bootstrap failed';
    if (!String(last).includes('no active sync session') && !String(last).includes('not connected')) {
      throw new Error(last);
    }
    await sleep(500);
  }
  throw new Error(last || 'bootstrap failed');
}

function mirrorPathForWorkspaceName(projectsRoot, workspaceName) {
  return assertInsideProjectsRoot(projectsRoot, path.join(projectsRoot, cleanWorkspaceName(workspaceName) || 'workspace'));
}

async function repoURLForWorkspace(root) {
  try {
    return redactURLSecret((await execGit(root, ['config', '--get', 'remote.origin.url'])).trim());
  } catch {
    return '';
  }
}

function redactURLSecret(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

// defaultProjectsRoot DERIVES the projectsRoot from `storageBaseDir`
// (user-chosen via settings) + the locked container name. Priority:
//
//   1. KARI_PROJECTS_ROOT env — explicit override (tests / ops).
//      Returns the resolved path AS-IS even if it doesn't exist yet
//      so the caller's mkdir creates the right place; previous
//      "skip if not existing" behavior silently fell back to other
//      candidates, which made the env override unreliable.
//   2. cfg.storageBaseDir + KARI_CONTAINER_DIR — user-chosen storage
//      location, container appended. NEVER returns just
//      storageBaseDir — that would let projects scatter into the
//      user's chosen folder (violates Storage Location Boundary).
//   3. <userData>/<KARI_CONTAINER_DIR>/ — canonical fallback when
//      no env + no user choice.
//
// REMOVED: cfg.workspaceRoot fallback (would let stale workspaceRoot
// from previous activations pin projectsRoot to an arbitrary
// historical directory) and unconditional cfg.projectsRoot trust
// (let legacy ~/.kariproject persist across the userData migration).
// Both were sources of "doesn't actually converge to the new root"
// drift identified in the prior review.
// clipboardPasteImageDirect reads the system clipboard's image and
// POSTs the raw PNG bytes to ConsoleZ's /api/v1/pty/clipboard-paste
// endpoint, bypassing the legacy desktop→syncthing→server roundtrip
// that the kari CLI sniffer + /v1/pty-attach path required. Returns
// the wire shape the renderer expects from clipboardImageLocalPath
// (so terminalPaste.ts can branch on { has_image, local_path }
// without knowing which transport handled it).
//
// On any non-200 (missing activation, server too old, network down)
// we fall through to the legacy local-temp path so paste degrades
// gracefully instead of dropping the user's image on the floor.
async function clipboardPasteImageDirect() {
  let image;
  try {
    image = clipboard.readImage();
    if (!image || image.isEmpty()) return { has_image: false };
  } catch {
    return { has_image: false };
  }
  const buf = image.toPNG();
  if (!buf || buf.length === 0) return { has_image: false };

  const cfg = await loadStoredConfig().catch(() => null);
  const activationCode = cfg ? decryptActivationCode(cfg) : '';
  const workspaceName = cfg && cfg.workspaceName ? String(cfg.workspaceName) : '';
  const workspaceRoot = cfg && cfg.workspaceRoot ? String(cfg.workspaceRoot) : '';
  const serverAddr = cfg && cfg.serverAddr ? String(cfg.serverAddr) : '';
  const projectsRoot = cfg ? defaultProjectsRoot(cfg) : '';
  let projectRelPath = '';
  if (projectsRoot && workspaceRoot) {
    const rel = path.relative(projectsRoot, workspaceRoot);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      projectRelPath = rel.split(path.sep).join('/');
    }
  }

  // Degrade to legacy local-temp path if we can't satisfy the bypass
  // route's preconditions. The renderer's terminalPaste still gets a
  // valid local_path, so the kari CLI sniffer will upload via the old
  // pty-attach flow — slower but functional.
  if (!serverAddr || !activationCode || !workspaceName || !projectRelPath) {
    return readClipboardImageLocal();
  }

  const url = `${normalizeServerAddrFor(serverAddr)}/api/v1/pty/clipboard-paste`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${activationCode}`,
        'content-type': 'image/png',
        'x-kari-workspace-name': workspaceName,
        'x-kari-project-path': projectRelPath,
        'x-kari-image-ext': 'png',
      },
      body: buf,
    });
  } catch (err) {
    console.warn('[clipboard:pasteImage] fetch failed, falling back to local temp:', err && err.message ? err.message : err);
    return readClipboardImageLocal();
  }
  if (!response.ok) {
    // 404 = old ConsoleZ without the new route. Fall back so paste
    // still works on un-upgraded servers.
    console.warn('[clipboard:pasteImage] server returned', response.status, '— falling back to local temp');
    return readClipboardImageLocal();
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  const remoteAbspath = body && typeof body.remote_abspath === 'string' ? body.remote_abspath : '';
  if (!remoteAbspath) {
    console.warn('[clipboard:pasteImage] server returned no remote_abspath, falling back to local temp');
    return readClipboardImageLocal();
  }
  // Wire shape mirrors readClipboardImageLocal so terminalPaste's
  // clipboardImageLocalPath() extractor finds the path under .local_path
  // without branching on transport.
  return { has_image: true, local_path: remoteAbspath };
}

// normalizeServerAddrFor mirrors syncthing_pair's normalizeServerAddr
// (host:port shape vs scheme-prefixed). Inlined here so this one IPC
// handler doesn't pull the whole syncthing_pair module into its hot
// path.
function normalizeServerAddrFor(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return 'http://' + s;
}

// readClipboardImageLocal reads the system clipboard's image via
// Electron's native API (NativeImage) and dumps it as PNG to a temp
// file under <os.tmpdir()>/kari-clipboard/. Returns the daemon's wire
// shape ({ has_image, local_path }) so the renderer's
// clipboardImageLocalPath helper continues to work unchanged.
//
// Returns { has_image: false } when the clipboard holds no image
// (NativeImage.isEmpty()) or when something else fails — the same
// "no image" semantics the daemon's HTTP path used to surface.
async function readClipboardImageLocal() {
  try {
    const image = clipboard.readImage();
    if (!image || image.isEmpty()) return { has_image: false };
    const buf = image.toPNG();
    if (!buf || buf.length === 0) return { has_image: false };
    const dir = path.join(os.tmpdir(), 'kari-clipboard');
    await fsp.mkdir(dir, { recursive: true });
    const name = `clip-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.png`;
    const dst = path.join(dir, name);
    await fsp.writeFile(dst, buf);
    return { has_image: true, local_path: dst };
  } catch (err) {
    console.warn('[clipboard:image] readClipboardImageLocal failed:', err && err.message ? err.message : err);
    return { has_image: false };
  }
}

function defaultProjectsRoot(cfg) {
  if (process.env.KARI_PROJECTS_ROOT) {
    return path.resolve(String(process.env.KARI_PROJECTS_ROOT));
  }
  const storageBase = cfg && cfg.storageBaseDir
    ? path.resolve(String(cfg.storageBaseDir))
    : app.getPath('userData');
  return path.join(storageBase, KARI_CONTAINER_DIR);
}

// ensureLocalWorkspaceContainer creates <projectsRoot>/<workspaceName>/
// on disk and tags it with the current cfg.workspaceId.
//
// Plan T6 patch: under PTY-driven sync, the legacy "pair on activation
// → server-side mkdir → desktop ls picks it up" path is gated off, so a
// fresh activation still needs a known local container for future
// imports/downloads. Server-side pair-info fires later per concrete
// project when import/open/PTY marks that project active.
//
// Idempotent — mkdir is recursive and writeWorkspaceOwnershipTag is
// safe to re-run on an already-tagged dir.
async function ensureLocalWorkspaceContainer(cfg) {
  if (!cfg || !cfg.workspaceId || !cfg.workspaceName) return null;
  const projectsRoot = defaultProjectsRoot(cfg);
  if (!projectsRoot) return null;
  const cleanName = cleanWorkspaceName(cfg.workspaceName) || 'workspace';
  const target = path.join(projectsRoot, cleanName);
  if (!targetInsideSource(projectsRoot, target)) {
    console.warn('[activation] derived workspace folder is outside projectsRoot:', target);
    return null;
  }
  await fsp.mkdir(target, { recursive: true });
  await writeWorkspaceOwnershipTag(target, cfg.workspaceId).catch((err) => {
    console.warn('[activation] ownership tag write failed for', target, ':', err && err.message ? err.message : err);
  });
  console.log('[activation] ensured local workspace container at', target);
  return target;
}

function containerWorkspacePairKey(cfg, projectRoot) {
  return [
    String(cfg && cfg.serverAddr || '').trim(),
    String(cfg && cfg.workspaceId || '').trim(),
    String(cfg && cfg.workspaceName || '').trim(),
    path.resolve(String(projectRoot || '')),
  ].join('|');
}

async function ensureContainerWorkspacePairForStoredConfig(reason = 'container') {
  if (!ENABLE_PTY_DRIVEN_SYNC) return { ok: false, skipped: 'pty_sync_disabled' };
  if (containerWorkspacePairInFlight) return containerWorkspacePairInFlight;

  containerWorkspacePairInFlight = (async () => {
    try {
      const cfg = await loadStoredConfig().catch(() => null);
      const activationCode = cfg ? decryptActivationCode(cfg) : '';
      if (!cfg || !cfg.serverAddr || !cfg.workspaceId || !cfg.workspaceName || !activationCode) {
        return { ok: false, skipped: 'stored_config_incomplete' };
      }

      ensurePtyDrivenSync();
      if (!ptyProjectTracker) return { ok: false, skipped: 'tracker_unavailable' };

      const projectRoot = await ensureLocalWorkspaceContainer(cfg);
      if (!projectRoot) return { ok: false, skipped: 'local_workspace_unavailable' };
      const key = containerWorkspacePairKey(cfg, projectRoot);
      if (containerWorkspacePairRegisteredKey === key) {
        return { ok: true, skipped: 'already_registered', projectRoot };
      }

      ptyProjectTracker.registerForProject(CONTAINER_WORKSPACE_HANDLE_PREFIX + projectRoot, projectRoot);
      containerWorkspacePairRegisteredKey = key;
      console.log(`[workspace-sync] ${reason}: registered workspace mirror for syncthing pair ${projectRoot}`);
      return { ok: true, projectRoot };
    } catch (err) {
      console.warn(`[workspace-sync] ${reason}: workspace pair trigger failed:`, err && err.message ? err.message : err);
      return { ok: false, error: String(err && err.message || err) };
    }
  })().finally(() => {
    containerWorkspacePairInFlight = null;
  });
  return containerWorkspacePairInFlight;
}

async function terminalProjectRoot(cfg) {
  const workspaceRoot = cfg && typeof cfg.workspaceRoot === 'string' ? cfg.workspaceRoot.trim() : '';
  if (workspaceRoot) {
    const resolved = path.resolve(workspaceRoot);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {}
  }
  console.log('[pty-tracker] remote PTY falling back to derived mirror path for workspace',
    cfg && (cfg.workspaceName || cfg.workspaceId) ? (cfg.workspaceName || cfg.workspaceId) : '');
  return await ensureLocalWorkspaceContainer(cfg);
}

function terminalSyncModeIdentity(cfg) {
  return {
    serverAddr: cfg && cfg.serverAddr || '',
    workspaceId: cfg && cfg.workspaceId || '',
    workspaceName: cfg && cfg.workspaceName || '',
    projectRelPath: cleanWorkspaceName(cfg && cfg.workspaceName) || 'workspace',
  };
}

// archiveStaleProjectDirsOnWorkspaceChange moves any top-level project
// dirs in the projects root into <root>/.archive/<prevWorkspaceId>-<ts>/
// when the workspaceId is changing between activations. Brand-new
// activation = brand-new workspace from mgmt's perspective; the
// welcome page should not show local-only project cards from prior
// activations against a different workspace_id. Non-destructive: the
// data stays under .archive/ so the user can recover it manually if
// they need to.
//
// Skipped when:
//   - prevWorkspaceId is empty (first activation, nothing to archive)
//   - prevWorkspaceId === nextCfg.workspaceId (same workspace — refresh,
//     not a swap; preserve local mirror dirs)
//   - projects root doesn't exist yet
//
// Entries skipped from the move:
//   - Hidden entries (start with '.'): .archive itself, .DS_Store, etc.
//   - Non-directory entries: stray loose files.
async function archiveStaleProjectDirsOnWorkspaceChange(nextCfg, prevWorkspaceId) {
  const nextWorkspaceId = nextCfg && nextCfg.workspaceId ? String(nextCfg.workspaceId).trim() : '';
  if (!prevWorkspaceId) return; // first-ever activation
  if (prevWorkspaceId === nextWorkspaceId) return; // same workspace, no swap
  const root = defaultProjectsRoot(nextCfg);
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const movable = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (movable.length === 0) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(root, '.archive', `${prevWorkspaceId}-${ts}`);
  await fsp.mkdir(archiveDir, { recursive: true });
  for (const entry of movable) {
    const src = path.join(root, entry.name);
    const dst = path.join(archiveDir, entry.name);
    await fsp.rename(src, dst).catch((err) => {
      console.warn(`archive: failed to move ${entry.name}:`, err && err.message ? err.message : err);
    });
  }
  console.log(`archived ${movable.length} stale project dir(s) from prev workspace ${prevWorkspaceId} → ${archiveDir}`);
}

async function isGitDirectory(projectPath) {
  try {
    const stat = await fsp.stat(path.join(projectPath, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function assertInsideProjectsRoot(root, target) {
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(String(target || ''));
  const rel = path.relative(resolvedRoot, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径不在工作目录内');
  return absolute;
}

function isInsideProjectsRoot(root, target) {
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(String(target || ''));
  const rel = path.relative(resolvedRoot, absolute);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)) === path.resolve(String(b));
}

function sanitizeProjectName(value) {
  const name = String(value || '').trim().replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || '';
}

function cleanWorkspaceName(value) {
  let name = String(value || '').trim().replace(/\.git$/i, '');
  name = name.replace(/[/\\]+/g, '-').replace(/\.\.+/g, '-').replace(/^-+|-+$/g, '').trim();
  while (name.startsWith('.')) name = name.slice(1).trim();
  if (Buffer.byteLength(name) > 180) {
    name = name.slice(0, 180).trim();
  }
  return name || '';
}

function deriveProjectNameFromGitURL(gitUrl) {
  const raw = String(gitUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const tail = raw.split(/[/:]/).filter(Boolean).pop() || 'project';
  return sanitizeProjectName(tail) || `project-${Date.now()}`;
}

// scanWorkspace: shallow scan of the workspace root only. Each directory
// is returned with `children: []` and the renderer hydrates per-directory
// children on demand via the files:listChildren IPC. This makes initial
// scan O(top-level entries) instead of O(total files) — the old 5000-entry
// truncation cap is gone; large monorepos open instantly.
//
// Trade-off: fileCount / directoryCount / totalBytes reflect TOP LEVEL
// only. MonitorGrid's "files / dirs / bytes" tile is the only consumer
// and it's a rough size hint, not a load-bearing number.
async function scanWorkspace(root) {
  const resolvedRoot = path.resolve(root || '');
  if (!resolvedRoot) return emptyTree('');
  const gitState = await gitWorkingTreeStatusForRoot(resolvedRoot);
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  let entries = [];
  try {
    entries = await fsp.readdir(resolvedRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const nodes = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.kari') {
      if (entry.name === '.DS_Store') continue;
    }
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const absolute = path.join(resolvedRoot, entry.name);
    const relPath = path.relative(resolvedRoot, absolute);
    try {
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        directoryCount++;
        nodes.push({
          name: entry.name,
          path: absolute,
          relPath,
          type: 'directory',
          size: 0,
          children: [],
          gitBadge: aggregateGitBadgeFromStatuses(relPath, gitState.statuses),
          gitStatus: ''
        });
      } else if (stat.isFile()) {
        fileCount++;
        totalBytes += stat.size;
        const gitItem = gitState.statuses[relKey(relPath)] || null;
        nodes.push({
          name: entry.name,
          path: absolute,
          relPath,
          type: 'file',
          size: stat.size,
          gitStatus: gitItem ? gitItem.status : '',
          gitBadge: gitItem ? gitItem.badge : ''
        });
      }
    } catch {}
  }

  return {
    root: resolvedRoot,
    nodes,
    fileCount,
    directoryCount,
    totalBytes,
    truncated: false,
    isGit: gitState.isGit,
    gitRoot: gitState.gitRoot || ''
  };
}

// Directory aggregate git badge — previously walked the directory's
// recursive children. With lazy expansion we don't have them; instead
// we filter the workspace-flat git status map by directory prefix.
// Same priority order (UU > U > A > M > D > R > any > none).
const GIT_BADGE_PRIORITY = new Map([
  ['UU', 100],
  ['U', 90],
  ['A', 80],
  ['M', 70],
  ['D', 60],
  ['R', 50],
]);

function aggregateGitBadgeFromStatuses(dirRelPath, statuses) {
  if (!dirRelPath || !statuses) return '';
  const prefix = relKey(dirRelPath) + '/';
  let best = '';
  let bestScore = 0;
  for (const key of Object.keys(statuses)) {
    if (!key.startsWith(prefix)) continue;
    const badge = (statuses[key] && statuses[key].badge) || '';
    const score = GIT_BADGE_PRIORITY.get(badge) || (badge ? 10 : 0);
    if (score > bestScore) {
      best = badge;
      bestScore = score;
    }
  }
  return best;
}

function relKey(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

async function gitWorkingTreeStatusForRoot(root) {
  const resolvedRoot = path.resolve(root || '');
  if (!resolvedRoot) return { isGit: false, gitRoot: '', statuses: {} };
  let gitRoot = '';
  try {
    gitRoot = (await execGit(resolvedRoot, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return { isGit: false, gitRoot: '', statuses: {} };
  }
  if (!gitRoot) return { isGit: false, gitRoot: '', statuses: {} };
  let stdout = '';
  try {
    stdout = await execGit(resolvedRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch {
    return { isGit: true, gitRoot, statuses: {} };
  }
  const statuses = {};
  const parts = stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const gitRel = entry.slice(3);
    const abs = path.resolve(gitRoot, gitRel);
    const workspaceRel = path.relative(resolvedRoot, abs);
    if (!workspaceRel || workspaceRel.startsWith('..') || path.isAbsolute(workspaceRel)) {
      if (status[0] === 'R' || status[0] === 'C') i++;
      continue;
    }
    statuses[relKey(workspaceRel)] = {
      status,
      badge: gitBadgeForStatus(status)
    };
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return { isGit: true, gitRoot, statuses };
}

function gitBadgeForStatus(status) {
  const x = status[0] || ' ';
  const y = status[1] || ' ';
  if (status === '??') return 'U';
  if (x === 'U' || y === 'U') return 'UU';
  if (x === 'A') return 'A';
  if (x === 'M' || y === 'M') return 'M';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'C' || y === 'C') return 'C';
  return status.trim();
}

async function readGitBaseForFile(workspaceRoot, absolute) {
  const empty = { baseContent: '', baseKind: 'none', gitStatus: '', gitBadge: '' };
  if (!workspaceRoot || !absolute) return empty;
  const state = await gitWorkingTreeStatusForRoot(workspaceRoot);
  if (!state.isGit || !state.gitRoot) return empty;
  const workspaceRel = path.relative(path.resolve(workspaceRoot), path.resolve(absolute));
  const gitRel = path.relative(state.gitRoot, path.resolve(absolute));
  if (!gitRel || gitRel.startsWith('..') || path.isAbsolute(gitRel)) return empty;
  const statusItem = state.statuses[relKey(workspaceRel)] || null;
  const gitStatus = statusItem ? statusItem.status : '';
  const gitBadge = statusItem ? statusItem.badge : '';
  if (gitStatus === '??') {
    return { baseContent: '', baseKind: 'empty', gitStatus, gitBadge };
  }
  try {
    const baseContent = await execGit(workspaceRoot, ['show', `HEAD:${relKey(gitRel)}`]);
    return { baseContent, baseKind: 'git-head', gitStatus, gitBadge };
  } catch {
    if (gitBadge === 'A' || gitBadge === 'U') {
      return { baseContent: '', baseKind: 'empty', gitStatus, gitBadge };
    }
    return { ...empty, gitStatus, gitBadge };
  }
}

// Diff Viewer commit 1: gitDiffSummary collects the read-only
// `Changes` review feed (plan §5). Always runs in main process —
// renderer never invokes git. Returns { ok, isGit, root, files,
// truncated, error } matching the GitDiffSummary type.
//
// Strategy:
//   1. Resolve workspace root + check is-git via existing
//      gitWorkingTreeStatusForRoot helper.
//   2. Detect HEAD presence (`git rev-parse --verify HEAD`); fresh
//      `git init` repos with no commit fall back to "all tracked
//      treated as added; just enumerate untracked".
//   3. With HEAD: `git diff HEAD --no-ext-diff` for staged +
//      unstaged combined view (plan §5 lock).
//   4. parseUnifiedDiff into per-file objects.
//   5. Enumerate untracked via status map; synthesizeUntrackedPatch
//      for each.
//   6. applyWorkspaceCap clears patches once total > 2 MB.
async function gitDiffSummary() {
  const cfg = await loadStoredConfig();
  const root = cfg && cfg.workspaceRoot ? path.resolve(cfg.workspaceRoot) : '';
  if (!root) {
    return { ok: false, isGit: false, root: '', files: [], error: 'no workspace selected' };
  }
  const status = await gitWorkingTreeStatusForRoot(root);
  if (!status.isGit) {
    return { ok: true, isGit: false, root, files: [], error: '' };
  }

  let hasHead = false;
  try {
    await execGit(root, ['rev-parse', '--verify', 'HEAD']);
    hasHead = true;
  } catch {
    hasHead = false;
  }

  let aggregate = '';
  let aggregateFailed = false;
  if (hasHead) {
    try {
      // -c core.quotePath=false is REQUIRED. Round-1 High #2:
      // without it, Git default-quotes non-ASCII paths as
      // \NNN-octal-escaped strings ("a/\344\270\255/foo.go"), and
      // parseUnifiedDiff's `diff --git a/(.+) b/(.+)` regex drops
      // them entirely → Unicode-named files silently disappear from
      // Changes. The flag emits literal UTF-8 which parses cleanly.
      aggregate = await execGit(root, [
        '-c', 'core.quotePath=false',
        'diff', 'HEAD', '--no-ext-diff',
      ]);
    } catch (err) {
      // Round-1 Medium #1: aggregate diff exec failed (e.g. execGit
      // maxBuffer overrun on > 10 MB total diff). Don't silently
      // drop — flag the summary as truncated below so renderer
      // shows the "changes exceed render budget" banner.
      aggregateFailed = true;
      console.warn('[git diff] HEAD diff failed:', err && err.message ? err.message : err);
    }
  }
  // HEAD-less repo: no diff output. Tracked staged files come back
  // through the status enumeration below — gitWorkingTreeStatusForRoot
  // includes them as `A ` entries which statusFromPorcelain maps to
  // `added`; we synthesize their patches the same way as untracked.

  const files = parseUnifiedDiff(aggregate);
  const sawInDiff = new Set(files.map((f) => f.path));

  // Enumerate ALL status entries; pull in:
  //  - untracked (`??`) → always synthesize
  //  - HEAD-less repo's staged adds (`A ` / `AM` / etc.) → synthesize
  //    as added if not already in `files`
  //  - any other code that didn't appear in the diff aggregate
  //    (e.g. status said modified but `git diff HEAD` had nothing —
  //    rare; keep a metadata-only entry so the row shows up)
  for (const [relPath, info] of Object.entries(status.statuses)) {
    const code = info && info.status ? info.status : '';
    const isUntracked = code === '??';
    const isStaged = code && code[0] && code[0] !== ' ' && code[0] !== '?';
    if (sawInDiff.has(relPath)) continue;
    if (!isUntracked && !(isStaged && !hasHead)) {
      // Status said this file changed, but `git diff HEAD` didn't
      // include it. Emit a metadata-only row.
      files.push({
        path: relPath,
        status: statusFromPorcelain(code),
        additions: 0,
        deletions: 0,
        patch: '',
        binary: false,
      });
      continue;
    }
    const abs = path.join(root, relPath);
    const synth = await synthesizeUntrackedPatch(abs, relPath).catch(() => null);
    if (!synth) continue;
    // For HEAD-less staged adds, override status from 'untracked'
    // (synthesize default) to 'added' to match the porcelain code.
    if (!isUntracked) synth.status = statusFromPorcelain(code);
    files.push(synth);
  }

  const capHit = applyWorkspaceCap(files);
  // Round-1 Medium #1: aggregate-diff failure (typically execGit
  // maxBuffer overrun) is ALSO a truncation. Renderer treats the
  // two cases identically — banner + per-row metadata.
  const truncated = capHit || aggregateFailed;
  return { ok: true, isGit: true, root, files, truncated, error: '' };
}

// gitFileDiff lazy-loads one file's full patch (plan §5). Called by
// the renderer when summary returned an empty patch for a file
// (capped) and the user opens that file's card. workspace-contained
// per assertInsideWorkspace.
async function gitFileDiff(relPath) {
  const cfg = await loadStoredConfig();
  if (!cfg || !cfg.workspaceRoot) {
    return { ok: false, error: 'no workspace selected' };
  }
  const root = path.resolve(cfg.workspaceRoot);
  const abs = assertInsideWorkspace(root, path.join(root, String(relPath || '')));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) {
    return { ok: false, error: 'path escapes workspace' };
  }

  const status = await gitWorkingTreeStatusForRoot(root);
  if (!status.isGit) {
    return { ok: true, file: null, isGit: false };
  }
  const statusInfo = status.statuses[rel];
  const code = statusInfo && statusInfo.status ? statusInfo.status : '';
  const isUntracked = code === '??';

  if (isUntracked) {
    const synth = await synthesizeUntrackedPatch(abs, rel);
    return { ok: true, file: synth, isGit: true };
  }

  // Tracked: ask Git for the per-file unified diff. HEAD-less repos
  // fall back to synthesizing the file content as added.
  let hasHead = false;
  try {
    await execGit(root, ['rev-parse', '--verify', 'HEAD']);
    hasHead = true;
  } catch {
    hasHead = false;
  }
  if (!hasHead) {
    const synth = await synthesizeUntrackedPatch(abs, rel);
    if (code) synth.status = statusFromPorcelain(code);
    return { ok: true, file: synth, isGit: true };
  }

  let aggregate = '';
  try {
    // -c core.quotePath=false: same Round-1 High #2 fix as summary
    // (Unicode tracked paths). Per-file lazy load must apply it too
    // — without it, a 中文 path lazy-load would parse to empty rel
    // and the .find() below would fail.
    aggregate = await execGit(root, [
      '-c', 'core.quotePath=false',
      'diff', 'HEAD', '--no-ext-diff', '--', rel,
    ]);
  } catch (err) {
    // Round-1 Medium #2: per-file diff exec failed (typically
    // execGit maxBuffer overrun on a single >10 MB file change).
    // Return a stable file shape with truncated=true so the
    // renderer's "click to load full file" banner reads "diff
    // capped, refresh later" instead of a generic error.
    return {
      ok: true,
      isGit: true,
      file: {
        path: rel,
        status: code ? statusFromPorcelain(code) : 'unknown',
        additions: 0,
        deletions: 0,
        patch: '',
        truncated: true,
      },
      error: String(err && err.message ? err.message : err),
    };
  }
  const parsed = parseUnifiedDiff(aggregate);
  const file = parsed.find((f) => f.path === rel) || parsed[0] || {
    path: rel,
    status: code ? statusFromPorcelain(code) : 'unknown',
    additions: 0,
    deletions: 0,
    patch: '',
  };
  // Apply per-file cap (the workspace cap doesn't apply to single-
  // file lazy load — one file is at most per-file cap).
  if (file.patch && file.patch.length > MAX_PATCH_BYTES_PER_FILE) {
    file.truncated = true;
    file.patch = '';
  }
  return { ok: true, file, isGit: true };
}

function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

// Cached 32×32 NativeImage used as the OS drag-source icon for
// file-tree → OS drag-out. Lazily resolved at first drag because
// process.resourcesPath isn't valid until app.whenReady, and we
// don't want to slow boot for a feature only some users use.
//
// Resolution order matches the packaging surface:
//   1. process.resourcesPath/build/icon.png  — production app
//      (extraResources copies bundled-runtime + build/ here)
//   2. app.getAppPath()/build/icon.png       — dev electron run
//   3. ../../build/icon.png                  — fallback if either
//      of the above is unset (unlikely)
let cachedDragIcon = null;
function dragIcon() {
  if (cachedDragIcon) return cachedDragIcon;
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'build', 'icon.png') : '',
    typeof app !== 'undefined' && app.getAppPath ? path.join(app.getAppPath(), 'build', 'icon.png') : '',
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (img && !img.isEmpty()) {
        cachedDragIcon = img.resize({ width: 32, height: 32 });
        return cachedDragIcon;
      }
    } catch {}
  }
  cachedDragIcon = nativeImage.createEmpty();
  return cachedDragIcon;
}

function startFileDragForSender(sender, absPath) {
  const p = String(absPath || '');
  if (!p || !path.isAbsolute(p)) return false;
  if (sender.isDestroyed()) return false;
  try {
    if (!fs.existsSync(p)) return false;
    const icon = dragIcon();
    // macOS rejects startDrag with an empty NativeImage. If our
    // resolution found nothing, refuse rather than crash.
    if (icon.isEmpty() && process.platform === 'darwin') return false;
    sender.startDrag({ file: p, icon });
    return true;
  } catch (err) {
    console.warn('files:startDrag failed:', err && err.message ? err.message : err);
    return false;
  }
}

function assertInsideWorkspace(root, target) {
  if (!root) throw new Error('未选择项目目录');
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(String(target || ''));
  const rel = path.relative(resolvedRoot, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径不在项目目录内');
  return absolute;
}

function languageFromPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ({
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    go: 'go',
    py: 'python',
    rs: 'rust',
    toml: 'toml',
    yaml: 'yaml',
    yml: 'yaml',
    css: 'css',
    html: 'html',
    sh: 'shell',
    ps1: 'powershell'
  })[ext] || 'plaintext';
}

async function daemonSnapshot() {
  // Phase 0 + 1.1 (syncthing migration): keep the renderer's flat
  // DaemonStatus shape (shared/types.ts) so StatusBar / MonitorGrid /
  // reverse-proxy gating keep working. `health` + `running` +
  // `connected` reflect the syncthing child instead of kari-syncd;
  // the field set stays identical so consumers don't have to change.
  // Phase 2 fills lastSyncAt + lastActivityAt + transferCount from
  // real /rest/events.
  //
  // workspaceRoot stays EMPTY in the snapshot (codex round 2 P1 fix).
  // The legacy daemon snapshot reported the daemon's bind target
  // here; if we populate it from cfg, callers like ensureMirrorSyncBound
  // mistake "config thinks we should be bound to X" for "daemon is
  // actually bound to X" and skip the bind step, leaving kari-syncd
  // permanently unbound after a crash-respawn.
  const meta = syncthingProcess.getRunningMeta();
  const cfg = await loadStoredConfig().catch(() => null);
  const base = {
    health: 'offline',
    connected: false,
    running: false,
    lastError: '',
    workspaceRoot: '',
    workspaceId: (cfg && cfg.workspaceId) || '',
    serverAddr: (cfg && cfg.serverAddr) || '',
    lastSyncAt: '',
    // lastActivityAt stays EMPTY until Phase 2 wires real events.
    // The renderer's App.tsx triggers a file-tree refresh whenever this
    // value changes, so ticking it every status poll (every 2s) would
    // re-scan the entire workspace continuously (codex round 2 P2).
    lastActivityAt: '',
    ptyCount: terminals.size,
    pendingOutbound: 0,
    frpState: '',
    frpError: '',
    sshState: '',
    sshAvailable: false,
    sshPlatform: '',
    sshInstallSupported: false,
    transferCount: 0,
    desktopUpload: null,
    // Phase 1.1-specific extras consumed by the new syncthing UI surface
    // (and ignored by legacy consumers).
    raw: { syncthing: meta ? { running: true, pid: meta.pid, guiAddress: meta.guiAddress, deviceId: meta.deviceId, listenPort: meta.listenPort } : { running: false } },
  };
  if (meta) {
    base.health = 'online';
    base.running = true;
    // `connected` traditionally meant "daemon ↔ server gRPC session
    // alive"; for syncthing we conservatively report true once the
    // local child is healthy. Phase 2's connection-event subscription
    // will refine this with peer-level state.
    base.connected = true;
  }
  return base;
}
async function postSyncTask() { return { ok: false, code: 'sync_disabled' }; }
async function pollSyncTasks() { /* Phase 0: no-op until syncthing event subscription (Phase 2) */ }
async function reconcileMarkersWithCache() { /* Phase 0: no-op */ }
async function applySyncTaskSideEffects() { /* Phase 0: no-op */ }
async function stagingPathForSession() { return null; }
async function supersededRootForCurrentProjectsRoot() { return null; }
function normalizeSyncTask() { return null; }
async function recoverSyncTasksFromMarkers() { /* Phase 0: no-op */ }
async function abandonDownload() { return { ok: false, code: 'sync_disabled', error: '已停用：等待 syncthing 接入。' }; }
// Last good remote-session list, keyed by workspace, served back when a
// refresh hits a *transient* daemon failure (timeout / network / 5xx) so the
// sidebar doesn't blank on a slow container scan. Keyed so a transient
// failure never repaints the sidebar with a different workspace's sessions.
let _lastRemoteSessions = null; // { key, list } | null
const REMOTE_SESSIONS_TIMEOUT_MS = 12000;

async function listRemoteSessions(forceRefresh = false) {
  const cfg = await loadStoredConfig();
  const ctxKey = String((cfg && (cfg.workspaceId || cfg.workspaceRoot)) || '');
  const aliases = await loadSessionAliases(cfg);
  const route = forceRefresh ? '/v1/remote-sessions?refresh=1' : '/v1/remote-sessions';
  const result = await getDaemon(route, REMOTE_SESSIONS_TIMEOUT_MS);
  if (!result.ok) {
    // Permanent daemon error (4xx — endpoint missing / unauthorized): clear
    // rather than show stale data. Transient (no status = network/abort/
    // timeout, or 5xx): keep THIS workspace's last good list; null (treated
    // as "no update" by the renderer) when nothing matches the context.
    const status = Number(result.status || 0);
    const transient = !result.status || status >= 500;
    if (!transient) return [];
    return _lastRemoteSessions && _lastRemoteSessions.key === ctxKey
      ? _lastRemoteSessions.list
      : null;
  }
  if (!result.data) return [];
  const out = [];
  const sources = Array.isArray(result.data.sources) ? result.data.sources : [];
  for (const source of sources) {
    const kind = String(source.kind || source.source || source.name || 'remote');
    for (const session of source.sessions || []) {
      const id = String(session.id || session.cli_session_id || crypto.randomUUID());
      const project = String(session.project || '').trim();
      const rawTitle = String(session.title || session.summary || '').trim();
      const originalTitle = rawTitle || project || `session ${id.slice(0, 8)}`;
      const aliasTitle = aliases.get(sessionAliasEntryKey(kind, id)) || '';
      out.push({
        id,
        source: kind,
        title: aliasTitle || originalTitle,
        originalTitle,
        customTitle: Boolean(aliasTitle),
        project,
        lastActiveAt: remoteSessionTime(session),
        mtime: Number(session.mtime || session.last_active_at || 0)
      });
    }
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const sessions = out.map(({ mtime, ...session }) => session);
  _lastRemoteSessions = { key: ctxKey, list: sessions };
  return sessions;
}

async function renameSessionAlias(payload) {
  const cfg = await loadStoredConfig();
  const source = sanitizeSessionSource(payload.source);
  const sessionID = sanitizeSessionID(payload.id || payload.sessionId || payload.session_id);
  const project = sanitizeSessionProject(payload.project || '');
  const title = sanitizeSessionAliasTitle(payload.title || payload.name || '');
  const dbPath = configDbPath();
  await ensureSessionAliasTable(dbPath);
  const now = new Date().toISOString();
  const projectKey = sessionAliasProjectKey(cfg, project);
  // Reads match aliases by workspace_id (session_id is globally unique), so a
  // reset must clear EVERY row for this session in the workspace — not just the
  // one under this project_key — or a stale alias written under a different
  // project_key would resurface. Legacy fallback for unbound (no workspace_id).
  const workspaceID = String(cfg.workspaceId || '').trim();
  const resetWhere = workspaceID
    ? `workspace_id=${sqliteString(workspaceID)} and source=${sqliteString(source)} and session_id=${sqliteString(sessionID)}`
    : `project_key=${sqliteString(projectKey)} and source=${sqliteString(source)} and session_id=${sqliteString(sessionID)}`;
  if (!title) {
    await sqliteExec(dbPath, `delete from SessionAliases where ${resetWhere};`);
    return { ok: true, id: sessionID, source, project, title: '', customTitle: false };
  }
  const sql = [
    `insert into SessionAliases(project_key, workspace_id, workspace_root, project, source, session_id, title, updated_at)`,
    `values(${sqliteString(projectKey)}, ${sqliteString(cfg.workspaceId || '')}, ${sqliteString(cfg.workspaceRoot || '')}, ${sqliteString(project)}, ${sqliteString(source)}, ${sqliteString(sessionID)}, ${sqliteString(title)}, ${sqliteString(now)})`,
    `on conflict(project_key, source, session_id) do update set title=excluded.title, project=excluded.project, workspace_id=excluded.workspace_id, workspace_root=excluded.workspace_root, updated_at=excluded.updated_at;`
  ].join(' ');
  await sqliteExec(dbPath, sql);
  return { ok: true, id: sessionID, source, project, title, customTitle: true };
}

async function loadSessionAliases(cfg) {
  const dbPath = configDbPath();
  if (!fs.existsSync(dbPath)) return new Map();
  await ensureSessionAliasTable(dbPath);
  // Match aliases by workspace, not by the full project_key. The project name
  // baked into the write-time key (renameSessionAlias uses session.project,
  // which for container sessions is derived inside the container) does not
  // equal the read-time key (basename of the local workspaceRoot), so a
  // project_key lookup silently missed every rename — the title appeared to
  // "not save". session_id is globally unique, so a workspace-scoped match by
  // (source, session_id) is correct. Falls back to the legacy project_key when
  // no workspace_id is bound. ORDER BY updated_at so the latest rename wins.
  const workspaceId = String((cfg && cfg.workspaceId) || '').trim();
  const where = workspaceId
    ? `workspace_id=${sqliteString(workspaceId)}`
    : `project_key=${sqliteString(sessionAliasProjectKey(cfg, ''))}`;
  const sql = `select source || char(31) || session_id || char(31) || title from SessionAliases where ${where} order by updated_at asc;`;
  const stdout = await sqliteExec(dbPath, sql).catch(() => '');
  const aliases = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\x1f');
    if (parts.length < 3) continue;
    aliases.set(sessionAliasEntryKey(parts[0], parts[1]), parts.slice(2).join('\x1f'));
  }
  return aliases;
}

async function ensureSessionAliasTable(dbPath) {
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  await sqliteExec(dbPath, [
    'create table if not exists SessionAliases (',
    'project_key text not null,',
    'workspace_id text not null default \'\',',
    'workspace_root text not null default \'\',',
    'project text not null default \'\',',
    'source text not null,',
    'session_id text not null,',
    'title text not null,',
    'updated_at text not null,',
    'primary key(project_key, source, session_id)',
    ');',
    'create index if not exists idx_session_alias_project on SessionAliases(project_key);'
  ].join('\n'));
  await fsp.chmod(dbPath, 0o600).catch(() => null);
}

function sessionAliasProjectKey(cfg, project) {
  const workspaceID = String(cfg && cfg.workspaceId || '').trim();
  const workspaceRoot = cfg && cfg.workspaceRoot ? path.resolve(String(cfg.workspaceRoot)) : '';
  const projectName = sanitizeSessionProject(project || (workspaceRoot ? path.basename(workspaceRoot) : cfg && cfg.workspaceName || ''));
  return [workspaceID, workspaceRoot, projectName].filter(Boolean).join('|') || 'default';
}

function sessionAliasEntryKey(source, sessionID) {
  return `${String(source || '').trim().toLowerCase()}|${String(sessionID || '').trim()}`;
}

function sanitizeSessionSource(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,48}$/.test(text)) throw new Error('invalid session source');
  return text;
}

function sanitizeSessionID(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 160 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('invalid session id');
  return text;
}

function sanitizeSessionProject(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function sanitizeSessionAliasTitle(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function remoteSessionTime(session) {
  const value = Number(session.last_active_at || session.mtime || session.modified_at || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  let ms = value;
  if (value > 1e15) {
    ms = Math.floor(value / 1e6);
  } else if (value < 1e11) {
    ms = value * 1000;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

// getDaemon / postDaemon are now thin shims over daemon_http.cjs so
// the predicate logic has a real test surface. See daemon_http.cjs
// for the response-shape contract.
const _daemonHttp = createDaemonHttp({ baseUrl: DAEMON_BASE });
const getDaemon = _daemonHttp.getDaemon;
const postDaemon = _daemonHttp.postDaemon;

function loadPty() {
  if (ptyModule) return ptyModule;
  try {
    ensureNodePtySpawnHelperExecutable();
    ptyModule = require('node-pty');
    return ptyModule;
  } catch (err) {
    throw new Error(`node-pty 未安装或不可用：${err && err.message ? err.message : err}`);
  }
}

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return;
  try {
    const pkg = require.resolve('node-pty/package.json');
    const root = path.dirname(pkg);
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      const helper = path.join(root, 'prebuilds', arch, 'spawn-helper');
      try {
        const stat = fs.statSync(helper);
        if (stat.isFile() && (stat.mode & 0o111) === 0) {
          fs.chmodSync(helper, stat.mode | 0o755);
        }
      } catch {}
    }
  } catch {}
}

async function createTerminal(req, deps = {}) {
  const loadStoredConfigFn = deps.loadStoredConfig || loadStoredConfig;
  const loadPtyFn = deps.loadPty || loadPty;
  const commandForTerminalFn = deps.commandForTerminal || commandForTerminal;
  const terminalCwdFn = deps.terminalCwd || terminalCwd;
  const terminalProjectRootFn = deps.terminalProjectRoot || terminalProjectRoot;
  const getEffectiveSyncModeFn = deps.getEffectiveSyncMode || getEffectiveSyncMode;
  const hasInjectedTracker = Object.prototype.hasOwnProperty.call(deps, 'ptyProjectTracker');
  const tracker = hasInjectedTracker ? deps.ptyProjectTracker : ptyProjectTracker;
  const cfg = await loadStoredConfigFn();
  const pty = loadPtyFn();
  const kind = req.kind || 'shell';
  const requestedMode = req.mode || 'local';
  const mode = kind === 'opencode' ? 'local' : requestedMode;
  const shell = defaultShell();
  const cols = Math.max(20, Number(req.cols || 100));
  const rows = Math.max(8, Number(req.rows || 30));
  const resumeSessionId = sanitizeResumeSessionID(req.resumeSessionId || req.resume_session_id || '');
  const spawn = await commandForTerminalFn(kind, mode, cfg, shell);
  const id = crypto.randomUUID();
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    KARI_CLIENT_ID: cfg.clientId || machineClientId()
  };
  let projectRoot = null;
  let skipRemoteAutoPair = false;
  if (mode === 'remote') {
    const syncMode = await getEffectiveSyncModeFn(terminalSyncModeIdentity(cfg)).catch(() => 'lightweight');
    if (syncMode === 'off' || syncMode === 'manual') {
      skipRemoteAutoPair = true;
      console.log(`[pty-tracker] skipping auto-pair for remote PTY: sync mode is ${syncMode}`);
    } else {
      projectRoot = await terminalProjectRootFn(cfg);
    }
  }
  const cwd = projectRoot || await terminalCwdFn(cfg.workspaceRoot);
  const child = pty.spawn(spawn.file, spawn.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  });
  terminals.set(id, child);
  terminalBacklogs.set(id, '');
  // Plan T6: announce the new PTY to the project tracker. Local PTYs
  // walk up cwd → project root; remote PTYs already know the root and
  // register directly. The scheduler picks either signal up via
  // pty:project:active. Failures here must NOT block terminal spawn —
  // a tracker miss just means the project doesn't sync, not that the
  // user loses their PTY.
  if (tracker && cwd) {
    if (mode === 'remote') {
      if (skipRemoteAutoPair) {
        // Sync is explicitly not automatic for this workspace.
      } else if (projectRoot) {
        try {
          tracker.registerForProject(id, projectRoot);
          console.log(`[pty-tracker] remote PTY registered to project ${projectRoot}`);
        } catch (err) {
          console.warn('[pty-tracker] registerForProject failed:', err && err.message ? err.message : err);
        }
      } else {
        console.warn('[pty-tracker] remote PTY project root unavailable; falling back to cwd walk-up registration:', cwd);
        tracker.registerPty(id, cwd).catch((err) => {
          console.warn('[pty-tracker] registerPty failed:', err && err.message ? err.message : err);
        });
      }
    } else {
      tracker.registerPty(id, cwd).catch((err) => {
        console.warn('[pty-tracker] registerPty failed:', err && err.message ? err.message : err);
      });
    }
  }
  const mcpWaiter = createMcpSessionWaiter(kind, mode);
  const mcpFrameFilter = createKariMcpFrameFilter((session) => {
    if (mcpWaiter) mcpWaiter.resolve(session);
  });
  let suppressPreStartupOutput = shouldHideRemoteCliStartup(kind, mode);
  const startupNoiseFilter = createRemoteCliStartupNoiseFilter(kind, mode);
  const startupInputPromise = remoteStartupInput(kind, mode, resumeSessionId, {
    mcpSessionPromise: mcpWaiter ? mcpWaiter.promise : Promise.resolve(null)
  }).catch(() => remoteStartupInput(kind, mode, resumeSessionId));
  let startupEchoFilter = null;
  startupInputPromise.then((startupInput) => {
    const startupCommand = startupInput ? startupInput.trim() : '';
    if (!startupInput) return;
    setTimeout(() => {
      if (terminals.get(id) === child) {
        startupEchoFilter = createStartupEchoFilter(startupCommand);
        suppressPreStartupOutput = false;
        child.write(startupInput);
      }
    }, 900);
  });
  child.onData((data) => {
    let next = mcpFrameFilter.push(data);
    if (suppressPreStartupOutput) {
      next = '';
    }
    if (startupEchoFilter) {
      next = startupEchoFilter.push(next);
      if (startupEchoFilter.done) startupEchoFilter = null;
    }
    if (startupNoiseFilter) {
      next = startupNoiseFilter.push(next);
    }
    if (next) {
      appendTerminalBacklog(id, next);
      broadcastRenderer('terminal:data', { id, data: next });
    }
  });
  child.onExit((ev) => {
    terminals.delete(id);
    pinnedTerminals.delete(id);
    const exitTracker = hasInjectedTracker ? tracker : ptyProjectTracker;
    if (exitTracker) exitTracker.unregisterPty(id);
    broadcastRenderer('terminal:exit', { id, code: ev.exitCode, signal: ev.signal });
  });
  return { id, title: terminalTitle(kind, mode, resumeSessionId, cwd, cfg), kind, mode };
}

async function commandForTerminal(kind, mode, cfg, shell) {
  if (mode === 'remote') {
    const runtime = await ensureRuntime();
    const kari = runtime.kariPath || process.env.KARI_CLI_PATH || '';
    const activationCode = decryptActivationCode(cfg);
    const missing = [];
    if (!kari) missing.push('kari CLI');
    if (!cfg.serverAddr) missing.push('serverAddr');
    if (!cfg.workspaceId) missing.push('workspaceId');
    if (!activationCode) missing.push('activation code');
    if (missing.length > 0) {
      throw new Error(`远端 PTY 缺少 ${missing.join('、')}。请先完成激活并确认 runtime。`);
    }
    // Strip http://https:// from serverAddr before handing it to the
    // bundled kari CLI's gRPC dial — same regression as daemon_control_bind:
    // recent grpc-go releases reject "http://host:port" with "too many
    // colons in address". cfg.serverAddr is kept as-is for other surfaces
    // (UI, browser launches) that DO expect a URL.
    const dialServerAddr = kariSyncdAddrFor(cfg.serverAddr);
    const args = [
      'pty',
      '--server', dialServerAddr,
      '--workspace', cfg.workspaceId,
      '--workspace-name', cfg.workspaceName || 'workspace',
      '--license', activationCode,
      '--client-id', cfg.clientId || machineClientId(),
      '--force-interactive',
      '--syncd', DAEMON_BASE
    ];
    if (kind === 'claude' || kind === 'codex') {
      args.push('--startup-kind', kind);
    }
    return { file: kari, args };
  }
  if (kind === 'codex') return { file: resolveRequiredCli('codex', 'KARI_CODEX_PATH'), args: [] };
  if (kind === 'claude') return { file: resolveRequiredCli('claude', 'KARI_CLAUDE_PATH'), args: [] };
  if (kind === 'opencode') {
    const resolved = await resolveOptionalCliBinary('opencode', 'KARI_OPENCODE_PATH');
    if (!resolved) throw new Error('opencode CLI not found; set KARI_OPENCODE_PATH, install opencode, or bundle it in bundled-runtime');
    return { file: resolved, args: [] };
  }
  if (kind === 'continue') return { file: resolveRequiredCli('continue', 'KARI_CONTINUE_PATH'), args: [] };
  return { file: shell.file, args: shell.args };
}

function resolveRequiredCli(name, envName) {
  const override = process.env[envName];
  const resolved = override ? findOnPath(override) : findOnPath(name);
  if (!resolved) {
    throw new Error(`${name} CLI not found; set ${envName} or add ${name} to PATH`);
  }
  return resolved;
}

async function terminalCwd(workspaceRoot) {
  if (workspaceRoot) {
    try {
      const st = await fsp.stat(workspaceRoot);
      if (st.isDirectory()) return workspaceRoot;
    } catch {}
  }
  return os.homedir();
}

function terminalTitle(kind, mode, resumeSessionId = '', cwd = '', cfg = null) {
  // Format: "<dir> <kind-label>", e.g. "test6 code", "nsl21 claude".
  // The kind label is shortened — codex → 'code', everything else
  // passes through unchanged. cwd's basename is the dir; falls back
  // to cfg.workspaceName, then the legacy mode:kind form for layouts
  // that key on the old string.
  const base = cwd ? path.basename(String(cwd).replace(/[\\/]+$/, '')) : '';
  const looksLikeRoot = !base || base === '/' || base === '.' || /^[a-zA-Z]:[\\/]?$/.test(base);
  const dirLabel = !looksLikeRoot
    ? base
    : (cfg && cfg.workspaceName ? String(cfg.workspaceName).trim() : '');
  const kindLabel = terminalKindLabel(kind);
  if (dirLabel) return kindLabel ? `${dirLabel} ${kindLabel}` : dirLabel;
  if (mode === 'remote') return resumeSessionId ? `remote:${kind || 'shell'} resume` : `remote:${kind || 'shell'}`;
  return `local:${kind}`;
}

function terminalKindLabel(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'codex') return 'code';
  if (k === 'claude') return 'claude';
  if (k === 'shell') return 'shell';
  if (k === 'opencode') return 'opencode';
  return k;
}

function appendTerminalBacklog(id, data) {
  const previous = terminalBacklogs.get(id) || '';
  let next = previous + String(data || '');
  if (next.length > MAX_TERMINAL_BACKLOG) {
    next = next.slice(next.length - MAX_TERMINAL_BACKLOG);
  }
  terminalBacklogs.set(id, next);
}

async function remoteStartupInput(kind, mode, resumeSessionId = '', opts = {}) {
  if (mode !== 'remote') return '';
  if (kind === 'codex') {
    const mcpSession = await resolveMcpSession(opts.mcpSessionPromise);
    const base = resumeSessionId ? `codex ${codexMcpConfigArgs(mcpSession)} resume ${shellEscape(resumeSessionId)}` : `codex ${codexMcpConfigArgs(mcpSession)}`.trim();
    if (mcpSession && mcpSession.context_path) {
      return `KARI_MCP_CONTEXT=${shellEscape(mcpSession.context_path)} ${base}\r`;
    }
    return resumeSessionId ? `codex resume ${shellEscape(resumeSessionId)}\r` : 'codex\r';
  }
  if (kind === 'claude') {
    const mcpSession = await resolveMcpSession(opts.mcpSessionPromise);
    const base = resumeSessionId ? `claude --resume ${shellEscape(resumeSessionId)}` : 'claude';
    if (mcpSession && mcpSession.context_path && mcpSession.mcp_config_path) {
      return `KARI_MCP_CONTEXT=${shellEscape(mcpSession.context_path)} ${base} --mcp-config ${shellEscape(mcpSession.mcp_config_path)} --strict-mcp-config\r`;
    }
    return `${base}\r`;
  }
  return '';
}

function createMcpSessionWaiter(kind, mode) {
  if (mode !== 'remote' || (kind !== 'claude' && kind !== 'codex')) return null;
  let done = false;
  let timer = null;
  let resolveFn = null;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, KARI_MCP_WAIT_MS);
  });
  return {
    promise,
    resolve(session) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolveFn(session || null);
    }
  };
}

function shouldHideRemoteCliStartup(kind, mode) {
  return mode === 'remote' && (kind === 'claude' || kind === 'codex');
}

async function resolveMcpSession(promise) {
  if (!promise) return null;
  try {
    return await promise;
  } catch {
    return null;
  }
}

function shellEscape(value) {
  const s = String(value || '');
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

function codexMcpConfigArgs(session) {
  if (!session || !session.context_path) return '';
  const command = session.mcp_command_path || '/usr/local/bin/kari-mcp-bridge';
  const parts = [
    `mcp_servers.kari_local.command=${tomlString(command)}`,
    'mcp_servers.kari_local.args=[]',
    `mcp_servers.kari_local.env.KARI_MCP_CONTEXT=${tomlString(session.context_path)}`
  ];
  return parts.map((part) => `-c ${shellEscape(part)}`).join(' ');
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function createKariMcpFrameFilter(onFrame) {
  let buffer = '';
  return {
    push(data) {
      buffer += String(data || '');
      let out = '';
      while (buffer) {
        const idx = buffer.indexOf(KARI_MCP_OSC_PREFIX);
        if (idx < 0) {
          const keep = prefixOverlap(buffer, KARI_MCP_OSC_PREFIX);
          out += buffer.slice(0, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          return out;
        }
        out += buffer.slice(0, idx);
        const payloadStart = idx + KARI_MCP_OSC_PREFIX.length;
        const end = buffer.indexOf('\x07', payloadStart);
        if (end < 0) {
          buffer = buffer.slice(idx);
          return out;
        }
        const payload = buffer.slice(payloadStart, end);
        const session = decodeKariMcpFrame(payload);
        if (session) onFrame(session);
        buffer = buffer.slice(end + 1);
      }
      return out;
    }
  };
}

function decodeKariMcpFrame(payload) {
  try {
    return JSON.parse(Buffer.from(String(payload || ''), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function prefixOverlap(value, prefix) {
  const max = Math.min(value.length, prefix.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (value.endsWith(prefix.slice(0, n))) return n;
  }
  return 0;
}

function createRemoteCliStartupNoiseFilter(kind, mode) {
  if (mode !== 'remote') return null;
  const patterns = [];
  if (kind === 'codex') {
    const codexBubblewrapIntro =
      '⚠ Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites:';
    const codexBubblewrapHelp =
      'https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.';
    patterns.push(
      codexBubblewrapIntro + '\r\n',
      codexBubblewrapIntro + '\n',
      codexBubblewrapIntro,
      '  ' + codexBubblewrapHelp + '\r\n',
      '  ' + codexBubblewrapHelp + '\n',
      codexBubblewrapHelp + '\r\n',
      codexBubblewrapHelp + '\n',
      codexBubblewrapHelp
    );
  }
  if (patterns.length === 0) return null;
  return createStreamSuppressFilter(patterns);
}

function createStreamSuppressFilter(patterns) {
  const maxPatternLength = Math.max(...patterns.map((p) => p.length));
  let buffer = '';
  return {
    push(data) {
      buffer += String(data || '');
      for (const pattern of patterns) {
        buffer = buffer.split(pattern).join('');
      }
      const keep = Math.min(maxSuffixPatternPrefixOverlap(buffer, patterns), maxPatternLength - 1);
      const out = buffer.slice(0, buffer.length - keep);
      buffer = buffer.slice(buffer.length - keep);
      return out;
    }
  };
}

function maxSuffixPatternPrefixOverlap(value, patterns) {
  let best = 0;
  const max = Math.min(value.length, Math.max(...patterns.map((p) => p.length - 1)));
  for (const pattern of patterns) {
    const limit = Math.min(max, pattern.length - 1);
    for (let n = limit; n > best; n -= 1) {
      if (value.endsWith(pattern.slice(0, n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}

function sanitizeResumeSessionID(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (/^[0-9a-fA-F-]{36}$/.test(id)) return id;
  throw new Error('invalid resume session id');
}

function createStartupEchoFilter(command) {
  const needle = String(command || '').trim();
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const echoLine = new RegExp(`(?:\\x1b\\[[0-9;?]*[ -/]*[@-~])*${escaped}(?:\\r\\n|\\n|\\r)`);
  let buffer = '';
  let done = false;
  const maxBuffer = Math.max(2048, needle.length + 512);
  return {
    get done() {
      return done;
    },
    push(data) {
      if (done || !needle) return data;
      buffer += data;
      const match = echoLine.exec(buffer);
      if (match) {
        done = true;
        const before = buffer.slice(0, match.index);
        const after = buffer.slice(match.index + match[0].length);
        buffer = '';
        return before + after;
      }
      if (buffer.length > maxBuffer || /\n/.test(buffer)) {
        done = true;
        const out = buffer;
        buffer = '';
        return out;
      }
      return '';
    }
  };
}

function defaultShell() {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'powershell.exe', args: [] };
  return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] };
}

function stopTerminal(id, opts = {}) {
  if (pinnedTerminals.has(id) && !opts.force) {
    // Caller asked for a soft stop but pin guards the PTY. Surface this
    // so callers (Dock cleanup, future GC) can tell "skipped due to pin"
    // apart from "already gone" — both used to look like void.
    return { ok: true, stopped: false, pinned: true };
  }
  const t = terminals.get(id);
  if (!t) return { ok: true, stopped: false, pinned: false };
  try {
    t.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  } catch {}
  terminals.delete(id);
  terminalBacklogs.delete(id);
  pinnedTerminals.delete(id);
  if (ptyProjectTracker) ptyProjectTracker.unregisterPty(id);
  const win = detachedTerminalWindows.get(id);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true, stopped: true, pinned: false };
}

async function gitSummary() {
  const [remote, status, bootstrap] = await Promise.all([
    getDaemon('/v1/git-remote', 4000),
    getDaemon('/v1/git/status', 4000),
    getDaemon('/v1/bootstrap-status', 4000)
  ]);
  return {
    remote: remote.ok ? remote.data : null,
    status: status.ok ? status.data : null,
    bootstrap: bootstrap.ok ? bootstrap.data : null,
    errors: {
      remote: remote.ok ? '' : remote.error,
      status: status.ok ? '' : status.error,
      bootstrap: bootstrap.ok ? '' : bootstrap.error
    }
  };
}

async function gitBootstrap(payload) {
  const body = {
    git_url: String(payload && payload.gitUrl || payload && payload.git_url || '').trim(),
    username: String(payload && payload.username || ''),
    password: String(payload && payload.password || ''),
    flatten: Boolean(payload && payload.flatten)
  };
  if (!body.git_url) throw new Error('git_url required');
  const res = await postDaemon('/v1/bootstrap', body, 10000);
  if (!res.ok) throw new Error(res.error || 'bootstrap failed');
  return res.data;
}

async function forceUpload(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const cfg = await loadStoredConfig();
  // B11: /v1/force-upload is purely legacy filesync; Syncthing has no
  // equivalent. The path-scoped sync flow (addOverride +
  // FT-Task-6's path-scoped snapshot upload) is the replacement. Until
  // FT-Task-6 lands, the user can still get the same outcome by adding
  // an "always sync this path" override via the file-tree context menu;
  // the next regular sync includes the path. Refuse here so the
  // renderer's old force-upload button surfaces a clear error instead
  // of silently hitting an unsupported endpoint.
  if (isSyncthingBackend(cfg)) {
    const err = new Error('force-upload is not supported for syncthing-backed workspaces; use the file-tree "Always sync this path" action instead');
    err.code = 'force_upload_unsupported_for_syncthing';
    throw err;
  }
  const safe = list.map((p) => assertInsideWorkspace(cfg.workspaceRoot, p));
  const res = await postDaemon('/v1/force-upload', { paths: safe }, 10000);
  if (!res.ok) throw new Error(res.error || 'force-upload failed');
  return res.data;
}

async function fetchWorkspaceContainer() {
  const cfg = await loadStoredConfig();
  const activationCode = decryptActivationCode(cfg);
  if (!cfg.serverAddr || !activationCode) throw new Error('缺少 serverAddr 或 activation code');
  const base = kariServerBaseUrl(cfg.serverAddr);
  const response = await fetch(`${base}/api/container`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${activationCode}`
    },
    body: JSON.stringify({ workspace_name: cfg.workspaceName || 'workspace' })
  });
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    if (body && body.error === 'container_disabled') return { disabled: true, message: body.message || '管理员已禁用云端环境' };
  }
  if (!response.ok) throw new Error(await httpErrorMessage(response));
  return response.json();
}

function kariServerBaseUrl(serverAddr) {
  const raw = String(serverAddr || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

async function rotateFRPWithActivationCode() {
  const cfg = await loadStoredConfig();
  const activationCode = decryptActivationCode(cfg);
  if (!cfg.managementUrl || !activationCode) throw new Error('缺少 management URL 或 activation code');
  const response = await fetch(`${cfg.managementUrl.replace(/\/$/, '')}/api/resolve/frp/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      activation_code: activationCode,
      client_id: cfg.clientId || machineClientId(),
      local_user: os.userInfo().username || ''
    })
  });
  if (!response.ok) throw new Error(await httpErrorMessage(response));
  const payload = await response.json();
  if (!payload || !payload.frp || !payload.frp.enabled) throw new Error('管理端没有返回可用的 frp 配置');
  await saveStoredConfig({ frp: payload.frp });
  return payload;
}

async function reverseProxyAction(action) {
  if (action === 'stop') {
    const res = await postDaemon('/v1/reverse-proxy/stop', {}, 8000);
    if (!res.ok) throw new Error(res.error || 'reverse proxy stop failed');
    return res.data;
  }
  let cfg = await loadStoredConfig();
  let frp = cfg.frp;
  let tokenRotated = false;
  if (action === 'refresh' || !frp || !frp.enabled) {
    const rotated = await rotateFRPWithActivationCode();
    frp = rotated.frp;
    tokenRotated = true;
  }
  const container = await fetchWorkspaceContainer();
  if (!container || container.disabled) throw new Error(container && container.message || '当前账号未分配云端环境');
  const publicKey = container.client_pub_key || container.clientPublicKey || container.client_public_key;
  if (!publicKey) throw new Error('云端 PTY 公钥尚未就绪');
  // Phase 4.6: just wait for kari-syncd to be reachable (no /v1/bind
  // needed for the reverse-proxy endpoints — they don't depend on a
  // workspace bind).
  await ensureDaemonRunning();
  const body = {
    container_id: container.container_id || container.id || container.name,
    public_key: publicKey,
    frp,
    token_rotated: tokenRotated
  };
  const route = action === 'refresh' ? '/v1/reverse-proxy/refresh' : '/v1/reverse-proxy/start';
  const res = await postDaemon(route, body, 30000);
  if (!res.ok) throw new Error(res.error || 'reverse proxy failed');
  return res.data;
}

async function copyReverseProxyInfo() {
  const cfg = await loadStoredConfig();
  const text = reverseProxyInfoText(cfg.frp, os.userInfo().username || 'user');
  if (!text) throw new Error('反代理连接信息不完整');
  clipboard.writeText(text);
  return { ok: true, text };
}

function reverseProxyInfoText(cfg, localUser) {
  if (!cfg || !cfg.server_addr || !cfg.remote_port) return '';
  const user = String(localUser || 'user').trim() || 'user';
  return [
    `export KARI_LOCAL_SSH_HOST=${posixShellQuote(cfg.server_addr)}`,
    `export KARI_LOCAL_SSH_PORT=${posixShellQuote(cfg.remote_port)}`,
    `export KARI_LOCAL_SSH_USER=${posixShellQuote(user)}`,
    `export KARI_LOCAL_SSH_KEY=${posixShellQuote('/root/.ssh/kari_client_ed25519')}`,
    '',
    'ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i "$KARI_LOCAL_SSH_KEY" "$KARI_LOCAL_SSH_USER@$KARI_LOCAL_SSH_HOST" -p "$KARI_LOCAL_SSH_PORT"'
  ].join('\n');
}

function posixShellQuote(value) {
  const s = String(value == null ? '' : value);
  if (s === '') return "''";
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

async function getCapabilities() {
  const cfg = await loadStoredConfig();
  const activationCode = decryptActivationCode(cfg);
  if (!cfg.managementUrl || !activationCode) return { ok: false, error: 'missing management URL or activation code' };
  const direct = await postDaemon('/v1/capabilities', {
    management_url: cfg.managementUrl,
    activation_code: activationCode
  }, 8000);
  if (direct.ok) {
    await saveStoredConfig({ capabilities: direct.data });
    return { ok: true, data: direct.data };
  }
  const response = await fetch(`${cfg.managementUrl.replace(/\/$/, '')}/api/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activation_code: activationCode })
  });
  if (!response.ok) return { ok: false, error: await httpErrorMessage(response) };
  const data = await response.json();
  await saveStoredConfig({ capabilities: data });
  return { ok: true, data };
}

async function getModelKeys() {
  const cfg = await loadStoredConfig();
  if (!cfg.managementUrl) return { ok: false, error: 'missing management URL' };
  const base = cfg.managementUrl.replace(/\/$/, '');
  const tenantToken = decryptTenantClientToken(cfg);
  let response;
  if (cfg.tenantClientId && tenantToken) {
    response = await fetch(`${base}/api/tenant/clients/model-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.tenantClientId, client_token: tenantToken })
    });
  } else {
    const activationCode = decryptActivationCode(cfg);
    if (!activationCode) return { ok: false, error: 'missing activation code' };
    response = await fetch(`${base}/api/model-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activation_code: activationCode })
    });
  }
  if (!response.ok) return { ok: false, error: await httpErrorMessage(response) };
  const payload = await response.json();
  return { ok: true, data: Array.isArray(payload) ? payload : (payload.model_keys || payload.continue_models || []) };
}

async function httpErrorMessage(response) {
  const text = await response.text().catch(() => '');
  return text.trim() || `HTTP ${response.status}`;
}

module.exports.__test = {
  createTerminal,
  defaultProjectsRoot,
  ensureLocalWorkspaceContainer,
  dismissDiscoveredProject,
  resolveDismissibleDir,
  hasDiscoveryIgnoredMarker,
  listLocalProjects,
  terminalCwd,
  terminalProjectRoot,
  writeWorkspaceOwnershipTag,
};
