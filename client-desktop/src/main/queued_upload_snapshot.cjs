'use strict';

// Pure decision helpers for the import-queue upload wait. Snapshot is the
// PROOF of completion; these never look at events. Extracted from main.cjs so
// they are unit-testable without booting Electron.
//
// A snapshot is the shape returned by loadSyncthingProjectSnapshot():
//   { ok, folder, peerConnected, dbStatus: { state, errors, pullErrors },
//     completion: { completion (0..100), needBytes, needItems, needDeletes, remoteState } }

// queuedUploadSnapshotState: short human/log string of the current state.
function queuedUploadSnapshotState(snapshot) {
  if (!snapshot) return 'no_snapshot';
  if (!snapshot.ok) return String(snapshot.code || snapshot.error || 'snapshot_unavailable');
  if (!snapshot.folder) return 'folder_not_configured';
  const dbState = snapshot.dbStatus && snapshot.dbStatus.state ? String(snapshot.dbStatus.state) : 'no_db_status';
  const completion = snapshot.completion && typeof snapshot.completion.completion === 'number'
    ? Math.round(snapshot.completion.completion)
    : 'no_completion';
  const rs = snapshot.completion && snapshot.completion.remoteState ? `/${snapshot.completion.remoteState}` : '';
  return `${dbState}/${completion}${rs}`;
}

// queuedUploadSnapshotComplete: the terminal SUCCESS proof — folder configured,
// peer connected, idle, no errors, remote completion 100% with zero need.
function queuedUploadSnapshotComplete(snapshot) {
  if (!snapshot || !snapshot.ok || !snapshot.folder) return false;
  if (!snapshot.peerConnected) return false;
  const status = snapshot.dbStatus || {};
  if (String(status.state || '').toLowerCase() !== 'idle') return false;
  if (Number(status.errors || 0) > 0 || Number(status.pullErrors || 0) > 0) return false;
  const completion = snapshot.completion || {};
  const percent = Number(completion.completion);
  if (!Number.isFinite(percent) || percent < 100) return false;
  return Number(completion.needBytes || 0) === 0
    && Number(completion.needItems || 0) === 0
    && Number(completion.needDeletes || 0) === 0;
}

// queuedUploadSnapshotFatal: a terminal FAILURE reason, or null when the
// situation is merely "not done yet". Persistent remoteState 'notSharing' means
// the peer never accepted the (re)paired folder — a pairing failure, not a slow
// upload, so the caller fails fast (with a wall-clock grace; see main.cjs).
// 'unknown' (peer offline) and 'paused' are NON-terminal — keep waiting.
function queuedUploadSnapshotFatal(snapshot) {
  if (!snapshot || !snapshot.ok || !snapshot.folder) return null;
  const rs = String((snapshot.completion && snapshot.completion.remoteState) || '').trim();
  if (rs === 'notSharing') return 'peer_not_sharing_folder';
  return null;
}

module.exports = {
  queuedUploadSnapshotState,
  queuedUploadSnapshotComplete,
  queuedUploadSnapshotFatal,
};
