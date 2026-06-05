'use strict';

// Syncthing REST client (Phase 1.2 + 1.3 of the syncthing migration).
//
// Thin wrapper around the syncthing v1 REST API:
//   GET  /rest/system/status        — version, deviceId, uptime
//   GET  /rest/system/version       — version metadata only
//   GET  /rest/system/connections   — peer connectivity
//   GET  /rest/config               — full config snapshot
//   GET  /rest/config/devices       — device array
//   PUT  /rest/config/devices/{id}  — upsert one device
//   DELETE /rest/config/devices/{id}
//   GET  /rest/config/folders       — folder array
//   PUT  /rest/config/folders/{id}  — upsert one folder
//   DELETE /rest/config/folders/{id}
//   GET  /rest/db/status?folder=ID  — per-folder sync state
//   GET  /rest/db/completion?folder=ID&device=ID — remote device completion
//   POST /rest/db/scan?folder=ID&sub=PATH — trigger a folder/subtree rescan
//   GET  /rest/db/ignores?folder=ID — read effective .stignore
//   POST /rest/db/ignores?folder=ID — write .stignore
//   GET  /rest/events?since=N&timeout=30 — long-poll event stream
//
// Authentication: every request carries X-API-Key header. The api key
// originates from config.xml (set on -generate, persisted in homeDir).
//
// The client is stateless — caller passes { guiAddress, apiKey } each
// call. main.cjs's syncthing_process.getRunningMeta() supplies them.

const http = require('node:http');

function parseGuiAddress(guiAddress) {
  if (typeof guiAddress !== 'string' || !guiAddress.includes(':')) {
    throw new Error('parseGuiAddress: expected "host:port", got ' + JSON.stringify(guiAddress));
  }
  const [host, portStr] = guiAddress.split(':');
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('parseGuiAddress: invalid port in ' + guiAddress);
  }
  return { host, port };
}

