'use strict';

// Syncthing event subscriber (Phase 2 of the migration).
//
// Long-polls /rest/events on the local syncthing child and folds the
// events into a small in-memory state cache that the renderer can read
// via the daemon:status / syncthing:state IPCs.
//
// We don't forward raw events to the renderer — that would force the
// renderer to mirror server-side bookkeeping. Instead the subscriber
// owns a derived projection:
//
//   {
//     peers: { [deviceId]: { connected, address, lastSeen } },
//     folders: { [folderId]: {
//        state, completion (0..1), errors[], lastItemAt, lastError,
//        globalFiles, inSyncFiles
//     } },
//     traffic: {
//        inBytesTotal, outBytesTotal, inBytesPerSec, outBytesPerSec,
//        at
//     },
//     events: { lastEventId, lastFetchAt, fetchOk },
//   }
//
// Event types we fold (subset of syncthing's full set):
//   - DeviceConnected       -> peers[id].connected = true
//   - DeviceDisconnected    -> peers[id].connected = false
//   - FolderSummary         -> folders[id].{globalFiles, inSyncFiles, completion}
//   - StateChanged          -> folders[id].state (scanning/syncing/idle/error)
//   - FolderErrors          -> folders[id].errors[]
//   - ItemStarted/ItemFinished — bump folders[id].lastItemAt
//
// Lifecycle:
//   - start({ guiAddress, apiKey, onUpdate }) — kicks off the poll loop.
//   - stop() — flips a flag so the next loop iteration exits; the
//     outstanding HTTP request times out within 30s.
//   - getState() — synchronous snapshot of the current cache.
//
// onUpdate(state) fires after each batch of folded events so callers
// (main.cjs) can broadcast to renderer windows.

const sc = require('./syncthing_client.cjs');

const LONG_POLL_TIMEOUT_SEC = 30;
const RETRY_BACKOFF_MS = 1000;
const CONNECTION_REFRESH_INTERVAL_MS = 1000;

function emptyState() {
  return {
    peers: {},
    folders: {},
    traffic: {
      inBytesTotal: 0,
      outBytesTotal: 0,
      inBytesPerSec: 0,
      outBytesPerSec: 0,
      at: null,
    },
    events: { lastEventId: 0, lastFetchAt: null, fetchOk: false },
  };
}

let _state = emptyState();
let _running = false;
let _stopReq = false;
let _onUpdate = null;
let _creds = null;
// Generation token: bumped on every start()/stop() so a previous run's loops
// (which may be parked in a 30s long-poll) exit cleanly when the subscriber is
// restarted with new creds, instead of lingering as a duplicate poller.
let _generation = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function getState() {
  // Return a structured clone so callers can't mutate the cache.
  return JSON.parse(JSON.stringify(_state));
}

function resetState() {
  _state = emptyState();
}

