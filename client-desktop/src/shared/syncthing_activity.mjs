export function projectsNeedSyncRefresh(projectList) {
  const projects = Array.isArray(projectList && projectList.projects)
    ? projectList.projects
    : [];
  return projects.some((project) => {
    const state = project && project.connectionState;
    if (!state || state.syncBackend !== 'syncthing') return false;
    if (state.availability === 'cloud_only') return false;
    if (state.syncState === 'queued' || state.syncState === 'syncing' || state.syncState === 'scanning') return true;
    if (
      state.syncState === 'paused'
      && typeof state.completion === 'number'
      && state.completion < 100
    ) {
      return true;
    }
    return false;
  });
}

export function syncthingEventsNeedProjectRefresh(syncthingState) {
  const folders = syncthingState && syncthingState.folders && typeof syncthingState.folders === 'object'
    ? Object.values(syncthingState.folders)
    : [];
  return folders.some((folder) => {
    if (!folder || typeof folder !== 'object') return false;
    const state = String(folder.state || '').toLowerCase();
    if (state && state !== 'idle') return true;
    return typeof folder.completion === 'number' && folder.completion < 1;
  });
}