async function request({ guiAddress, apiKey, method = 'GET', pathStr, body = null, timeoutMs = 5000 }) {
  const { host, port } = parseGuiAddress(guiAddress);
  return new Promise((resolve) => {
    const headers = { 'X-API-Key': String(apiKey || '') };
    let payload = null;
    if (body != null) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({ host, port, path: pathStr, method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (raw.length > 0) {
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        }
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: String(err && err.message || err) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// --- System / config queries ---

async function getStatus(creds) { return request({ ...creds, pathStr: '/rest/system/status' }); }
async function getVersion(creds) { return request({ ...creds, pathStr: '/rest/system/version' }); }
async function getConnections(creds) { return request({ ...creds, pathStr: '/rest/system/connections' }); }
async function getConfig(creds) { return request({ ...creds, pathStr: '/rest/config' }); }
async function getDevices(creds) { return request({ ...creds, pathStr: '/rest/config/devices' }); }
async function getFolders(creds) { return request({ ...creds, pathStr: '/rest/config/folders' }); }
async function getDbStatus(creds, folderId) {
  return request({ ...creds, pathStr: `/rest/db/status?folder=${encodeURIComponent(folderId)}` });
}
async function getDbCompletion(creds, folderId, deviceId) {
  return request({
    ...creds,
    pathStr: `/rest/db/completion?folder=${encodeURIComponent(folderId)}&device=${encodeURIComponent(deviceId)}`,
  });
}
async function scanFolder(creds, folderId, subPath = '') {
  const sub = String(subPath || '').trim();
  const subQuery = sub ? `&sub=${encodeURIComponent(sub)}` : '';
  return request({
    ...creds,
    method: 'POST',
    pathStr: `/rest/db/scan?folder=${encodeURIComponent(folderId)}${subQuery}`,
    timeoutMs: 15000,
  });
}

// --- Device / folder mutations ---

// Add or update a peer device. Idempotent.
async function putDevice(creds, device) {
  return request({ ...creds, method: 'PUT', pathStr: `/rest/config/devices/${encodeURIComponent(device.deviceID)}`, body: device });
}
async function deleteDevice(creds, deviceId) {
  return request({ ...creds, method: 'DELETE', pathStr: `/rest/config/devices/${encodeURIComponent(deviceId)}` });
}
async function putFolder(creds, folder) {
  return request({ ...creds, method: 'PUT', pathStr: `/rest/config/folders/${encodeURIComponent(folder.id)}`, body: folder });
}
async function deleteFolder(creds, folderId) {
  return request({ ...creds, method: 'DELETE', pathStr: `/rest/config/folders/${encodeURIComponent(folderId)}` });
}

// --- Ignore rules (.stignore) ---

async function getIgnores(creds, folderId) {
  return request({ ...creds, pathStr: `/rest/db/ignores?folder=${encodeURIComponent(folderId)}` });
}
async function setIgnores(creds, folderId, lines) {
  return request({ ...creds, method: 'POST', pathStr: `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`, body: { ignore: Array.isArray(lines) ? lines : [] } });
}

// --- Event stream (used by Phase 2 UI subscription) ---

async function getEvents(creds, { since = 0, timeoutSec = 30, events = [] } = {}) {
  const list = Array.isArray(events)
    ? events.map((eventType) => String(eventType || '').trim()).filter(Boolean)
    : [];
  const eventQuery = list.length ? `&events=${encodeURIComponent(list.join(','))}` : '';
  return request({
    ...creds,
    pathStr: `/rest/events?since=${since}&timeout=${timeoutSec}${eventQuery}`,
    timeoutMs: (timeoutSec + 5) * 1000,
  });
}

// --- High-level helpers ---

// Build a Device payload from primitive fields. Use this rather than
// constructing literals so we keep server-side defaults consistent.
function buildDevicePayload({ deviceId, name, addresses, autoAcceptFolders = true }) {
  return {
    deviceID: deviceId,
    name: name || '',
    addresses: Array.isArray(addresses) && addresses.length > 0 ? addresses : ['dynamic'],
    compression: 'metadata',
    introducer: false,
    skipIntroductionRemovals: false,
    introducedBy: '',
    paused: false,
    autoAcceptFolders,
    maxSendKbps: 0,
    maxRecvKbps: 0,
    maxRequestKiB: 0,
    untrusted: false,
    remoteGUIPort: 0,
    numConnections: 0,
  };
}

// Build a Folder payload. Defaults follow Plan §6.3 strict remote-wins:
//   - no versioning on Desktop (set type='none')
//   - order='alphabetic'
//   - ignorePerms=false
function buildFolderPayload({ folderId, label, folderPath, deviceIds, sendreceive = true }) {
  const devices = (deviceIds || []).map((id) => ({ deviceID: id, introducedBy: '', encryptionPassword: '' }));
  return {
    id: folderId,
    label: label || folderId,
    filesystemType: 'basic',
    path: folderPath,
    type: sendreceive ? 'sendreceive' : 'receiveonly',
    devices,
    rescanIntervalS: 60,
    fsWatcherEnabled: true,
    fsWatcherDelayS: 2,
    ignorePerms: false,
    autoNormalize: true,
    minDiskFree: { value: 1, unit: '%' },
    versioning: { type: '', params: {}, cleanupIntervalS: 3600, fsPath: '', fsType: 'basic' },
    copiers: 0,
    pullerMaxPendingKiB: 0,
    hashers: 0,
    order: 'alphabetic',
    ignoreDelete: false,
    scanProgressIntervalS: 0,
    pullerPauseS: 0,
    maxConflicts: 0,
    disableSparseFiles: false,
    disableTempIndexes: false,
    paused: false,
    weakHashThresholdPct: 25,
    markerName: '.stfolder',
    copyOwnershipFromParent: false,
    modTimeWindowS: 0,
    maxConcurrentWrites: 2,
    disableFsync: false,
    blockPullOrder: 'standard',
    copyRangeMethod: 'standard',
    caseSensitiveFS: false,
    junctionsAsDirs: false,
    syncOwnership: false,
    sendOwnership: false,
    syncXattrs: false,
    sendXattrs: false,
    xattrFilter: { entries: [], maxSingleEntrySize: 1024, maxTotalSize: 4096 },
  };
}

module.exports = {
  request,
  getStatus,
  getVersion,
  getConnections,
  getConfig,
  getDevices,
  getFolders,
  getDbStatus,
  getDbCompletion,
  scanFolder,
  putDevice,
  deleteDevice,
  putFolder,
  deleteFolder,
  getIgnores,
  setIgnores,
  getEvents,
  buildDevicePayload,
  buildFolderPayload,
  parseGuiAddress,
};
