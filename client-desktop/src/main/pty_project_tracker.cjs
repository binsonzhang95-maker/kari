'use strict';

// pty_project_tracker — PTY-driven project activity index.
//
// PTY-driven concurrent-sync plan T4. The tracker is the "what projects
// is the user actively working on" oracle, sourcing its signal from PTY
// lifecycle events.
//
// Lifecycle:
//
//   registerPty(ptyId, cwd)
//     ├─ walkUpToProjectRoot finds nearest project root
//     ├─ if no project (cwd is outside any project tree) → no-op
//     ├─ ptyCount 0 → 1 → emit 'pty:project:active'
//     └─ cancels any pending retire timer for that project
//
//   unregisterPty(ptyId)
//     ├─ ptyCount > 0 → emit 'pty:project:idle'
//     └─ schedule retire after cooldownMs; on fire (if still idle) →
//        emit 'pty:project:retire' and forget the project
//
// Downstream (plan T5 sync_scheduler) listens to active + retire to drive
// syncthing folder creation / teardown. The intermediate idle event is
// informational — most consumers can ignore it and only act on retire.
//
// Pure module: no I/O beyond walkUpToProjectRoot's readdir. Injectable
// timers + isProjectRoot make every code path reachable in tests without
// touching real PTYs or real disks.

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// HOME_DIR is excluded from the project-root check below. Kari's own
// runtime state lives at <home>/.kari/, which collides with the
// per-project `.kari/` marker `defaultIsProjectRoot` looks for. On
// Windows this matters every time because `os.tmpdir()` returns
// `C:\Users\<user>\AppData\Local\Temp\…` — a child of home — so any
// walk-up from a temp path eventually hits the home dir and false-
// positives. macOS hides the bug only because /var/folders is
// outside the home tree.
const HOME_DIR = path.resolve(os.homedir() || '');

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

// defaultIsProjectRoot recognises a directory as a project root if it
// contains a `.kariignore` file or a `.kari/` subdirectory. Production
// callers can override via the createPtyProjectTracker option so the
// tracker can defer to the live project registry instead of walking the
// filesystem.
async function defaultIsProjectRoot(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === '.kariignore') return true;
    if (entry.name === '.kari' && entry.isDirectory()) return true;
  }
  return false;
}

