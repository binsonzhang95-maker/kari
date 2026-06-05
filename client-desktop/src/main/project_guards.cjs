// PR2 Phase 1 commit 5 round-fix — pure helpers for the cloud-only
// product boundary (locked: cloud project must be downloaded before
// the user can open it in Files view).
//
// Lives in its own module so:
//   1. Both main.cjs (openProject + downloadProject) and tests can
//      import via plain require.
//   2. Tests don't drag in Electron's runtime — these are pure
//      logical predicates.
//   3. Future renderer-side TypeScript helpers can keep their
//      isCloudOnlyNotDownloaded twin in App.tsx without divergence:
//      both express the same predicate.

'use strict';

const fsp = require('fs/promises');
const path = require('path');

// Round-1 review fix #2: downloadProject writes this marker file
// INTO the mirror dir at mkdir time. listServerProjects reads it
// to gate existsLocal — a mirror dir with the marker is "started
// but not confirmed complete" and the openProject guard still
// fires. The marker is only removed once daemonSnapshot observes
// confirmed sync completion (cache phase=synced via disappeared
// transfer rows OR daemon's last_sync_at advancing past the
// download's triggeredAt). Until then, existsLocal stays false
// and the user can't enter the project.
//
// This closes the "/v1/sync-once only triggers, doesn't await
// completion" gap reviewer identified.
//
// Round-2 review fix #1 (marker placement): the marker lives
// under .kari-engine/desktop-download-incomplete, NOT at the
// mirror root. The filesync engine excludes .kari-engine/... from
// sync (it's the engine's internal state dir); a root-level
// .kari-download-incomplete would be uploaded to the server, then
// propagate to other clients, AND — worse — /v1/sync-once might
// "complete" by syncing only the marker, triggering the cache's
// disappeared-row→synced derivation and prematurely flipping
// existsLocal=true on a still-empty mirror.
const DOWNLOAD_INCOMPLETE_MARKER_REL = path.join('.kari-engine', 'desktop-download-incomplete');
const DOWNLOAD_COMPLETE_MARKER_REL = path.join('.kari-engine', 'desktop-download-complete');

// Export the relative path for tests + operator inspection. The
// absolute path is computed via markerPathFor; callers should not
// reassemble it.
const DOWNLOAD_INCOMPLETE_MARKER = DOWNLOAD_INCOMPLETE_MARKER_REL;
const DOWNLOAD_COMPLETE_MARKER = DOWNLOAD_COMPLETE_MARKER_REL;

// markerPathFor builds the absolute path to the marker inside one
// mirror dir. The marker lives under <mirror>/.kari-engine/ — that
// dir is filesync-internal and will NOT be uploaded to the server.
function markerPathFor(mirrorPath) {
  return path.join(mirrorPath, DOWNLOAD_INCOMPLETE_MARKER_REL);
}

function completeMarkerPathFor(mirrorPath) {
  return path.join(mirrorPath, DOWNLOAD_COMPLETE_MARKER_REL);
}

function mirrorPathFromMarkerPath(markerPath) {
  return path.dirname(path.dirname(markerPath));
}

// hasIncompleteMarker returns true when the mirror dir contains the
// download-incomplete marker. Used by listServerProjects to compute
// existsLocal as "dir exists AND no marker". Both readability via
// fsp.stat must succeed for true — anything else (ENOENT, EACCES,
// etc.) returns false (the marker isn't present from our POV).
async function hasIncompleteMarker(mirrorPath) {
  if (!mirrorPath) return false;
  const stat = await fsp.stat(markerPathFor(mirrorPath)).catch(() => null);
  return Boolean(stat);
}

async function hasDownloadCompleteMarker(mirrorPath) {
  if (!mirrorPath) return false;
  const stat = await fsp.stat(completeMarkerPathFor(mirrorPath)).catch(() => null);
  return Boolean(stat);
}

// writeIncompleteMarker creates the marker file. Idempotent — re-
// triggering a download writes the same marker; calling on an
// already-marked dir is a no-op.
//
// Round-2 review fix #1: the marker lives under .kari-engine/, so
// we have to mkdir that parent dir first. The filesync engine
// would normally create it on its own, but downloadProject runs
// BEFORE the daemon binds the workspace; we can't depend on the
// engine having booted yet. mkdir -p is idempotent — a later
// engine-side mkdir of .kari-engine/ is harmless.
async function writeIncompleteMarker(mirrorPath) {
  if (!mirrorPath) throw new Error('mirrorPath required');
  const markerPath = markerPathFor(mirrorPath);
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  await fsp.writeFile(markerPath, '', { flag: 'w' });
}

async function writeDownloadCompleteMarker(mirrorPath) {
  if (!mirrorPath) throw new Error('mirrorPath required');
  const markerPath = completeMarkerPathFor(mirrorPath);
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  await fsp.writeFile(markerPath, '', { flag: 'w' });
}

