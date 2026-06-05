'use strict';

// Per-workspace sync mode store (Phase B step B3).
//
// Storage: a single JSON file in Electron's userData dir, shape:
//   {
//     "default": "lightweight",
//     "projects": {
//       "<serverAddr>|<workspaceId>|<workspaceName>": "full"
//     }
//   }
//
// Mode values: "lightweight" (Kari-managed denylist + .kariignore)
// or "full" (only hard-ignore + .kariignore). Legacy persisted values
// "fast" / "project" both migrate to "lightweight" transparently on
// load via migrateLegacyMode from ignore_evaluator. Setters reject
// legacy names so the file naturally upgrades to the new schema on
// the next write.
//
// Composite-key rationale (Round 1 High #8 from the plan review):
// workspaceName alone collides across accounts (same workspaceId under
// different servers, two activation_codes pointing at the same name,
// etc.). The three-part key is the smallest stable identity that
// survives renaming a single field. serverAddr is included so a user
// migrating across instances (dev / staging / prod) keeps mode
// settings per-instance rather than carrying them across.
//
// Phase 1 is local-only — these settings live on each Desktop and
// don't sync to mgmt. Phase 2 will lift the per-project entries into
// server-side workspace metadata so they carry across devices; the
// global default stays local because it represents user preference,
// not workspace property.
//
// Atomic writes: every persisted state mutation goes via writeFile to
// a .tmp then rename — same protocol B1 settled on for staging-meta.
// A crash mid-write leaves either the pre-write or the post-write
// state, never a half-parsed JSON the loader chokes on.
//
// The store is intentionally NOT a singleton. Tests construct their
// own filePath; the main process glue (in main.cjs) calls
// createSyncModeStore({ filePath: path.join(app.getPath('userData'),
// 'sync_modes.json') }) once at startup and exposes the result to IPC
// handlers.

const fsp = require('node:fs/promises');
const path = require('node:path');

// Sync mode constants are owned by ignore_evaluator (the canonical
// source for `lightweight` vs `full` semantics). We re-import them
// here so a future rename only needs to touch one file, and the
// store + evaluator can't drift out of agreement.
const {
  VALID_MODES,
  DEFAULT_MODE,
  isValidMode,
  migrateLegacyMode,
} = require('./ignore_evaluator.cjs');

// Normalize serverAddr for identity-only comparison. Matches the
// shape the URL builder (`kariServerBaseUrl` in main.cjs) would
// produce so the same logical server doesn't end up with multiple
// keys after re-pair / scheme drift / trailing-slash quirks.
//   - lowercased scheme (HTTP://x → http://x)
//   - default to https:// if no scheme (matches kariServerBaseUrl)
//   - no trailing slash on the origin
//   - no fragment / query
// This is identity normalization; the HTTP request builder may still
// apply its own quirks (e.g., resolving a name). We use this only
// for the composite key.
function normalizeServerAddrForKey(raw) {
  const s = String(raw || '').trim();
  if (s.length === 0) return '';
  let withScheme = s;
  if (!/^https?:\/\//i.test(withScheme)) {
    withScheme = 'https://' + withScheme;
  }
  try {
    const u = new URL(withScheme);
    let origin = u.protocol.toLowerCase() + '//' + u.host;
    // Preserve a non-root pathname (some users may reverse-proxy
    // under /kari/), but strip the trailing slash.
    let pathPart = u.pathname || '';
    if (pathPart === '/') pathPart = '';
    if (pathPart.endsWith('/')) pathPart = pathPart.replace(/\/+$/, '');
    return origin + pathPart;
  } catch {
    // Malformed URL — fall back to the trimmed raw string so we still
    // produce a stable key rather than throwing.
    return s;
  }
}

