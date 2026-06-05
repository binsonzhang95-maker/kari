'use strict';

// Desktop-side pairing helper for the syncthing migration (Phase 1.2(b)).
//
// Three responsibilities:
//
//  1. folderIdForWorkspaceId(workspaceId) — LEGACY workspace-level shape.
//
//       folder_id = "kari1_" + slug(wsid) + "__" + shortsha256(wsid)
//
//     Kept until the sync scheduler (plan T5/T6) reworks the snapshot
//     caller. Boot-time legacy sweep (T8) deletes any folders matching
//     this shape — production installs will only see the per-project
//     shape below.
//
//  2. folderIdFor({ workspaceId, projectRelPath }) — per-project shape.
//
//       folder_id = "kari1_" + slug(wsid) + "__" + slug(proj) + "__"
//                 + shortsha256(wsid + "\x1f" + canonicalProjRel)
//
//     Each project under a workspace gets its own folder slot so the
//     desktop can sync 2-3 projects concurrently driven by PTY presence.
//     projectRelPath is REQUIRED — empty → hard error (no silent
//     fallback to legacy shape).
//
//  3. requestPairInfo + applyPairInfoLocally — the runtime workflow.
//     After activation succeeds, we POST the desktop's syncthing
//     device_id to the trans-server's /api/v1/syncthing/pair-info
//     and then run PutDevice + PutFolder against the local syncthing.
//
// Pure helpers are tested independently; the HTTP / REST side is
// exercised via the existing syncthing_e2e.spec.cjs flow when the
// production pair endpoint lands in test mode.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ALGO_VERSION = 'kari1';
const MAX_FOLDER_ID_LEN = 96;
const HASH_LEN = 12; // first 12 hex chars of sha256

// normalizeServerAddr accepts both "host:port" and "https://host:port"
// shapes (manifest_client + kariServerBaseUrl already tolerate both).
// Returns a trimmed, scheme-prefixed origin URL with no trailing slash.
function normalizeServerAddr(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (s === '') return s;
  if (/^https?:\/\//i.test(s)) return s;
  return 'http://' + s;
}

function slugifyFolderId(input, max) {
  let out = '';
  for (const ch of String(input || '')) {
    const code = ch.codePointAt(0);
    // Same ASCII class as the Go version: A-Z, a-z, 0-9, '.', '_', '-'
    const keep = (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2e || code === 0x5f || code === 0x2d
    );
    out += keep ? ch : '_';
  }
  // Truncate at byte boundary — runes that span the cut are dropped.
  // For ASCII-only inputs (the production workspace_id format) byte ≡ char.
  if (out.length > max) out = out.slice(0, max);
  return out;
}

// folderIdForWorkspaceId is the LEGACY workspace-level folder ID. Kept until
// T5/T6 (sync scheduler) reworks the snapshot caller in
// syncthing_status_snapshot.cjs to be per-project. The boot-time legacy sweep
// (plan T8) deletes any syncthing folders matching this shape, so production
// installs only see project-level IDs from folderIdFor below.
function folderIdForWorkspaceId(workspaceId) {
  const id = String(workspaceId || '');
  const hash = crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, HASH_LEN);
  // Total budget = 96. "kari1_" = 6 + "__" = 2 + hash = 12 → slug ≤ 76.
  const prefix = `${ALGO_VERSION}_`;
  const separator = '__';
  const maxSlug = MAX_FOLDER_ID_LEN - prefix.length - separator.length - HASH_LEN;
  const slug = slugifyFolderId(id, maxSlug);
  return prefix + slug + separator + hash;
}

