/// <reference types="vite/client" />

import type {
  AbandonDownloadResult,
  ActivationConfig,
  ActivationResult,
  DaemonStatus,
  FileTreeChildrenRequest,
  FileTreeChildrenResult,
  FileTreePathAction,
  FileTreeResult,
  GitDiffFile,
  GitDiffSummary,
  GitSummary,
  GitWorkingTreeStatus,
  ProjectItem,
  ProjectImportQueueJob,
  ProjectListResult,
  ReadFileResult,
  RuntimeStatus,
  SaveFileResult,
  SavedConfig,
  SessionItem,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  UsageRange,
  UsageSnapshot,
  StorageSummary,
  SyncthingState
} from '../shared/types';

declare global {
  interface Window {
    kari: {
      windowMinimize(): Promise<void>;
      windowToggleMaximize(): Promise<{ fullscreen: boolean; maximized: boolean }>;
      windowClose(): Promise<void>;
      platformInfo: { platform: NodeJS.Platform; arch: NodeJS.Architecture; osRelease: string };
      windowState(): Promise<{ fullscreen: boolean; maximized: boolean; platform: NodeJS.Platform }>;
      onWindowState(handler: (state: { fullscreen: boolean; maximized: boolean; platform: NodeJS.Platform }) => void): () => void;
      getConfig(): Promise<SavedConfig>;
      importVSCodeConfig(): Promise<SavedConfig>;
      logout(): Promise<SavedConfig>;
      activate(payload: ActivationConfig): Promise<ActivationResult>;
      runtimeStatus(): Promise<RuntimeStatus>;
      ensureDaemon(): Promise<{ ok: boolean; base: string; error?: string; runtime?: RuntimeStatus }>;
      bindStartDaemon(): Promise<{ ok: boolean; skipped?: boolean; reason?: string }>;
      selectWorkspace(): Promise<{ canceled: boolean; path?: string; tree?: FileTreeResult; config?: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string }; needsImport?: boolean; importName?: string; projectsRoot?: string; targetPath?: string }>;
      storageSummary(): Promise<StorageSummary>;
      // Storage Location Boundary: pick storageBaseDir; Kari creates
      // "Kari 存储" container inside. Refuses picking the existing
      // container or anything inside it (would nest).
      selectStorageBaseDir(): Promise<
        | { canceled: true }
        | { ok: true; canceled: false; storageBaseDir: string; projectsRoot: string; config: SavedConfig }
        | { ok: false; canceled: false; code: string; error: string }
      >;
      listProjects(): Promise<ProjectListResult>;
      deleteLocalProject(project: ProjectItem | null, confirmName: string): Promise<{ ok: boolean; code?: string; error?: string; workspaceName?: string; path?: string; bytesDeleted?: number }>;
      deleteCloudProject(project: ProjectItem | null, confirmName: string): Promise<{ ok: boolean; code?: string; error?: string; workspaceName?: string; body?: { bytes_deleted?: number; bytes_used_after?: number; deleted_rows?: number } }>;
      openProject(path: string, project?: ProjectItem | null): Promise<
        | { ok: true; path: string; tree: FileTreeResult; config: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string }; sync?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string; code?: string; taskId?: string } }
        | { ok: false; code: string; error: string }
      >;
      // Tells main to drop the UI-active virtual sync handle for the
      // currently-open project. Pinned PTYs keep their projects active
      // independently of this signal.
      closeProjectUi?(): Promise<{ ok: boolean }>;
      // Cloud-only-not-downloaded projects MUST come through this
      // entry to materialize their local mirror. ok:true means a
      // sync-task was accepted; ok:false carries a discriminating
      // code (daemon_too_old / bind_failed / sync_task_failed / ...)
      // the renderer maps to a banner.
      downloadProject(path: string, project?: ProjectItem | null): Promise<
        | { ok: true; path: string; workspaceName: string; config: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string }; taskId?: string; code?: string }
        | { ok: false; code: string; error: string; config?: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string } }
      >;
      // Local→cloud self-service upload. ok:false codes:
      // quota_exceeded / workspace_name_conflict / server_unavailable
      // / daemon_too_old / bind_failed / sync_task_failed.
      uploadProject(path: string, project?: ProjectItem | null): Promise<
        | { ok: true; path: string; workspaceName: string; config: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string }; taskId?: string; code?: string; quota?: { limit_bytes?: number; used_bytes?: number; remaining_bytes?: number } }
        // Phase 4 scheduler.runNow path (current workspace + syncthing
        // backend). Shape is intentionally minimal — scheduler returns
        // only ok + an alreadyRunning hint; renderer falls through to the
        // status card to surface progress.
        | { ok: true; alreadyRunning?: boolean }
        | { ok: false; code: string; error: string; body?: { limit_bytes?: number; used_bytes?: number; requested_bytes?: number; remaining_bytes?: number; quota?: unknown }; config?: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string } }
      >;
      // Cancel an in-flight or stuck download. Stops the daemon
      // task (best-effort) and flips the cache phase to 'cancelled'.
      // The incomplete marker is INTENTIONALLY kept so the project
      // stays un-openable (the open-guard rule "首次下载未完成前
      // 禁止打开" still fires); partial files in the mirror dir are
      // preserved so a future retry can resume incrementally.
      abandonDownload(project: ProjectItem | null): Promise<AbandonDownloadResult>;
      // B6d operator escape hatch — cancel a snapshot upload session
      // stuck in a non-terminal state (commit_race etc) so the user can
      // retry without restarting Desktop. Returns the underlying
      // cancelIfNonTerminal shape so the renderer can distinguish
      // found / already-terminal / cancelled.
      cancelSnapshotSession(
        stagingId: string,
        reason?: string | null,
      ): Promise<
        | { ok: true; result: { found: boolean; alreadyTerminal?: boolean; finalState?: string; committedManifestId?: string | null } }
        | { ok: false; code: string; error: string }
      >;
      // Cancel the active upload-snapshot session for a project. Main
      // process looks up the snapshot session by (workspaceName +
      // cfg.serverAddr/workspaceId) and routes through
      // cancelSnapshotSession (which cleans staging + abandons the
      // server-side manifest).
      cancelSnapshotUpload(project: ProjectItem | null): Promise<
        | { ok: true; result: { found: boolean; alreadyTerminal?: boolean; finalState?: string; committedManifestId?: string | null }; stagingId: string }
        | { ok: false; code: string; error: string }
      >;
      importAndUploadProject(path: string): Promise<
        | { ok: true; queued: true; job: ProjectImportQueueJob; path: string; workspaceName: string }
        | { ok: false; code: string; error: string; body?: { limit_bytes?: number; used_bytes?: number; requested_bytes?: number; remaining_bytes?: number; quota?: unknown }; imported?: unknown; targetPath?: string; workspaceName?: string; config?: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string }; sync?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string } }
      >;
      dismissDiscoveredProject(path: string): Promise<{ ok: boolean; code?: string; error?: string; path?: string }>;
      importQueueSnapshot(): Promise<{ ok: true; jobs: ProjectImportQueueJob[] } | { ok: false; error?: string }>;
      onProjectImportQueue(handler: (event: { jobs: ProjectImportQueueJob[]; failedJob?: ProjectImportQueueJob | null }) => void): () => void;
      // Welcome-page git clone. Optional username/password trigger a
      // credentialed retry — the first attempt usually fires without
      // them; on the auth_required branch the renderer prompts and
      // re-issues the call with credentials filled in.
      cloneProject(payload: { gitUrl: string; name?: string; username?: string; password?: string }): Promise<
        | { ok: true; path: string; tree: FileTreeResult; config: SavedConfig; bind?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string }; bootstrap?: { ok?: boolean; status?: string; error?: string; log_tail?: string }; localTarget?: { ok?: boolean; archived?: boolean; archivePath?: string; path?: string } }
        | { ok: false; code: 'auth_required'; error: string; gitUrl: string; workspaceName: string }
        | { ok: false; code: string; error: string; bootstrap?: { ok?: boolean; status?: string; error?: string; log_tail?: string } }
      >;
      listFiles(): Promise<FileTreeResult>;
      // File-tree sync visibility — lazy per-directory listing with
      // sync-disposition annotations + server-side filter + pagination.
      listFileChildren(request?: FileTreeChildrenRequest): Promise<FileTreeChildrenResult>;
      // Path-scoped context menu actions. Returns {ok:true, ...} on
      // success, {ok:false, code, ...} on error. `code` is mapped to a
      // locale-correct message by the renderer's FILE_ACTION_ERROR_CODE_KEY
      // table; raw error strings are last-resort fallback.
      filePathAction(payload: {
        action: FileTreePathAction;
        path: string;
        relPath: string;
        replaceChildren?: boolean;
      }): Promise<
        | { ok: true; removed?: boolean; persisted?: boolean; code?: string }
        | { ok: false; code: string; error?: string; inFlightPath?: string; wouldDominate?: string[]; interp?: Record<string, unknown> }
      >;
      // Sync mode IPC (Phase B B9). Mode is 'lightweight' (Kari-managed
      // denylist + .kariignore) or 'full' (only .kariignore + hard-ignore).
      // Setting an empty/null project mode CLEARS the override (project
      // falls back to global default).
      getSyncMode(): Promise<
        | { ok: true; defaultMode: 'lightweight' | 'full'; projectMode: 'lightweight' | 'full' | null; effectiveMode: 'lightweight' | 'full' | null; identityComplete: boolean }
        | { ok: false; code: string; error?: string }
      >;
      setGlobalSyncMode(mode: 'lightweight' | 'full'): Promise<{ ok: true } | { ok: false; code: string; error?: string }>;
      setProjectSyncMode(mode: 'lightweight' | 'full' | null): Promise<
        | { ok: true; cleared?: boolean }
        | { ok: false; code: string; error?: string }
      >;
      // Crash recovery (Phase B B10). Returns leftover state from
      // previous crashes; orphan staging dirs can be cleaned via
      // recoveryCleanupOrphan (one at a time, refuses paths outside
      // <userData>/staging by construction).
      recoveryScan(): Promise<
        | {
            ok: true;
            nonTerminalSessions: Array<{
              id: string;
              direction: string;
              scopeRelPath: string | null;
              stagingPath: string;
              state: string;
              lastError: string | null;
              createdAt: string;
              updatedAt: string;
              stagingExists: boolean;
            }>;
            orphanStagingDirs: Array<{
              name: string;
              absPath: string;
              stat: { mtime: string; size: number } | null;
            }>;
            totalNeedsAttention: number;
          }
        | { ok: false; code: string; error?: string }
      >;
      recoveryCleanupOrphan(absPath: string): Promise<
        | { ok: true }
        | { ok: false; code: string; error?: string }
      >;
      readFile(path: string): Promise<ReadFileResult>;
      saveFile(path: string, content: string): Promise<SaveFileResult>;
      // File-tree right-click delete: rm the path + trigger snapshot
      // Upload so cloud reflects the deletion. upload field carries the
      // uploadProject() result so renderer can surface "local rm
      // succeeded but cloud sync failed" separately from "rm failed."
      deleteFileTreeNode(absPath: string): Promise<
        | { ok: true; deleted: string; wasDir: boolean; upload?: { ok?: boolean; code?: string; error?: string; scheduled?: boolean } }
        | { ok: false; error: string }
      >;
      // File-tree right-click paste: fs.cp source → targetDir + trigger
      // snapshot Upload. errorOnExist=true (target_exists code).
      pasteFileTreeNode(sourceAbsPath: string, targetDirAbsPath: string): Promise<
        | { ok: true; pasted: string; wasDir: boolean; upload?: { ok?: boolean; code?: string; error?: string; scheduled?: boolean } }
        | { ok: false; error: string }
      >;
      // Reveal in the native file browser. Path must be inside the bound workspace.
      showFileTreeNodeInFinder(absPath: string): Promise<{ ok: boolean; error?: string }>;
      // Drop a list of OS paths (files and/or folders) into a
      // destination directory inside the bound workspace. Returns
      // per-source success/skip detail. copy uses fs.cp recursive so
      // a folder source is copied as a sub-tree of destAbsDir.
      importFilesFromDisk(destAbsDir: string, sourcePaths: string[]): Promise<{
        ok: boolean;
        error?: string;
        copied?: Array<{ src: string; dst: string }>;
        skipped?: Array<{ src: string; reason: string }>;
      }>;
      // Drag-out from tree to OS: fire-and-forget. Must be called
      // synchronously inside the dragstart event handler so Electron's
      // webContents.startDrag can take over the OS drag source.
      pathForFile(file: File): string;
      startFileDrag(absPath: string): boolean;
      daemonStatus(): Promise<DaemonStatus>;
      // Phase 2 / 4.3 (syncthing migration): pull the current syncthing
      // event-subscriber state on mount, then subscribe via
      // onSyncthingState for live updates.
      syncthingState(): Promise<SyncthingState>;
      onSyncthingState(handler: (state: SyncthingState) => void): () => void;
      listSessions(forceRefresh?: boolean): Promise<SessionItem[] | null>;
      renameSession(payload: { id: string; source: string; project?: string; title: string }): Promise<{ ok: boolean; id: string; source: string; project?: string; title: string; customTitle: boolean }>;
      createTerminal(req: TerminalCreateRequest): Promise<TerminalCreateResult>;
      writeTerminal(id: string, data: string): Promise<void>;
      resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
      stopTerminal(id: string, opts?: { force?: boolean }): Promise<{ ok: boolean; stopped: boolean; pinned: boolean }>;
      // Pin a detached PTY so project back-out / future auto-cleanup
      // flows skip it. Force-stop still works. State is in-memory in
      // main only — app restart loses it.
      setTerminalPinned(id: string, pinned: boolean): Promise<{ ok: boolean; pinned: boolean }>;
      isTerminalPinned(id: string): Promise<boolean>;
      // App.tsx mirrors its `panes` state (CLI terminal IDs) so detached
      // PTY windows can tell "main has a pane I can re-dock to" from "no
      // pane left, my close button means stop+close".
      setActiveTerminalPanes(ids: string[]): Promise<{ ok: boolean }>;
      hasActiveTerminalPane(id: string): Promise<boolean>;
      onActiveTerminalPanesChanged(handler: (event: { ids: string[] }) => void): () => void;
      terminalSnapshot(id: string): Promise<{ id: string; data: string; alive: boolean }>;
      detachTerminal(id: string, title: string): Promise<{ ok: boolean; existing?: boolean }>;
      focusDetachedTerminal(id: string): Promise<{ ok: boolean }>;
      closeDetachedTerminal(id: string): Promise<{ ok: boolean }>;
      gitSummary(): Promise<GitSummary>;
      gitWorkingTreeStatus(): Promise<GitWorkingTreeStatus>;
      gitBootstrap(payload: { gitUrl: string; username?: string; password?: string; flatten?: boolean }): Promise<unknown>;
      // Diff Viewer commit 1: read-only Changes feed. Summary first;
      // gitFileDiff lazy-loads one capped file's patch.
      gitDiffSummary(): Promise<GitDiffSummary>;
      gitFileDiff(relPath: string): Promise<{ ok: boolean; isGit?: boolean; file?: GitDiffFile | null; error?: string }>;
      forceUpload(paths: string[]): Promise<
        | { ok: true; data?: unknown }
        | { ok: false; code: string; error?: string }
      >;
      clipboardImage(): Promise<unknown>;
      clipboardPasteImage(): Promise<unknown>;
      clipboardHasImage(): boolean;
      clipboardText(): string;
      ptyAttach(localPath: string): Promise<unknown>;
      reverseRotate(): Promise<unknown>;
      reverseStart(): Promise<unknown>;
      reverseRefresh(): Promise<unknown>;
      reverseStop(): Promise<unknown>;
      reverseCopy(): Promise<{ ok: boolean; text: string }>;
      getCapabilities(): Promise<unknown>;
      getModelKeys(): Promise<unknown>;
      updateSettings(payload: Partial<SavedConfig>): Promise<SavedConfig>;
      readUsage(range: UsageRange): Promise<UsageSnapshot>;
      // Mobile pairing (Phase 4.K — direct-to-mgmt). Backend in
      // src/main/mobile_pair.cjs. Bearer = decrypted activation_code
      // (main process only). reason ∈ {no_management_url,
      // no_activation_code, no_workspace, unreachable, unauthorized,
      // revoked, workspace_mismatch, mint_failed, bad_payload, ...}.
      mobilePairAvailability(): Promise<{ ok: true } | { ok: false; reason: string; message?: string }>;
      mobilePairCode(workspaceId: string): Promise<
        | {
            ok: true;
            code: string;
            qr_token: string;
            expires_at: number;
            workspace_id: string;
            server_url?: string;
            license_label?: string;
          }
        | { ok: false; reason: string; message?: string; status?: number }
      >;
      mobilePairStatus(workspaceId: string, code: string): Promise<
        | { ok: true; workspace_id?: string; consumed: boolean; expires_at?: number }
        | { ok: false; reason: string; message?: string; status?: number }
      >;
      onTerminalData(handler: (event: TerminalDataEvent) => void): () => void;
      onTerminalExit(handler: (event: TerminalExitEvent) => void): () => void;
      onTerminalResize(handler: (event: { id: string; cols: number; rows: number }) => void): () => void;
      onTerminalDetachedClosed(handler: (event: { id: string }) => void): () => void;
      onTerminalDetachedTitle(handler: (event: { id: string; title: string }) => void): () => void;
    };
  }
}
