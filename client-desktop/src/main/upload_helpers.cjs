// PR2 Phase 1 commit 6 — pure helpers for uploadProject. Extracted
// from main.cjs so tests can exercise them without dragging Electron
// globals.

'use strict';

const fsp = require('fs/promises');
const path = require('path');

// directoryByteSize is a raw du-style walk. Matches plan §4.2 step
// 2's size-pre-check semantics: total file bytes minus filesync-
// internal dirs (.kari-engine/, .git/). The predicted upload size
// matches what filesync actually pushes to the server — predicting
// raw size including .kari-engine would over-estimate and reject
// uploads that filesync would actually fit under quota.
//
// Round-1 review fix #3: root MUST exist and be a directory. The
// pre-fix readdir(root).catch(() => []) swallowed ENOENT / EACCES
// and returned size=0, which let upload-intent proceed for a stale
// path and register a phantom empty workspace. Now the root stat
// throws; uploadProject's try-catch maps that to
// `size_compute_failed` and refuses to bind/sync.
//
// Sub-directory failures (permission denied / race-removed during
// walk) are still tolerated as best-effort — those map to a
// slightly under-estimated size for the upload-intent payload,
// which is benign (server's Touch will reconcile actual bytes).
async function directoryByteSize(absRoot) {
  if (!absRoot) throw new Error('absRoot required');
  // Fail-closed root check. throws ENOENT / EACCES / etc. so the
  // caller's catch surfaces the failure code cleanly.
  const rootStat = await fsp.stat(absRoot);
  if (!rootStat.isDirectory()) {
    throw new Error('not a directory: ' + absRoot);
  }
  let total = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const ep = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.kari-engine' || e.name === '.git') continue;
        await walk(ep);
      } else if (e.isFile()) {
        const st = await fsp.stat(ep).catch(() => null);
        if (st) total += st.size;
      }
    }
  }
  await walk(absRoot);
  return total;
}

// deriveClientId returns the client_id used by upload-intent. Must
// match what the daemon /v1/bind uses (main.cjs cfg.clientId ||
// machineClientId()) so server-side workspace_dirs.client_id +
// local_path align with the daemon session that actually transfers
// bytes for this client.
//
// Round-1 review fix #1: pre-fix this hashed cfg.activationCode,
// but normalizeStoredConfig strips that field (moves it to
// activationCodePlain). So the hash collapsed to seed='desktop'
// across all Desktop installs, breaking per-client local_path /
// multi-device isolation. New priority mirrors the daemon-bind
// pattern exactly:
//   1. cfg.clientId — the canonical Desktop-install identifier
//      (set at first-run via normalizeStoredConfig + persisted).
//   2. machineFallback — caller passes the same machineClientId()
//      function that daemon bind uses. Required to avoid duplicating
//      the os.hostname() + crypto plumbing in this pure helper.
//   3. 'desktop-unknown' — only hit if main forgot to pass a
//      fallback. Surfaces obviously in server logs if it ever
//      leaks through.
function deriveClientId(cfg, machineFallback) {
  if (cfg && typeof cfg.clientId === 'string' && cfg.clientId.length > 0) {
    return cfg.clientId;
  }
  if (typeof machineFallback === 'function') {
    const v = machineFallback();
    if (typeof v === 'string' && v.length > 0) return v;
  } else if (typeof machineFallback === 'string' && machineFallback.length > 0) {
    return machineFallback;
  }
  return 'desktop-unknown';
}

// shouldUseSnapshotUpload decides the local→cloud upload backend before
// upload-intent runs. Fresh local projects do not have a server row yet,
// so projectMeta.syncBackend is usually absent or still stamped as the
// legacy filesync default by the local-project list. In the server-first
// Syncthing product path, local projects MUST route to snapshot upload;
// otherwise first upload falls back to legacy filesync and the staged
// Syncthing/manifest flow never starts.
function shouldUseSnapshotUpload({ projectMeta, cfg } = {}) {
  const metaBackend = String(projectMeta && projectMeta.syncBackend || '').toLowerCase();
  if (projectMeta && projectMeta.source === 'local') return true;
  if (metaBackend === 'syncthing') return true;
  if (metaBackend === 'filesync') return false;
  return !!(cfg && cfg.workspaceSyncBackend === 'syncthing');
}

// shouldUseSnapshotDownload decides the cloud→local download backend.
// Some HTTPRegistry deployments do not surface workspace_dirs.sync_backend,
// but the same server can still expose a committed snapshot manifest.
// Treat that manifest as authoritative: routing those projects through
// legacy filesync lets an empty local skeleton become a bidirectional
// sync source and can wipe the server-side materialized directory.
function shouldUseSnapshotDownload({ projectMeta, latestManifestResult } = {}) {
  const metaBackend = String(projectMeta && projectMeta.syncBackend || '').toLowerCase();
  if (metaBackend === 'syncthing') return true;
  if (latestManifestResult
      && latestManifestResult.ok === true
      && typeof latestManifestResult.manifestId === 'string'
      && latestManifestResult.manifestId.length > 0) {
    return true;
  }
  return false;
}

// targetInsideSource returns true when the import target path would
// land inside the user-selected source path (i.e. source contains
// target as a descendant or equals it). Used by importLocalProject
// to reject "user picked home/ as the source while Kari storage lives
// in home/" — fs.cp would self-recurse or fail mid-walk.
//
// Both arguments are expected pre-resolved (path.resolve). Comparison
// uses `+ path.sep` to avoid false-positive prefix matches between
// sibling dirs like `/foo` and `/foobar`.
function targetInsideSource(sourceAbs, targetAbs) {
  if (!sourceAbs || !targetAbs) return false;
  const source = path.normalize(String(sourceAbs));
  const target = path.normalize(String(targetAbs));
  if (source === target) return true;
  const srcWithSep = source.endsWith(path.sep) ? source : source + path.sep;
  return target.startsWith(srcWithSep);
}

module.exports = {
  directoryByteSize,
  deriveClientId,
  shouldUseSnapshotUpload,
  shouldUseSnapshotDownload,
  targetInsideSource,
};
