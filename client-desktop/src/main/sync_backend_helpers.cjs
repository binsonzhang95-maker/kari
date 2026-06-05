'use strict';

// Phase B B11 helpers. Tiny module so the predicates can be unit-
// tested without instantiating Electron's runtime.
//
// isSyncthingBackend(cfg) — true iff the workspace's sync_backend is
// 'syncthing'. Used to gate legacy /v1/sync-once and /v1/force-upload
// callsites in main.cjs that would otherwise race with Syncthing's
// own scan/watch on syncthing-backed workspaces.
//
// shouldKickLegacySyncOnce(cfg) — convenience inverse for the most
// common gating pattern. Equivalent to !isSyncthingBackend(cfg) but
// reads naturally at the call site:
//   if (shouldKickLegacySyncOnce(cfg)) postDaemon('/v1/sync-once', ...);

function isSyncthingBackend(_cfg) {
  // Single-tenant OSS: Syncthing is the ONLY, mandatory file backend. The
  // legacy filesync plane is disabled server-side (karid runs control-only),
  // so every workspace is syncthing-backed regardless of the stored
  // workspaceSyncBackend value (which older opens may have written as
  // 'filesync'). Forcing true keeps the daemon bind, the connection-state
  // routing, and the legacy-sync gates all on the syncthing path.
  return true;
}

function shouldKickLegacySyncOnce(cfg) {
  return !isSyncthingBackend(cfg);
}

function shouldUseLegacyManifestForFileTree(cfg) {
  return !isSyncthingBackend(cfg);
}

module.exports = {
  isSyncthingBackend,
  shouldKickLegacySyncOnce,
  shouldUseLegacyManifestForFileTree,
};
