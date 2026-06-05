'use strict';

// Ignore evaluator for the snapshot pipeline (Phase B step B2).
//
// Two-mode model (replaces the earlier fast/project/full triplet):
//
//   - lightweight (default)
//       Kari-managed denylist (built-in patterns covering common
//       dependency directories, build artifacts, runtime logs) PLUS
//       the user's project-root `.kariignore` (which may add ignore
//       rules or limited re-include rules to clw back specific files
//       from the denylist). The HARD-IGNORE patterns (.git/,
//       .kari-engine/, *.kari-incoming, *.tmp.kari-incoming) are
//       always applied as a separate front predicate and CANNOT be
//       re-included by any .kariignore rule.
//
//   - full
//       The lightweight denylist is NOT applied. Only the
//       user's .kariignore + hard-ignore are honored. The user
//       chose to include all dependency / build artifacts and
//       accepts the size + churn cost.
//
// `.gitignore` is no longer read at all — sync ignore is now a Kari
// concern, decoupled from the project's git ignore. This matches the
// "Kari fully manages ignore" alignment decision: the user shouldn't
// have to maintain two ignore systems, and gitignore semantics (e.g.
// directory exclusion is final) confused the snapshot pipeline.
//
// Hard-ignore as a separate front predicate is load-bearing for
// data safety. If hard-ignore patterns lived inside the `ignore`
// instance, a hostile or misconfigured `.kariignore` could re-include
// them via `!.git/` negation. Splitting the check makes that
// impossible.
//
// Hard-ignore is segment-based (not anchored to project root) so
// nested .git / .kari-engine in monorepos, submodules, vendored
// repos, or worktrees are still protected. Comparisons are
// case-insensitive so .Git / .KARI-ENGINE on case-insensitive
// filesystems can't bypass. Backslash-style paths are normalized
// defensively.
//
// The same effective rule set is consumed by:
//   - the matcher (in-memory, used by snapshot walker)
//   - the .stignore writer (B12 — sends to Syncthing folder so daemon
//     transport-layer ignore matches Desktop snapshot/manifest ignore)
// Both pull from `getEffectiveIgnoreLines` to guarantee manifest and
// .stignore can never disagree on what's syncable.

const fsp = require('node:fs/promises');
const path = require('node:path');
const ignore = require('ignore');

// Sync modes. fast/project from the previous version both collapse to
// `lightweight`; the old `full` value carries through unchanged.
const VALID_MODES = ['lightweight', 'full'];
const VALID_MODE_SET = new Set(VALID_MODES);
const DEFAULT_MODE = 'lightweight';

// Map legacy mode names → current ones. Used by the sync_mode_store
// and session_store loaders to migrate persisted values without
// requiring a separate migration step.
const LEGACY_MODE_MAP = {
  fast: 'lightweight',
  project: 'lightweight',
  full: 'full',
};

function isValidMode(m) {
  return typeof m === 'string' && VALID_MODE_SET.has(m);
}

function migrateLegacyMode(m) {
  if (typeof m !== 'string') return null;
  if (isValidMode(m)) return m;
  if (Object.prototype.hasOwnProperty.call(LEGACY_MODE_MAP, m)) {
    return LEGACY_MODE_MAP[m];
  }
  return null;
}

// Hard-ignore patterns. Written into the .stignore (LAST, so they
// win against any user re-include rules) AND enforced via a front
// predicate in the matcher (where they can't be bypassed at all).
//
// Object.freeze prevents a caller — or a future test — that
// dereferences the export from mutating the underlying array. The
// matcher's front predicate doesn't actually read this array
// (hardIgnoreCheckNormalized has the patterns inlined), but B12's
// .stignore writer DOES, and a .splice(0) would silently drop
// hard-ignore lines from the transport-layer filter. getHardIgnoreLines()
// also returns a slice for defense in depth.
const HARD_IGNORE_PATTERNS = Object.freeze([
  '.git/',
  '.kari-engine/',
  '*.kari-incoming',
  '*.tmp.kari-incoming',
  '.DS_Store',
  'Thumbs.db',
]);

