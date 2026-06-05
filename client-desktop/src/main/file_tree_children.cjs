'use strict';

// Lazy file-tree directory listing (file-tree visibility plan, Task 3).
//
// One directory level, paginated, with each child annotated by the
// sync-disposition classifier. Caller (IPC handler in main.cjs) hydrates:
//   - manifestPaths: Set<string> of relPaths the latest committed
//     manifest contains (or empty when the project hasn't committed yet
//     / manifest hydration failed).
//   - overrideIncludes: Set<string> of canonical anchor relPaths from
//     sync_override_store.getIncludeSetForProject (any state).
//   - pendingOverrides: Set<string> of canonical anchors in
//     state='pending_upload' from getPendingOverrideSetForProject.
//   - isIgnored: (relPath, isDirectory) => boolean built from
//     ignore_evaluator.buildIgnoreMatcher({projectRoot, mode,
//     includeOverrides}). Matcher already applies hard-ignore as a
//     front predicate AND the override claw-back BEFORE consulting the
//     `ignore` package, so a returned `true` means "user explicitly
//     wants this excluded".
//   - hardIgnored: Set<string> — currently unused (the classifier
//     delegates to ignore_evaluator.isHardIgnored directly), kept in
//     the signature for the plan's documented contract.
//
// Symlinks are lstat'd (NOT stat) so a link pointing outside the
// workspace isn't followed during listing. They surface as
// type='symlink' with disposition='excluded' and reason='symlink'.
// The IPC `files:pathAction` rejects symlinks the same way — a symlink
// can never be picked up by a force_upload_once or always_sync_path
// action (round-2 codex P2 #13: defense in depth against follow-link
// exfiltration via direct IPC).
//
// `hasMixedSubtree` is INTENTIONALLY NOT computed here. The plan's
// round-3 codex P1 #4 moved it to lazy/expansion-only: an eager
// depth-1 peek with 64-sample cap on every non-denylisted directory
// child of every listed dir would run up to 25-50k stat calls per IPC
// on wide trees (e.g. packages/ with 800 subprojects). Non-denylisted
// dirs paint as 'included' on first listing; the renderer's
// applyChildListing patcher flips them to 'partially_included' once
// expansion reveals mixed children.
//
// hasOverriddenDescendant + hasPendingDescendant ARE computed here —
// cheap anchor-prefix scans against in-memory Sets, no readdir.

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  classifySyncDisposition,
  emptySummary,
  addDisposition,
  normalizeRel,
  matchesAnchor,
} = require('./file_tree_sync_disposition.cjs');
const { isHardIgnored } = require('./ignore_evaluator.cjs');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const MIN_LIMIT = 1;

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(n)));
}

function decodeCursor(cursor) {
  const n = Number(cursor || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Refuse paths that escape the workspace root. Lexical check on the
// resolved path. The IPC handler in main.cjs is expected to also realpath()
// the input (round-3 codex P2 — symlink-resolve check) so the lexical
// guard here doesn't have to.
function assertInside(root, target) {
  const rel = path.relative(root, target);
  if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error('listFileTreeChildren: path escapes workspace');
  }
}

// True if any anchor in `anchors` sits BELOW dirRel (strict descendant,
// not dirRel itself). Drives the parent badge's hasOverriddenDescendant
// signal — cheap O(anchors.size) scan, no IO.
function hasAnchorUnderPrefix(dirRel, anchors) {
  if (!anchors || anchors.size === 0) return false;
  if (dirRel === '') {
    // Root listing — any anchor at all qualifies as "below root".
    return anchors.size > 0;
  }
  const prefix = dirRel + '/';
  for (const anchor of anchors) {
    if (anchor.startsWith(prefix)) return true;
  }
  return false;
}

// Returns the ANCESTOR anchor (if any) that covers `rel` via descent,
// or null. Used to render an "inherited override" indicator on
// descendants of an own-override anchor.
function findCoveringAnchor(rel, anchors) {
  if (!anchors || anchors.size === 0) return null;
  for (const anchor of anchors) {
    if (rel.startsWith(anchor + '/')) return anchor;
  }
  return null;
}

// Map our internal SyncDisposition to the filter values the IPC accepts.
// Internal pending_upload / partially_included are treated as
// 'included'-bucket for the simple filter UX (the filter is a coarse
// "show me what's syncing"). The renderer's filter chip set is
// intentionally narrow; the per-node icons surface the finer state.
function matchesFilter(disposition, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'included') {
    return disposition === 'included'
      || disposition === 'partially_included'
      || disposition === 'pending_upload';
  }
  if (filter === 'excluded') {
    return disposition === 'excluded' || disposition === 'hard_ignored';
  }
  if (filter === 'local_only') return disposition === 'local_only';
  if (filter === 'cloud_only') return disposition === 'cloud_only';
  return true;
}

