'use strict';

const path = require('node:path');

const KARI_FOLDER_PREFIX = 'kari1_';
const KARI_CONTAINER_DIR = 'kari-drive';

function cleanName(value) { return String(value || '').trim(); }

// folderLooksLikeSameProject: a Syncthing folder is a candidate for the named
// project when it is kari-managed (id prefix) AND its label or path-basename
// matches the workspace name. Name match alone is intentionally weak — the
// caller pairs it with statusLooksIdleAndComplete + a kari-drive shape check +
// (at runtime) a Kari ownership tag, before adopting.
function folderLooksLikeSameProject(folder, workspaceName) {
  const wanted = cleanName(workspaceName);
  if (!wanted || !folder || typeof folder !== 'object') return false;
  if (!cleanName(folder.id).startsWith(KARI_FOLDER_PREFIX)) return false;
  if (cleanName(folder.label) === wanted) return true;
  const folderPath = cleanName(folder.path);
  return folderPath ? path.basename(path.resolve(folderPath)) === wanted : false;
}

// statusLooksIdleAndComplete: a folder is a safe local baseline only when its
// /rest/db/status shows idle with zero outstanding need + no errors.
function statusLooksIdleAndComplete(status) {
  if (!status || typeof status !== 'object') return false;
  if (String(status.state || '').toLowerCase() !== 'idle') return false;
  if (Number(status.errors || 0) > 0) return false;
  if (Number(status.pullErrors || 0) > 0) return false;
  // Require the core need counters to be PRESENT. A partial response (e.g. a
  // bare { state: 'idle' } with no need* fields) must NOT pass as complete —
  // `Number(undefined || 0) === 0` would otherwise read "unknown" as "synced".
  if (status.needBytes == null || status.needTotalItems == null) return false;
  return Number(status.needBytes || 0) === 0
    && Number(status.needFiles || 0) === 0
    && Number(status.needDirectories || 0) === 0
    && Number(status.needSymlinks || 0) === 0
    && Number(status.needDeletes || 0) === 0
    && Number(status.needTotalItems || 0) === 0;
}

// storageBaseDirForAdoptedProjectPath: returns the <storageBaseDir> for a path
// shaped like <base>/kari-drive/<name>, or '' when the path is not under a
// kari-drive container. Doubles as the "is this an adoptable Kari path?"
// predicate (non-empty == adoptable shape). Restricting adoption to this shape
// keeps the selection scope equal to the success-wait's support scope — an
// out-of-container adopted path would make projectRelPathFromRootBase() empty
// and (pre-Phase-0) falsely succeed, (post-Phase-0) fail the job.
function storageBaseDirForAdoptedProjectPath(projectPath) {
  const resolved = cleanName(projectPath) ? path.resolve(projectPath) : '';
  if (!resolved) return '';
  const projectsRoot = path.dirname(resolved);
  if (path.basename(projectsRoot) !== KARI_CONTAINER_DIR) return '';
  return path.dirname(projectsRoot);
}

// chooseAdoptableSyncthingFolder: from the full folder list + their statuses,
// pick the single idle same-name kari-drive-shaped folder (excluding the
// current workspace's own folder). Ambiguity (>1) is rejected rather than
// guessed.
function chooseAdoptableSyncthingFolder({ workspaceName, currentFolderId, folders, statusesByFolderId } = {}) {
  const current = cleanName(currentFolderId);
  const wanted = cleanName(workspaceName);
  const statuses = statusesByFolderId instanceof Map ? statusesByFolderId : new Map();
  const candidates = (Array.isArray(folders) ? folders : []).filter((folder) => {
    if (!folderLooksLikeSameProject(folder, workspaceName)) return false;
    if (cleanName(folder.id) === current) return false;
    // Selection scope == success-wait support scope: only <base>/kari-drive/<name>.
    const folderPath = cleanName(folder.path);
    if (!storageBaseDirForAdoptedProjectPath(folderPath)) return false;
    // The adopted DIRECTORY must itself be named after the workspace. A
    // label-only same-project match (folderLooksLikeSameProject accepts a
    // label match) could otherwise let us adopt <base>/kari-drive/OTHER for
    // workspace "kari" — pairing the wrong location. Require the path basename
    // to equal the workspace name.
    if (path.basename(path.resolve(folderPath)) !== wanted) return false;
    return statusLooksIdleAndComplete(statuses.get(cleanName(folder.id)));
  });
  if (candidates.length === 0) return { ok: false, code: 'no_adoptable_folder' };
  if (candidates.length > 1) return { ok: false, code: 'ambiguous_adoptable_folder', candidates };
  return { ok: true, folder: candidates[0] };
}

module.exports = {
  folderLooksLikeSameProject,
  statusLooksIdleAndComplete,
  storageBaseDirForAdoptedProjectPath,
  chooseAdoptableSyncthingFolder,
};
