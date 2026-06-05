'use strict';

const path = require('path');

function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(String(a)) === path.resolve(String(b));
  } catch {
    return String(a) === String(b);
  }
}

function stringOr(value, fallback) {
  const s = String(value || '').trim();
  return s || fallback;
}

function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function completionPercent(completion) {
  if (!completion || typeof completion !== 'object') return undefined;
  return clampPercent(completion.completion, undefined);
}

function hasRemoteNeed(completion) {
  if (!completion || typeof completion !== 'object') return false;
  return Number(completion.needBytes || 0) > 0
    || Number(completion.needItems || 0) > 0
    || Number(completion.needDeletes || 0) > 0;
}

function dbStatusError(dbStatus) {
  if (!dbStatus || typeof dbStatus !== 'object') return '';
  const explicit = stringOr(dbStatus.error, '') || stringOr(dbStatus.invalid, '');
  if (explicit) return explicit;
  if (Number(dbStatus.errors || 0) > 0) return 'state.syncthing.folder_errors';
  if (Number(dbStatus.pullErrors || 0) > 0) return 'state.syncthing.pull_errors';
  if (String(dbStatus.state || '').toLowerCase() === 'error') return 'state.syncthing.folder_error';
  return '';
}

function mapSyncthingStateName(raw) {
  const state = String(raw || '').toLowerCase();
  if (state === 'error') return 'error';
  if (
    state === 'scanning'
    || state === 'scan-waiting'
    || state === 'scan-preparing'
  ) {
    return 'scanning';
  }
  if (
    state === 'syncing'
    || state === 'sync-preparing'
    || state === 'sync-waiting'
    || state === 'sync-cleaning'
    || state === 'cleaning'
  ) {
    return 'syncing';
  }
  return 'idle';
}

function isTransientStartupSnapshotError(snapshot) {
  const code = String(snapshot && snapshot.code || '');
  return code === 'syncthing_not_running'
    || code === 'syncthing_folders_unavailable';
}

function buildState(ctx, fields) {
  const project = ctx.project || {};
  const workspaceName = stringOr(ctx.workspaceName, stringOr(project.workspaceName, stringOr(project.name, '')));
  const localPath = fields.localPath;
  const out = {
    workspaceId: stringOr(ctx.workspaceId, stringOr(project.workspaceId, '')),
    workspaceName,
    name: stringOr(project.name, workspaceName),
    syncBackend: 'syncthing',
    availability: fields.availability,
    openable: Boolean(fields.openable),
    syncState: fields.syncState,
    connectionIntent: fields.connectionIntent || null,
    completion: fields.completion,
    conflictCount: 0,
  };
  if (localPath) out.localPath = localPath;
  if (fields.lastError) out.lastError = fields.lastError;
  return out;
}

function mapInactiveProject(ctx) {
  const project = ctx.project || {};
  const mirrorPresent = Boolean(ctx.mirrorDirExists || project.existsLocal);
  const localPath = mirrorPresent ? stringOr(project.localPath, stringOr(project.path, '')) : '';
  if (mirrorPresent) {
    return buildState(ctx, {
      availability: 'connected',
      openable: true,
      syncState: 'idle',
      connectionIntent: null,
      completion: 100,
      localPath,
    });
  }
  if (project.source === 'local') {
    return buildState(ctx, {
      availability: 'local_only',
      openable: true,
      syncState: 'idle',
      connectionIntent: null,
      completion: undefined,
      localPath: stringOr(project.localPath, stringOr(project.path, '')),
    });
  }
  return buildState(ctx, {
    availability: 'cloud_only',
    openable: false,
    syncState: 'idle',
    connectionIntent: null,
    completion: undefined,
    localPath: '',
  });
}