// Validate identity inputs. The setter API still requires complete
// identity (you can't write a mode for an unidentified workspace);
// read APIs degrade gracefully via the `isCompleteKeyParts` predicate
// below (returning DEFAULT_MODE / null instead of throwing).
function normalizeKeyParts({ serverAddr, workspaceId, workspaceName }) {
  if (typeof serverAddr !== 'string' || serverAddr.trim().length === 0) {
    throw new Error('sync_mode_store: serverAddr is required (got ' + typeof serverAddr + ')');
  }
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    throw new Error('sync_mode_store: workspaceId is required (got ' + typeof workspaceId + ')');
  }
  if (typeof workspaceName !== 'string' || workspaceName.trim().length === 0) {
    throw new Error('sync_mode_store: workspaceName is required (got ' + typeof workspaceName + ')');
  }
  return {
    serverAddr: normalizeServerAddrForKey(serverAddr),
    workspaceId: workspaceId.trim(),
    workspaceName: workspaceName.trim(),
  };
}

function isCompleteKeyParts(parts) {
  return !!(parts
    && typeof parts.serverAddr === 'string' && parts.serverAddr.trim().length > 0
    && typeof parts.workspaceId === 'string' && parts.workspaceId.trim().length > 0
    && typeof parts.workspaceName === 'string' && parts.workspaceName.trim().length > 0);
}

// Composite key with percent-encoded segments. Encoding makes the
// segment boundaries unambiguous so a workspaceName like "foo|bar"
// can't crash through the split-based loader as a 4-segment key
// that subsequently gets dropped on load (silent persistence loss
// reviewer flagged).
function projectKey(keyParts) {
  const { serverAddr, workspaceId, workspaceName } = normalizeKeyParts(keyParts);
  return `${encodeURIComponent(serverAddr)}|${encodeURIComponent(workspaceId)}|${encodeURIComponent(workspaceName)}`;
}

function defaultStoreShape() {
  return { default: DEFAULT_MODE, projects: {} };
}