// Kari-managed denylist applied only in `lightweight` mode. Curated
// for the common cases that dominate sync time + storage cost:
// language package managers, build artifacts, native build caches,
// IDE intermediate dirs, runtime logs.
//
// The user's .kariignore is appended AFTER this list so the user
// CAN re-include specific FILE-level patterns (e.g.,
// `!important.log` to claw back a file the `*.log` denylist entry
// would otherwise drop).
//
// IMPORTANT — gitignore directory-exclusion is final: once a
// directory like `dist/` is matched by the denylist, individual
// children CANNOT be re-included by a `!dist/release-notes.md` rule
// (the `ignore` package follows gitignore's "Git doesn't list
// excluded directories for performance reasons" rule). To keep
// specific children of a denylisted directory, the user must pick
// `full` mode for that project. The matcher's hard-ignore front
// predicate still applies regardless of any `.kariignore` rule.
//
// Frozen for the same reason HARD_IGNORE_PATTERNS is frozen — a
// caller mutating the array would silently re-shape every
// subsequent matcher / .stignore output in the process.
const LIGHTWEIGHT_DEFAULT_IGNORE = Object.freeze([
  // Node / JS / web
  'node_modules/',
  '.pnpm-store/',
  '.yarn/cache/',
  '.vite/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  // Generic build outputs
  'dist/',
  'build/',
  'out/',
  'coverage/',
  // Native / JVM / Rust
  'target/',
  '.gradle/',
  '.cxx/',
  // Python
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  // Python virtualenv (multiple conventional names — pip / python -m
  // venv default to .venv/, older tutorials and some tools still use
  // venv/ or env/). All three can grow to GBs of installed wheels;
  // never useful to sync between machines (interpreter ABI differs).
  '.venv/',
  'venv/',
  'env/',
  // Mobile
  'Pods/',
  'DerivedData/',
  '.dart_tool/',
  // .NET / MSBuild. obj/ is intermediate build output (incl. the nuget
  // restore cache) — always generated, never source, so it's safe to
  // ignore at any depth. *.pdb (debug symbols) and *.nupkg (built nuget
  // packages) likewise. bin/ is deliberately NOT blanket-ignored here —
  // JS/CLI projects keep runnable scripts in bin/; a .NET-heavy workspace
  // should add `bin/` via its own .kariignore.
  'obj/',
  '*.pdb',
  '*.nupkg',
  // Swift (SwiftPM build dir; Xcode's DerivedData is above)
  '.build/',
  // Elixir / Erlang
  '_build/',
  // Ruby (bundler)
  '.bundle/',
  // Infra-as-code — downloaded providers/modules, can be hundreds of MB
  '.terraform/',
  '.serverless/',
  // Web framework build / caches (Rust's target/, Node's node_modules +
  // dist/ + .next/ etc. are already above; these fill the common gaps)
  '.angular/',
  '.svelte-kit/',
  '.astro/',
  '.nyc_output/',
  // React Native / Expo
  '.expo/',
  // Logs. `*.log` covers the common runtime case at any depth.
  // (Dropped `logs/` to avoid hard-excluding source content in
  // log-tooling repos — users with runtime logs in a non-`*.log`
  // pattern should add their own rule via .kariignore, or pick
  // `full` mode if the directory's contents need to sync.)
  '*.log',
]);

