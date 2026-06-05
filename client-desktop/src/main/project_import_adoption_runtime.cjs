'use strict';

const path = require('node:path');
const {
  chooseAdoptableSyncthingFolder,
  storageBaseDirForAdoptedProjectPath,
} = require('./project_import_adoption.cjs');

// findAdoptableIdleSyncthingProject — runtime discovery of a previous
// activation's idle, fully-synced Kari mirror so the current import can adopt
// it instead of re-copying. I/O is injected via `deps` so this is unit-testable
// without booting Electron / a real Syncthing.
//
// deps:
//   isSyncthingBackend(cfg) -> bool
//   getRunningMeta() -> { guiAddress, apiKey } | null
//   getFolders(creds) -> { ok, body: folder[] }
//   getDbStatus(creds, folderId) -> { ok, body: status }
//   statIsDirectory(absPath) -> Promise<bool>
//   hasUserProjectContent(absPath) -> Promise<bool>
//   readWorkspaceOwnershipTag(absPath) -> Promise<{ workspaceId } | null>
//
// Returns { ok: true, path, folder } or { ok: false, code, ... }.
async function findAdoptableIdleSyncthingProject({ cfg, workspaceName, currentFolderId, currentTargetPath } = {}, deps = {}) {
  const {
    isSyncthingBackend,
    getRunningMeta,
    getFolders,
    getDbStatus,
    statIsDirectory,
    hasUserProjectContent,
    readWorkspaceOwnershipTag,
  } = deps;

  const wanted = String(workspaceName || '').trim();
  const current = String(currentFolderId || '').trim();
  if (!cfg || !wanted || !current) return { ok: false, code: 'missing_input' };
  if (typeof isSyncthingBackend === 'function' && !isSyncthingBackend(cfg)) {
    return { ok: false, code: 'not_syncthing' };
  }
  const meta = typeof getRunningMeta === 'function' ? getRunningMeta() : null;
  if (!meta || !meta.guiAddress || !meta.apiKey) return { ok: false, code: 'syncthing_not_running' };
  const creds = { guiAddress: meta.guiAddress, apiKey: meta.apiKey };

  const foldersResult = await Promise.resolve()
    .then(() => getFolders(creds))
    .catch((err) => ({ ok: false, error: String(err && err.message || err) }));
  if (!foldersResult || !foldersResult.ok || !Array.isArray(foldersResult.body)) {
    return { ok: false, code: 'folders_unavailable' };
  }

  // This finder is for CROSS-base adoption only. A same-base existing mirror
  // (the normal target path) is already handled by decideExistingImportTarget
  // in importLocalProject — adopting it here would bypass that gate. Exclude it.
  const normalTarget = currentTargetPath ? path.resolve(String(currentTargetPath)) : '';
  // Status is fetched ONLY for same-name, kari-drive-shaped, correctly-named,
  // cross-base candidates — never N+1 over every folder.
  const candidates = foldersResult.body.filter((f) => {
    if (!f || !f.id || String(f.id) === current) return false;
    const p = String(f.path || '');
    if (!storageBaseDirForAdoptedProjectPath(p)) return false;
    if (normalTarget && path.resolve(p) === normalTarget) return false;
    return path.basename(path.resolve(p)) === wanted;
  });
  const statusesByFolderId = new Map();
  for (const folder of candidates) {
    const statusResult = await Promise.resolve()
      .then(() => getDbStatus(creds, folder.id))
      .catch(() => null);
    if (statusResult && statusResult.ok) statusesByFolderId.set(String(folder.id), statusResult.body);
  }

  const choice = chooseAdoptableSyncthingFolder({
    workspaceName: wanted,
    currentFolderId: current,
    folders: foldersResult.body,
    statusesByFolderId,
  });
  if (!choice.ok) return choice;

  const folderPath = path.resolve(String(choice.folder.path || ''));
  if (typeof statIsDirectory === 'function' && !(await statIsDirectory(folderPath).catch(() => false))) {
    return { ok: false, code: 'folder_path_missing' };
  }
  if (typeof hasUserProjectContent === 'function' && !(await hasUserProjectContent(folderPath).catch(() => false))) {
    return { ok: false, code: 'folder_has_no_user_content' };
  }
  // Data-safety gate: only adopt a folder that actually carries a Kari
  // ownership tag (any workspace id). A bare same-name directory is never
  // adopted.
  const ownership = typeof readWorkspaceOwnershipTag === 'function'
    ? await readWorkspaceOwnershipTag(folderPath).catch(() => null)
    : null;
  if (!ownership || !ownership.workspaceId) return { ok: false, code: 'folder_not_kari_owned' };

  return { ok: true, path: folderPath, folder: choice.folder };
}

module.exports = { findAdoptableIdleSyncthingProject };