// Validate the loaded shape; drop unknown / malformed entries rather
// than reject the whole file. A user who edits this manually shouldn't
// brick their entire mode store with one typo.
//
// Mode migration: legacy `fast` / `project` values land here from
// stores written before the lightweight/full alignment. They are
// transparently migrated via migrateLegacyMode (fast/project →
// lightweight, full → full) so users don't lose their per-project
// overrides on the upgrade.
//
// Each key must split into exactly 3 percent-encoded segments, none
// empty. The encoding makes `|` impossible within a segment, so
// split-by-`|` is unambiguous; the non-empty check rejects
// hand-edited `|w|n` / `s||n` / `s|w|` ghosts that would otherwise
// be unreachable via projectKey() (which always produces
// fully-populated segments).
function normalizeStoreShape(raw) {
  const out = defaultStoreShape();
  if (raw && typeof raw === 'object') {
    const migratedDefault = migrateLegacyMode(raw.default);
    if (migratedDefault) out.default = migratedDefault;
    if (raw.projects && typeof raw.projects === 'object') {
      for (const [k, v] of Object.entries(raw.projects)) {
        if (typeof k !== 'string') continue;
        const segments = k.split('|');
        if (segments.length !== 3) continue;
        if (segments.some((s) => s.length === 0)) continue;
        const mode = migrateLegacyMode(v);
        if (!mode) continue;
        out.projects[k] = mode;
      }
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
    // Corrupt file (mid-write crash that bypassed atomic rename, or
    // user hand-edit gone wrong). Fall back to defaults rather than
    // crash the whole IPC layer. The corrupt file is left in place so
    // the user can recover the JSON if they want.
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

// Public factory. Caller passes the absolute path; this module
// doesn't touch Electron / app directories so tests can use tmpdir
// without mocking.
function createSyncModeStore({ filePath }) {
  if (!filePath) throw new Error('createSyncModeStore requires filePath');

  // Per-store mutation serializer. Read-modify-write operations on a
  // JSON store race in JS even within a single process: two awaiting
  // setters can both readStore → both modify their copy → both
  // writeStore, and the second write silently clobbers the first.
  // Funnel every mutation through this chain so the read-modify-write
  // is sequential. Reads still go straight to disk (concurrent reads
  // are safe; they only need to see a consistent file, which the
  // atomic rename in writeStore already guarantees).
  let mutationChain = Promise.resolve();
  function serialize(fn) {
    const next = mutationChain.then(fn, fn);  // run regardless of prior failure
    // Don't let one rejection poison the chain — record settled state.
    mutationChain = next.catch(() => undefined);
    return next;
  }

  async function getGlobalDefaultSyncMode() {
    const store = await readStore(filePath);
    return store.default;
  }

  async function setGlobalDefaultSyncMode(mode) {
    if (!isValidMode(mode)) {
      throw new Error('setGlobalDefaultSyncMode: invalid mode ' + mode
        + ' (expected one of ' + VALID_MODES.join('/') + ')');
    }
    return serialize(async () => {
      const store = await readStore(filePath);
      store.default = mode;
      await writeStore(filePath, store);
      return mode;
    });
  }

  async function getProjectSyncMode(keyParts) {
    // Graceful read for incomplete identity (e.g. pre-activation,
    // cfg.serverAddr=''). Settings UI / B6/B7 callers that want to
    // probe "is there an override?" shouldn't have to wrap every
    // lookup in try/catch.
    if (!isCompleteKeyParts(keyParts)) return null;
    const key = projectKey(keyParts);
    const store = await readStore(filePath);
    const explicit = store.projects[key];
    return isValidMode(explicit) ? explicit : null;
  }

  async function setProjectSyncMode(keyParts, mode) {
    // Writes require complete identity — projectKey will throw.
    // Validate mode first so a bad-mode + bad-key call produces the
    // mode error (more actionable).
    if (!isValidMode(mode)) {
      throw new Error('setProjectSyncMode: invalid mode ' + mode);
    }
    const key = projectKey(keyParts);
    return serialize(async () => {
      const store = await readStore(filePath);
      store.projects[key] = mode;
      await writeStore(filePath, store);
      return mode;
    });
  }

  // Clear a per-project override. No-op if the key isn't present
  // (still reads, but doesn't write — so file mtime stays stable).
  async function clearProjectSyncMode(keyParts) {
    if (!isCompleteKeyParts(keyParts)) return;
    const key = projectKey(keyParts);
    return serialize(async () => {
      const store = await readStore(filePath);
      if (!Object.prototype.hasOwnProperty.call(store.projects, key)) return;
      delete store.projects[key];
      await writeStore(filePath, store);
    });
  }

  // The decision API: per-project override > global default.
  // Pre-activation / incomplete identity → return DEFAULT_MODE
  // (graceful degrade). Callers in hot paths don't need to wrap.
  async function getEffectiveSyncMode(keyParts) {
    const store = await readStore(filePath);
    const fallback = isValidMode(store.default) ? store.default : DEFAULT_MODE;
    if (!isCompleteKeyParts(keyParts)) return fallback;
    const key = projectKey(keyParts);
    const explicit = store.projects[key];
    if (isValidMode(explicit)) return explicit;
    return fallback;
  }

  // Used by crash-recovery / settings UI to enumerate explicit
  // per-project overrides.
  async function listProjectOverrides() {
    const store = await readStore(filePath);
    return { ...store.projects };
  }

  return {
    getGlobalDefaultSyncMode,
    setGlobalDefaultSyncMode,
    getProjectSyncMode,
    setProjectSyncMode,
    clearProjectSyncMode,
    getEffectiveSyncMode,
    listProjectOverrides,
  };
}

module.exports = {
  createSyncModeStore,
  projectKey,
  VALID_MODES,
  DEFAULT_MODE,
  isValidMode,
  isCompleteKeyParts,
  normalizeServerAddrForKey,
  // Internal helpers exposed for tests; not part of the public API.
  _internals: {
    normalizeKeyParts,
    normalizeStoreShape,
    readStore,
    writeStore,
  },
};