function mapSyncthingProjectConnectionState(args) {
  const ctx = args || {};
  const project = ctx.project || {};
  const mirrorPresent = Boolean(ctx.mirrorDirExists || project.existsLocal);
  const localPath = mirrorPresent ? stringOr(project.localPath, stringOr(project.path, '')) : '';

  if (!ctx.activeForCurrentFolder) {
    return mapInactiveProject(ctx);
  }

  const snapshot = ctx.snapshot || null;
  if (snapshot && snapshot.ok === false) {
    if (isTransientStartupSnapshotError(snapshot)) {
      return buildState(ctx, {
        availability: mirrorPresent ? 'connected' : 'provisioning',
        openable: mirrorPresent,
        syncState: 'syncing',
        connectionIntent: 'publishing',
        completion: 0,
        localPath,
      });
    }
    return buildState(ctx, {
      availability: mirrorPresent ? 'connected' : 'cloud_only',
      openable: mirrorPresent,
      syncState: 'error',
      connectionIntent: null,
      completion: undefined,
      lastError: snapshot.error || snapshot.code || 'state.syncthing.status_unavailable',
      localPath,
    });
  }

  if (!snapshot || !snapshot.folder) {
    return buildState(ctx, {
      availability: mirrorPresent ? 'connected' : 'provisioning',
      openable: mirrorPresent,
      syncState: 'syncing',
      connectionIntent: 'publishing',
      completion: 0,
      localPath,
    });
  }

  const dbStatus = snapshot.dbStatus || null;
  const completion = snapshot.completion || null;
  const dbError = dbStatusError(dbStatus);
  const percent = completionPercent(completion);
  const remoteNeed = hasRemoteNeed(completion);
  const mapped = mapSyncthingStateName(dbStatus && dbStatus.state);

  if (dbError) {
    return buildState(ctx, {
      availability: mirrorPresent ? 'connected' : 'provisioning',
      openable: mirrorPresent,
      syncState: 'error',
      connectionIntent: null,
      completion: percent,
      lastError: dbError,
      localPath,
    });
  }

  if (snapshot.peerConnected === false && remoteNeed) {
    return buildState(ctx, {
      availability: mirrorPresent ? 'connected' : 'provisioning',
      openable: mirrorPresent,
      syncState: 'paused',
      connectionIntent: null,
      completion: percent,
      lastError: 'state.syncthing.peer_disconnected',
      localPath,
    });
  }

  if (mapped === 'scanning') {
    const scanProgress = typeof percent === 'number'
      ? Math.min(percent, 10)
      : 10;
    return buildState(ctx, {
      availability: mirrorPresent ? 'connected' : 'provisioning',
      openable: mirrorPresent,
      syncState: 'scanning',
      connectionIntent: 'publishing',
      completion: scanProgress,
      localPath,
    });
  }

  if (mapped === 'syncing' || remoteNeed || (typeof percent === 'number' && percent < 100)) {
    return buildState(ctx, {
      availability: mirrorPresent ? 'connected' : 'provisioning',
      openable: mirrorPresent,
      syncState: 'syncing',
      connectionIntent: 'publishing',
      completion: typeof percent === 'number' ? percent : 0,
      localPath,
    });
  }

  return buildState(ctx, {
    availability: mirrorPresent ? 'connected' : 'cloud_only',
    openable: mirrorPresent,
    syncState: 'idle',
    connectionIntent: null,
    completion: typeof percent === 'number' ? percent : 100,
    localPath,
  });
}

function syncthingProjectIsActive({ project, cfgWorkspaceName, cfgWorkspaceRoot, folderPath } = {}) {
  const p = project || {};
  const projectName = stringOr(p.workspaceName, stringOr(p.name, ''));
  if (projectName && cfgWorkspaceName && projectName === String(cfgWorkspaceName).trim()) return true;
  const localPath = stringOr(p.localPath, '');
  const projectPath = stringOr(p.path, '');
  if (samePath(localPath, cfgWorkspaceRoot) || samePath(projectPath, cfgWorkspaceRoot)) return true;
  if (samePath(localPath, folderPath) || samePath(projectPath, folderPath)) return true;
  return false;
}

function projectUsesSyncthingState({ project, cfgWorkspaceSyncBackend, activeForCurrentFolder } = {}) {
  const backend = String(project && project.syncBackend || '').toLowerCase();
  if (backend === 'syncthing') return true;
  if (backend === 'filesync') return false;
  return String(cfgWorkspaceSyncBackend || '').toLowerCase() === 'syncthing'
    && Boolean(activeForCurrentFolder);
}

module.exports = {
  mapSyncthingProjectConnectionState,
  projectUsesSyncthingState,
  syncthingProjectIsActive,
  // exported for focused tests if this mapper grows
  _private: {
    completionPercent,
    dbStatusError,
    hasRemoteNeed,
    isTransientStartupSnapshotError,
    mapSyncthingStateName,
    samePath,
  },
};
