const os = require('os');
const { clipboard, contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kari', {
  platformInfo: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
  },
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowState: () => ipcRenderer.invoke('window:state'),
  onWindowState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  importVSCodeConfig: () => ipcRenderer.invoke('config:importVSCode'),
  logout: () => ipcRenderer.invoke('config:logout'),
  activate: (payload) => ipcRenderer.invoke('activation:submit', payload),
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  // Phase 1.1 (syncthing migration): expose the running syncthing child's
  // meta (pid / guiAddress / deviceId / listenPort / apiKey preview).
  // Returns { running: false } when the child isn't up yet.
  syncthingStatus: () => ipcRenderer.invoke('syncthing:status'),
  // Phase 1.2 (manual pair until consoleZ pair-endpoint exists). Args:
  //   { serverDeviceId, serverAddresses[], folderId, folderPath,
  //     folderLabel?, sendreceive? }
  syncthingDevPair: (payload) => ipcRenderer.invoke('syncthing:devPair', payload),
  syncthingConnections: () => ipcRenderer.invoke('syncthing:connections'),
  syncthingDbStatus: (folderId) => ipcRenderer.invoke('syncthing:dbStatus', folderId),
  // Phase 2: read the current syncthing state snapshot (derived from
  // /rest/events poll). Use this on mount; subscribe to live updates
  // via onSyncthingState below.
  syncthingState: () => ipcRenderer.invoke('syncthing:state'),
  // Live updates pushed by main.cjs after each event-fold batch. The
  // payload is the same shape as syncthingState(). Returns an
  // unsubscribe function.
  onSyncthingState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('syncthing:state', listener);
    return () => ipcRenderer.removeListener('syncthing:state', listener);
  },
  ensureDaemon: () => ipcRenderer.invoke('daemon:ensure'),
  bindStartDaemon: () => ipcRenderer.invoke('daemon:bindStart'),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  // Storage Location Boundary: pick storageBaseDir; Kari creates
  // "Kari Drive" container inside.
  storageSummary: () => ipcRenderer.invoke('storage:summary'),
  selectStorageBaseDir: () => ipcRenderer.invoke('storage:selectBaseDir'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  deleteLocalProject: (project, confirmName) => ipcRenderer.invoke('projects:deleteLocal', project || null, confirmName || ''),
  deleteCloudProject: (project, confirmName) => ipcRenderer.invoke('projects:deleteCloud', project || null, confirmName || ''),
  openProject: (projectPath, project) => ipcRenderer.invoke('projects:open', projectPath, project || null),
  closeProjectUi: () => ipcRenderer.invoke('projects:closeUi'),
  // PR2 Phase 1 commit 5 round-fix: explicit download path for
  // cloud-only-not-downloaded projects. openProject refuses to
  // mkdir mirror dirs; downloadProject is the only legitimate
  // path that creates them.
  downloadProject: (projectPath, project) => ipcRenderer.invoke('projects:download', projectPath, project || null),
  // PR2 Phase 1 commit 6: local→cloud self-service upload (mirrors
  // the trans-server upload-intent endpoint from commit 2).
  uploadProject: (projectPath, project) => ipcRenderer.invoke('projects:upload', projectPath, project || null),
  // Cancel an in-flight or stuck download for a cloud project. Daemon
  // is asked to stop the sync session; partial files + incomplete
  // marker are preserved so the user can retry with incremental
  // resume.
  abandonDownload: (project) => ipcRenderer.invoke('projects:abandon-download', project || null),
  // B6d operator escape hatch — cancel a snapshot upload session that
  // got stuck (commit_race CAS conflict that the not-yet-shipped retry
  // loop would have rebuilt against). Renderer wires this to a "取消
  // 上传" affordance on cards stuck at verifying/syncing without
  // recent progress.
  cancelSnapshotSession: (stagingId, reason) => ipcRenderer.invoke('snapshot:cancelSession', stagingId, reason || null),
  // Renderer-facing wrapper: cancel the active upload snapshot session
  // for a project (looked up by workspaceName + cfg identity in
  // main.cjs). Used by the ✕ button on cards stuck at verifying.
  // Counterpart to abandonDownload (which handles cloud downloads).
  cancelSnapshotUpload: (project) => ipcRenderer.invoke('projects:cancelSnapshotUpload', project || null),
  importAndUploadProject: (projectPath) => ipcRenderer.invoke('projects:importAndUpload', projectPath),
  dismissDiscoveredProject: (projectPath) => ipcRenderer.invoke('projects:dismissDiscovered', projectPath),
  importQueueSnapshot: () => ipcRenderer.invoke('projects:importQueueSnapshot'),
  onProjectImportQueue: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('projects:importQueue', listener);
    return () => ipcRenderer.removeListener('projects:importQueue', listener);
  },
  cloneProject: (payload) => ipcRenderer.invoke('projects:clone', payload),
  listFiles: () => ipcRenderer.invoke('files:list'),
  // File-tree sync visibility (plan: docs/superpowers/plans/2026-05-25-file-tree-sync-visibility.md)
  //   listFileChildren — lazy per-directory listing with sync-disposition
  //     annotations + server-side filter + pagination cursor.
  //   filePathAction — context-menu actions: force_upload_once /
  //     always_sync_path / stop_always_syncing.
  listFileChildren: (request) => ipcRenderer.invoke('files:listChildren', request),
  filePathAction: (payload) => ipcRenderer.invoke('files:pathAction', payload),
  // Sync mode IPC (Phase B B9): global default + per-project override.
  // Mode is 'lightweight' (Kari-managed denylist + .kariignore) or
  // 'full' (only .kariignore + hard-ignore).
  getSyncMode: () => ipcRenderer.invoke('sync:getMode'),
  setGlobalSyncMode: (mode) => ipcRenderer.invoke('sync:setGlobalMode', { mode }),
  setProjectSyncMode: (mode) => ipcRenderer.invoke('sync:setProjectMode', { mode }),
  // Crash recovery (Phase B B10). recoveryScan returns leftover state
  // from previous crashes; recoveryCleanupOrphan deletes one orphan
  // staging dir at a time. Both refuse paths outside <userData>/staging
  // by construction.
  recoveryScan: () => ipcRenderer.invoke('recovery:scan'),
  recoveryCleanupOrphan: (absPath) => ipcRenderer.invoke('recovery:cleanupOrphan', { absPath }),
  readFile: (filePath) => ipcRenderer.invoke('files:read', filePath),
  saveFile: (filePath, content) => ipcRenderer.invoke('files:save', filePath, content),
  // File-tree right-click delete/paste. Both mutate the local working
  // tree (rm / cp) and then trigger a snapshot Upload so the cloud
  // mirror reflects the change — necessary because the daemon's
  // control-only mode (sub-commit A) blocks outbound auto-sync.
  // Copy is renderer-state-only (no IPC needed).
  deleteFileTreeNode: (absPath) => ipcRenderer.invoke('files:deleteNode', absPath),
  pasteFileTreeNode: (sourceAbsPath, targetDirAbsPath) =>
    ipcRenderer.invoke('files:pasteNode', sourceAbsPath, targetDirAbsPath),
  // Reveal the path in the native file browser.
  showFileTreeNodeInFinder: (absPath) => ipcRenderer.invoke('files:showInFinder', absPath),
  // Drop-from-OS into project: dest must be workspace root or a dir
  // inside it. Each src is an absolute OS path the user dropped from
  // the native file browser.
  importFilesFromDisk: (destAbsDir, sourcePaths) =>
    ipcRenderer.invoke('files:importFromDisk', { destAbsDir, sourcePaths }),
  // Electron 32+ removed the old File.path augmentation. Keep the
  // filesystem path lookup in preload where Electron's webUtils is
  // available, then pass only plain strings into React.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  // Drag-out from tree to OS: use sync IPC so webContents.startDrag
  // still runs inside the browser's dragstart handoff window.
  startFileDrag: (absPath) => {
    try {
      return Boolean(ipcRenderer.sendSync('files:startDragSync', absPath));
    } catch {
      ipcRenderer.send('files:startDrag', absPath);
      return false;
    }
  },
  daemonStatus: () => ipcRenderer.invoke('daemon:status'),
  listSessions: (forceRefresh) => ipcRenderer.invoke('sessions:list', Boolean(forceRefresh)),
  renameSession: (payload) => ipcRenderer.invoke('sessions:rename', payload),
  createTerminal: (req) => ipcRenderer.invoke('terminal:create', req),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  stopTerminal: (id, opts) => ipcRenderer.invoke('terminal:stop', id, opts || undefined),
  setTerminalPinned: (id, pinned) => ipcRenderer.invoke('terminal:setPinned', id, Boolean(pinned)),
  isTerminalPinned: (id) => ipcRenderer.invoke('terminal:isPinned', id),
  setActiveTerminalPanes: (ids) => ipcRenderer.invoke('view:setActiveTerminals', Array.isArray(ids) ? ids : []),
  hasActiveTerminalPane: (id) => ipcRenderer.invoke('view:hasActivePane', id),
  onActiveTerminalPanesChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('view:active-terminals', listener);
    return () => ipcRenderer.removeListener('view:active-terminals', listener);
  },
  terminalSnapshot: (id) => ipcRenderer.invoke('terminal:snapshot', id),
  detachTerminal: (id, title) => ipcRenderer.invoke('terminal:detach', id, title),
  focusDetachedTerminal: (id) => ipcRenderer.invoke('terminal:focusDetached', id),
  closeDetachedTerminal: (id) => ipcRenderer.invoke('terminal:closeDetached', id),
  gitSummary: () => ipcRenderer.invoke('git:summary'),
  gitWorkingTreeStatus: () => ipcRenderer.invoke('git:workingTreeStatus'),
  gitBootstrap: (payload) => ipcRenderer.invoke('git:bootstrap', payload),
  // Diff Viewer commit 1: read-only Changes feed. Renderer never
  // executes git directly — all calls funnel through these two IPCs.
  gitDiffSummary: () => ipcRenderer.invoke('git:diffSummary'),
  gitFileDiff: (relPath) => ipcRenderer.invoke('git:fileDiff', relPath),
  forceUpload: (paths) => ipcRenderer.invoke('files:forceUpload', paths),
  clipboardImage: () => ipcRenderer.invoke('clipboard:image'),
  clipboardPasteImage: () => ipcRenderer.invoke('clipboard:pasteImage'),
  clipboardHasImage: () => {
    try {
      return !clipboard.readImage().isEmpty();
    } catch {
      return false;
    }
  },
  clipboardText: () => clipboard.readText(),
  ptyAttach: (localPath) => ipcRenderer.invoke('pty:attach', localPath),
  reverseRotate: () => ipcRenderer.invoke('reverse:rotate'),
  reverseStart: () => ipcRenderer.invoke('reverse:start'),
  reverseRefresh: () => ipcRenderer.invoke('reverse:refresh'),
  reverseStop: () => ipcRenderer.invoke('reverse:stop'),
  reverseCopy: () => ipcRenderer.invoke('reverse:copy'),
  getCapabilities: () => ipcRenderer.invoke('capabilities:get'),
  getModelKeys: () => ipcRenderer.invoke('models:get'),
  updateSettings: (payload) => ipcRenderer.invoke('settings:update', payload),
  readUsage: (range) => ipcRenderer.invoke('usage:read', { range }),
  // Mobile pairing (Phase 1.E). Bearer auth + same-machine guard live in
  // main; renderer just gets {ok, ...} JSON-ish back.
  onTerminalData: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onTerminalResize: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('terminal:resized', listener);
    return () => ipcRenderer.removeListener('terminal:resized', listener);
  },
  onTerminalDetachedClosed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('terminal:detached-closed', listener);
    return () => ipcRenderer.removeListener('terminal:detached-closed', listener);
  },
  onTerminalDetachedTitle: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('terminal:detached-title', listener);
    return () => ipcRenderer.removeListener('terminal:detached-title', listener);
  }
});
