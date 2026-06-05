'use strict';

// Project-scoped sync override store (file-tree sync visibility plan,
// Task 2b).
//
// Persists "always sync this path" carve-outs at the PROJECT level so
// a user can include `node_modules/some-patched-package/` in project A
// without affecting project B and without weakening the global lightweight
// denylist. Reads of overrides feed:
//
//   - the snapshot walker's `buildIgnoreMatcher({includeOverrides})` —
//     claw-back predicate that runs before the `ignore` package, so
//     denylist-final directories don't silently strip the anchor's
//     descendants.
//   - the file-tree classifier (Task 2) — `pending_upload` vs
//     `included` badges depend on per-anchor state.
//   - the `.stignore` writer (B12) — same effective rule set as the
//     matcher, ordered with `!`-prefix-first so Syncthing's transport
//     layer agrees with what the manifest contains.
//
// Storage: <userData>/sync_overrides.json, shape:
//   {
//     "overrides": [
//       {
//         "serverAddr": "<normalized>",
//         "workspaceId": "<id>",
//         "workspaceName": "<name>",
//         "relPath": "<canonical posix>",
//         "action": "include",                          // future-proof
//         "state": "pending_upload" | "committed",
//         "committedManifestId": "<sha256 hex or null>",
//         "createdAt": "<ISO>",
//         "updatedAt": "<ISO>"
//       },
//       ...
//     ]
//   }
//
// Composite key: (serverAddr, workspaceId, workspaceName, relPath) with
// percent-encoded segments. serverAddr is normalized via
// `normalizeServerAddrForKey` from sync_mode_store (lowercase scheme,
// strip trailing slash, default to https://) so re-pair / scheme drift
// can't silently disappear overrides. relPath is normalized via the
// same path.posix-based helper as snapshot_session_store.scopeRelPath,
// so `node_modules/foo`, `node_modules/foo/`, and `./node_modules/foo`
// all resolve to one row.
//
// workspaceName is COMPARED CASE-SENSITIVELY (`r.workspaceName === x`)
// without folding. Callers (activation flow + IPC handlers) must pass
// the canonical-case workspaceName from cfg.workspaceName; the renderer
// must NOT title-case or otherwise transform user input before reaching
// the store. If activation produces a different case after re-pair than
// the prior session used, listOrphanedOverrides won't surface those rows
// — they become un-discoverable. This is a deliberate trade-off: folding
// workspaceName in the identity key would change the shape consumed by
// sync_mode_store and snapshot_session_store too. (Round-1 codex #3.)
//
// Hard-ignore reject: `addOverride` calls into the shared `isHardIgnored`
// from ignore_evaluator.cjs — never duplicate the list inline, or the
// two will drift. Anyone hand-injecting a `.git/` anchor into the
// matcher's includeOverrides is still blocked by the front predicate
// (defense in depth).
//
// Nested anchors: addOverride enforces two invariants:
//   - COVERED_BY_ANCESTOR_OVERRIDE: a NEW anchor whose ancestor already
//     has an override is rejected — the ancestor already pulls the new
//     anchor's contents into sync; the narrower anchor would never
//     observably do anything (since matcher's `matchesOverride`
//     early-exits on first prefix match).
//   - DOMINATES_EXISTING_OVERRIDES: a NEW anchor that would shadow N
//     existing narrower rows requires explicit `replaceChildren:true`.
//     The renderer is expected to call `dryRunAddOverride` first and
//     show a confirm dialog ("replace 3 child overrides?"); on confirm,
//     `addOverride({...payload, replaceChildren:true})` removes the
//     dominated rows and inserts the broader one in a single serialized
//     mutation.
//
// Pre-activation: when workspaceId / workspaceName are empty (Desktop
// just opened, no project paired yet), READ APIs return [] / new Set()
// gracefully; WRITE APIs throw INCOMPLETE_IDENTITY. The IPC handler
// catches and surfaces `code='not_activated'`.

const fsp = require('node:fs/promises');
const path = require('node:path');

const { isHardIgnored } = require('./ignore_evaluator.cjs');
const {
  normalizeServerAddrForKey,
  isCompleteKeyParts,
} = require('./sync_mode_store.cjs');

const VALID_STATES = ['pending_upload', 'committed'];
const VALID_STATE_SET = new Set(VALID_STATES);
const DEFAULT_ACTION = 'include';

function nowIso() {
  return new Date().toISOString();
}

