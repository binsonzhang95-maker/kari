'use strict';

function decideExistingImportTarget({ targetExistsNonEmpty, currentWorkspaceId, ownershipWorkspaceId } = {}) {
  if (!targetExistsNonEmpty) return { action: 'copy' };
  const current = String(currentWorkspaceId || '').trim();
  const owner = String(ownershipWorkspaceId || '').trim();
  if (arguments[0] && arguments[0].resumeExistingCurrentTarget && current && owner === current) {
    return { action: 'resume' };
  }
  if (current && owner && owner !== current) return { action: 'adopt' };
  // Untagged existing dir (an orphan from a failed/pre-tag import or a
  // syncthing-materialised mirror): CLAIM it for the current activation on
  // explicit import. Without this it is both invisible (listLocalProjects
  // hides untagged dirs) AND un-importable (returns import_target_exists) — a
  // stuck state the user can't escape. They explicitly chose to import this
  // name, so adopting the existing content (no copy) is the right move.
  if (current && !owner) return { action: 'adopt' };
  return { action: 'exists' };
}

function queuedImportMatchesWorkspace(payload, cfg) {
  const expected = String(payload && payload.enqueuedWorkspaceId || '').trim();
  if (!expected) return true;
  const current = String(cfg && cfg.workspaceId || '').trim();
  return Boolean(current && current === expected);
}

module.exports = {
  decideExistingImportTarget,
  queuedImportMatchesWorkspace,
};