// walkUpToProjectRoot ascends from `cwd` until it finds a directory the
// `isProjectRoot` predicate accepts. Returns the absolute project root
// path or null if none up to filesystem root / depth cap (64 levels —
// far past any sane checkout depth, kept finite to bound the call).
async function walkUpToProjectRoot(cwd, isProjectRoot) {
  const check = typeof isProjectRoot === 'function' ? isProjectRoot : defaultIsProjectRoot;
  let dir = path.resolve(cwd);
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    if (seen.has(dir)) return null; // symlink loop guard
    seen.add(dir);
    // Skip the user's home dir as a candidate. Kari stores its own
    // runtime state at <home>/.kari/ and that directory would
    // otherwise satisfy the default predicate's `.kari/` check,
    // causing every walk that passes through home to return home as
    // a "project." Walk continues upward — projects living at
    // /<drive>/<random>/<proj> still resolve correctly; the only
    // semantic loss is "project IS the home dir," which nobody does.
    if (HOME_DIR && dir === HOME_DIR) {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
      continue;
    }
    if (await check(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// createPtyProjectTracker wires a fresh state machine + EventEmitter.
//
// Options:
//   - cooldownMs:    ms after the last PTY closes before retire fires.
//                    Default 10 min (plan T4 default).
//   - isProjectRoot: async predicate (dir → bool). Default checks for
//                    .kariignore or .kari/ child.
//   - timers:        { setTimeout, clearTimeout } injection point for
//                    deterministic tests. Defaults to globals.
function createPtyProjectTracker({
  cooldownMs = DEFAULT_COOLDOWN_MS,
  isProjectRoot,
  timers,
} = {}) {
  const events = new EventEmitter();
  const setTimeoutFn = (timers && typeof timers.setTimeout === 'function') ? timers.setTimeout : global.setTimeout;
  const clearTimeoutFn = (timers && typeof timers.clearTimeout === 'function') ? timers.clearTimeout : global.clearTimeout;
  // projects: Map<projectRoot, { ptyCount, lastSeenMs, retireTimer }>
  const projects = new Map();
  // ptyToProject: Map<ptyId, projectRoot>
  const ptyToProject = new Map();

  async function registerPty(ptyId, cwd) {
    if (!ptyId) return null;
    if (!cwd) return null;
    if (ptyToProject.has(ptyId)) return ptyToProject.get(ptyId); // idempotent (sync)
    const projectRoot = await walkUpToProjectRoot(cwd, isProjectRoot);
    if (!projectRoot) return null;
    // Double-check after the await: a concurrent register for the same
    // ptyId may have raced past the first has() check and reached this
    // point too. The first writer wins; the second returns the existing
    // mapping without incrementing ptyCount.
    if (ptyToProject.has(ptyId)) return ptyToProject.get(ptyId);
    return commitRegistration(ptyId, projectRoot);
  }

  // registerForProject lets callers register a handle against a specific
  // project root directly, skipping the cwd → walkUp resolution. Used by
  // virtual "UI-active" markers where the caller already knows the
  // project path (no PTY cwd to walk up from). Idempotent on duplicate
  // ptyId — second call returns the cached mapping.
  function registerForProject(ptyId, projectAbsPath) {
    if (!ptyId || !projectAbsPath) return null;
    if (ptyToProject.has(ptyId)) return ptyToProject.get(ptyId);
    return commitRegistration(ptyId, projectAbsPath);
  }

  function commitRegistration(ptyId, projectRoot) {
    ptyToProject.set(ptyId, projectRoot);
    let state = projects.get(projectRoot);
    if (!state) {
      state = { ptyCount: 0, lastSeenMs: Date.now(), retireTimer: null };
      projects.set(projectRoot, state);
    }
    if (state.retireTimer) {
      clearTimeoutFn(state.retireTimer);
      state.retireTimer = null;
    }
    const wasIdle = state.ptyCount === 0;
    state.ptyCount += 1;
    state.lastSeenMs = Date.now();
    if (wasIdle) {
      events.emit('pty:project:active', projectRoot);
    }
    return projectRoot;
  }

  function unregisterPty(ptyId) {
    if (!ptyId) return null;
    const projectRoot = ptyToProject.get(ptyId);
    if (!projectRoot) return null;
    ptyToProject.delete(ptyId);
    const state = projects.get(projectRoot);
    if (!state) return projectRoot;
    state.ptyCount = Math.max(0, state.ptyCount - 1);
    state.lastSeenMs = Date.now();
    if (state.ptyCount === 0) {
      events.emit('pty:project:idle', projectRoot);
      // Schedule retire. Use the injected timer so tests can fast-
      // forward without 10-minute waits.
      state.retireTimer = setTimeoutFn(() => {
        const cur = projects.get(projectRoot);
        // Re-check at fire time — a registerPty during cooldown would
        // have cleared this timer, but a race is possible if the timer
        // fires before clearTimeout took effect. Treat the live state
        // as authoritative.
        if (!cur || cur.ptyCount > 0) return;
        cur.retireTimer = null;
        projects.delete(projectRoot);
        events.emit('pty:project:retire', projectRoot);
      }, cooldownMs);
    }
    return projectRoot;
  }

  function snapshot() {
    const out = [];
    for (const [projectRoot, state] of projects) {
      out.push({
        projectRoot,
        ptyCount: state.ptyCount,
        lastSeenMs: state.lastSeenMs,
        pendingRetire: state.retireTimer !== null,
      });
    }
    return out;
  }

  function clear() {
    for (const state of projects.values()) {
      if (state.retireTimer) clearTimeoutFn(state.retireTimer);
    }
    projects.clear();
    ptyToProject.clear();
  }

  // clearForProject forcibly drops every handle registered against a
  // specific project root and fires `pty:project:retire` immediately
  // (bypassing the cooldown). Used by deleteLocalProject so the
  // syncthing folder is torn down BEFORE the directory disappears
  // from disk — otherwise the folder enters fail state on the next
  // scan and we'd be relying on sweepKariFoldersOnBoot to clean it.
  // Returns the list of ptyIds that were dropped, in case the caller
  // also needs to kill underlying native PTY handles.
  function clearForProject(projectAbsPath) {
    if (!projectAbsPath) return [];
    const state = projects.get(projectAbsPath);
    if (!state) return [];
    const droppedPtyIds = [];
    for (const [ptyId, projectRoot] of ptyToProject) {
      if (projectRoot === projectAbsPath) {
        droppedPtyIds.push(ptyId);
      }
    }
    for (const ptyId of droppedPtyIds) {
      ptyToProject.delete(ptyId);
    }
    if (state.retireTimer) clearTimeoutFn(state.retireTimer);
    projects.delete(projectAbsPath);
    events.emit('pty:project:retire', projectAbsPath);
    return droppedPtyIds;
  }

  return {
    events,
    registerPty,
    registerForProject,
    unregisterPty,
    snapshot,
    clear,
    clearForProject,
  };
}

module.exports = {
  createPtyProjectTracker,
  walkUpToProjectRoot,
  defaultIsProjectRoot,
  DEFAULT_COOLDOWN_MS,
};
