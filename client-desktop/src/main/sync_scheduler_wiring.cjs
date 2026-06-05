'use strict';

// sync_scheduler_wiring — adapts the sync_scheduler (T5) pairWorker
// contract to the existing main.cjs syncthing primitives.
//
// Plan T6 keeps main.cjs from bloating further: the wiring module
// builds the pairWorker + resolveProject hooks out of dependency-
// injected primitives (loadStoredConfig / syncthing_pair / etc.). main.cjs
// passes the live deps; tests pass fakes.
//
// pairWorker contract (sync_scheduler.cjs):
//   activate({ projectAbsPath, projectRelPath }) → { ok, folderId } | { ok:false, code }
//   retire({ projectAbsPath, folderId })          → { ok }            | { ok:false, code }
//
// resolveProject contract (sync_scheduler.cjs):
//   resolveProject(projectAbsPath) → { projectRelPath } | null
//
// The wiring intentionally short-circuits at every "not bound / not
// configured" guard so a sync_scheduler running before activation has
// completed (or after logout) emits sync:activate:failed with a clear
// code rather than hanging on a HTTP round-trip.

const path = require('node:path');

function workspaceNameFromProjectRelPath(projectRelPath) {
  let rel = String(projectRelPath || '').trim().replace(/\\/g, '/');
  rel = rel.replace(/\/{2,}/g, '/');
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (!rel || rel === '.' || rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)) return '';
  const first = rel.split('/').find(Boolean) || '';
  if (!first || first === '.' || first === '..') return '';
  return first;
}

