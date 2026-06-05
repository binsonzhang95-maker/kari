'use strict';

// download_verify — local safety guards that gate
// .kari-engine/desktop-download-incomplete marker removal.
//
// CRITICAL CONTRACT (reviewer pin):
//   Daemon "task succeeded" is a transport-level signal — it means
//   the daemon thinks bytes arrived, NOT that the local tree is
//   complete and stable. Without this guard the marker could be
//   removed while:
//     - syncthing's *.kari-incoming staging files are still mid-rename
//     - another sync task is concurrently writing to the mirror
//   Either case lets the user click into a mirror whose tree is
//   actively being mutated → torn reads, missing subdirectories,
//   the "二级目录缺文件" symptom we're trying to fix.
//
// HARD LIMITATION:
//   The current daemon binary exposes no manifest / verify endpoint.
//   This module CANNOT prove tree completeness on its own — it can
//   only prove that nothing is mid-write right now. A strong
//   verification path (folder local/global state agreement, need-
//   list empty, completion 100%, no errors, not scanning, quiet
//   window) requires daemon support and is out of scope for this
//   round. Tracking issue: daemon team needs to expose
//   /v1/workspaces/{name}/syncthing-status (or equivalent).
//
//   `bytes_used` from the server's /api/workdirs response is RAW
//   `dirSize(workdirPath)` — includes .git/, .kari-engine/, ignores
//   .gitignore + .kariignore. Comparing it to localBytes
//   (directoryByteSize, which excludes .git + .kari-engine and
//   respects .kariignore in the daemon) gives nonsense ratios on
//   both ends:
//     - server has .git/ → bytes_used inflated → local always looks short
//     - local has un-ignored node_modules → localBytes inflated → missing files pass
//   So we keep the ratio as a console.warn diagnostic ONLY and never
//   gate marker removal on it.

const fsp = require('node:fs/promises');
const path = require('node:path');

// Names we must traverse INTO when looking for staging files; .git
// and .kari-engine cannot contain syncthing staging artifacts because
// the daemon excludes them from sync.
const TRAVERSAL_SKIP_DIRS = new Set(['.git', '.kari-engine']);

// Match syncthing's staging suffix. Also covers the older daemon
// filesync `.kari-incoming` suffix used elsewhere in this codebase
// (sync recv: apply file ... rename .../foo.kari-incoming → foo).
function hasStagingSuffix(name) {
  return name.endsWith('.kari-incoming') || name.endsWith('.tmp.kari-incoming');
}

/**
 * Walk mirrorPath recursively looking for the first .kari-incoming
 * staging file. Returns early on first match — we only need to know
 * existence, not enumeration.
 *
 * Returns:
 *   { found: true, samplePath: string }  // staging file present
 *   { found: false }                     // tree is quiescent
 *
 * Errors (broken symlinks, permission denied on a subdir) are
 * swallowed conservatively: an unreadable subtree is treated as
 * "no staging files seen", because rejecting on read errors would
 * make finalization brittle on Windows where antivirus can briefly
 * lock paths. Real staging files would still be picked up by a later
 * recovery pass.
 */
async function findStagingFile(mirrorPath) {
  const queue = [mirrorPath];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (TRAVERSAL_SKIP_DIRS.has(entry.name)) continue;
        queue.push(full);
        continue;
      }
      if (entry.isFile() && hasStagingSuffix(entry.name)) {
        return { found: true, samplePath: full };
      }
    }
  }
  return { found: false };
}

/**
 * Gate for the three marker-removal call sites in main.cjs:
 *   - applySyncTaskSideEffects (tracker terminal-succeeded effect)
 *   - recoverSyncTasksFromMarkers (daemon-current task succeeded)
 *   - reconcileMarkersWithCache (cache phase synced heal)
 *
 * All three must call this BEFORE removeIncompleteMarker. On ok=false
 * the marker stays in place, the renderer keeps the card in
 * syncing/attaching/provisioning, and the next pass (next
 * daemonSnapshot tick, or next user-initiated download) tries again.
 *
 * @param {object} args
 * @param {string} args.mirrorPath — local mirror dir
 * @param {object} args.syncTaskTracker — sync_task_tracker instance
 *   (has getEntryByCacheKey method)
 * @param {string} args.cacheKey — sync_state_cache key for this
 *   project (so we can ask the tracker if any task is still active)
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
async function checkDownloadSafeToFinalize({ mirrorPath, syncTaskTracker, cacheKey }) {
  // Guard 1: no syncthing staging files anywhere in the tree. If any
  // exist, an in-flight write is mid-rename and the visible file
  // names don't reflect on-disk reality yet.
  const staging = await findStagingFile(mirrorPath);
  if (staging.found) {
    return {
      ok: false,
      reason: `staging_files_present sample=${staging.samplePath}`,
    };
  }
  // Guard 2: no active tracker entry for this workspace. The tracker
  // is the single source of truth for "is a sync task still in
  // flight"; if it has an entry for this cacheKey, postSyncTask has
  // not yet observed terminal success even if the daemon claims so
  // (race window where the tracker hasn't applied the terminal-task
  // effect yet).
  if (syncTaskTracker && typeof syncTaskTracker.getEntryByCacheKey === 'function') {
    const active = syncTaskTracker.getEntryByCacheKey(cacheKey);
    if (active) {
      return {
        ok: false,
        reason: `tracker_entry_still_active taskId=${active.taskId}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Diagnostic-only bytes comparison. Logs a warning when local bytes
 * are dramatically smaller than the server's reported bytes_used,
 * but never gates a decision — the two values are NOT a like-for-
 * like comparison (see module header).
 *
 * Intended for grep-after-bug-report use; safe to call from any
 * marker-removal call site.
 *
 * @param {string} mirrorPath
 * @param {number} expectedBytes — server bytes_used from workdirs row
 * @param {function} directoryByteSize — main.cjs's existing helper
 *   (excludes .kari-engine + .git, honors filesync exclusions)
 */
async function logBytesUsedDiagnostic(mirrorPath, expectedBytes, directoryByteSize) {
  if (!expectedBytes || expectedBytes <= 0) return;
  if (typeof directoryByteSize !== 'function') return;
  let localBytes;
  try {
    localBytes = await directoryByteSize(mirrorPath);
  } catch {
    return;
  }
  const ratio = expectedBytes > 0 ? localBytes / expectedBytes : 0;
  // Threshold deliberately loose. server bytes_used includes .git +
  // .kari-engine + ignored paths, so localBytes will almost always
  // be smaller. We only WARN when the gap is bad enough to suggest
  // "entire subdirectory missing" rather than "normal exclusion gap".
  // 0.4 catches losing half the tree without firing on every
  // .git-heavy clone.
  if (ratio < 0.4) {
    console.warn(
      '[download_verify diagnostic] suspiciously low byte ratio — mirror=' +
        mirrorPath +
        ' localBytes=' + localBytes +
        ' serverBytesUsed=' + expectedBytes +
        ' ratio=' + ratio.toFixed(3) +
        ' (server bytes_used is RAW dirSize, includes .git/.kari-engine ' +
        'and ignores .gitignore/.kariignore — ratio is a hint, NOT a ' +
        'completeness signal; marker decision is gated by local guards only)',
    );
  }
}

module.exports = {
  checkDownloadSafeToFinalize,
  findStagingFile,
  hasStagingSuffix,
  logBytesUsedDiagnostic,
  _internals: { TRAVERSAL_SKIP_DIRS },
};