// Normalize a relative path for matching:
//   - replace backslash with forward slash (Windows)
//   - strip leading "./"
//   - strip trailing "/" (canonical form has no trailing slash)
function normalizeRel(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return '';
  let s = relPath.replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function hardIgnoreCheckNormalized(norm) {
  if (norm.length === 0) return false;
  const segments = norm.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length === 0) continue;
    const lower = seg.toLowerCase();
    if (lower === '.git' || lower === '.kari-engine') return true;
  }
  const base = segments[segments.length - 1];
  const baseLower = base.toLowerCase();
  // Case-insensitive on the `.kari-incoming` / `.tmp.kari-incoming`
  // checks so a hostile or accidentally-titlecased name (e.g.
  // `foo.KARI-INCOMING` on a case-insensitive macOS HFS+ volume) can't
  // bypass hard-ignore. The original code lowercased the segment-based
  // checks but raw-compared the suffix endsWith — silent drift the
  // sync_override_store commit message accidentally promised was fixed.
  if (baseLower.endsWith('.kari-incoming') || baseLower.endsWith('.tmp.kari-incoming')) return true;
  if (baseLower === '.ds_store' || baseLower === 'thumbs.db') return true;
  return false;
}

function isHardIgnored(relPath) {
  const norm = normalizeRel(relPath);
  if (norm.length === 0) return false;
  return hardIgnoreCheckNormalized(norm);
}