// Normalize relPath into canonical form. Mirrors
// snapshot_session_store.normalizeScopeRelPath so the matcher's
// includeOverrides Set and the override store's row Set canonicalize
// the same way — none of {matcher, store, session} can disagree on
// "which paths are anchored".
function normalizeRelPath(value) {
  if (typeof value !== 'string') return null;
  let s = value.replace(/\\/g, '/');
  // Reject absolute paths up front. path.posix.normalize collapses
  // `..` segments above `/` as no-ops, so '/../foo' would launder
  // into 'foo' via a naive leading-slash strip.
  if (s.startsWith('/')) return null;
  // Reject ANY `..` segment in the raw input BEFORE normalize. Without
  // this guard, `path.posix.normalize` collapses `foo/../bar` to `bar`
  // — silent path laundering. An override is identity-shaping: pinning
  // the user's input to a different anchor than they intended is the
  // kind of subtle surprise the contract should hard-reject. (Round-1
  // codex finding #4.) Legitimate `..` use is escape, already rejected
  // by the absolute-path + ../foo path.
  for (const rawSeg of s.split('/')) {
    if (rawSeg === '..') return null;
  }
  s = path.posix.normalize(s);
  while (s.startsWith('./')) s = s.slice(2);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (s.length === 0 || s === '.' || s === '..') return null;
  for (const seg of s.split('/')) {
    if (seg === '..') return null;
  }
  return s;
}

// Validate identity for WRITE calls. Reads accept incomplete identity
// and degrade to empty results gracefully (matches sync_mode_store's
// pattern + the file-tree plan's pre-activation contract).
function normalizeWriteIdentity({ serverAddr, workspaceId, workspaceName }) {
  if (!isCompleteKeyParts({ serverAddr, workspaceId, workspaceName })) {
    const err = new Error('sync_override_store: incomplete identity');
    err.code = 'INCOMPLETE_IDENTITY';
    throw err;
  }
  return {
    serverAddr: normalizeServerAddrForKey(serverAddr),
    workspaceId: String(workspaceId).trim(),
    workspaceName: String(workspaceName).trim(),
  };
}

// Read-side identity normalization. Returns null if any field is
// missing — caller short-circuits to [] / new Set() instead of throwing.
function normalizeReadIdentity({ serverAddr, workspaceId, workspaceName }) {
  if (!isCompleteKeyParts({ serverAddr, workspaceId, workspaceName })) {
    return null;
  }
  return {
    serverAddr: normalizeServerAddrForKey(serverAddr),
    workspaceId: String(workspaceId).trim(),
    workspaceName: String(workspaceName).trim(),
  };
}

// Composite key. Percent-encoded segments so a `|` in a workspaceName
// or relPath doesn't crash the split-based loader as a different-arity
// key (silent persistence loss — same bug we fixed in sync_mode_store
// composite key encoding).
function overrideKey({ serverAddr, workspaceId, workspaceName, relPath }) {
  return [
    encodeURIComponent(serverAddr),
    encodeURIComponent(workspaceId),
    encodeURIComponent(workspaceName),
    encodeURIComponent(relPath),
  ].join('|');
}

function defaultStoreShape() {
  return { overrides: [] };
}

// Validate the loaded shape; drop unknown / malformed entries rather
// than reject the whole file. Hand-edits + version skew shouldn't brick
// the store; the surviving rows still work.
function normalizeOverrideRow(raw, fallbackTimestamp) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.serverAddr !== 'string' || raw.serverAddr.length === 0) return null;
  if (typeof raw.workspaceId !== 'string' || raw.workspaceId.length === 0) return null;
  if (typeof raw.workspaceName !== 'string' || raw.workspaceName.length === 0) return null;
  const normalizedRel = normalizeRelPath(raw.relPath);
  if (!normalizedRel) return null;
  // Hard-ignore rows that somehow made it onto disk (legacy / hand-edit)
  // are silently dropped on load. The matcher's front predicate would
  // block them anyway; surfacing them in listOverridesForProject would
  // confuse the renderer.
  if (isHardIgnored(normalizedRel)) return null;
  const action = raw.action === DEFAULT_ACTION ? DEFAULT_ACTION : null;
  if (!action) return null;
  const state = VALID_STATE_SET.has(raw.state) ? raw.state : 'pending_upload';
  const tsFallback = typeof fallbackTimestamp === 'string' && fallbackTimestamp.length > 0
    ? fallbackTimestamp
    : nowIso();
  return {
    serverAddr: raw.serverAddr,
    workspaceId: raw.workspaceId,
    workspaceName: raw.workspaceName,
    relPath: normalizedRel,
    action,
    state,
    committedManifestId: typeof raw.committedManifestId === 'string' && raw.committedManifestId.length > 0
      ? raw.committedManifestId
      : null,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt.length > 0
      ? raw.createdAt
      : tsFallback,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.length > 0
      ? raw.updatedAt
      : tsFallback,
  };
}