function foldEvent(state, evt) {
  if (!evt || typeof evt !== 'object') return state;
  const t = evt.type;
  const data = evt.data || {};
  if (t === 'DeviceConnected') {
    const id = String(data.id || '');
    if (id) {
      state.peers[id] = {
        ...(state.peers[id] || {}),
        connected: true,
        address: String(data.addr || ''),
        lastSeen: evt.time || new Date().toISOString(),
      };
    }
  } else if (t === 'DeviceDisconnected') {
    const id = String(data.id || '');
    if (id) {
      state.peers[id] = {
        ...(state.peers[id] || {}),
        connected: false,
        lastSeen: evt.time || new Date().toISOString(),
      };
    }
  } else if (t === 'FolderSummary') {
    const folderId = String(data.folder || '');
    const summary = data.summary || {};
    if (folderId) {
      const globalFiles = Number(summary.globalFiles || 0);
      const inSyncFiles = Number(summary.inSyncFiles || 0);
      // UNIT: folders[id].completion is a 0..1 ratio, LOCAL (file-count) — how
      // much of the global index this node has locally in sync. It is NOT the
      // per-remote-device 0..100 upload percent (that lives in
      // remoteCompletionByDevice and must never overwrite this field).
      const completion = globalFiles > 0 ? Math.min(1, Math.max(0, inSyncFiles / globalFiles)) : 1;
      state.folders[folderId] = {
        ...(state.folders[folderId] || {}),
        globalFiles,
        inSyncFiles,
        completion,
        state: summary.state || (state.folders[folderId] && state.folders[folderId].state) || 'idle',
      };
    }
  } else if (t === 'FolderCompletion') {
    // Per-remote-device upload/sync completion. completion is a 0..100 PERCENT
    // (distinct unit from FolderSummary's 0..1 local ratio above). Keyed by
    // device so the import-queue wait can check the CONSOLE peer specifically.
    const folderId = String(data.folder || '');
    const deviceId = String(data.device || '');
    if (folderId && deviceId) {
      const folder = { ...(state.folders[folderId] || {}) };
      folder.remoteCompletionByDevice = {
        ...(folder.remoteCompletionByDevice || {}),
        [deviceId]: {
          completion: Number(data.completion || 0), // 0..100 percent
          needBytes: Number(data.needBytes || 0),
          needItems: Number(data.needItems || 0),
          needDeletes: Number(data.needDeletes || 0),
          remoteState: String(data.remoteState || ''),
          sequence: Number(data.sequence || 0),
        },
      };
      state.folders[folderId] = folder;
    }
  } else if (t === 'FolderScanProgress') {
    // Scan-phase progress (~2s cadence). current/total are BYTES; derive a
    // 0..100 scanPercent (null when total<=0 to avoid divide-by-zero).
    const folderId = String(data.folder || '');
    if (folderId) {
      const total = Number(data.total || 0);
      const current = Number(data.current || 0);
      state.folders[folderId] = {
        ...(state.folders[folderId] || {}),
        scanCurrentBytes: current,
        scanTotalBytes: total,
        scanRateBytesPerSec: Number(data.rate || 0),
        scanPercent: total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : null,
      };
    }
  } else if (t === 'LocalIndexUpdated') {
    // Wakeup only (not completion proof): local index changed after a scan or
    // applied items.
    const folderId = String(data.folder || '');
    if (folderId) {
      state.folders[folderId] = {
        ...(state.folders[folderId] || {}),
        localIndexSequence: Number(data.sequence || data.version || 0),
        localIndexItems: Number(data.items || 0),
        lastIndexAt: evt.time || new Date().toISOString(),
      };
    }
  } else if (t === 'RemoteIndexUpdated') {
    // Wakeup only: a peer announced new index information.
    const folderId = String(data.folder || '');
    const deviceId = String(data.device || '');
    if (folderId) {
      const folder = { ...(state.folders[folderId] || {}), lastIndexAt: evt.time || new Date().toISOString() };
      if (deviceId) {
        folder.remoteIndexByDevice = {
          ...(folder.remoteIndexByDevice || {}),
          [deviceId]: { items: Number(data.items || 0), at: evt.time || new Date().toISOString() },
        };
      }
      state.folders[folderId] = folder;
    }
  } else if (t === 'StateChanged') {
    const folderId = String(data.folder || '');
    if (folderId) {
      state.folders[folderId] = {
        ...(state.folders[folderId] || {}),
        state: String(data.to || 'idle'),
      };
    }
  } else if (t === 'FolderErrors') {
    const folderId = String(data.folder || '');
    const errors = Array.isArray(data.errors) ? data.errors : [];
    if (folderId) {
      state.folders[folderId] = {
        ...(state.folders[folderId] || {}),
        errors: errors.map((e) => ({ path: String(e.path || ''), error: String(e.error || '') })),
        lastError: errors.length > 0 ? errors[errors.length - 1].error : (state.folders[folderId] && state.folders[folderId].lastError) || '',
      };
    }
  } else if (t === 'ItemStarted' || t === 'ItemFinished') {
    const folderId = String(data.folder || '');
    if (folderId) {
      state.folders[folderId] = {
        ...(state.folders[folderId] || {}),
        lastItemAt: evt.time || new Date().toISOString(),
      };
    }
  }
  return state;
}