// Read .kariignore. ENOENT → empty string. Other errors throw —
// silent swallowing would degrade the matcher to "no ignore rules"
// and leak files the user expected to exclude. Strips leading BOM.
async function readKariignore(projectRoot) {
  const absPath = path.join(projectRoot, '.kariignore');
  let content;
  try {
    content = await fsp.readFile(absPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
  if (content.length > 0 && content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  return content;
}

// Split a multi-line ignore-file content into individual rule lines,
// trimming whitespace and dropping blank lines + comments. The
// `ignore` package handles blanks/comments internally, but for
// .stignore output we want a tidy list with comments / blanks
// excluded so downstream tooling sees only effective rules.
function splitIgnoreLines(content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const out = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

// Get the effective ignore rule list for a project + mode. The
// returned list is consumed by BOTH the matcher (via ig.add) AND
// the .stignore writer in B12, so the in-memory matcher and the
// daemon's Syncthing folder filter come from the same source.
//
// Order is significant for .stignore (later rules override earlier
// via gitignore-style negation): lightweight denylist first, then
// user .kariignore (so user can re-include from the denylist).
// Hard-ignore lives in a SEPARATE list returned via
// `getHardIgnoreLines` so the .stignore writer can append it last
// (transport-layer enforcement that no `!` rule can override).
async function getEffectiveIgnoreLines({ projectRoot, mode }) {
  if (!projectRoot) throw new Error('getEffectiveIgnoreLines requires projectRoot');
  const m = mode || DEFAULT_MODE;
  if (!isValidMode(m)) {
    throw new Error('getEffectiveIgnoreLines: unknown mode ' + m
      + ' (expected one of ' + VALID_MODES.join('/') + ')');
  }
  const lines = [];
  if (m === 'lightweight') {
    lines.push(...LIGHTWEIGHT_DEFAULT_IGNORE);
  }
  const userContent = await readKariignore(path.resolve(projectRoot));
  lines.push(...splitIgnoreLines(userContent));
  return lines;
}

function getHardIgnoreLines() {
  return HARD_IGNORE_PATTERNS.slice();
}

// Build the matcher used by the snapshot walker. THREE-stage with
// override claw-back in the middle slot:
//   1. isHardIgnored (front predicate — short-circuits, can't be
//      bypassed by any rule, including overrides)
//   2. Project include override claw-back — if relPath matches an
//      override anchor (or descends from one), return false (do NOT
//      ignore) regardless of what the denylist would say. This is
//      the file-tree sync visibility plan's load-bearing precedence:
//      hard-ignore > project override > lightweight denylist > .kariignore
//   3. ignore package over effective lines (denylist + .kariignore)
//
// Why claw-back is a separate predicate, NOT `!`-prefix lines in the
// ignore package: gitignore (and thus the `ignore` npm package) treats
// directory exclusion as FINAL — once `node_modules/` is denylisted,
// `!node_modules/foo/` cannot re-include children (the matcher never
// recurses into the excluded directory). So a `!`-line approach
// silently no-ops for the common case (override on a child of a
// denylisted directory). Short-circuiting BEFORE ig.ignores is the
// only correct shape. See plan §"Effective ignore precedence" warning
// block for the full reasoning.
//
// Returned matcher: `(relPath, isDir) => boolean` where true means
// "ignore this path". Defensive normalization makes the contract
// robust against walker bugs (forgotten backslash conversion,
// leading "./", etc.).
//
// includeOverrides — optional Set<string> of canonicalized anchor
// relPaths. Same canonical form as the override store
// (sync_override_store + snapshot_session_store both use
// path.posix.normalize + strip leading/trailing /). An anchor matches
// if relPath equals it OR descends from it with a "/" boundary
// ("node_modules/foo" matches "node_modules/foo/index.js" but NOT
// "node_modules/foo-bar"). Empty / undefined Set means no overrides.
async function buildIgnoreMatcher({ projectRoot, mode, includeOverrides }) {
  if (!projectRoot) throw new Error('buildIgnoreMatcher requires projectRoot');
  const m = mode || DEFAULT_MODE;
  if (!isValidMode(m)) {
    throw new Error('buildIgnoreMatcher: unknown mode ' + m
      + ' (expected one of ' + VALID_MODES.join('/') + ')');
  }
  const anchors = normalizeAnchorSet(includeOverrides);
  const lines = await getEffectiveIgnoreLines({ projectRoot, mode: m });
  const ig = ignore();
  if (lines.length > 0) ig.add(lines);
  return function matcher(relPath, isDir) {
    const norm = normalizeRel(relPath);
    if (norm.length === 0) return false;
    if (hardIgnoreCheckNormalized(norm)) return true;
    if (anchors.size > 0 && matchesAnyAnchor(norm, anchors)) return false;
    const probe = isDir && !norm.endsWith('/') ? norm + '/' : norm;
    return ig.ignores(probe);
  };
}

// Canonicalize the override anchor Set so caller-side variation
// (trailing slash, leading ./, embedded ./, double slash, etc.) doesn't
// produce two anchors that look different but match the same paths.
// Mirrors snapshot_session_store.normalizeScopeRelPath — both share
// the canonical form to ensure the matcher's view of "which paths are
// override-anchored" matches the session store's view of "which path
// is being uploaded for this anchor".
function normalizeAnchorSet(input) {
  const out = new Set();
  if (!input) return out;
  const iter = (typeof input[Symbol.iterator] === 'function') ? input : [];
  for (const raw of iter) {
    if (typeof raw !== 'string') continue;
    let s = raw.replace(/\\/g, '/');
    if (s.startsWith('/')) continue;   // absolute path is not a valid anchor
    s = path.posix.normalize(s);
    while (s.startsWith('./')) s = s.slice(2);
    while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    if (s.length === 0 || s === '.' || s === '..') continue;
    let escapes = false;
    for (const seg of s.split('/')) {
      if (seg === '..') { escapes = true; break; }
    }
    if (escapes) continue;
    out.add(s);
  }
  return out;
}

// Test if `norm` (already-normalized relPath) is at-or-below any anchor.
// Boundary check uses "anchor/" so "node_modules/foo" doesn't match an
// anchor "node_modules/f".
function matchesAnyAnchor(norm, anchors) {
  if (anchors.has(norm)) return true;
  for (const a of anchors) {
    if (norm.startsWith(a + '/')) return true;
  }
  return false;
}

module.exports = {
  buildIgnoreMatcher,
  getEffectiveIgnoreLines,
  getHardIgnoreLines,
  isHardIgnored,
  isValidMode,
  migrateLegacyMode,
  VALID_MODES,
  DEFAULT_MODE,
  HARD_IGNORE_PATTERNS,
  LIGHTWEIGHT_DEFAULT_IGNORE,
  LEGACY_MODE_MAP,
  _internals: {
    normalizeRel,
    normalizeAnchorSet,
    matchesAnyAnchor,
    readKariignore,
    splitIgnoreLines,
  },
};