function normalizeStoreShape(raw) {
  const out = defaultStoreShape();
  if (raw && typeof raw === 'object' && Array.isArray(raw.overrides)) {
    const seenKeys = new Set();
    for (const r of raw.overrides) {
      const norm = normalizeOverrideRow(r);
      if (!norm) continue;
      // Deduplicate by composite key — hand-edits could create
      // duplicates that would otherwise both surface in listOverrides
      // and break the "one row per anchor" invariant.
      const key = overrideKey(norm);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      out.overrides.push(norm);
    }
  }
  return out;
}

async function readStore(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultStoreShape();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file — fall back to defaults rather than crash the IPC
    // layer. The corrupt file is left in place for manual recovery.
    return defaultStoreShape();
  }
  return normalizeStoreShape(parsed);
}

async function writeStore(filePath, store) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => null);
    throw err;
  }
}

// Returns the ancestor anchor (if any) of `relPath` in `rows`, or null.
// "Ancestor" = a row whose normalized relPath is a strict prefix of
// `relPath` with a "/" boundary.
function findCoveringAncestor(rows, relPath) {
  for (const r of rows) {
    if (relPath === r.relPath) continue;
    if (relPath.startsWith(r.relPath + '/')) return r;
  }
  return null;
}

// Returns the set of rows in `rows` that `relPath` would dominate —
// "dominate" = the candidate anchor is a strict ancestor of an existing
// row with a "/" boundary.
function findDominatedRows(rows, relPath) {
  const prefix = relPath + '/';
  return rows.filter((r) => r.relPath !== relPath && r.relPath.startsWith(prefix));
}

// Returns rows for the given project identity.
function rowsForIdentity(allRows, ident) {
  return allRows.filter((r) =>
    r.serverAddr === ident.serverAddr
    && r.workspaceId === ident.workspaceId
    && r.workspaceName === ident.workspaceName,
  );
}

