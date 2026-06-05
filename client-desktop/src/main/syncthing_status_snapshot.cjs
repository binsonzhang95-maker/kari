'use strict';

const syncthingPair = require('./syncthing_pair.cjs');

function findRemoteDeviceId(folder, localDeviceId) {
  const local = String(localDeviceId || '').trim();
  const devices = folder && Array.isArray(folder.devices) ? folder.devices : [];
  for (const device of devices) {
    const id = String(device && (device.deviceID || device.deviceId || device.id) || '').trim();
    if (id && id !== local) return id;
  }
  return '';
}

async function loadSyncthingProjectSnapshot({ cfg, meta, projectRelPath, syncthingClient } = {}) {
  const workspaceId = String(cfg && cfg.workspaceId || '').trim();
  if (!workspaceId) return null;
  if (!meta || !meta.guiAddress || !meta.apiKey || !meta.deviceId) {
    return { ok: false, code: 'syncthing_not_running', error: 'state.syncthing.not_running' };
  }

  const sc = syncthingClient || require('./syncthing_client.cjs');
  const creds = { guiAddress: meta.guiAddress, apiKey: meta.apiKey };
  // Per-project folder_id when projectRelPath supplied (PTY-driven sync,
  // plan T6); legacy workspace-level shape otherwise — kept so a
  // KARI_DISABLE_PTY_SYNC=1 rollback still renders correct snapshots.
  let folderId;
  if (projectRelPath) {
    try {
      folderId = syncthingPair.folderIdFor({ workspaceId, projectRelPath });
    } catch (err) {
      return { ok: false, code: 'invalid_project_rel_path', error: String(err && err.message || err) };
    }
  } else {
    folderId = syncthingPair.folderIdForWorkspaceId(workspaceId);
  }

  const foldersResult = await sc.getFolders(creds);
  if (!foldersResult || !foldersResult.ok || !Array.isArray(foldersResult.body)) {
    return {
      ok: false,
      code: 'syncthing_folders_unavailable',
      error: 'state.syncthing.status_unavailable',
      folderId,
      status: foldersResult && foldersResult.status,
      body: foldersResult && foldersResult.body,
    };
  }

  const folder = foldersResult.body.find((f) => f && f.id === folderId) || null;
  if (!folder) {
    return {
      ok: true,
      folderId,
      folder: null,
      folderPath: '',
      serverDeviceId: '',
      dbStatus: null,
      completion: null,
      peerConnected: false,
    };
  }

  const serverDeviceId = findRemoteDeviceId(folder, meta.deviceId);
  const statusResult = await sc.getDbStatus(creds, folderId);
  const connectionsResult = await sc.getConnections(creds);
  const connections = connectionsResult && connectionsResult.ok && connectionsResult.body
    ? connectionsResult.body.connections || {}
    : {};
  const peer = serverDeviceId ? connections[serverDeviceId] : null;
  let completionResult = null;
  if (serverDeviceId) {
    completionResult = await sc.getDbCompletion(creds, folderId, serverDeviceId);
  }

  return {
    ok: true,
    folderId,
    folder,
    folderPath: String(folder.path || ''),
    serverDeviceId,
    dbStatus: statusResult && statusResult.ok ? statusResult.body : null,
    completion: completionResult && completionResult.ok ? completionResult.body : null,
    peerConnected: Boolean(peer && peer.connected),
    statusError: statusResult && !statusResult.ok ? statusResult.error || statusResult.status : undefined,
    completionError: completionResult && !completionResult.ok ? completionResult.error || completionResult.status : undefined,
  };
}

module.exports = {
  findRemoteDeviceId,
  loadSyncthingProjectSnapshot,
};