function createSyncSchedulerWiring(deps = {}) {
  const {
    loadStoredConfig,
    decryptActivationCode,
    defaultProjectsRoot,
    startSyncthingChild,
    syncthingProcess,
    syncthingPair,
    syncthingClient,
    writeStignoreFile,
    getEffectiveSyncMode,
    getIncludeSetForProject,
  } = deps;

  if (typeof loadStoredConfig !== 'function') {
    throw new Error('sync_scheduler_wiring: loadStoredConfig is required');
  }
  if (typeof defaultProjectsRoot !== 'function') {
    throw new Error('sync_scheduler_wiring: defaultProjectsRoot is required');
  }
  if (!syncthingPair || typeof syncthingPair.requestPairInfo !== 'function') {
    throw new Error('sync_scheduler_wiring: syncthingPair with requestPairInfo + applyPairInfoLocally is required');
  }

  // resolveProject:
  //   - cfg missing / not activated / no projectsRoot → null (skip)
  //   - projectAbsPath OUTSIDE the kari container       → null (skip)
  //   - projectAbsPath IS the container itself          → null (skip)
  //   - otherwise return { projectRelPath: relative-from-container }
  //
  // The "outside the container" filter is the key safety net: a PTY's
  // cwd can be anywhere on disk, but only paths under projectsRoot are
  // ours to sync. Sync activation for /home/user/random-repo would
  // silently install a kari syncthing folder there, which is wrong.
  async function resolveProject(projectAbsPath) {
    const cfg = await loadStoredConfig().catch(() => null);
    if (!cfg || !cfg.workspaceId) return null;
    const projectsRoot = defaultProjectsRoot(cfg);
    if (!projectsRoot) return null;
    const containerRoot = path.resolve(projectsRoot);
    const target = path.resolve(projectAbsPath);
    if (target === containerRoot) return null;
    const rel = path.relative(containerRoot, target);
    // path.relative returns '..' or '../..' etc. when target is outside
    // containerRoot. Treat anything starting with '..' as outside.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    // Normalise to POSIX separators — syncthing_pair.folderIdFor +
    // server-side FolderIDFor both canonicalise \ → /, but sending the
    // POSIX form keeps logs readable on Windows too.
    return { projectRelPath: rel.split(path.sep).join('/') };
  }

  // Build a fresh activate() bound to the live cfg / syncthing meta.
  // Returns { ok, folderId } on success; { ok:false, code, message? }
  // on every failure path. Never throws — the scheduler treats throws
  // the same way as ok:false but with code 'activate_threw'.
  async function activate({ projectAbsPath, projectRelPath } = {}) {
    if (!projectAbsPath) return { ok: false, code: 'missing_project_abs_path' };
    if (!projectRelPath) return { ok: false, code: 'missing_project_rel_path' };

    const cfg = await loadStoredConfig().catch(() => null);
    if (!cfg || !cfg.serverAddr || !cfg.workspaceId || !cfg.workspaceName) {
      return { ok: false, code: 'not_activated' };
    }
    const pairingWorkspaceName = workspaceNameFromProjectRelPath(projectRelPath) || cfg.workspaceName;
    const activationCode = typeof decryptActivationCode === 'function'
      ? decryptActivationCode(cfg)
      : '';
    if (!activationCode) {
      return { ok: false, code: 'no_activation_code' };
    }

    // Ensure syncthing child is up; restart only if the SOCKS5 proxy
    // address moved (matches schedulePairAfterActivation policy).
    if (typeof startSyncthingChild === 'function') {
      const startResult = await startSyncthingChild({ cfg, activationCode, restartIfProxyChanged: true }).catch((err) => ({ ok: false, reason: 'start_threw', error: String(err && err.message || err) }));
      if (!startResult || !startResult.ok) {
        return { ok: false, code: 'syncthing_not_ready', message: startResult && startResult.reason };
      }
    }

    const meta = syncthingProcess && typeof syncthingProcess.getRunningMeta === 'function'
      ? syncthingProcess.getRunningMeta()
      : null;
    if (!meta || !meta.deviceId || !meta.guiAddress || !meta.apiKey) {
      return { ok: false, code: 'syncthing_no_meta' };
    }

    const pairResult = await syncthingPair.requestPairInfo({
      serverAddr: cfg.serverAddr,
      activationCode,
      desktopDeviceId: meta.deviceId,
      desktopName: cfg.machineLabel,
      // Single-tenant: pair by the same (workspace_id, workspace_name) the PTY
      // uses, so the project folder lands as a subdir of the terminal's cwd
      // tree (<wsid>/<wsname>/<projectRelPath>). pairingWorkspaceName (derived
      // from the project path) is intentionally NOT used here.
      workspaceId: cfg.workspaceId,
      workspaceName: cfg.workspaceName,
      projectRelPath,
      desktopAddresses: [],
    }).catch((err) => ({ ok: false, code: 'request_pair_info_threw', message: String(err && err.message || err) }));
    if (!pairResult || !pairResult.ok) {
      return {
        ok: false,
        code: 'request_pair_info_failed',
        message: pairResult ? `${pairResult.code || ''} ${pairResult.message || ''}`.trim() : 'no response',
      };
    }

    // Mode + override resolution — best-effort so a metadata read
    // failure doesn't block the pair.
    const identity = {
      serverAddr: cfg.serverAddr,
      workspaceId: cfg.workspaceId,
      workspaceName: pairingWorkspaceName,
      // Carry the project rel path so future mode-per-project policies
      // can key on it. Today getEffectiveSyncMode ignores extra fields.
      projectRelPath,
    };
    const mode = typeof getEffectiveSyncMode === 'function'
      ? await getEffectiveSyncMode(identity).catch(() => 'lightweight')
      : 'lightweight';
    const includeOverrides = typeof getIncludeSetForProject === 'function'
      ? await getIncludeSetForProject(identity).catch(() => new Set())
      : new Set();

    const apply = await syncthingPair.applyPairInfoLocally({
      creds: { guiAddress: meta.guiAddress, apiKey: meta.apiKey },
      localDeviceId: meta.deviceId,
      pairInfo: pairResult.body,
      folderPath: projectAbsPath,
      stignoreWriter: typeof writeStignoreFile === 'function' ? writeStignoreFile : null,
      stignoreArgs: { mode, includeOverrides },
    }).catch((err) => ({ ok: false, code: 'apply_pair_threw', message: String(err && err.message || err) }));
    if (!apply || !apply.ok) {
      try { console.warn('[syncthing-pair] applyPairInfoLocally failed:', JSON.stringify(apply)); } catch {}
      return {
        ok: false,
        code: 'apply_pair_failed',
        message: apply ? (apply.code || '') : 'no response',
      };
    }

    return {
      ok: true,
      folderId: pairResult.body && pairResult.body.folder_id,
    };
  }

  // retire() removes the syncthing folder entry. Files on disk are
  // never touched. Returning ok:true on no-folder makes the scheduler's
  // stop()/eviction code simpler: never had a folder → nothing to clean.
  async function retire({ projectAbsPath, folderId } = {}) {
    if (!folderId) return { ok: true, skipped: 'no_folder_id' };
    if (!syncthingClient || typeof syncthingClient.deleteFolder !== 'function') {
      return { ok: false, code: 'syncthing_client_unavailable' };
    }
    const meta = syncthingProcess && typeof syncthingProcess.getRunningMeta === 'function'
      ? syncthingProcess.getRunningMeta()
      : null;
    if (!meta || !meta.guiAddress || !meta.apiKey) {
      // Syncthing already gone; nothing for us to do. Don't treat this
      // as a failure — the next syncthing start scans clean state anyway.
      return { ok: true, skipped: 'syncthing_not_running' };
    }
    const r = await syncthingClient.deleteFolder({ guiAddress: meta.guiAddress, apiKey: meta.apiKey }, folderId).catch((err) => ({ ok: false, status: 0, error: String(err && err.message || err) }));
    if (!r || !r.ok) {
      return { ok: false, code: 'delete_folder_failed', status: r && r.status, message: r && r.error };
    }
    return { ok: true };
  }

  return {
    resolveProject,
    pairWorker: { activate, retire },
  };
}

module.exports = { createSyncSchedulerWiring };
