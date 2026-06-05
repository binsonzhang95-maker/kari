'use strict';

// File-tree sync disposition classifier (file-tree visibility plan, Task 2).
//
// Pure function — no filesystem IO. Takes the per-node facts the walker
// already has and returns the SyncDisposition + reason the renderer paints.
//
// Precedence rule (LOAD-BEARING — pinned in tests; matches matcher contract):
//
//   hard-ignore  >  project override  >  lightweight denylist  >  .kariignore
//
// 1. Hard-ignore wins over everything, including overrides. The store
//    rejects hard-ignore at write time, but a hostile / hand-edited row
//    could still surface — the classifier blocks it as defense in depth.
//    Delegates to ignore_evaluator.isHardIgnored so this and the matcher
//    can't drift (round-1 codex P1 #7 reconciliation).
//
// 2. Project include override (claw-back from denylist). Two states:
//      - committed → 'included' (green) — but cross-check manifestPaths
//        to detect stale-committed rows (round-3 codex P1 #3: file
//        deleted locally + next normal upload commits a manifest without
//        the path → row stays committed but isn't actually in cloud).
//      - pending_upload → 'pending_upload' (yellow) — override exists
//        but no committed manifest yet contains the anchor. Prevents
//        the "green cloud lying" scenario where a failed snapshot +
//        user-deleted local copy = data loss.
//      - committed + file NEWER than commit (file post-dates the
//        committed anchor) → 'pending_upload' too.
//
// 3. Lightweight denylist / .kariignore exclusion.
//      - Directory with overridden-descendant + pending-descendant →
//        'pending_upload' (parent badge reflects the in-flight child).
//      - Directory with overridden-descendant (committed) →
//        'partially_included' (yellow/amber — mixed subtree).
//      - Otherwise → 'excluded'.
//
// 4. Non-denylisted directory with mixed subtree (any disposition mix
//    that includes both included AND excluded/hard-ignored children) →
//    'partially_included'. Round-3 codex P1 #4 deferred actual mixed
//    detection to expansion-time; classifier honors the input flag.
//
// 5. Cloud/local divergence.
//      - localExists=false + manifestPaths.has(relPath) → 'cloud_only'
//      - localExists=true + manifestPaths non-empty + relPath not in
//        manifest + no descendant in manifest → 'local_only'
//      - else → 'included'

const { isHardIgnored } = require('./ignore_evaluator.cjs');

function emptySummary() {
  return {
    included: 0,
    partiallyIncluded: 0,
    pendingUpload: 0,
    excluded: 0,
    hardIgnored: 0,
    localOnly: 0,
    cloudOnly: 0,
    conflict: 0,
  };
}

function addDisposition(summary, disposition) {
  if (disposition === 'included') summary.included += 1;
  else if (disposition === 'partially_included') summary.partiallyIncluded += 1;
  // pending_upload is DATA-SAFETY-distinct from partially_included
  // (round-1 codex P1 #3): override exists, cloud has never seen this.
  // UI drives the yellow/pulsing badge from pendingUpload; partial is
  // just informational "mixed committed children".
  else if (disposition === 'pending_upload') summary.pendingUpload += 1;
  else if (disposition === 'excluded') summary.excluded += 1;
  else if (disposition === 'hard_ignored') summary.hardIgnored += 1;
  else if (disposition === 'local_only') summary.localOnly += 1;
  else if (disposition === 'cloud_only') summary.cloudOnly += 1;
  else if (disposition === 'conflict') summary.conflict += 1;
  return summary;
}

// Normalize relPath to POSIX, strip leading "./" and "/", strip trailing
// "/". Mirrors ignore_evaluator.normalizeRel (kept narrow because this
// runs once per tree node).
function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

// True if relPath matches an anchor in `anchors` (exact match OR descends
// via "/" boundary).
function matchesAnchor(relPath, anchors) {
  if (!anchors || anchors.size === 0) return false;
  if (anchors.has(relPath)) return true;
  for (const a of anchors) {
    if (relPath.startsWith(a + '/')) return true;
  }
  return false;
}

// True if any manifest path equals or descends from relPath.
function hasManifestDescendant(relPath, manifestPaths) {
  if (!manifestPaths || manifestPaths.size === 0) return false;
  const prefix = relPath ? relPath + '/' : '';
  for (const p of manifestPaths) {
    if (p === relPath) return true;
    if (prefix && p.startsWith(prefix)) return true;
  }
  return false;
}