async function listFileTreeChildren(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('listFileTreeChildren: args required');
  }
  if (typeof args.root !== 'string' || args.root.length === 0) {
    throw new Error('listFileTreeChildren: root is required');
  }
  const root = path.resolve(args.root);
  const dirPath = args.dirPath ? path.resolve(args.dirPath) : root;
  assertInside(root, dirPath);

  const limit = clampLimit(args.limit);
  const offset = decodeCursor(args.cursor);
  const overrideIncludes = args.overrideIncludes instanceof Set
    ? args.overrideIncludes
    : new Set();
  const pendingOverrides = args.pendingOverrides instanceof Set
    ? args.pendingOverrides
    : new Set();
  const manifestPaths = args.manifestPaths instanceof Set
    ? args.manifestPaths
    : new Set();
  const isIgnored = typeof args.isIgnored === 'function' ? args.isIgnored : null;
  const filter = args.filter || 'all';

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      // Directory disappeared / isn't a directory — return an empty
      // listing rather than throw so the renderer can show "this
      // directory is gone" instead of an IPC reject.
      return {
        root,
        dirPath,
        nodes: [],
        hasMore: false,
        summary: emptySummary(),
      };
    }
    throw err;
  }
  // Sort: directories first, then files. Within each: binary string
  // compare (NOT localeCompare) so the pagination cursor is stable
  // across platforms and locale flips — the cursor is an offset into
  // this sort, and a process-locale change between page 1 and page 2
  // would otherwise produce skipped / duplicated entries (round-1
  // codex finding #4).
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });

  const summary = emptySummary();
  const filteredNodes = [];

  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    const rel = normalizeRel(path.relative(root, abs));

    // lstat (NOT stat) — see header comment. Symlinks surface as
    // type='symlink' regardless of target, never followed. Capture the
    // error code so we can distinguish "file deleted between readdir
    // and lstat" (ENOENT — really gone) from "permission/IO failure"
    // (file exists; we just couldn't stat it).
    let lstatResult = null;
    let lstatErrCode = null;
    try {
      lstatResult = await fs.lstat(abs);
    } catch (err) {
      lstatErrCode = err && err.code ? String(err.code) : 'EUNKNOWN';
    }

    // Symlink detection uses BOTH the Dirent's symlink bit AND the
    // lstat result. Round-1 codex #1: lstat-fail-then-null would
    // silently bypass the safety branch and reclassify a symlink as a
    // regular file, breaking the follow-link exfiltration defense.
    // The Dirent (from readdir-withFileTypes) carries lstat-style
    // info on POSIX, so we can trust it even when the standalone
    // lstat call fails.
    const isSymlink = (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink())
      || (lstatResult && lstatResult.isSymbolicLink());

    if (isSymlink) {
      // Even for symlinks, hard-ignore wins via precedence (a symlink
      // literally named `.git` is rare but possible — submodules, some
      // worktree layouts; round-1 codex #3). Surface as hard_ignored
      // so summary buckets correctly and the precedence rule holds.
      const disposition = isHardIgnored(rel)
        ? { syncDisposition: 'hard_ignored', syncReason: 'hard-ignore' }
        : { syncDisposition: 'excluded', syncReason: 'symlink' };
      addDisposition(summary, disposition.syncDisposition);
      if (matchesFilter(disposition.syncDisposition, filter)) {
        filteredNodes.push({
          name: entry.name,
          path: abs,
          relPath: rel,
          type: 'symlink',
          size: 0,
          syncDisposition: disposition.syncDisposition,
          syncReason: disposition.syncReason,
          hasOverride: false,
        });
      }
      continue;
    }

    const isDirectory = entry.isDirectory();
    const ignored = isIgnored ? Boolean(isIgnored(rel, isDirectory)) : false;
    const hasOverriddenDescendant = isDirectory
      && hasAnchorUnderPrefix(rel, overrideIncludes);
    const hasPendingDescendant = isDirectory
      && hasAnchorUnderPrefix(rel, pendingOverrides);
    const hasOwnOverride = overrideIncludes.has(rel);
    const inheritedOverride = !hasOwnOverride
      ? findCoveringAnchor(rel, overrideIncludes)
      : null;

    // Round-1 codex #2: only treat the file as missing when lstat
    // returned ENOENT (genuine "file deleted between readdir and lstat").
    // EACCES / EIO etc. mean the file is there but we couldn't stat it
    // — classifying it as 'cloud_only' / 'local_only' would mislead the
    // user. readdir just enumerated it; default to "exists" on error.
    const localExists = lstatResult !== null || (lstatErrCode !== null && lstatErrCode !== 'ENOENT');

    const disposition = classifySyncDisposition({
      relPath: rel,
      isDirectory,
      ignored,
      overrideIncludes,
      pendingOverrides,
      hasOverriddenDescendant,
      hasPendingDescendant,
      // hasMixedSubtree intentionally omitted — see header. Renderer
      // patches the parent badge after expansion reveals mixed children.
      manifestPaths,
      localExists,
    });

    addDisposition(summary, disposition.syncDisposition);
    if (!matchesFilter(disposition.syncDisposition, filter)) continue;

    filteredNodes.push({
      name: entry.name,
      path: abs,
      relPath: rel,
      type: isDirectory ? 'directory' : 'file',
      size: lstatResult && lstatResult.isFile() ? Number(lstatResult.size) : 0,
      syncDisposition: disposition.syncDisposition,
      syncReason: disposition.syncReason,
      hasOverride: hasOwnOverride,
      overrideInheritedFrom: inheritedOverride || undefined,
      // Directories get hasMoreChildren=true so the renderer knows to
      // show an expand chevron. Files (and symlinks above) don't.
      hasMoreChildren: isDirectory ? true : undefined,
    });
  }

  // Page slice over the FILTERED nodes. hasMore is computed against
  // the filtered length so the renderer's "load next page" terminates
  // correctly under any filter.
  //
  // CONTRACT (round-1 codex #5): the cursor is an offset into the
  // post-filter, post-sort list. Callers MUST reset cursor to undefined
  // (page 0) whenever they change `filter` — the same offset against a
  // different filtered set would silently return a wrong page. This is
  // a documented constraint of the IPC, NOT enforced server-side (we
  // have no per-caller session state to detect a filter change).
  const page = filteredNodes.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < filteredNodes.length;

  return {
    root,
    dirPath,
    nodes: page,
    nextCursor: hasMore ? String(nextOffset) : undefined,
    hasMore,
    // summary is the IMMEDIATE-children total for THIS directory
    // (NOT a recursive subtree total — recursive counts are an
    // intentional non-goal; see header). Always reflects the unfiltered
    // counts so the renderer can render "filtering 3 of 523".
    summary,
  };
}

module.exports = {
  listFileTreeChildren,
  clampLimit,
  decodeCursor,
  hasAnchorUnderPrefix,
  findCoveringAnchor,
  matchesFilter,
};