// Public factory.
function createSyncOverrideStore({ filePath }) {
  if (!filePath) throw new Error('createSyncOverrideStore requires filePath');

  let mutationChain = Promise.resolve();
  function serialize(fn) {
    const next = mutationChain.then(fn, fn);
    mutationChain = next.catch(() => undefined);
    return next;
  }

  // Read APIs: graceful on incomplete identity (return [] / empty Set).
  // Writes use normalizeWriteIdentity which throws INCOMPLETE_IDENTITY.

  async function listOverridesForProject(args) {
    const ident = normalizeReadIdentity(args || {});
    if (!ident) return [];
    const store = await readStore(filePath);
    return rowsForIdentity(store.overrides, ident).slice();
  }

  async function getIncludeSetForProject(args) {
    const rows = await listOverridesForProject(args);
    return new Set(rows.map((r) => r.relPath));
  }

  async function getPendingOverrideSetForProject(args) {
    const rows = await listOverridesForProject(args);
    return new Set(
      rows.filter((r) => r.state === 'pending_upload').map((r) => r.relPath),
    );
  }

  // dryRunAddOverride: read-only, for the renderer's confirm-replace
  // dialog flow. Returns:
  //   { wouldRejectHardIgnore: boolean,
  //     wouldBeCoveredBy: string|null,
  //     wouldDominate: string[],
  //     wouldExistAlready: boolean }
  // Renderer calls this BEFORE addOverride to decide whether to show
  // a confirm dialog (wouldDominate non-empty), surface a hard-reject
  // error toast (wouldBeCoveredBy non-null OR wouldRejectHardIgnore),
  // or skip the dialog (wouldExistAlready — exact-match anchor is a no-op).
  async function dryRunAddOverride(args) {
    const ident = normalizeReadIdentity(args || {});
    if (!ident) {
      const err = new Error('sync_override_store: incomplete identity');
      err.code = 'INCOMPLETE_IDENTITY';
      throw err;
    }
    const normalized = normalizeRelPath(args.relPath);
    if (!normalized) {
      return {
        wouldRejectHardIgnore: false,
        wouldRejectInvalidPath: true,
        wouldBeCoveredBy: null,
        wouldDominate: [],
        wouldExistAlready: false,
      };
    }
    if (isHardIgnored(normalized)) {
      return {
        wouldRejectHardIgnore: true,
        wouldRejectInvalidPath: false,
        wouldBeCoveredBy: null,
        wouldDominate: [],
        wouldExistAlready: false,
      };
    }
    const store = await readStore(filePath);
    const projectRows = rowsForIdentity(store.overrides, ident);
    const covering = findCoveringAncestor(projectRows, normalized);
    const dominated = findDominatedRows(projectRows, normalized);
    const exact = projectRows.find((r) => r.relPath === normalized);
    return {
      wouldRejectHardIgnore: false,
      wouldRejectInvalidPath: false,
      wouldBeCoveredBy: covering ? covering.relPath : null,
      wouldDominate: dominated.map((r) => r.relPath),
      wouldExistAlready: !!exact,
    };
  }

  // addOverride. Creates a new row in state='pending_upload' OR returns
  // the existing exact-match row (idempotent). Rejects:
  //   - hard-ignore: HARD_IGNORE_IMMUTABLE
  //   - ancestor already covers: COVERED_BY_ANCESTOR_OVERRIDE
  //   - would dominate existing rows AND replaceChildren not set:
  //     DOMINATES_EXISTING_OVERRIDES (the renderer should dry-run first
  //     and re-issue with replaceChildren:true on confirm)
  //   - invalid identity: INCOMPLETE_IDENTITY
  //   - invalid relPath (empty, .., absolute, ..-escape):
  //     INVALID_REL_PATH
  // With replaceChildren=true: removes all dominated rows then inserts
  // the broader anchor in a single serialized mutation.
  async function addOverride(args) {
    const ident = normalizeWriteIdentity(args || {});
    const normalized = normalizeRelPath(args.relPath);
    if (!normalized) {
      const err = new Error('sync_override_store: invalid relPath ' + JSON.stringify(args.relPath));
      err.code = 'INVALID_REL_PATH';
      throw err;
    }
    if (isHardIgnored(normalized)) {
      const err = new Error('sync_override_store: hard-ignore paths cannot be overridden (' + normalized + ')');
      err.code = 'HARD_IGNORE_IMMUTABLE';
      throw err;
    }
    const replaceChildren = !!args.replaceChildren;
    return serialize(async () => {
      const store = await readStore(filePath);
      const projectRows = rowsForIdentity(store.overrides, ident);
      const exact = projectRows.find((r) => r.relPath === normalized);
      if (exact) {
        // Idempotent — return the existing row unchanged. The caller
        // wanted "always sync this anchor"; it's already true.
        return exact;
      }
      const covering = findCoveringAncestor(projectRows, normalized);
      if (covering) {
        const err = new Error('sync_override_store: anchor ' + normalized
          + ' is covered by ancestor override ' + covering.relPath);
        err.code = 'COVERED_BY_ANCESTOR_OVERRIDE';
        err.ancestor = covering.relPath;
        throw err;
      }
      const dominated = findDominatedRows(projectRows, normalized);
      if (dominated.length > 0 && !replaceChildren) {
        const err = new Error('sync_override_store: anchor ' + normalized
          + ' would dominate ' + dominated.length + ' existing rows');
        err.code = 'DOMINATES_EXISTING_OVERRIDES';
        err.wouldDominate = dominated.map((r) => r.relPath);
        throw err;
      }
      // Remove dominated rows (if replaceChildren was confirmed).
      if (dominated.length > 0) {
        const dominatedKeys = new Set(dominated.map(overrideKey));
        store.overrides = store.overrides.filter((r) => !dominatedKeys.has(overrideKey(r)));
      }
      const ts = nowIso();
      const row = {
        serverAddr: ident.serverAddr,
        workspaceId: ident.workspaceId,
        workspaceName: ident.workspaceName,
        relPath: normalized,
        action: DEFAULT_ACTION,
        state: 'pending_upload',
        committedManifestId: null,
        createdAt: ts,
        updatedAt: ts,
      };
      store.overrides.push(row);
      await writeStore(filePath, store);
      return row;
    });
  }

  async function removeOverride(args) {
    const ident = normalizeWriteIdentity(args || {});
    const normalized = normalizeRelPath(args.relPath);
    if (!normalized) {
      const err = new Error('sync_override_store: invalid relPath ' + JSON.stringify(args.relPath));
      err.code = 'INVALID_REL_PATH';
      throw err;
    }
    const targetKey = overrideKey({ ...ident, relPath: normalized });
    return serialize(async () => {
      const store = await readStore(filePath);
      const before = store.overrides.length;
      store.overrides = store.overrides.filter((r) => overrideKey(r) !== targetKey);
      const removed = before - store.overrides.length;
      if (removed > 0) await writeStore(filePath, store);
      return { removed: removed > 0 };
    });
  }

  // markOverrideCommitted: flip a row from pending_upload to committed,
  // recording the manifest_id that contained it. Called by uploadProject
  // (both normal and path-scoped flows) AFTER /commit succeeds. No-op
  // (returns {found:false}) if the row doesn't exist (the user may have
  // cancelled the override while the snapshot was in flight).
  async function markOverrideCommitted(args) {
    const ident = normalizeWriteIdentity(args || {});
    const normalized = normalizeRelPath(args.relPath);
    if (!normalized) {
      const err = new Error('sync_override_store: invalid relPath ' + JSON.stringify(args.relPath));
      err.code = 'INVALID_REL_PATH';
      throw err;
    }
    if (typeof args.manifestId !== 'string' || args.manifestId.length === 0) {
      const err = new Error('sync_override_store: manifestId is required');
      err.code = 'MISSING_MANIFEST_ID';
      throw err;
    }
    const targetKey = overrideKey({ ...ident, relPath: normalized });
    return serialize(async () => {
      const store = await readStore(filePath);
      const idx = store.overrides.findIndex((r) => overrideKey(r) === targetKey);
      if (idx < 0) return { found: false };
      const cur = store.overrides[idx];
      // Idempotent: if already committed against the same manifestId,
      // no write — just return found:true.
      if (cur.state === 'committed' && cur.committedManifestId === args.manifestId) {
        return { found: true, alreadyCommitted: true, row: cur };
      }
      const next = {
        ...cur,
        state: 'committed',
        committedManifestId: args.manifestId,
        updatedAt: nowIso(),
      };
      store.overrides[idx] = next;
      await writeStore(filePath, store);
      return { found: true, alreadyCommitted: false, row: next };
    });
  }

  // migrateOverridesForRepair: on re-pair, copy rows from the old
  // workspaceId to the new one (same serverAddr + workspaceName).
  // Preserves state + committedManifestId. Deletes the old rows.
  // Idempotent (re-running with no old rows is a no-op). Per round-3
  // codex P2 #10 the caller should also re-verify committedManifestId
  // against the new server before trusting it — that lives in the
  // calling code, not here.
  async function migrateOverridesForRepair(args) {
    if (!args || typeof args !== 'object') {
      throw new Error('migrateOverridesForRepair: args required');
    }
    const { oldWorkspaceId, newWorkspaceId, workspaceName, serverAddr } = args;
    if (typeof oldWorkspaceId !== 'string' || oldWorkspaceId.length === 0
        || typeof newWorkspaceId !== 'string' || newWorkspaceId.length === 0
        || typeof workspaceName !== 'string' || workspaceName.length === 0
        || typeof serverAddr !== 'string' || serverAddr.length === 0) {
      const err = new Error('migrateOverridesForRepair: all of oldWorkspaceId, newWorkspaceId, workspaceName, serverAddr are required');
      err.code = 'INCOMPLETE_IDENTITY';
      throw err;
    }
    const normalizedServer = normalizeServerAddrForKey(serverAddr);
    return serialize(async () => {
      const store = await readStore(filePath);
      const oldRows = store.overrides.filter((r) =>
        r.serverAddr === normalizedServer
        && r.workspaceId === oldWorkspaceId
        && r.workspaceName === workspaceName,
      );
      if (oldRows.length === 0) return { migrated: 0, conflictUpgraded: 0 };
      // Build a lookup of existing rows under the new workspaceId so we
      // can detect conflicts AND prefer the more-progressed state on
      // collision (round-1 codex #1: silent loss of committed state was
      // a real concern — if old.state='committed' with manifestId 'X'
      // and new.state='pending_upload', migration must NOT downgrade
      // by keeping the pending row).
      const newRowsByRel = new Map();
      for (const r of store.overrides) {
        if (r.serverAddr === normalizedServer
            && r.workspaceId === newWorkspaceId
            && r.workspaceName === workspaceName) {
          newRowsByRel.set(r.relPath, r);
        }
      }
      const oldKeysToRemove = new Set(oldRows.map(overrideKey));
      // Track which new-row keys we'll overwrite via committed-upgrade.
      const newKeysToUpgrade = new Set();
      for (const old of oldRows) {
        const existing = newRowsByRel.get(old.relPath);
        if (existing && old.state === 'committed' && existing.state !== 'committed') {
          // Upgrade the new row from pending → committed (carrying over
          // the old row's committedManifestId).
          newKeysToUpgrade.add(overrideKey(existing));
        }
      }
      store.overrides = store.overrides.filter((r) =>
        !oldKeysToRemove.has(overrideKey(r))
        && !newKeysToUpgrade.has(overrideKey(r)),
      );
      const ts = nowIso();
      let migrated = 0;
      let conflictUpgraded = 0;
      let conflictResolvedByTimestamp = 0;
      for (const row of oldRows) {
        const existing = newRowsByRel.get(row.relPath);
        if (existing) {
          if (row.state === 'committed' && existing.state !== 'committed') {
            // Conflict — old is committed, new was pending. Insert the
            // upgraded row (old's committed state + manifestId, but
            // keyed under the new workspaceId).
            store.overrides.push({
              ...row,
              workspaceId: newWorkspaceId,
              updatedAt: ts,
            });
            conflictUpgraded += 1;
          } else if (row.state === 'committed' && existing.state === 'committed'
                     && row.committedManifestId !== existing.committedManifestId) {
            // Both committed with DIFFERENT manifestIds (round-2 codex):
            // ambiguous. Pick by updatedAt — the later commit wins as
            // "most recent reality". The natural mental model: old row
            // committed under the prior workspaceId pre-pair; new row
            // committed under the new workspaceId post-pair; the later
            // timestamp is the user's most recent intent. Deterministic
            // and matches the "timeline wins" expectation. If a stale
            // replay caused the new commit, the user can re-trigger
            // sync to get the row they actually want.
            const oldTime = Date.parse(row.updatedAt);
            const newTime = Date.parse(existing.updatedAt);
            const oldWins = Number.isFinite(oldTime) && Number.isFinite(newTime)
              ? oldTime > newTime
              : false;  // can't compare → prefer new (already in place)
            if (oldWins) {
              // Replace the existing new-id row with the old-id's content.
              store.overrides = store.overrides.filter((r) =>
                overrideKey(r) !== overrideKey(existing),
              );
              store.overrides.push({
                ...row,
                workspaceId: newWorkspaceId,
                updatedAt: ts,
              });
              conflictResolvedByTimestamp += 1;
            }
            // Otherwise new stays as-is; old is dropped (still removed
            // by oldKeysToRemove earlier).
          } else {
            // - both already committed with SAME manifestId (no-op)
            // - new is committed and old was pending (no downgrade)
            // - both pending (equivalent; new wins arbitrarily)
            // In all these cases the new row stays as-is; we drop the old.
          }
          continue;
        }
        // No conflict: straight migrate.
        store.overrides.push({
          ...row,
          workspaceId: newWorkspaceId,
          updatedAt: ts,
        });
        migrated += 1;
      }
      await writeStore(filePath, store);
      return { migrated, conflictUpgraded, conflictResolvedByTimestamp };
    });
  }

  // listOrphanedOverrides: rows under (serverAddr, workspaceName) whose
  // workspaceId doesn't match the current cfg.workspaceId. Used by the
  // UI to offer "restore from previous activation" after a re-pair.
  async function listOrphanedOverrides(args) {
    if (!args || typeof args !== 'object') return [];
    const { serverAddr, workspaceName, currentWorkspaceId } = args;
    if (typeof serverAddr !== 'string' || serverAddr.length === 0
        || typeof workspaceName !== 'string' || workspaceName.length === 0
        || typeof currentWorkspaceId !== 'string' || currentWorkspaceId.length === 0) {
      return [];
    }
    const normalizedServer = normalizeServerAddrForKey(serverAddr);
    const store = await readStore(filePath);
    return store.overrides
      .filter((r) =>
        r.serverAddr === normalizedServer
        && r.workspaceName === workspaceName
        && r.workspaceId !== currentWorkspaceId,
      )
      .slice();
  }

  return {
    listOverridesForProject,
    getIncludeSetForProject,
    getPendingOverrideSetForProject,
    dryRunAddOverride,
    addOverride,
    removeOverride,
    markOverrideCommitted,
    migrateOverridesForRepair,
    listOrphanedOverrides,
  };
}

module.exports = {
  createSyncOverrideStore,
  overrideKey,
  normalizeRelPath,
  VALID_STATES,
  _internals: {
    normalizeOverrideRow,
    normalizeStoreShape,
    readStore,
    writeStore,
    findCoveringAncestor,
    findDominatedRows,
  },
};