function classifySyncDisposition(args) {
  const relPath = normalizeRel(args.relPath);
  const manifestPaths = args.manifestPaths || new Set();
  const overrideIncludes = args.overrideIncludes || new Set();
  const pendingOverrides = args.pendingOverrides || new Set();
  const localExists = args.localExists !== false;

  // Empty / root relPath isn't a meaningful node — surface as included
  // so the root tree row doesn't paint with a weird state.
  if (relPath.length === 0) {
    return { syncDisposition: 'included', syncReason: 'root' };
  }

  // 1. Hard-ignore wins over everything.
  if (isHardIgnored(relPath)) {
    return { syncDisposition: 'hard_ignored', syncReason: 'hard-ignore' };
  }

  // Explicit conflict marker (the walker can pass `conflict: '<reason>'`
  // to override into the conflict state — e.g. .sync-conflict files
  // emitted by Syncthing).
  if (args.conflict) {
    return { syncDisposition: 'conflict', syncReason: String(args.conflict) };
  }

  // 2. Project include override claw-back.
  const overriddenSelf = matchesAnchor(relPath, overrideIncludes);
  if (overriddenSelf) {
    const stillPending = matchesAnchor(relPath, pendingOverrides);
    if (stillPending) {
      return { syncDisposition: 'pending_upload', syncReason: 'override-not-yet-committed' };
    }
    // Override is committed. Cross-check manifestPaths to detect stale
    // rows (round-3 codex P1 #3 + FT-Task-2 round-1 codex P0):
    //
    // Note: when manifestPaths is empty (size === 0), the staleness
    // checks are SKIPPED — this is a graceful default for "manifest
    // not yet hydrated" / "no commit history yet" rather than a real
    // signal of "the manifest contains zero paths" (which is itself
    // extremely rare). The trade-off is documented; the caller can
    // surface an additional `manifestHydrated` flag if it ever needs
    // to distinguish "loading" from "genuinely empty".
    //
    //   - File MISSING from latest manifest + locally absent → row is
    //     stale + the file is gone everywhere → 'excluded'.
    //   - File MISSING from latest manifest + locally present → file
    //     post-dates commit → 'pending_upload'.
    //   - File PRESENT in latest manifest + locally absent →
    //     'cloud_only' (round-1 codex P0 #1 — previously returned
    //     'included' which was a UX bug: the user saw green for a
    //     file that doesn't exist on disk).
    //   - Directory with NO descendant in manifest → stale-directory
    //     → 'excluded' (override no longer represents real cloud state).
    //   - Directory WITH descendant in manifest + mixed subtree →
    //     'partially_included' / 'pending_upload' (round-1 codex P1 #2 —
    //     a committed directory override with some pending or excluded
    //     children should not paint solid green).
    if (!args.isDirectory && manifestPaths.size > 0) {
      if (!manifestPaths.has(relPath)) {
        if (!localExists) {
          return { syncDisposition: 'excluded', syncReason: 'override-stale-and-local-missing' };
        }
        return { syncDisposition: 'pending_upload', syncReason: 'override-committed-but-file-new' };
      }
      // File IS in manifest:
      if (!localExists) {
        return { syncDisposition: 'cloud_only', syncReason: 'manifest-only' };
      }
    }
    // Directory under a committed override — propagate descendant
    // signals even when the override "won" the precedence check. Users
    // need to know a green-overridden parent has yellow / excluded
    // children somewhere underneath (round-1 codex P1 #2 +
    // round-2 codex: hoisted ABOVE the stale-directory check because
    // hasPendingDescendant is a LIVE local signal independent of manifest
    // staleness — a stale-committed parent can still have in-flight
    // child uploads under it, and the data-safety signal must win over
    // the informational "stale" label).
    if (args.isDirectory && args.hasPendingDescendant) {
      return { syncDisposition: 'pending_upload', syncReason: 'pending-descendant' };
    }
    if (args.isDirectory && manifestPaths.size > 0
        && !manifestPaths.has(relPath)
        && !hasManifestDescendant(relPath, manifestPaths)) {
      return { syncDisposition: 'excluded', syncReason: 'override-stale-directory' };
    }
    if (args.isDirectory && args.hasMixedSubtree) {
      return { syncDisposition: 'partially_included', syncReason: 'mixed-subtree' };
    }
    return { syncDisposition: 'included', syncReason: 'project-override' };
  }

  // 3. Lightweight denylist / .kariignore exclusion.
  if (args.ignored) {
    if (args.isDirectory && args.hasOverriddenDescendant) {
      // Subtree carves out at least one child via override. Paint
      // pending if any descendant override is still pending; otherwise
      // partial (mixed committed-overridden + denylisted children).
      if (args.hasPendingDescendant) {
        return { syncDisposition: 'pending_upload', syncReason: 'pending-descendant' };
      }
      return { syncDisposition: 'partially_included', syncReason: 'override-descendant' };
    }
    return { syncDisposition: 'excluded', syncReason: 'lightweight-ignore' };
  }

  // 4. Non-denylisted directory whose subtree is known-mixed (walker
  //    populates hasMixedSubtree on expansion; see plan's round-3 P1 #4
  //    deferred-detection design). Paint partially_included so users
  //    aren't misled into thinking everything under a green directory
  //    is synced.
  if (args.isDirectory && args.hasMixedSubtree) {
    return { syncDisposition: 'partially_included', syncReason: 'mixed-subtree' };
  }

  // 5. Cloud/local divergence.
  if (!localExists && manifestPaths.has(relPath)) {
    return { syncDisposition: 'cloud_only', syncReason: 'manifest-only' };
  }
  if (localExists && manifestPaths.size > 0
      && !manifestPaths.has(relPath)
      && !hasManifestDescendant(relPath, manifestPaths)) {
    return { syncDisposition: 'local_only', syncReason: 'not-in-latest-manifest' };
  }
  return { syncDisposition: 'included', syncReason: 'included-by-sync-mode' };
}

module.exports = {
  classifySyncDisposition,
  emptySummary,
  addDisposition,
  normalizeRel,
  matchesAnchor,
  hasManifestDescendant,
};