// folderIdFor returns the per-project syncthing folder ID for a workspace +
// project pair. Each project under a workspace gets its own folder slot, so
// the desktop can keep multiple project folders syncing concurrently. The
// new shape is:
//
//     kari1_<wsSlug>__<projSlug>__<hash12>
//
// where hash12 = first 12 hex of sha256(workspaceId + "\x1f" + projectRelPath).
// The unit separator ensures `wsid="ws-A" + projRel="B/C"` and
// `wsid="ws-A/B" + projRel="C"` produce different hashes even though their
// raw concatenation would coincide.
//
// projectRelPath is the POSIX-style path from the workspace sync root to the
// project root. Required and non-empty — passing "" or null is a hard error
// to prevent silent regression to the legacy workspace-level folder.
//
// Rejects absolute paths, ".." segments, and empty strings. Caller is
// responsible for canonical normalization upstream; this helper only catches
// the malformed inputs it would otherwise hash blindly.
function folderIdFor({ workspaceId, projectRelPath } = {}) {
  const wsid = String(workspaceId || '');
  if (!wsid) {
    throw new Error('folderIdFor: workspaceId is required');
  }
  const rawProj = projectRelPath == null ? '' : String(projectRelPath);
  if (rawProj === '') {
    throw new Error('folderIdFor: projectRelPath is required (empty no longer supported — workspace-level sync is gone)');
  }
  // Canonicalize FIRST, then validate the result. Order matters: inputs like
  // "./" or ".//." would otherwise pass an early "starts with /" check, then
  // canonicalize to "/" or "." behind the validator's back. By stripping
  // "./" + "//" + trailing-"/" up front, every validator below sees the
  // exact string we will hash.
  let canon = rawProj.replace(/\\/g, '/');
  canon = canon.replace(/\/{2,}/g, '/');
  while (canon.startsWith('./')) canon = canon.slice(2);
  while (canon.length > 1 && canon.endsWith('/')) canon = canon.slice(0, -1);
  if (canon === '' || canon === '.') {
    throw new Error('folderIdFor: projectRelPath resolved to empty after normalization');
  }
  if (canon.startsWith('/')) {
    throw new Error('folderIdFor: projectRelPath must be relative, not absolute');
  }
  if (/^[a-zA-Z]:\//.test(canon)) {
    throw new Error('folderIdFor: projectRelPath must be relative, not a drive path');
  }
  for (const seg of canon.split('/')) {
    if (seg === '..') {
      throw new Error('folderIdFor: projectRelPath must not contain ".." segments');
    }
  }

  // Total budget = 96 chars (syncthing folder ID limit):
  //   "kari1_" (6) + wsSlug (≤30) + "__" (2) + projSlug (≤44) + "__" (2) + hash12 (12) = 96
  // ws and proj slugs collide-resistant via the hash tail; the split is
  // cosmetic so operators can `grep kari1_ws-X__projY` in syncthing logs.
  const WS_MAX = 30;
  const PROJ_MAX = 44;
  const prefix = `${ALGO_VERSION}_`;
  const sep = '__';

  const hash = crypto
    .createHash('sha256')
    .update(`${wsid}\x1f${canon}`, 'utf8')
    .digest('hex')
    .slice(0, HASH_LEN);

  const wsSlug = slugifyFolderId(wsid, WS_MAX);
  const projSlug = slugifyFolderId(canon, PROJ_MAX);

  return prefix + wsSlug + sep + projSlug + sep + hash;
}

// requestPairInfo POSTs the desktop's syncthing device_id to the
// server's pair-info endpoint and returns the response shape:
//   { server_device_id, server_addresses, folder_id, folder_path,
//     workspace_id, workspace_name, project_path }
//
// On non-200 it returns { ok:false, status, code, message }. The
// caller decides whether to surface the error to the user.
//
// projectRelPath is REQUIRED — the server side rejects empty
// project_path with 400 missing_project_path (PTY-driven concurrent-
// sync plan T2/T3). We catch missing values here too so callers get a
// fast `missing_project_path` instead of a round-trip 400. Acceptable
// shapes: POSIX-style relative path, Windows separators tolerated and
// normalised server-side (folderIdFor canonicalises).
async function requestPairInfo({ serverAddr, activationCode, desktopDeviceId, desktopName, workspaceId, workspaceName, projectRelPath, desktopAddresses } = {}) {
  if (!serverAddr) return { ok: false, status: 0, code: 'missing_server_addr' };
  if (!activationCode) return { ok: false, status: 0, code: 'missing_activation_code' };
  if (!desktopDeviceId) return { ok: false, status: 0, code: 'missing_device_id' };
  if (!workspaceId) return { ok: false, status: 0, code: 'missing_workspace_id' };
  if (!workspaceName) return { ok: false, status: 0, code: 'missing_workspace_name' };
  if (projectRelPath == null || String(projectRelPath).trim() === '') {
    return { ok: false, status: 0, code: 'missing_project_path' };
  }
  // serverAddr may be a bare host:port; fetch() needs a scheme, so prepend
  // http:// when missing and strip trailing slashes. The single-tenant karid
  // pair endpoint is POST /v1/syncthing/pair (Bearer = shared secret).
  const url = `${normalizeServerAddr(serverAddr)}/v1/syncthing/pair`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${activationCode}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        desktop_device_id: desktopDeviceId,
        desktop_name: String(desktopName || '').trim() || undefined,
        desktop_addresses: Array.isArray(desktopAddresses) ? desktopAddresses : [],
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        project_path: String(projectRelPath).trim(),
      }),
    });
  } catch (err) {
    return { ok: false, status: 0, code: 'fetch_threw', error: String(err && err.message || err) };
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const code = (body && body.code) || 'http_' + response.status;
    return {
      ok: false,
      status: response.status,
      code,
      message: (body && body.message) || response.statusText,
    };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, status: response.status, code: 'bad_response_body' };
  }
  return { ok: true, status: response.status, body };
}