function foldConnectionsSnapshot(state, snapshot, nowIso = new Date().toISOString()) {
  if (!state || !snapshot || typeof snapshot !== 'object') return state;
  const connections = snapshot.connections && typeof snapshot.connections === 'object'
    ? snapshot.connections
    : {};
  let inBytesTotal = 0;
  let outBytesTotal = 0;
  for (const [id, conn] of Object.entries(connections)) {
    if (!id || !conn || typeof conn !== 'object') continue;
    const peerInBytes = numberOrNull(conn.inBytesTotal);
    const peerOutBytes = numberOrNull(conn.outBytesTotal);
    if (peerInBytes != null) inBytesTotal += peerInBytes;
    if (peerOutBytes != null) outBytesTotal += peerOutBytes;
    state.peers[id] = {
      ...(state.peers[id] || {}),
      connected: Boolean(conn.connected),
      address: String(conn.address || ''),
      lastSeen: String(conn.at || nowIso),
      ...(peerInBytes == null ? {} : { inBytesTotal: peerInBytes }),
      ...(peerOutBytes == null ? {} : { outBytesTotal: peerOutBytes }),
    };
  }
  const previous = state.traffic && typeof state.traffic === 'object' ? state.traffic : null;
  const prevAt = previous && previous.at ? Date.parse(previous.at) : NaN;
  const nowAt = Date.parse(nowIso);
  const elapsedSec = Number.isFinite(prevAt) && Number.isFinite(nowAt) && nowAt > prevAt
    ? (nowAt - prevAt) / 1000
    : 0;
  const prevIn = previous ? numberOrNull(previous.inBytesTotal) : null;
  const prevOut = previous ? numberOrNull(previous.outBytesTotal) : null;
  const inDelta = prevIn == null ? 0 : Math.max(0, inBytesTotal - prevIn);
  const outDelta = prevOut == null ? 0 : Math.max(0, outBytesTotal - prevOut);
  state.traffic = {
    inBytesTotal,
    outBytesTotal,
    inBytesPerSec: elapsedSec > 0 ? inDelta / elapsedSec : 0,
    outBytesPerSec: elapsedSec > 0 ? outDelta / elapsedSec : 0,
    at: nowIso,
  };
  return state;
}

function notifyUpdate() {
  if (typeof _onUpdate !== 'function') return;
  try {
    _onUpdate(getState());
  } catch (e) {
    console.warn('[syncthing-events] onUpdate threw:', String(e && e.message || e));
  }
}

async function refreshConnectionsSnapshot() {
  if (!_creds) return { ok: false };
  const r = await sc.getConnections(_creds);
  if (!r.ok || !r.body || typeof r.body !== 'object') {
    return { ok: false };
  }
  foldConnectionsSnapshot(_state, r.body);
  notifyUpdate();
  return { ok: true };
}

async function connectionsLoop(gen) {
  while (_running && !_stopReq && gen === _generation) {
    try {
      await refreshConnectionsSnapshot();
    } catch (err) {
      console.warn('[syncthing-events] connections snapshot failed:', String(err && err.message || err));
    }
    await delay(CONNECTION_REFRESH_INTERVAL_MS);
  }
}

async function pollOnce() {
  const since = _state.events.lastEventId;
  const r = await sc.getEvents(_creds, { since, timeoutSec: LONG_POLL_TIMEOUT_SEC });
  _state.events.lastFetchAt = new Date().toISOString();
  if (!r.ok) {
    _state.events.fetchOk = false;
    return { ok: false };
  }
  _state.events.fetchOk = true;
  if (!Array.isArray(r.body)) return { ok: true, count: 0 };
  let maxId = since;
  for (const evt of r.body) {
    if (typeof evt.id === 'number' && evt.id > maxId) maxId = evt.id;
    foldEvent(_state, evt);
  }
  _state.events.lastEventId = maxId;
  return { ok: true, count: r.body.length };
}

async function loop(gen) {
  while (_running && !_stopReq && gen === _generation) {
    try {
      const r = await pollOnce();
      notifyUpdate();
      if (!r.ok) {
        // Backoff briefly so we don't busy-loop against a dead child.
        await new Promise((s) => setTimeout(s, RETRY_BACKOFF_MS));
      }
    } catch (err) {
      console.warn('[syncthing-events] poll loop error:', String(err && err.message || err));
      await new Promise((s) => setTimeout(s, RETRY_BACKOFF_MS));
    }
  }
  // NOTE: do not clear _running here — a concurrent restart may have already
  // set it true for the new generation; the gen check above is what stops us.
}

function start({ guiAddress, apiKey, onUpdate } = {}) {
  if (_running) return { ok: false, reason: 'already_running' };
  if (!guiAddress || !apiKey) throw new Error('start: guiAddress + apiKey required');
  _creds = { guiAddress, apiKey };
  _onUpdate = onUpdate || null;
  _running = true;
  _stopReq = false;
  const gen = ++_generation;
  resetState();
  void connectionsLoop(gen);
  void loop(gen);
  return { ok: true };
}

function stop() {
  _stopReq = true;
  _running = false;
  _onUpdate = null;
  _creds = null;
  _generation += 1; // invalidate any in-flight loops from the stopped run
}

function isRunning() { return _running; }

module.exports = {
  start,
  stop,
  isRunning,
  getState,
  // Exposed for tests.
  foldEvent,
  foldConnectionsSnapshot,
  emptyState,
};