// removeIncompleteMarker deletes the marker if present. ENOENT
// is swallowed (the marker is gone — that's the goal). Other
// errors propagate so callers can decide whether to retry.
async function removeIncompleteMarker(mirrorPath) {
  if (!mirrorPath) return;
  try {
    await fsp.unlink(markerPathFor(mirrorPath));
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

async function removeDownloadCompleteMarker(mirrorPath) {
  if (!mirrorPath) return;
  try {
    await fsp.unlink(completeMarkerPathFor(mirrorPath));
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

// isCloudOnlyNotDownloaded matches the renderer twin in
// src/renderer/App.tsx. A cloud project is "not downloaded" when:
//   - source === 'cloud' (came from server-side workdirs listing)
//   - existsLocal !== true (mirror dir NOT confirmed complete locally)
//
// Round-1 review fail-closed fix: `existsLocal === false` only caught
// the explicit-false case. Cloud projects with missing/undefined/
// null existsLocal would slip past the guard and openProject would
// proceed to mkdir an empty mirror, which subsequent listProjects
// would then misread as "downloaded" (mkdir leftover) and silently
// elide the guard for next clicks. Strict `!== true` is fail-closed:
// only the confirmed-true case opens the project; everything else
// (false / undefined / null / "true"-as-string / etc.) routes to
// download.
//
// projectMeta=null or non-object returns false — these are not the
// guard's concern (openProject's other path handlers cover them).
function isCloudOnlyNotDownloaded(projectMeta) {
  if (!projectMeta || typeof projectMeta !== 'object') return false;
  // Syncthing-native Phase 1: if main has computed connectionState
  // (always true for projects produced by listProjects), the
  // openable field is the authoritative signal. A syncthing-backed
  // mirror with a healthy local dir but no filesync completion
  // markers gets existsLocal=false yet openable=true — honor that
  // and let openProject through. Codex round 7 P1 pin.
  if (projectMeta.connectionState && typeof projectMeta.connectionState === 'object') {
    return projectMeta.connectionState.openable !== true;
  }
  return projectMeta.source === 'cloud' && projectMeta.existsLocal !== true;
}


// isCloudDownloadInProgress gates cloud project entry while the
// FIRST-DOWNLOAD pipeline is still running. After Ultraplan medium
// #4 ("已下载云端项目允许立即打开，即便后台同步在跑"), this
// predicate only fires when the project's local mirror hasn't been
// confirmed downloaded yet (existsLocal !== true). Background sync
// over an already-downloaded mirror does NOT block open.
function isCloudDownloadInProgress(projectMeta) {
  if (!projectMeta || typeof projectMeta !== 'object') return false;
  // Syncthing-native Phase 1: prefer connectionState when present.
  // Openable projects (any backend) are not "download-in-progress"
  // even if a background sync is running.
  if (projectMeta.connectionState && typeof projectMeta.connectionState === 'object') {
    const s = projectMeta.connectionState;
    if (s.openable) return false;
    return (
      s.availability === 'provisioning' &&
      (s.syncState === 'syncing' || s.syncState === 'scanning')
    );
  }
  if (projectMeta.source !== 'cloud') return false;
  if (projectMeta.existsLocal === true) return false;
  const sync = projectMeta.sync && typeof projectMeta.sync === 'object' ? projectMeta.sync : null;
  const phase = sync && typeof sync.phase === 'string' ? sync.phase : '';
  return phase === 'scanning' || phase === 'binding' || phase === 'downloading';
}

// cloudNotDownloadedResponse is the canonical { ok:false, code,
// error } shape openProject returns when the guard fires. Centralized
// here so callers + tests assert against the same code string.
function cloudNotDownloadedResponse() {
  return {
    ok: false,
    code: 'cloud_project_not_downloaded',
    error: '云端项目尚未下载到本机，请先点击"下载到本机"。',
  };
}

// projectMetaSufficient returns true when projectMeta carries enough
// info for isCloudOnlyNotDownloaded to make a reliable judgment. If
// false, main openProject must cross-check the cloud projects list
// itself (round-2 review fix #2). The bare requirement is having
// `source` so we know whether the project is cloud or local in the
// first place.
function projectMetaSufficient(projectMeta) {
  return Boolean(
    projectMeta &&
      typeof projectMeta === 'object' &&
      typeof projectMeta.source === 'string' &&
      projectMeta.source.length > 0
  );
}

module.exports = {
  isCloudOnlyNotDownloaded,
  isCloudDownloadInProgress,
  cloudNotDownloadedResponse,
  projectMetaSufficient,
  DOWNLOAD_INCOMPLETE_MARKER,
  DOWNLOAD_COMPLETE_MARKER,
  markerPathFor,
  completeMarkerPathFor,
  mirrorPathFromMarkerPath,
  hasIncompleteMarker,
  hasDownloadCompleteMarker,
  writeIncompleteMarker,
  writeDownloadCompleteMarker,
  removeIncompleteMarker,
  removeDownloadCompleteMarker,
};