// applyPairInfoLocally calls PutDevice + PutFolder against the LOCAL
// syncthing child using the pair-info response. Mirrors the work the
// syncthing:devPair IPC does, but parameterised so activation:submit
// can call it without going through the dev-gated IPC.
//
// Args:
//   creds:        { guiAddress, apiKey } — from syncthing_process.getRunningMeta
//   localDeviceId: the local syncthing's device id (Devices list needs it too)
//   pairInfo:     { server_device_id, server_addresses, folder_id, ... }
//   folderPath:   the LOCAL path syncthing should mirror into (caller-chosen;
//                 typically <projectsRoot>/.kari-drive/<workspace_name>/)
//   sendreceive:  bool, default true
//   stignoreWriter: optional injected writer (DI for tests). When set,
//                  called BEFORE PutFolder so syncthing's first scan
//                  honours the ignore list (mirrors devPair's
//                  ordering — codex round-4 P2 fix). When omitted, the
//                  step is skipped silently to keep the legacy
//                  surface backwards-compatible.
//   stignoreArgs:  passed through to stignoreWriter — typically
//                  { mode: 'lightweight'|'full', includeOverrides: Set }
//   syncthingClient: the syncthing_client module (DI for tests)
async function applyPairInfoLocally({ creds, localDeviceId, pairInfo, folderPath, sendreceive = true, syncthingClient, stignoreWriter = null, stignoreArgs = null } = {}) {
  if (!creds || !creds.guiAddress || !creds.apiKey) {
    return { ok: false, code: 'missing_creds' };
  }
  if (!localDeviceId) return { ok: false, code: 'missing_local_device_id' };
  if (!pairInfo || !pairInfo.server_device_id || !pairInfo.folder_id) {
    return { ok: false, code: 'invalid_pair_info' };
  }
  if (!folderPath) return { ok: false, code: 'missing_folder_path' };
  const sc = syncthingClient || require('./syncthing_client.cjs');
  const absFolderPath = path.resolve(folderPath);
  const staleDeviceDeletes = [];
  // Phase 4.2 (syncthing migration cleanup): if the local syncthing
  // already has a folder pointing at this exact path but with a
  // different folder_id (typical when the user re-activated against
  // a new workspace), delete the stale entries first. Two folders
  // sharing one filesystem path causes double-rescans + confusing
  // event noise.
  //
  // ALSO: if a folder with the SAME folder_id already exists but at a
  // DIFFERENT path, delete it first (then re-PutFolder below). This is
  // the "user switched projects inside one workspace" case — folder_id
  // is derived from workspaceId so it stays stable across project
  // switches, while folder.path moves. Without dropping the old entry,
  // PutFolder rebinds the in-memory index from path A → path B; syncthing
  // then reconciles B's contents against A's index, which either pulls
  // A's files into B (the symptom reported in field) or propagates
  // spurious deletes to the peer (worse). Drop the folder so the new
  // PutFolder is a clean reinstall — fresh index, no migration step.
  //
  // Best-effort: if GET /rest/config/folders or DELETE fails we log +
  // proceed — the new PutFolder still goes through.
  const staleDeletes = [];
  const rebindDeletes = [];
  try {
    const folders = await sc.getFolders(creds);
    if (folders && folders.ok && Array.isArray(folders.body)) {
      for (const f of folders.body) {
        if (!f || typeof f !== 'object') continue;
        if (!f.id || !f.path) continue;
        const fPath = path.resolve(String(f.path));
        const sameId = f.id === pairInfo.folder_id;
        const samePath = fPath === absFolderPath;
        if (sameId && samePath) continue;
        if (sameId && !samePath) {
          const del = await sc.deleteFolder(creds, f.id);
          rebindDeletes.push({ folderId: f.id, oldPath: fPath, newPath: absFolderPath, ok: !!del.ok, status: del.status });
          if (!del.ok) {
            console.warn('[syncthing-pair] path-rebind delete failed:', f.id, del.status);
          }
          continue;
        }
        if (!sameId && samePath) {
          const del = await sc.deleteFolder(creds, f.id);
          staleDeletes.push({ folderId: f.id, ok: !!del.ok, status: del.status });
          if (!del.ok) {
            console.warn('[syncthing-pair] stale folder delete failed:', f.id, del.status);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[syncthing-pair] stale-folder scan threw:', String(err && err.message || err));
  }
  const deviceResult = await sc.putDevice(creds, sc.buildDevicePayload({
    deviceId: pairInfo.server_device_id,
    name: 'kari-server',
    addresses: Array.isArray(pairInfo.server_addresses) && pairInfo.server_addresses.length > 0
      ? pairInfo.server_addresses
      : ['dynamic'],
  }));
  if (!deviceResult.ok) {
    return { ok: false, code: 'put_device_failed', deviceResult, staleDeletes, rebindDeletes, staleDeviceDeletes };
  }
  // Re-activation against a different mgmt/server leaves the previous
  // server device in Syncthing's config. Syncthing keeps dialing it and
  // can report a persistent handshake error ("expected old id, got new
  // id") even after the new server is connected. Keep the newly paired
  // kari-server and the local device, remove older kari-server peers.
  try {
    if (typeof sc.getDevices === 'function' && typeof sc.deleteDevice === 'function') {
      const devices = await sc.getDevices(creds);
      if (devices && devices.ok && Array.isArray(devices.body)) {
        for (const d of devices.body) {
          if (!d || typeof d !== 'object') continue;
          const deviceId = String(d.deviceID || d.deviceId || d.id || '').trim();
          const name = String(d.name || '').trim();
          if (!deviceId) continue;
          if (deviceId === pairInfo.server_device_id || deviceId === localDeviceId) continue;
          if (name !== 'kari-server') continue;
          const del = await sc.deleteDevice(creds, deviceId);
          staleDeviceDeletes.push({ deviceId, ok: !!del.ok, status: del.status });
          if (!del.ok) {
            console.warn('[syncthing-pair] stale kari-server device delete failed:', deviceId, del.status);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[syncthing-pair] stale-device scan threw:', String(err && err.message || err));
  }
  // PutFolder preconditions — ALL THREE are required and fail-closed
  // (no PutFolder if any fails). Order matters:
  //   (1) mkdir absFolderPath          → syncthing's "folder path missing"
  //   (2) mkdir .stfolder marker       → syncthing's "folder marker missing"
  //                                       (folder fail-closes into state=error
  //                                        without this and never recovers
  //                                        on its own — the bug that bit us
  //                                        in production)
  //   (3) writeStignoreFile (optional) → prevent first-scan from advertising
  //                                       node_modules/dist/etc to peer
  //
  // Previously (1) only ran inside the stignoreWriter branch, so
  // callers without a writer never created either the folder or the
  // marker. Now (1)+(2) always run; (3) is still injection-based.
  try {
    await fsp.mkdir(absFolderPath, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: 'folder_mkdir_failed',
      error: String(err && err.message || err),
      deviceResult,
      staleDeletes,
      rebindDeletes,
      staleDeviceDeletes,
    };
  }
  try {
    await fsp.mkdir(path.join(absFolderPath, '.stfolder'), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: 'marker_mkdir_failed',
      error: String(err && err.message || err),
      deviceResult,
      staleDeletes,
      rebindDeletes,
      staleDeviceDeletes,
    };
  }
  let stignoreResult = { ok: false, reason: 'not_attempted' };
  if (typeof stignoreWriter === 'function') {
    try {
      stignoreResult = await stignoreWriter({
        projectRoot: absFolderPath,
        ...(stignoreArgs && typeof stignoreArgs === 'object' ? stignoreArgs : {}),
      });
    } catch (err) {
      stignoreResult = { ok: false, reason: 'threw', error: String(err && err.message || err) };
    }
  }
  const folderResult = await sc.putFolder(creds, sc.buildFolderPayload({
    folderId: pairInfo.folder_id,
    label: pairInfo.workspace_name || pairInfo.folder_id,
    folderPath: absFolderPath,
    deviceIds: [localDeviceId, pairInfo.server_device_id],
    sendreceive,
  }));
  if (!folderResult.ok) {
    return { ok: false, code: 'put_folder_failed', deviceResult, folderResult, stignoreResult, staleDeletes, rebindDeletes, staleDeviceDeletes };
  }
  return { ok: true, deviceResult, folderResult, stignoreResult, staleDeletes, rebindDeletes, staleDeviceDeletes };
}

// Phase 4.5 (syncthing migration cleanup): on workspace switch the
// previously-paired kari1_ws-* folders are still in the local
// syncthing config — they reference paths that may no longer exist
// (storage location changed, project deleted) and generate noisy
// rescan failures every tick. Walk the folder list, drop every
// kari1_ws-* entry whose id isn't the one we just installed.
//
// Best-effort: getFolders failure surfaces as {ok:false}; per-folder
// deleteFolder failures land in `removed[].ok=false` but the function
// keeps going. Caller logs the result; pair stays valid either way.
async function unshareOtherKariFolders({ creds, keepFolderId, syncthingClient } = {}) {
  if (!creds || !creds.guiAddress || !creds.apiKey) return { ok: false, reason: 'missing_creds' };
  if (!keepFolderId) return { ok: false, reason: 'missing_keep_folder_id' };
  const sc = syncthingClient || require('./syncthing_client.cjs');
  const folders = await sc.getFolders(creds);
  if (!folders || !folders.ok || !Array.isArray(folders.body)) {
    return { ok: false, reason: 'get_folders_failed' };
  }
  const removed = [];
  for (const f of folders.body) {
    if (!f || typeof f !== 'object' || !f.id) continue;
    if (f.id === keepFolderId) continue;
    if (!/^kari1_ws-/.test(f.id)) continue;
    const r = await sc.deleteFolder(creds, f.id);
    removed.push({ folderId: f.id, ok: !!r.ok, status: r.status });
  }
  return { ok: true, removed };
}

// isLegacyWorkspaceFolderId returns true for the pre-T1 workspace-level
// folder shape and false for the T1 per-project shape. Used by T8's
// boot-time sweep to drop legacy folders so the new project-driven
// scheduler is the only writer of syncthing folder config.
//
//   legacy: kari1_<wsSlug>__<12hex>            ← two segments after kari1_
//   fresh : kari1_<wsSlug>__<projSlug>__<12hex> ← three segments after kari1_
//
// Anything that doesn't match either shape (handcrafted folder ids,
// non-kari syncthing folders) returns false so the sweep leaves them
// untouched.
function isLegacyWorkspaceFolderId(folderId) {
  if (typeof folderId !== 'string') return false;
  if (!folderId.startsWith(`${ALGO_VERSION}_`)) return false;
  const body = folderId.slice(`${ALGO_VERSION}_`.length);
  const parts = body.split('__');
  if (parts.length !== 2) return false;
  // Last segment MUST be exactly 12 lower-hex chars (the truncated
  // sha256 hash). Without this length check, a folder like
  // "kari1_ws-x__some-non-hash" would be falsely identified as legacy.
  return /^[0-9a-f]{12}$/.test(parts[1]);
}

// sweepKariFoldersOnBoot DeleteFolder's every kari1_<wsid>__* entry —
// BOTH the legacy two-segment shape AND the new per-project shape.
// Files on disk at those folders' paths are NOT touched; only the
// syncthing config entry is dropped.
//
// Why both shapes? Plan T8 needs to be idempotent across crashes. If
// Kari quits while a project sync was active, the scheduler's retire
// race (stop() is fire-and-forget against syncthing shutdown) leaves
// the folder in syncthing's on-disk config. Next boot, syncthing
// reloads the orphaned folder. The scheduler doesn't know about it
// (no PTY event reproduced) so the folder sits there syncing until
// 手动 cleanup. The fresh-state sweep on boot makes the scheduler the
// only owner — every folder we want will be re-created on the next
// pty:project:active event.
//
// Idempotent — running twice on the same install is a no-op after
// the first pass.
async function sweepKariFoldersOnBoot({ creds, syncthingClient } = {}) {
  if (!creds || !creds.guiAddress || !creds.apiKey) return { ok: false, reason: 'missing_creds' };
  const sc = syncthingClient || require('./syncthing_client.cjs');
  // Cold-start race: syncthing's HTTP REST surface can take a few hundred
  // ms after `getRunningMeta` reports ready before /rest/config/folders
  // responds. Retry up to 6×1s before giving up so first-launch sweeps
  // don't silently no-op against a still-booting daemon.
  let folders = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      folders = await sc.getFolders(creds);
    } catch (err) {
      folders = { ok: false, threw: String(err && err.message || err) };
    }
    if (folders && folders.ok && Array.isArray(folders.body)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!folders || !folders.ok || !Array.isArray(folders.body)) {
    return { ok: false, reason: 'get_folders_failed' };
  }
  const removed = [];
  for (const f of folders.body) {
    if (!f || typeof f !== 'object' || !f.id) continue;
    if (!/^kari1_ws-/.test(f.id)) continue;
    const r = await sc.deleteFolder(creds, f.id).catch((err) => ({ ok: false, status: 0, error: String(err && err.message || err) }));
    removed.push({ folderId: f.id, path: f.path || '', shape: isLegacyWorkspaceFolderId(f.id) ? 'legacy' : 'per-project', ok: !!(r && r.ok), status: r && r.status });
    if (!r || !r.ok) {
      console.warn('[syncthing-pair] boot sweep delete failed:', f.id, r && r.status);
    }
  }
  return { ok: true, removed };
}

// sweepLegacyWorkspaceFolders walks the live syncthing folder list and
// DeleteFolder's every entry whose id matches the legacy two-segment
// shape. Files on disk at those folders' paths are NOT touched — only
// the syncthing config entry is dropped.
//
// Kept for back-compat with anything that wants the narrower
// legacy-only behavior (tests + KARI_DISABLE_PTY_SYNC=1 rollback path).
// New callers should prefer sweepKariFoldersOnBoot, which also catches
// per-project folders left over from a crashed shutdown.
//
// Idempotent — running twice on the same install is a no-op after the
// first pass.
async function sweepLegacyWorkspaceFolders({ creds, syncthingClient } = {}) {
  if (!creds || !creds.guiAddress || !creds.apiKey) return { ok: false, reason: 'missing_creds' };
  const sc = syncthingClient || require('./syncthing_client.cjs');
  let folders;
  try {
    folders = await sc.getFolders(creds);
  } catch (err) {
    return { ok: false, reason: 'get_folders_threw', error: String(err && err.message || err) };
  }
  if (!folders || !folders.ok || !Array.isArray(folders.body)) {
    return { ok: false, reason: 'get_folders_failed' };
  }
  const removed = [];
  for (const f of folders.body) {
    if (!f || typeof f !== 'object' || !f.id) continue;
    if (!isLegacyWorkspaceFolderId(f.id)) continue;
    const r = await sc.deleteFolder(creds, f.id).catch((err) => ({ ok: false, status: 0, error: String(err && err.message || err) }));
    removed.push({ folderId: f.id, path: f.path || '', ok: !!(r && r.ok), status: r && r.status });
    if (!r || !r.ok) {
      console.warn('[syncthing-pair] legacy folder sweep delete failed:', f.id, r && r.status);
    }
  }
  return { ok: true, removed };
}

module.exports = {
  folderIdForWorkspaceId,
  folderIdFor,
  requestPairInfo,
  applyPairInfoLocally,
  unshareOtherKariFolders,
  sweepLegacyWorkspaceFolders,
  sweepKariFoldersOnBoot,
  isLegacyWorkspaceFolderId,
  // exposed for tests
  slugifyFolderId,
  normalizeServerAddr,
  ALGO_VERSION,
  MAX_FOLDER_ID_LEN,
  HASH_LEN,
};
