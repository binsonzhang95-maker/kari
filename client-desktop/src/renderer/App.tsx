import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent } from 'react';
import { AlertTriangle, Cloud, EyeOff, FolderOpen, GitBranch, HardDrive, MessageSquare, RefreshCw, Settings as SettingsIcon, Sparkles, UploadCloud } from 'lucide-react';
import type {
  DaemonStatus,
  FileTreeResult,
  GitSummary,
  GitDiffSummary,
  ProjectConnectionState,
  ProjectImportQueueJob,
  ProjectItem,
  ProjectListResult,
  ReadFileResult,
  RuntimeStatus,
  SavedConfig,
  SessionItem,
  StorageSummary,
  SidebarModule,
  SyncthingState,
  TerminalCreateResult,
  TerminalKind,
  TerminalMode
} from '../shared/types';
import { APP_COPYRIGHT, APP_VERSION } from '../shared/appMeta';
import { droppedFilePaths } from '../shared/drop_paths.mjs';
import { projectsNeedSyncRefresh, syncthingEventsNeedProjectRefresh } from '../shared/syncthing_activity.mjs';
import { ActivationPage } from './components/ActivationPage';
import { AppSettingsModal } from './components/AppSettingsModal';
import { DetachedTerminalWindow } from './components/DetachedTerminalWindow';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { WindowTitleBar } from './components/WindowChrome';
import { WorkspaceGrid, type WorkspacePane } from './components/WorkspaceGrid';
import { ProjectSyncDiamondProgress } from './components/SyncDiamondProgress';
import { I18nProvider, loadInitialLanguage, persistLanguage, translate, useI18n, type AppLanguage, type I18nKey } from './i18n';
import { reverseActionBlockedReason, type ReverseAction } from './reverseProxy';

const EMPTY_DAEMON: DaemonStatus = {
  health: 'offline',
  connected: false,
  running: false,
  lastError: '',
  workspaceRoot: '',
  workspaceId: '',
  serverAddr: '',
  lastSyncAt: '',
  lastActivityAt: '',
  ptyCount: 0,
  pendingOutbound: 0,
  frpState: 'disabled',
  frpError: '',
  sshState: 'unknown',
  sshAvailable: false,
  sshPlatform: '',
  sshInstallSupported: false,
  transferCount: 0
};

const LUNAR_SYNC_MIN_VISIBLE_MS = 4000;

type AppDialogState =
  | {
      id: number;
      kind: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      tone?: 'default' | 'danger';
      resolve: (value: boolean) => void;
    }
  | {
      id: number;
      kind: 'prompt';
      title: string;
      message: string;
      value: string;
      placeholder?: string;
      confirmLabel: string;
      cancelLabel: string;
      resolve: (value: string | null) => void;
    }
  | {
      id: number;
      kind: 'credentials';
      title: string;
      message: string;
      usernameLabel: string;
      passwordLabel: string;
      usernamePlaceholder?: string;
      passwordPlaceholder?: string;
      confirmLabel: string;
      cancelLabel: string;
      resolve: (value: { username: string; password: string } | null) => void;
    };

function joinWorkspacePath(root: string, relPath: string) {
  const base = String(root || '').replace(/[\\/]+$/, '');
  const child = String(relPath || '').replace(/^[\\/]+/, '');
  if (!base) return child;
  if (/^[a-zA-Z]:[\\/]/.test(base) || base.includes('\\')) {
    return `${base}\\${child.replace(/[\\/]+/g, '\\')}`;
  }
  return `${base}/${child.replace(/\\/g, '/')}`;
}

function App() {
  const [language, setLanguageState] = useState<AppLanguage>(() => loadInitialLanguage());
  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    setLanguageState(nextLanguage);
    persistLanguage(nextLanguage);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const detachedTerminalID = new URLSearchParams(window.location.search).get('detachedTerminal');
  if (detachedTerminalID) {
    return (
      <I18nProvider language={language} setLanguage={setLanguage}>
        <DetachedTerminalWindow />
      </I18nProvider>
    );
  }

  const [config, setConfig] = useState<SavedConfig | null>(null);
  const [activeModule, setActiveModule] = useState<SidebarModule>('project');
  const [tree, setTree] = useState<FileTreeResult | null>(null);
  const [projects, setProjects] = useState<ProjectListResult | null>(null);
  const [projectImportQueue, setProjectImportQueue] = useState<ProjectImportQueueJob[]>([]);
  const importQueueSyncState = useCallback((queueState: ProjectImportQueueJob['state']): ProjectConnectionState['syncState'] => {
    if (queueState === 'queued') return 'queued';
    if (queueState === 'failed') return 'error';
    if (queueState === 'uploading') return 'syncing';
    return 'migrating';
  }, []);
  const importQueueConnectionIntent = useCallback((queueState: ProjectImportQueueJob['state']): ProjectConnectionState['connectionIntent'] => (
    queueState === 'uploading' ? 'publishing' : null
  ), []);
  // makeImportingPlaceholder builds a minimal ProjectItem for queued
  // imports that have no visible real row yet. Path is prefixed with a
  // sentinel namespace so it can never collide with a real workspace.
  const makeImportingPlaceholder = useCallback((sourcePath: string, workspaceId: string, queueState: ProjectImportQueueJob['state'] = 'running', idSuffix = '', progress?: ProjectImportQueueJob['progress'], workspaceNameOverride = ''): ProjectItem => {
    // Prefer the job's (already-cleaned) workspace name so the placeholder's
    // name/workspaceName EXACTLY match the real project row that replaces it —
    // the card is keyed by workspaceName, so a mismatch would unmount/remount
    // (the card flickers away then back when the real row arrives).
    const basename = workspaceNameOverride || sourcePath.split(/[\\/]/).filter(Boolean).pop() || 'imported';
    // When live progress is present, drive the chip off the real phase so the
    // percent shows: 'scanning' renders scanPercent, 'syncing' renders
    // completion. Otherwise fall back to the queue-state mapping.
    const syncState: ProjectConnectionState['syncState'] = progress?.phase === 'scanning'
      ? 'scanning'
      : progress?.phase === 'syncing'
        ? 'syncing'
        : importQueueSyncState(queueState);
    const completion = progress?.phase === 'scanning'
      ? (typeof progress.scanPercent === 'number' ? progress.scanPercent : undefined)
      : (progress && typeof progress.completion === 'number' ? progress.completion : undefined);
    return {
      name: basename,
      path: `__importing__/${basename}/${idSuffix || Date.now()}`,
      workspaceName: basename,
      source: 'local',
      existsLocal: false,
      isGit: false,
      modifiedAt: new Date().toISOString(),
      current: false,
      syncBackend: 'syncthing',
      connectionState: {
        workspaceId,
        workspaceName: basename,
        name: basename,
        syncBackend: 'syncthing',
        availability: 'provisioning',
        openable: false,
        syncState,
        connectionIntent: importQueueConnectionIntent(queueState),
        completion,
        conflictCount: 0,
        lastError: queueState === 'failed' ? 'import.failed' : undefined,
      },
    };
  }, [importQueueConnectionIntent, importQueueSyncState]);
  // Project paths currently being click-handled. The cache phase
  // update from main lands via refreshProjects AFTER the IPC returns,
  // which leaves a ~100ms gap where the welcome card has no in-flight
  // phase class and the shimmer doesn't fire. This optimistic set
  // bridges that gap — entries are added on click entry and removed
  // on IPC settle. The shimmer rule keys off both this and the real
  // phase classes so motion is continuous from the click moment.
  const [pendingClicks, setPendingClicks] = useState<Set<string>>(() => new Set());
  const [daemon, setDaemon] = useState<DaemonStatus>(EMPTY_DAEMON);
  // Phase 4.3 (syncthing migration): live event-folded state from
  // main's syncthing_event_subscriber. null until first push lands.
  const [syncthingState, setSyncthingState] = useState<SyncthingState | null>(null);

  // Merge importing placeholders into the projects list the children
  // render against. Placeholders go FIRST so the new card lands at the
  // top of the list — the user just dropped it, that's where they
  // expect to see it. When refreshProjects eventually returns the real
  // row (with the actual local path) AND removeImportingPlaceholder
  // strips the synthetic row, the list converges; there is no flicker
  // because the real row's sort order is stable and the placeholder
  // is keyed on a distinct __importing__ path.
  const projectsWithPlaceholders = useMemo<ProjectListResult | null>(() => {
    const activeQueue = projectImportQueue.filter((job) => (
      job.state === 'queued'
      || job.state === 'migrating'
      || job.state === 'uploading'
      || job.state === 'running'
    ));
    const queueByName = new Map(activeQueue.map((job) => [job.workspaceName, job]));
    // Also key by source path. A discovered local card's job has
    // sourcePath === the card's own path, so path-matching catches it
    // even when cleanWorkspaceName(basename) !== the raw dir name (where
    // a name-only match would miss, leaving the card stuck idle and its
    // Upload button visible during an in-flight import). Drag-imports are
    // unaffected: their sourcePath is an external path, never a card path.
    const queueByPath = new Map(activeQueue.map((job) => [job.sourcePath, job]));
    const matchedJobIds = new Set<string>();
    const baseProjects = (projects?.projects || []).map((project) => {
      const job = queueByName.get(project.workspaceName || project.name) || queueByPath.get(project.path);
      if (!job) return project;
      matchedJobIds.add(job.id);
      const phase = job.progress?.phase;
      const syncState: ProjectConnectionState['syncState'] = phase === 'scanning'
        ? 'scanning'
        : phase === 'syncing'
          ? 'syncing'
          : importQueueSyncState(job.state);
      const connectionIntent = importQueueConnectionIntent(job.state);
      const completion = phase === 'scanning'
        ? (typeof job.progress?.scanPercent === 'number' ? job.progress.scanPercent : undefined)
        : (job.progress && typeof job.progress.completion === 'number' ? job.progress.completion : undefined);
      return {
        ...project,
        connectionState: project.connectionState
          ? {
              ...project.connectionState,
              syncState,
              connectionIntent,
              completion,
            }
          : project.connectionState,
      };
    });
    // A placeholder is only needed for an active job that didn't overlay
    // onto an existing card — match by id (covers both name and path
    // matches above) and keep the name guard for any job that matched a
    // same-named base project without being recorded.
    const visibleNames = new Set(baseProjects.map((project) => project.workspaceName || project.name));
    const queuePlaceholders = activeQueue
      .filter((job) => !matchedJobIds.has(job.id) && !visibleNames.has(job.workspaceName))
      .map((job) => makeImportingPlaceholder(job.sourcePath, projects?.workspaceId || config?.workspaceId || '', job.state, job.id, job.progress, job.workspaceName));
    const placeholders = queuePlaceholders;
    if (placeholders.length === 0) {
      return projects ? { ...projects, projects: baseProjects } : projects;
    }
    if (!projects) {
      return { root: '', projects: placeholders };
    }
    return { ...projects, projects: [...placeholders, ...baseProjects] };
  }, [projects, projectImportQueue, makeImportingPlaceholder, config?.workspaceId, importQueueConnectionIntent, importQueueSyncState]);
  const syncthingProjectRefreshActive = useMemo(
    () => projectsNeedSyncRefresh(projectsWithPlaceholders),
    [projectsWithPlaceholders],
  );
  const syncthingEventRefreshActive = useMemo(
    () => syncthingEventsNeedProjectRefresh(syncthingState),
    [syncthingState],
  );
  const liveProjectRefreshActive =
    Boolean(daemon.transferCount && daemon.transferCount > 0)
    || syncthingProjectRefreshActive
    || syncthingEventRefreshActive;

  const markPendingClick = useCallback((projectPath: string) => {
    if (!projectPath) return;
    setPendingClicks((prev) => {
      if (prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.add(projectPath);
      return next;
    });
  }, []);

  const clearPendingClick = useCallback((projectPath: string) => {
    if (!projectPath) return;
    setPendingClicks((prev) => {
      if (!prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.delete(projectPath);
      return next;
    });
  }, []);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  // Mirror of `sessions` so callbacks/timers can read the latest list without
  // being re-created (and re-subscribed) on every list change.
  const sessionsRef = useRef<SessionItem[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [git, setGit] = useState<GitSummary | null>(null);
  const [capabilities, setCapabilities] = useState<unknown>(null);
  const [models, setModels] = useState<unknown>(null);
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [panes, setPanes] = useState<WorkspacePane[]>([]);
  const [activePaneId, setActivePaneId] = useState('');
  const [toast, setToast] = useState<{ id: number; message: string; closing: boolean } | null>(null);
  const [dialog, setDialog] = useState<AppDialogState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Diff Viewer commit 3: Project view sub-tab state. 'files' is
  // the existing WorkspaceGrid (editors); 'changes' renders the
  // read-only DiffReviewPanel. Per plan §3: NOT a top-level sidebar
  // module; explicit project-level segmented control.
  const [projectView, setProjectView] = useState<'files' | 'changes'>('files');
  const [diffSummary, setDiffSummary] = useState<GitDiffSummary | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffLastFetchedIso, setDiffLastFetchedIso] = useState<string | null>(null);
  const panesRef = useRef<WorkspacePane[]>([]);
  const openProjectGenerationRef = useRef(0);
  const lastCliHistoryRefreshAt = useRef(0);

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  // Tell main which CLI terminals currently have a pane in the project
  // view. Detached PTY windows query this (via main) to decide whether
  // their close button means "re-dock" or "stop+close" — without this
  // a detached window has no way to know panes were cleared on back-out.
  useEffect(() => {
    const ids = panes
      .filter((pane): pane is Extract<WorkspacePane, { type: 'cli' }> => pane.type === 'cli')
      .map((pane) => pane.terminalId || '')
      .filter(Boolean);
    void window.kari.setActiveTerminalPanes(ids);
  }, [panes]);

  useEffect(() => {
    void window.kari.getConfig().then(setConfig);
  }, []);

  // Phase 4.3 (syncthing migration): seed syncthingState from the
  // current snapshot, then subscribe to live updates from main's
  // event-subscriber. The unsubscribe closure is returned to React
  // so a hot-reload doesn't leak the IPC listener.
  useEffect(() => {
    let active = true;
    void window.kari.syncthingState().then((s) => {
      if (active) setSyncthingState(s);
    }).catch(() => {/* main not ready yet — first push will set state */});
    const off = window.kari.onSyncthingState((next) => {
      setSyncthingState(next);
    });
    return () => {
      active = false;
      try { off(); } catch { /* idempotent */ }
    };
  }, []);

  const setNotice = useCallback((message: string) => {
    const text = String(message || '').trim();
    if (!text) {
      setToast(null);
      return;
    }
    setToast({ id: Date.now(), message: text, closing: false });
  }, []);

  const showConfirm = useCallback((options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
  }) => new Promise<boolean>((resolve) => {
    setDialog({
      id: Date.now(),
      kind: 'confirm',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel || translate(language, 'common.confirm'),
      cancelLabel: options.cancelLabel || translate(language, 'common.cancel'),
      tone: options.tone,
      resolve
    });
  }), [language]);

  const showPrompt = useCallback((options: {
    title: string;
    message: string;
    value?: string;
    placeholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }) => new Promise<string | null>((resolve) => {
    setDialog({
      id: Date.now(),
      kind: 'prompt',
      title: options.title,
      message: options.message,
      value: options.value || '',
      placeholder: options.placeholder,
      confirmLabel: options.confirmLabel || translate(language, 'common.save'),
      cancelLabel: options.cancelLabel || translate(language, 'common.cancel'),
      resolve
    });
  }), [language]);

  const showCredentials = useCallback((options: {
    title: string;
    message: string;
    usernameLabel?: string;
    passwordLabel?: string;
    usernamePlaceholder?: string;
    passwordPlaceholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }) => new Promise<{ username: string; password: string } | null>((resolve) => {
    setDialog({
      id: Date.now(),
      kind: 'credentials',
      title: options.title,
      message: options.message,
      usernameLabel: options.usernameLabel || translate(language, 'credentials.username'),
      passwordLabel: options.passwordLabel || translate(language, 'credentials.password'),
      usernamePlaceholder: options.usernamePlaceholder,
      passwordPlaceholder: options.passwordPlaceholder,
      confirmLabel: options.confirmLabel || translate(language, 'common.confirm'),
      cancelLabel: options.cancelLabel || translate(language, 'common.cancel'),
      resolve
    });
  }), [language]);

  const refreshOpenEditorPanes = useCallback(async () => {
    const editorPanes = panesRef.current.filter((pane): pane is Extract<WorkspacePane, { type: 'editor' }> => pane.type === 'editor');
    const reloadable = editorPanes.filter((pane) => !pane.dirty && !pane.saving);
    if (!reloadable.length) return;
    const updates = await Promise.all(reloadable.map(async (pane) => {
      try {
        const file = await window.kari.readFile(pane.file.path);
        return { paneId: pane.id, file };
      } catch {
        return null;
      }
    }));
    const byPane = new Map(updates.filter(Boolean).map((item) => [item!.paneId, item!.file]));
    if (!byPane.size) return;
    setPanes((prev) => prev.map((pane) => {
      if (pane.type !== 'editor' || pane.dirty || pane.saving) return pane;
      const file = byPane.get(pane.id);
      if (!file) return pane;
      if (
        pane.content === file.content
        && pane.savedContent === file.content
        && pane.file.gitBadge === file.gitBadge
        && pane.file.gitStatus === file.gitStatus
        && pane.file.baseKind === file.baseKind
        && pane.file.baseContent === file.baseContent
      ) {
        return pane;
      }
      return {
        ...pane,
        title: file.relPath || file.path,
        file,
        content: file.content,
        savedContent: file.content,
        dirty: false
      };
    }));
  }, []);

  const refreshDaemon = useCallback(async () => {
    const next = await window.kari.daemonStatus();
    setDaemon(next);
  }, []);

  const refreshSessions = useCallback(async (forceRefresh = false): Promise<SessionItem[] | null> => {
    const next = await window.kari.listSessions(forceRefresh);
    // null = transient daemon failure (timeout / busy). Keep the current
    // list instead of blanking the sidebar.
    if (next == null) return null;
    setSessions(next);
    return next;
  }, []);

  // After a CLI starts, the new session's JSONL takes a moment to appear and
  // the daemon's list cache must be busted (forceRefresh). Poll with backoff
  // and stop as soon as a session id we didn't have before shows up — instead
  // of firing a fixed number of full container re-scans. Trade-off: if several
  // CLIs start within this window it may stop after the first appears; the
  // rest are picked up by the activity refresh or the 20s safety-net poll.
  const refreshSessionsUntilNew = useCallback(async (delaysMs: number[]) => {
    const known = new Set(sessionsRef.current.map((s) => `${s.source}-${s.id}`));
    for (const delay of delaysMs) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      const next = await refreshSessions(true);
      if (next && next.some((s) => !known.has(`${s.source}-${s.id}`))) return;
    }
  }, [refreshSessions]);

  const refreshSessionsAfterCliActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastCliHistoryRefreshAt.current < 3500) return;
    lastCliHistoryRefreshAt.current = now;
    window.setTimeout(() => void refreshSessions(true), 600);
  }, [refreshSessions]);

  const refreshRuntime = useCallback(async () => {
    const next = await window.kari.runtimeStatus();
    setRuntime(next);
  }, []);

  const refreshGit = useCallback(async () => {
    const next = await window.kari.gitSummary();
    setGit(next);
  }, []);

  // Diff Viewer commit 3 round-1 High fix: refresh the Changes feed
  // via a single effect keyed on [projectView, workspaceRoot]. Two
  // entry conditions:
  //   1. User clicks the Changes tab (projectView flips).
  //   2. User switches projects while on the Changes tab
  //      (workspaceRoot changes).
  // Either way the effect clears the stale summary first, then
  // refetches. This closes the stale-project window where the
  // panel would show Project A's diff after the user moved to
  // Project B; openFileFromDiff would then try to open a Project
  // A relPath under Project B's workspaceRoot.
  // Manual Refresh from the panel still works via onRefresh.

  // Diff Viewer commit 3: refresh the Changes feed. Plan §3 explicit
  // refresh policy: no fs-watch in Phase 1 — fetches happen on Changes
  // sub-tab open / explicit Refresh click / project switch.
  const refreshDiff = useCallback(async () => {
    setDiffLoading(true);
    try {
      const summary = await window.kari.gitDiffSummary();
      setDiffSummary(summary);
      setDiffLastFetchedIso(new Date().toISOString());
    } catch (err) {
      setDiffSummary({
        ok: false,
        isGit: false,
        root: '',
        files: [],
        error: String(err instanceof Error ? err.message : err),
      });
      setDiffLastFetchedIso(new Date().toISOString());
    } finally {
      setDiffLoading(false);
    }
  }, []);

  // Effect: clear + auto-refetch on (a) projectView flips to
  // 'changes', or (b) workspaceRoot changes while still on
  // 'changes'. Keyed on both so either trigger fires. The clear
  // step is unconditional — even if workspaceRoot is empty, we
  // null the summary so the panel doesn't render stale data.
  useEffect(() => {
    if (projectView !== 'changes') return;
    setDiffSummary(null);
    setDiffLastFetchedIso(null);
    if (!config?.workspaceRoot) return;
    void refreshDiff();
  }, [projectView, config?.workspaceRoot, refreshDiff]);

  // Copy diff with plan §3 truncated/binary safety: binary → refuse;
  // truncated → prepend explicit `# diff truncated...` warning so the
  // user (or paste target) sees the partial-content marker. Renderer
  // never copies raw without context.
  const copyDiff = useCallback(async (req: { patch: string; path: string; truncated: boolean; binary: boolean }) => {
    if (req.binary) {
      setNotice(translate(language, 'diff.copyBinaryDenied'));
      return;
    }
    if (!req.patch) {
      setNotice(translate(language, 'diff.copyEmpty'));
      return;
    }
    const warning = req.truncated
      ? `# diff truncated at 256 KB — content below is partial (file: ${req.path})\n#\n`
      : '';
    try {
      await navigator.clipboard.writeText(warning + req.patch);
      setNotice(translate(language, req.truncated ? 'diff.copyTruncatedDone' : 'diff.copyDone'));
    } catch (err) {
      setNotice(translate(language, 'diff.copyFailed', { error: String(err instanceof Error ? err.message : err) }));
    }
  }, [language, setNotice]);


  const refreshStorage = useCallback(async () => {
    try {
      setStorageSummary(await window.kari.storageSummary());
    } catch {
      setStorageSummary(null);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    const [nextCapabilities, nextModels, nextStorage] = await Promise.all([
      window.kari.getCapabilities().catch((err) => ({ ok: false, error: String(err instanceof Error ? err.message : err) })),
      window.kari.getModelKeys().catch((err) => ({ ok: false, error: String(err instanceof Error ? err.message : err) })),
      window.kari.storageSummary().catch(() => null)
    ]);
    setCapabilities(nextCapabilities);
    setModels(nextModels);
    setStorageSummary(nextStorage);
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const next = await window.kari.listFiles();
      setTree(next);
      void refreshOpenEditorPanes();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [refreshOpenEditorPanes]);

  const refreshProjects = useCallback(async () => {
    try {
      const next = await window.kari.listProjects();
      setProjects(next);
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void window.kari.importQueueSnapshot().then((result) => {
      if (active && result.ok) setProjectImportQueue(result.jobs || []);
    }).catch(() => {});
    const off = window.kari.onProjectImportQueue((event) => {
      setProjectImportQueue(event.jobs || []);
      if (event.failedJob) {
        const name = event.failedJob.workspaceName || event.failedJob.sourcePath || 'unknown';
        const error = event.failedJob.error || name;
        if (String(error).startsWith('import_target_exists')) {
          // Re-importing a project that already exists in Kari isn't a failure —
          // it's already here (and keeps syncing). Inform, don't alarm.
          showSyncNotice(translate(language, 'import.alreadyExists', { name }));
        } else {
          setNotice(translate(language, 'import.failed', { error }));
        }
      }
      void refreshProjects();
    });
    return () => {
      active = false;
      try { off(); } catch {}
    };
    // showSyncNotice intentionally omitted from deps: it is declared later in
    // the component (TDZ if referenced here) and is stable per `language`,
    // which is already a dep — so the subscription re-binds when it changes.
  }, [language, refreshProjects]);

  useEffect(() => {
    if (!settingsOpen) return;
    void refreshStorage();
  }, [settingsOpen, refreshStorage]);

  useEffect(() => {
    if (!config?.activated) return;
    void refreshProjects();
    void refreshDaemon();
    void refreshSessions();
    void refreshFiles();
    void refreshRuntime();
    void refreshGit();
    void refreshSettings();
    void window.kari.ensureDaemon().then((res) => {
      if (!res.ok && res.error) setNotice(res.error);
    });
    const timer = window.setInterval(() => {
      void refreshDaemon();
    }, 2000);
    // Session list changes on CLI start/activity (handled by events); this
    // slow poll is only a safety net for changes made outside the app.
    const sessionTimer = window.setInterval(() => {
      void refreshSessions();
    }, 20000);
    const fileTimer = window.setInterval(() => {
      void refreshFiles();
    }, 5000);
    const projectTimer = window.setInterval(() => {
      void refreshProjects();
    }, 60000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(sessionTimer);
      window.clearInterval(fileTimer);
      window.clearInterval(projectTimer);
    };
  }, [config?.activated, refreshDaemon, refreshFiles, refreshGit, refreshProjects, refreshRuntime, refreshSessions, refreshSettings]);

  // While sync is active, poll listProjects at 1s so the project card's
  // progress chip + diamond actually move. Filesync still uses daemon
  // transferCount; Syncthing uses project.connectionState and the live
  // event feed because BEP transfer progress no longer appears in the
  // old daemon counters.
  useEffect(() => {
    if (!liveProjectRefreshActive) return;
    void refreshProjects();
    const id = window.setInterval(() => void refreshProjects(), 1000);
    return () => window.clearInterval(id);
  }, [liveProjectRefreshActive, refreshProjects]);

  const showSyncNotice = useCallback((message: string) => {
    setNotice(message);
  }, [setNotice]);

  useEffect(() => {
    if (!toast) return;
    const closingTimer = window.setTimeout(() => {
      setToast((current) => current && current.id === toast.id ? { ...current, closing: true } : current);
    }, 4300);
    const removeTimer = window.setTimeout(() => {
      setToast((current) => current && current.id === toast.id ? null : current);
    }, 5000);
    return () => {
      window.clearTimeout(closingTimer);
      window.clearTimeout(removeTimer);
    };
  }, [toast]);

  useEffect(() => {
    if (!config?.activated) return;
    if (!daemon.lastSyncAt && !daemon.lastActivityAt) return;
    void refreshFiles();
  }, [config?.activated, daemon.lastActivityAt, daemon.lastSyncAt, refreshFiles]);

  const handleActivated = useCallback((next: SavedConfig, message?: string) => {
    setConfig(next);
    if (message && message !== 'activated') setNotice(message);
  }, []);

  const logout = useCallback(async () => {
    const confirmed = await showConfirm({
      title: translate(language, 'auth.logoutTitle'),
      message: translate(language, 'auth.logoutMessage'),
      confirmLabel: translate(language, 'auth.logoutConfirm'),
      tone: 'danger'
    });
    if (!confirmed) return;
    try {
      const next = await window.kari.logout();
      setConfig(next);
      setDaemon(EMPTY_DAEMON);
      setProjects(null);
      setSessions([]);
      setRuntime(null);
      setGit(null);
      setCapabilities(null);
      setModels(null);
      setPanes([]);
      setActivePaneId('');
      setActiveModule('project');
      setSettingsOpen(false);
      setNotice(translate(language, 'auth.logoutDone'));
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language, showConfirm]);

  const selectStorageBaseDir = useCallback(async () => {
    const result = await window.kari.selectStorageBaseDir();
    if (result.canceled) return;
    if (!result.ok) {
      setNotice(result.error || translate(language, 'storage.selectFailed'));
      return;
    }
    setConfig(result.config);
    setStorageSummary(await window.kari.storageSummary().catch(() => ({
      storageBaseDir: result.storageBaseDir,
      projectsRoot: result.projectsRoot,
      bytesUsed: 0,
      projectCount: 0,
    })));
    setNotice(translate(language, 'storage.updated', { path: result.storageBaseDir }));
    void refreshProjects();
  }, [language, refreshProjects]);

  const selectWorkspace = useCallback(async () => {
    const result = await window.kari.selectWorkspace();
    if (result.canceled) return;
    if (result.needsImport && result.path) {
      const confirmed = await showConfirm({
        title: translate(language, 'import.confirmTitle'),
        message: translate(language, 'import.confirmOutsideMessage', { path: result.path }),
        confirmLabel: translate(language, 'import.confirmAction'),
      });
      if (!confirmed) return;
      let uploaded;
      try {
        uploaded = await window.kari.importAndUploadProject(result.path);
      } catch (err) {
        setNotice(translate(language, 'import.failed', { error: String(err instanceof Error ? err.message : err) || 'unknown' }));
        void refreshProjects();
        return;
      }
      if (!uploaded.ok) {
        if (uploaded.code === 'import_target_exists') {
          setNotice(translate(language, 'import.targetExists'));
        } else {
          setNotice(translate(language, 'import.failed', { error: uploaded.error || uploaded.code || 'unknown' }));
        }
        void refreshProjects();
        return;
      }
      if (uploaded.job) {
        setProjectImportQueue((prev) => {
          if (prev.some((job) => job.id === uploaded.job.id)) return prev;
          return [...prev, uploaded.job];
        });
      }
      showSyncNotice(translate(language, 'import.queued', { count: 1 }));
      void refreshProjects();
      void refreshDaemon();
      setActiveModule('project');
      return;
    }
    if (result.config) {
      setConfig((prev) => ({ ...result.config!, activated: Boolean(prev?.activated || result.config!.activated) }));
    }
    if (result.tree) setTree(result.tree);
    if (result.bind && !result.bind.ok && result.bind.error) setNotice(translate(language, 'daemon.bindFailed', { error: result.bind.error }));
    if (result.bind && result.bind.skipped) setNotice(result.bind.reason || translate(language, 'daemon.unbound'));
    void refreshProjects();
    setActiveModule('files');
  }, [language, refreshDaemon, refreshProjects, showConfirm, showSyncNotice]);

  // Drag-folder-into-project handler. Mirrors selectWorkspace's
  // import branch but bypasses the native file picker — the path
  // comes from a Finder/Explorer drop on the welcome page or the
  // sidebar's project list. The same confirm dialog + outcome
  // banners stay so the user can't silently double-upload a folder.
  const importFolderByDrop = useCallback(async (folderPaths: string[]) => {
    const cleaned = folderPaths.map((p) => String(p || '').trim()).filter(Boolean);
    if (!cleaned.length) return;
    const confirmed = await showConfirm({
      title: translate(language, 'import.confirmTitle'),
      message: cleaned.length === 1
        ? translate(language, 'import.confirmDropMessage', { path: cleaned[0] })
        : translate(language, 'import.confirmDropMultipleMessage', { count: cleaned.length }),
      confirmLabel: translate(language, 'import.confirmAction'),
    });
    if (!confirmed) return;
    let queued = 0;
    for (const projectPath of cleaned) {
      try {
        const uploaded = await window.kari.importAndUploadProject(projectPath);
        if (uploaded.ok) {
          queued += 1;
          if (uploaded.job) {
            setProjectImportQueue((prev) => {
              if (prev.some((job) => job.id === uploaded.job.id)) return prev;
              return [...prev, uploaded.job];
            });
          }
          continue;
        }
        if (uploaded.code === 'import_target_exists') {
          setNotice(translate(language, 'import.targetExists'));
        } else {
          setNotice(translate(language, 'import.failed', { error: uploaded.error || uploaded.code || 'unknown' }));
        }
      } catch (err) {
        setNotice(translate(language, 'import.failed', { error: String(err instanceof Error ? err.message : err) || 'unknown' }));
      }
    }
    if (queued > 0) showSyncNotice(translate(language, 'import.queued', { count: queued }));
    void refreshProjects();
    void refreshDaemon();
    setActiveModule('project');
  }, [language, refreshDaemon, refreshProjects, showConfirm, showSyncNotice]);

  // Drop files/folders from the OS into a specific tree directory.
  // destAbsDir is workspaceRoot or any sub-directory inside it.
  // Main does fs.cp recursive per source; the tree is refreshed after
  // a successful copy so the new entries show up immediately.
  const importFilesIntoTree = useCallback(async (destAbsDir: string, sourcePaths: string[]) => {
    const cleaned = sourcePaths.map((p) => String(p || '').trim()).filter(Boolean);
    if (!cleaned.length) return;
    const result = await window.kari.importFilesFromDisk(destAbsDir, cleaned);
    if (!result.ok) {
      setNotice(translate(language, 'import.filesFailed', { error: result.error || 'unknown' }));
      return;
    }
    const copied = result.copied?.length || 0;
    const skipped = result.skipped?.length || 0;
    if (copied > 0) {
      showSyncNotice(translate(language, skipped > 0 ? 'import.filesCopiedWithSkipped' : 'import.filesCopied', { copied, skipped }));
    } else if (skipped > 0) {
      const reasons = result.skipped!.map((s) => `${s.src.split('/').pop()}: ${s.reason}`).slice(0, 3).join('; ');
      setNotice(translate(language, 'import.filesSkipped', { reasons }));
    }
    void refreshFiles();
  }, [language, refreshFiles, showSyncNotice]);

  // Upload a local-only project on demand — the "上传" affordance on a
  // discovered / unpublished local card. The path already lives inside
  // the storage container (the user dropped it into kari-drive, or it's
  // an unpublished local mirror), so importAndUploadProject →
  // importLocalProject sees source===target, skips the copy, writes the
  // ownership tag, and enqueues the upload. The click itself is the
  // user's explicit claim of the orphan under the current activation —
  // no confirm dialog needed.
  const uploadLocalProject = useCallback(async (project: ProjectItem) => {
    const projectPath = project.path || project.localPath;
    if (!projectPath) return;
    let uploaded;
    try {
      uploaded = await window.kari.importAndUploadProject(projectPath);
    } catch (err) {
      setNotice(translate(language, 'import.failed', { error: String(err instanceof Error ? err.message : err) || 'unknown' }));
      void refreshProjects();
      return;
    }
    if (!uploaded.ok) {
      if (uploaded.code === 'import_target_exists') {
        setNotice(translate(language, 'import.targetExists'));
      } else {
        setNotice(translate(language, 'import.failed', { error: uploaded.error || uploaded.code || 'unknown' }));
      }
      void refreshProjects();
      return;
    }
    if (uploaded.job) {
      setProjectImportQueue((prev) => {
        if (prev.some((job) => job.id === uploaded.job.id)) return prev;
        return [...prev, uploaded.job];
      });
    }
    showSyncNotice(translate(language, 'import.queued', { count: 1 }));
    void refreshProjects();
    void refreshDaemon();
  }, [language, refreshDaemon, refreshProjects, showSyncNotice]);

  // Dismiss a discovered (untagged) local orphan from the list. Writes a
  // marker into the dir's .kari-engine/ — the files on disk are untouched
  // — and refreshes so the card disappears. Only offered on discovered
  // cards; an owned/uploaded project can't be dismissed this way.
  const dismissDiscoveredProject = useCallback(async (project: ProjectItem) => {
    const projectPath = project.path || project.localPath;
    if (!projectPath) return;
    const result = await window.kari.dismissDiscoveredProject(projectPath).catch(() => null);
    if (!result || !result.ok) {
      setNotice(translate(language, 'project.dismissFailed'));
      return;
    }
    void refreshProjects();
  }, [language, refreshProjects]);

  // Sync progress and phase come exclusively from project.sync (the
  // main-process sync_state_cache, populated by sync_task_tracker
  // from daemon /v1/sync-tasks). The renderer no longer invents
  // intermediate progress — refreshProjects below pulls fresh state
  // after each click.

  // Download a cloud-only project to the local mirror dir. Does NOT
  // auto-enter the Files view. IPC success only means the daemon
  // accepted the sync-task; the task's terminal succeeded is what
  // flips the card to openable.
  const downloadProject = useCallback(async (projectPath: string, project?: ProjectItem) => {
    markPendingClick(projectPath);
    try {
      const displayName = project?.workspaceName || project?.name || projectPath;
      const remotePath = project?.remoteWorkdir || project?.path || projectPath;
      const confirmed = await showConfirm({
        title: translate(language, 'project.downloadConfirmTitle'),
        message: translate(language, 'project.downloadConfirmMessage', {
          name: displayName,
          path: remotePath,
        }),
        confirmLabel: translate(language, 'project.downloadConfirmAction'),
      });
      if (!confirmed) return;
      showSyncNotice(translate(language, 'project.downloadStarted', { name: displayName }));
      const result = await window.kari.downloadProject(projectPath, project || null);
      if (!result || !result.ok) {
        if (result?.code === 'daemon_too_old') {
          setNotice(translate(language, 'project.daemonTooOldDownload'));
        } else {
          const msg = result?.error || 'unknown';
          setNotice(translate(language, 'project.downloadFailed', { error: msg }));
        }
        return;
      }
      showSyncNotice(translate(language, 'project.downloadStarted', { name: result.workspaceName || displayName }));
      void refreshProjects();
      window.setTimeout(() => void refreshProjects(), 1800);
      window.setTimeout(() => void refreshProjects(), 5000);
      void refreshDaemon();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    } finally {
      clearPendingClick(projectPath);
    }
  }, [clearPendingClick, language, markPendingClick, refreshDaemon, refreshProjects, showConfirm, showSyncNotice]);

  // Cancel an in-flight or stuck download. Asks main to stop the
  // daemon task; the incomplete marker is INTENTIONALLY kept so the
  // project stays un-openable and the user can retry with filesync's
  // incremental resume (partial files on disk are reused).
  const abandonDownload = useCallback(async (project: ProjectItem) => {
    try {
      const displayName = project.workspaceName || project.name || project.path;
      const confirmed = await showConfirm({
        title: translate(language, 'project.abandonConfirmTitle'),
        message: translate(language, 'project.abandonConfirmMessage', { name: displayName }),
        confirmLabel: translate(language, 'project.abandonConfirmAction'),
        tone: 'danger',
      });
      if (!confirmed) return;
      // Dispatch by the project's current connection intent:
      //   - 'publishing' = upload in flight (snapshot upload pipeline);
      //     route through projects:cancelSnapshotUpload which looks up
      //     the active upload-snapshot session by workspace identity and
      //     cancels it (local cleanup + server abandon).
      //   - anything else (typically 'attaching' = download in flight or
      //     legacy filesync 'both') → window.kari.abandonDownload which
      //     stops the daemon task + preserves the partial mirror dir.
      //
      // The button label is shared between the two; only the underlying
      // IPC differs.
      const intent = project.connectionState?.connectionIntent;
      const isUpload = intent === 'publishing';
      const result = isUpload
        ? await window.kari.cancelSnapshotUpload(project)
        : await window.kari.abandonDownload(project);
      if (!result || !result.ok) {
        setNotice(translate(language, 'project.abandonFailed', { error: result?.error || 'unknown' }));
      } else {
        showSyncNotice(translate(language, 'project.abandonDone', { name: displayName }));
      }
      void refreshProjects();
      void refreshDaemon();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language, refreshDaemon, refreshProjects, showConfirm, showSyncNotice]);

  const deleteLocalProjectFromSettings = useCallback(async (project: ProjectItem) => {
    const name = project.workspaceName || project.name || project.path;
    const typed = await showPrompt({
      title: translate(language, 'settings.projects.deleteLocalTitle'),
      message: translate(language, 'settings.projects.deleteConfirmMessage', { name }),
      placeholder: name,
      confirmLabel: translate(language, 'settings.projects.deleteLocal'),
    });
    if (typed === null) return;
    if (typed !== name) {
      setNotice(translate(language, 'settings.projects.deleteNameMismatch'));
      return;
    }
    try {
      const result = await window.kari.deleteLocalProject(project, typed);
      if (!result.ok) {
        setNotice(translate(language, 'settings.projects.deleteFailed', { error: result.error || result.code || 'unknown' }));
        return;
      }
      showSyncNotice(translate(language, 'settings.projects.localDeleted', { name }));
      setPanes([]);
      setActivePaneId('');
      setTree(null);
      setGit(null);
      setProjectView('files');
      setActiveModule('project');
      setSettingsOpen(false);
      void refreshProjects();
      void refreshStorage();
    } catch (err) {
      setNotice(translate(language, 'settings.projects.deleteFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }, [language, refreshProjects, refreshStorage, showPrompt, showSyncNotice]);

  const deleteCloudProjectFromSettings = useCallback(async (project: ProjectItem) => {
    const name = project.workspaceName || project.name || project.path;
    const typed = await showPrompt({
      title: translate(language, 'settings.projects.deleteCloudTitle'),
      message: translate(language, 'settings.projects.deleteCloudConfirmMessage', { name }),
      placeholder: name,
      confirmLabel: translate(language, 'settings.projects.deleteCloud'),
    });
    if (typed === null) return;
    if (typed !== name) {
      setNotice(translate(language, 'settings.projects.deleteNameMismatch'));
      return;
    }
    try {
      const result = await window.kari.deleteCloudProject(project, typed);
      if (!result.ok) {
        setNotice(translate(language, 'settings.projects.deleteFailed', { error: result.error || result.code || 'unknown' }));
        return;
      }
      showSyncNotice(translate(language, 'settings.projects.cloudDeleted', { name }));
      void refreshProjects();
      void refreshStorage();
    } catch (err) {
      setNotice(translate(language, 'settings.projects.deleteFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }, [language, refreshProjects, refreshStorage, showPrompt, showSyncNotice]);

  const openProject = useCallback(async (projectPath: string, project?: ProjectItem) => {
    const openGeneration = ++openProjectGenerationRef.current;
    const isLatestOpenProject = () => openGeneration === openProjectGenerationRef.current;
    // Cloud-only-not-downloaded route to download; main-side guard
    // still defends (refuses to mkdir the mirror dir). The
    // already-downloaded case is allowed to open even when a
    // background sync task is still running — opening Files is no
    // longer blocked on phase ∈ {scanning, binding, downloading}.
    if (project && isCloudOnlyNotDownloaded(project)) {
      // Already downloading → toast only; do NOT re-POST a new
      // sync-task (would create a second daemon task for the same
      // workspace). The current task's progress lives on project.sync
      // and the next refreshProjects will move the chip.
      if (isCloudDownloadActive(project)) {
        showSyncNotice(translate(language, 'project.downloadInProgress'));
        void refreshProjects();
        return;
      }
      await downloadProject(projectPath, project);
      return;
    }
    markPendingClick(projectPath);
    try {
      if (project && isPureLocalProject(project)) {
        const trusted = await showConfirm({
          title: translate(language, 'project.trustTitle'),
          message: translate(language, 'project.trustMessage'),
          confirmLabel: translate(language, 'project.trustAction')
        });
        if (!trusted) return;
        if (!isLatestOpenProject()) return;
      }
      const result = await window.kari.openProject(projectPath, project || null);
      if (!isLatestOpenProject()) {
        void refreshProjects();
        return;
      }
      if (!result.ok) {
        // Belt-and-suspenders: main may still return cloud-project
        // guard codes if a race lets a stale projectMeta through.
        if (result.code === 'cloud_project_downloading') {
          showSyncNotice(translate(language, 'project.downloadInProgress'));
          void refreshProjects();
          void refreshDaemon();
          return;
        }
        if (result.code === 'cloud_project_not_downloaded') {
          await downloadProject(projectPath, project);
          return;
        }
        setNotice(translate(language, 'project.openFailed', { error: result.error || result.code || 'unknown' }));
        return;
      }
      // result.ok narrowed to true past this point.
      setConfig((prev) => ({ ...result.config, activated: Boolean(prev?.activated || result.config.activated) }));
      setTree(result.tree);
      setPanes([]);
      setActivePaneId('');
      if (result.bind && !result.bind.ok && result.bind.error) {
        setNotice(translate(language, 'project.openedBindFailed', { error: result.bind.error }));
      } else if (result.bind && result.bind.skipped) {
        setNotice(result.bind.reason || translate(language, 'project.openedBindSkipped'));
      } else if (result.sync && !result.sync.ok && !result.sync.skipped) {
        // sync result.code distinguishes daemon_too_old vs other
        // failures; the chip on the card will still reflect cache
        // state, but the toast tells the user something needs
        // attention.
        if (result.sync.code === 'daemon_too_old') {
          setNotice(translate(language, 'project.daemonTooOldOpen'));
        } else {
          setNotice(translate(language, 'project.syncStartFailed', { error: result.sync.error || 'daemon offline' }));
        }
      } else {
        showSyncNotice(translate(language, 'project.openedSyncing', { name: result.config.workspaceName || result.path }));
      }
      void refreshProjects();
      window.setTimeout(() => void refreshProjects(), 1800);
      window.setTimeout(() => void refreshProjects(), 5000);
      void refreshDaemon();
      void refreshGit();
      void refreshSessions();
      setActiveModule('files');
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    } finally {
      clearPendingClick(projectPath);
    }
  }, [clearPendingClick, downloadProject, language, markPendingClick, refreshDaemon, refreshGit, refreshProjects, refreshSessions, showConfirm, showSyncNotice]);

  const cloneProject = useCallback(async (gitUrl: string) => {
    // attemptClone is the recursive worker. It runs the IPC once,
    // and if the server reports auth_required it pops a one-shot
    // credential dialog and recurses ONCE with the credentials.
    // No retry on a second auth_required — we'd just loop forever
    // if the user pasted a permanently bad token.
    const attemptClone = async (
      payload: { gitUrl: string; username?: string; password?: string },
      allowRetry: boolean
    ): Promise<boolean> => {
      const result = await window.kari.cloneProject(payload);
      if (result.ok === false && result.code === 'auth_required') {
        if (!allowRetry) {
          setNotice(translate(language, 'project.cloneAuthFailed', { error: result.error || '' }));
          return false;
        }
        const creds = await showCredentials({
          title: translate(language, 'project.cloneCredentialsTitle'),
          message: translate(language, 'project.cloneCredentialsMessage', { url: payload.gitUrl }),
          usernamePlaceholder: translate(language, 'project.cloneUsernamePlaceholder'),
          passwordPlaceholder: translate(language, 'project.clonePasswordPlaceholder'),
          confirmLabel: translate(language, 'project.cloneCredentialsAction'),
        });
        if (!creds) {
          setNotice(translate(language, 'project.cloneCancelled'));
          return false;
        }
        return attemptClone({ gitUrl: payload.gitUrl, username: creds.username, password: creds.password }, false);
      }
      if (result.ok === false) {
        setNotice(translate(language, 'project.cloneFailedWithError', { error: result.error || result.code || 'unknown' }));
        return false;
      }
      // result.ok narrowed true.
      setConfig((prev) => ({ ...result.config, activated: Boolean(prev?.activated || result.config.activated) }));
      setTree(result.tree);
      setPanes([]);
      setActivePaneId('');
      if (result.bind && !result.bind.ok && result.bind.error) setNotice(translate(language, 'project.cloneCreatedBindFailed', { error: result.bind.error }));
      else if (result.bootstrap && result.bootstrap.status && result.bootstrap.status !== 'ok') setNotice(translate(language, 'project.cloneBootstrapReturned', { status: result.bootstrap.error || result.bootstrap.status }));
      else if (result.bind && result.bind.skipped) setNotice(result.bind.reason || translate(language, 'project.cloneCreatedBindSkipped'));
      else showSyncNotice(translate(language, 'project.cloneDone', { name: result.config.workspaceName || result.path }));
      void refreshProjects();
      void refreshDaemon();
      void refreshGit();
      void refreshSessions();
      setActiveModule('files');
      return true;
    };

    try {
      setNotice(translate(language, 'project.cloneStarting'));
      await attemptClone({ gitUrl }, true);
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language, refreshDaemon, refreshGit, refreshProjects, refreshSessions, showCredentials, showSyncNotice]);

  const bindStartDaemon = useCallback(async () => {
    try {
      const result = await window.kari.bindStartDaemon();
      setNotice(result.skipped ? (result.reason || translate(language, 'daemon.managementUnbound')) : translate(language, 'daemon.reconnected'));
      void refreshDaemon();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language, refreshDaemon]);

  const reverseAction = useCallback(async (action: ReverseAction) => {
    if (config) {
      const blocked = reverseActionBlockedReason(action, config, daemon, runtime, language);
      if (blocked) {
        setNotice(blocked);
        return;
      }
    }
    try {
      if (action === 'start') await window.kari.reverseStart();
      if (action === 'refresh') await window.kari.reverseRefresh();
      if (action === 'stop') await window.kari.reverseStop();
      if (action === 'copy') await window.kari.reverseCopy();
      setNotice(action === 'copy'
        ? translate(language, 'reverse.copied')
        : translate(language, 'reverse.actionDone', { action }));
      void refreshDaemon();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [config, daemon, language, refreshDaemon, runtime]);

  const bootstrapGit = useCallback(async (gitUrl: string) => {
    try {
      await window.kari.gitBootstrap({ gitUrl });
      setNotice(translate(language, 'git.bootstrapSubmitted'));
      void refreshGit();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language, refreshGit]);

  const openFilePath = useCallback(async (filePath: string) => {
    try {
      const file = await window.kari.readFile(filePath);
      setPanes((prev) => {
        const existing = prev.find((pane) => pane.type === 'editor' && pane.file.path === file.path);
        if (existing) {
          setActivePaneId(existing.id);
          return prev;
        }
        if (prev.length >= 9) {
          setNotice(translate(language, 'pane.maxReached'));
          return prev;
        }
        const pane: WorkspacePane = {
          id: newPaneId(),
          type: 'editor',
          title: file.relPath || file.path,
          file,
          content: file.content,
          savedContent: file.content,
          dirty: false
        };
        setActivePaneId(pane.id);
        return [...prev, pane];
      });
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language]);

  // Open file from Diff panel: switch back to 'files' view + reuse
  // openFilePath. Declared AFTER openFilePath to avoid TDZ at
  // useCallback evaluation time (React reads deps synchronously
  // during render).
  const openFileFromDiff = useCallback(async (relPath: string) => {
    if (!config?.workspaceRoot) {
      setNotice(translate(language, 'file.noWorkspace'));
      return;
    }
    const abs = joinWorkspacePath(config.workspaceRoot, relPath);
    setProjectView('files');
    await openFilePath(abs);
  }, [config, language, openFilePath]);

  const saveEditorPane = useCallback(async (paneId: string) => {
    const target = panes.find((pane) => pane.id === paneId && pane.type === 'editor') as Extract<WorkspacePane, { type: 'editor' }> | undefined;
    if (!target) return;
    setPanes((prev) => prev.map((pane) => (
      pane.id === paneId && pane.type === 'editor' ? { ...pane, saving: true } : pane
    )));
    try {
      const result = await window.kari.saveFile(target.file.path, target.content);
      const nextFile = result.file || { ...target.file, content: target.content };
      setPanes((prev) => prev.map((pane) => (
        pane.id === paneId && pane.type === 'editor'
          ? {
              ...pane,
              content: nextFile.content,
              savedContent: nextFile.content,
              dirty: false,
              saving: false,
              file: nextFile
            }
          : pane
      )));
      setNotice(result.synced
        ? translate(language, 'file.savedSynced')
        : translate(language, 'file.savedUnsynced', { error: result.syncError || 'daemon offline' }));
      void refreshDaemon();
      void refreshFiles();
      void refreshGit();
    } catch (err) {
      setPanes((prev) => prev.map((pane) => (pane.id === paneId && pane.type === 'editor' ? { ...pane, saving: false } : pane)));
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language, panes, refreshDaemon, refreshFiles, refreshGit]);

  const changeEditorPane = useCallback((paneId: string, nextContent: string) => {
    setPanes((prev) => prev.map((pane) => {
      if (pane.id !== paneId || pane.type !== 'editor') return pane;
      return { ...pane, content: nextContent, dirty: nextContent !== pane.savedContent };
    }));
  }, []);

  const closePane = useCallback((paneId: string) => {
    const closingPane = panes.find((pane) => pane.id === paneId);
    if (closingPane?.type === 'cli') {
      if (closingPane.terminalId) {
        void window.kari.stopTerminal(closingPane.terminalId).finally(() => {
          void refreshDaemon();
        });
      } else {
        window.setTimeout(() => void refreshDaemon(), 150);
      }
    }
    setPanes((prev) => prev.filter((pane) => pane.id !== paneId));
    setActivePaneId((current) => {
      if (current !== paneId) return current;
      const next = panes.find((pane) => pane.id !== paneId);
      return next?.id || '';
    });
  }, [panes, refreshDaemon]);

  const returnToProjectDirectory = useCallback(async () => {
    const hasDirtyEditor = panes.some((pane) => pane.type === 'editor' && pane.dirty);
    if (hasDirtyEditor) {
      const confirmed = await showConfirm({
        title: translate(language, 'project.backDirtyTitle'),
        message: translate(language, 'project.backDirtyMessage'),
        confirmLabel: translate(language, 'project.backDirtyAction'),
        tone: 'danger'
      });
      if (!confirmed) return;
    }
    const terminalStops = panes
      .filter((pane): pane is Extract<WorkspacePane, { type: 'cli' }> & { terminalId: string } => pane.type === 'cli' && Boolean(pane.terminalId))
      .map((pane) => window.kari.stopTerminal(pane.terminalId));
    if (terminalStops.length > 0) {
      void Promise.allSettled(terminalStops).finally(() => {
        void refreshDaemon();
      });
    }
    // PTY-driven sync: drop the UI-active virtual handle for this
    // project. Pinned PTYs in the same project will keep its ptyCount
    // above zero, so it continues syncing in the background until the
    // user kills the pin too.
    window.kari.closeProjectUi?.().catch(() => null);
    setPanes([]);
    setActivePaneId('');
    setActiveModule('project');
    void refreshProjects();
  }, [language, panes, refreshDaemon, refreshProjects, showConfirm]);

  const markCliStarted = useCallback((paneId: string, result: TerminalCreateResult) => {
    setPanes((prev) => prev.map((pane) => (
      pane.id === paneId && pane.type === 'cli'
        ? { ...pane, terminalId: result.id, title: result.title, exited: false, error: '' }
        : pane
    )));
    void refreshDaemon();
    // Bounded poll that stops once the new session appears, instead of three
    // fixed-time forced full re-scans.
    void refreshSessionsUntilNew([1200, 1800, 3000]);
  }, [refreshDaemon, refreshSessionsUntilNew]);

  const markCliExited = useCallback((paneId: string) => {
    setPanes((prev) => prev.map((pane) => (pane.id === paneId && pane.type === 'cli' ? { ...pane, exited: true } : pane)));
    void refreshDaemon();
  }, [refreshDaemon]);

  const markCliError = useCallback((paneId: string, error: string) => {
    setPanes((prev) => prev.map((pane) => (
      pane.id === paneId && pane.type === 'cli'
        ? { ...pane, terminalId: error ? pane.terminalId : undefined, exited: false, error }
        : pane
    )));
    if (error) setNotice(error);
  }, []);

  const renamePane = useCallback((paneId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setPanes((prev) => prev.map((pane) => (pane.id === paneId ? { ...pane, title: nextTitle } : pane)));
  }, []);

  const togglePaneFloating = useCallback((paneId: string, floating: boolean) => {
    setPanes((prev) => prev.map((pane) => (
      pane.id === paneId && pane.type === 'cli' ? { ...pane, floating } : pane
    )));
    setActivePaneId(paneId);
  }, []);

  const shakeFloatingPane = useCallback((paneId: string) => {
    setPanes((prev) => prev.map((pane) => (
      pane.id === paneId && pane.type === 'cli' ? { ...pane, shakeNonce: (pane.shakeNonce || 0) + 1 } : pane
    )));
  }, []);

  const newTerminal = useCallback((kind: TerminalKind, mode: TerminalMode = 'remote', resumeSessionId = '') => {
    setPanes((prev) => {
      if (kind === 'continue') {
        setNotice(translate(language, 'terminal.continueLater'));
        return prev;
      }
      if (prev.length >= 9) {
        setNotice(translate(language, 'pane.maxReached'));
        return prev;
      }
      const effectiveMode = kind === 'opencode' ? 'local' : mode;
      const title = effectiveMode === 'remote'
        ? resumeSessionId ? `remote:${kind} resume` : `remote:${kind}`
        : `${effectiveMode}:${kind}`;
      const pane: WorkspacePane = {
        id: newPaneId(),
        type: 'cli',
        title,
        kind,
        mode: effectiveMode,
        resumeSessionId
      };
      setActivePaneId(pane.id);
      return [...prev, pane];
    });
  }, [language]);

  const resumeSession = useCallback((session: SessionItem) => {
    const source = session.source.toLowerCase();
    const kind: TerminalKind | null = source.includes('codex')
      ? 'codex'
      : source.includes('claude')
        ? 'claude'
        : null;
    if (!kind) {
      setNotice(translate(language, 'session.unsupportedResume', { source: session.source }));
      return;
    }
    newTerminal(kind, 'remote', session.id);
  }, [language, newTerminal]);

  const renameSession = useCallback(async (session: SessionItem) => {
    const next = await showPrompt({
      title: translate(language, 'session.renameTitle'),
      message: translate(language, 'session.renameMessage'),
      value: session.title,
      placeholder: session.originalTitle || session.title || translate(language, 'session.renamePlaceholder'),
      confirmLabel: translate(language, 'common.save')
    });
    if (next === null) return;
    try {
      const result = await window.kari.renameSession({
        id: session.id,
        source: session.source,
        project: session.project,
        title: next
      });
      setNotice(translate(language, result.customTitle ? 'session.renamed' : 'session.renameReset'));
      await refreshSessions(true);
    } catch (err) {
      setNotice(translate(language, 'session.renameFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }, [language, refreshSessions, showPrompt]);

  const selectedFile = useMemo(() => {
    const active = panes.find((pane) => pane.id === activePaneId);
    if (active?.type === 'editor') return active.file.path;
    const lastEditor = [...panes].reverse().find((pane) => pane.type === 'editor') as Extract<WorkspacePane, { type: 'editor' }> | undefined;
    return lastEditor?.file.path || '';
  }, [activePaneId, panes]);

  const forceUploadSelected = useCallback(async () => {
    if (!selectedFile) {
      setNotice(translate(language, 'file.selectFirst'));
      return;
    }
    try {
      const result = await window.kari.forceUpload([selectedFile]);
      // B11 codex #2: IPC returns {ok, code, error} so the renderer
      // can branch on the typed code instead of regex-matching
      // error.message. For force_upload_unsupported_for_syncthing
      // (the only typed code today), surface a clearer hint pointing
      // users to the "Always sync this path" action.
      if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
        const r = result as { ok: false; code?: string; error?: string };
        if (r.code === 'force_upload_unsupported_for_syncthing') {
          setNotice(translate(language, 'file.forceUploadSyncthingUseAlwaysSync'));
        } else {
          setNotice(r.error || translate(language, 'file.forceUploadFailed'));
        }
        return;
      }
      setNotice(translate(language, 'file.forceUploadSubmitted'));
      void refreshDaemon();
      void refreshFiles();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  }, [language, refreshDaemon, refreshFiles, selectedFile]);

  const statusLine = useMemo(() => {
    if (!config) return 'loading';
    if (!config.activated) return translate(language, 'status.activationRequired');
    if (!config.workspaceRoot) return translate(language, 'status.workspaceNotSelected');
    return config.workspaceName || config.workspaceId || translate(language, 'status.workspaceReady');
  }, [config, language]);

  const showProjectWelcome = activeModule === 'project' && panes.length === 0;

  useEffect(() => {
    if (!showProjectWelcome) setSettingsOpen(false);
  }, [showProjectWelcome]);

  function newPaneId() {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `pane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  if (!config) {
    return (
      <I18nProvider language={language} setLanguage={setLanguage}>
        <div className="app-shell app-shell--plain">
          <WindowTitleBar />
          <div className="frameless-content">
            <div className="boot-screen">{translate(language, 'app.booting')}</div>
          </div>
        </div>
      </I18nProvider>
    );
  }

  if (!config.activated) {
    return (
      <I18nProvider language={language} setLanguage={setLanguage}>
        <div className="app-shell app-shell--plain">
          <WindowTitleBar />
          <div className="frameless-content">
            <ActivationPage onActivated={handleActivated} />
          </div>
        </div>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider language={language} setLanguage={setLanguage}>
      <div className={showProjectWelcome ? 'app-shell app-shell--welcome' : 'app-shell'}>
      <StatusBar
        config={config}
        daemon={daemon}
        syncthingState={syncthingState}
        statusLine={statusLine}
        onBackToProjects={returnToProjectDirectory}
        showBackToProjects={!showProjectWelcome}
        currentProject={
          // Derive a minimal "current project" context from config +
          // projects list. config.workspaceRoot is the source of truth
          // for the active workspace (always set when not on welcome).
          // Fall back to projects list for source/name metadata; tree
          // root match is the secondary key (Sidebar's same pattern).
          showProjectWelcome || !config.workspaceRoot
            ? null
            : (projects?.projects?.find((p) => p.current)
                || projects?.projects?.find((p) => (p.localPath || p.path || '').replace(/\\/g, '/').replace(/\/+$/, '') === config.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, ''))
                || {
                    name: config.workspaceName || 'workspace',
                    path: config.workspaceRoot,
                    workspaceName: config.workspaceName || 'workspace',
                    source: 'local' as const,
                    existsLocal: true,
                    current: true,
                    isGit: false,
                    modifiedAt: '',
                  } as ProjectItem)
        }
        onUploadCurrentToCloud={async (project) => {
          // Phase 4.4 (syncthing migration cleanup): kari-syncd is
          // retired, syncthing auto-syncs every change in the workspace.
          // The explicit "upload" gesture is obsolete — keep the button
          // for now (StatusBar already hides it when syncthing is
          // active) but if a stale render does click through, surface
          // a friendly notice instead of the raw `code:sync_disabled`
          // error string.
          const result = await window.kari.uploadProject(project.path, project);
          const name = project.workspaceName || project.name;
          if (result.ok) {
            showSyncNotice(translate(language, 'status.uploadSuccess').replace('{name}', name));
            void refreshFiles();
            return;
          }
          const err = (result as { error?: string; code?: string });
          if (err.code === 'sync_disabled') {
            showSyncNotice(translate(language, 'sync.autoSyncing'));
            return;
          }
          showSyncNotice(translate(language, 'status.uploadFailed').replace('{name}', name) + ': ' + (err.error || err.code || 'unknown'));
        }}
      />
      <div className={showProjectWelcome ? 'workbench workbench--welcome' : 'workbench'}>
        {showProjectWelcome ? (
          <ProjectWelcome
            config={config}
            daemon={daemon}
            projects={projectsWithPlaceholders}
            onRefreshProjects={refreshProjects}
            onSelectWorkspace={selectWorkspace}
            onOpenProject={openProject}
            onAbandonDownload={abandonDownload}
            onCloneProject={cloneProject}
            onImportFolderByDrop={importFolderByDrop}
            onUploadLocalProject={uploadLocalProject}
            onDismissDiscovered={dismissDiscoveredProject}
            pendingClicks={pendingClicks}
          />
        ) : (
          <>
            <Sidebar
              activeModule={activeModule}
              onModuleChange={setActiveModule}
              config={config}
              daemon={daemon}
              tree={tree}
              projects={projectsWithPlaceholders}
              sessions={sessions}
              runtime={runtime}
              git={git}
              capabilities={capabilities}
              models={models}
              selectedFile={selectedFile}
              projectView={projectView}
              diffSummary={diffSummary}
              diffLoading={diffLoading}
              diffLastFetchedIso={diffLastFetchedIso}
              onProjectViewChange={setProjectView}
              onRefreshDiff={refreshDiff}
              onOpenDiffFile={openFileFromDiff}
              onSelectWorkspace={selectWorkspace}
              onRefreshProjects={refreshProjects}
              onOpenProject={openProject}
              onCloneProject={cloneProject}
              onImportFolderByDrop={importFolderByDrop}
              onUploadLocalProject={uploadLocalProject}
              onDismissDiscovered={dismissDiscoveredProject}
              onImportFilesIntoTree={importFilesIntoTree}
              onRefreshFiles={refreshFiles}
              onRefreshSessions={refreshSessions}
              onRefreshGit={refreshGit}
              onRefreshSettings={refreshSettings}
              onBindDaemon={bindStartDaemon}
              onLogout={logout}
              onForceUploadSelected={forceUploadSelected}
              onReverseAction={reverseAction}
              onGitBootstrap={bootstrapGit}
              onOpenFile={openFilePath}
              onNewTerminal={newTerminal}
              onResumeSession={resumeSession}
              onRenameSession={renameSession}
            />
            <section className="workbench-main">
              <WorkspaceGrid
                panes={panes}
                activePaneId={activePaneId}
                onActivePane={setActivePaneId}
                onClosePane={closePane}
                onNewTerminal={newTerminal}
                onCliStarted={markCliStarted}
                onCliExited={markCliExited}
                onCliError={markCliError}
                onCliActivity={refreshSessionsAfterCliActivity}
                onRenamePane={renamePane}
                onTogglePaneFloating={togglePaneFloating}
                onShakeFloatingPane={shakeFloatingPane}
                onEditorChange={changeEditorPane}
                onEditorSave={saveEditorPane}
                onConfirmCloseDirtyEditor={(title) => showConfirm({
                  title: translate(language, 'dialog.unsavedTitle'),
                  message: translate(language, 'dialog.unsavedMessage', { title }),
                  confirmLabel: translate(language, 'dialog.closeDirty'),
                  tone: 'danger'
                })}
              />
            </section>
          </>
        )}
      </div>
      {showProjectWelcome && (
        <button className="floating-settings-button" type="button" onClick={() => setSettingsOpen(true)} title={translate(language, 'settings.title')}>
          <SettingsIcon size={20} />
        </button>
      )}
      {toast && (
        <button
          className={toast.closing ? 'sync-toast sync-toast--closing' : 'sync-toast'}
          type="button"
          onClick={() => setToast(null)}
          title={translate(language, 'common.close')}
        >
          <span className="sync-toast__dot" />
          <span>{toast.message}</span>
        </button>
      )}
      <AppSettingsModal
        open={settingsOpen}
        config={config}
        daemon={daemon}
        runtime={runtime}
        capabilities={capabilities}
        models={models}
        storage={storageSummary}
        projects={projects?.projects || []}
        onClose={() => setSettingsOpen(false)}
        onRefreshSettings={refreshSettings}
        onBindDaemon={bindStartDaemon}
        onSelectStorageBaseDir={selectStorageBaseDir}
        onRefreshProjects={refreshProjects}
        onDeleteLocalProject={deleteLocalProjectFromSettings}
        onDeleteCloudProject={deleteCloudProjectFromSettings}
        onReverseAction={reverseAction}
        onLogout={logout}
      />
      <AppDialog dialog={dialog} onClose={() => setDialog(null)} />
      </div>
    </I18nProvider>
  );
}

interface ProjectWelcomeProps {
  config: SavedConfig;
  daemon: DaemonStatus;
  projects: ProjectListResult | null;
  onRefreshProjects: () => void;
  onSelectWorkspace: () => void;
  onOpenProject: (path: string, project?: ProjectItem) => void;
  // Cancel an in-flight or stuck download on a cloud project that
  // hasn't been confirmed downloaded yet (existsLocal !== true).
  onAbandonDownload: (project: ProjectItem) => void;
  onCloneProject: (gitUrl: string) => void;
  // Drag-folder-into-welcome handler. Same outcome as
  // onSelectWorkspace's import branch but driven by a Finder/Explorer
  // drop instead of the native file picker.
  onImportFolderByDrop: (folderPaths: string[]) => void;
  // Upload a local-only / discovered project into the import-upload
  // queue (the "上传" affordance on a local-only card).
  onUploadLocalProject: (project: ProjectItem) => void | Promise<void>;
  // Dismiss a discovered (untagged) orphan from the list without
  // deleting it on disk (the "忽略" affordance on a discovered card).
  onDismissDiscovered: (project: ProjectItem) => void | Promise<void>;
  // Project paths whose click handlers are currently mid-IPC. Used
  // to render the in-flight shimmer the moment the user clicks,
  // before main's cache phase update reaches the renderer.
  pendingClicks: Set<string>;
}

function AppDialog({ dialog, onClose }: { dialog: AppDialogState | null; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (dialog?.kind === 'prompt') setValue(dialog.value);
    if (dialog?.kind === 'credentials') {
      setUsername('');
      setPassword('');
    }
  }, [dialog?.id, dialog?.kind]);

  if (!dialog) return null;

  const cancel = () => {
    if (dialog.kind === 'prompt') dialog.resolve(null);
    else if (dialog.kind === 'credentials') dialog.resolve(null);
    else dialog.resolve(false);
    onClose();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dialog.kind === 'prompt') dialog.resolve(value);
    else if (dialog.kind === 'credentials') dialog.resolve({ username: username.trim(), password });
    else dialog.resolve(true);
    onClose();
  };
  const Icon = dialog.kind === 'confirm' && dialog.tone === 'danger' ? AlertTriangle : MessageSquare;

  return (
    <div className="app-dialog-backdrop" role="presentation" onMouseDown={cancel}>
      <form className={dialog.kind === 'confirm' && dialog.tone === 'danger' ? 'app-dialog app-dialog--danger' : 'app-dialog'} role="dialog" aria-modal="true" aria-label={dialog.title} onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="app-dialog__icon">
          <Icon size={18} />
        </div>
        <div className="app-dialog__content">
          <strong>{dialog.title}</strong>
          <p>{dialog.message}</p>
          {dialog.kind === 'prompt' && (
            <input
              autoFocus
              value={value}
              placeholder={dialog.placeholder}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          )}
          {dialog.kind === 'credentials' && (
            <div className="app-dialog__fields">
              <label className="app-dialog__field">
                <span>{dialog.usernameLabel}</span>
                <input
                  autoFocus
                  value={username}
                  placeholder={dialog.usernamePlaceholder}
                  autoComplete="username"
                  onChange={(event) => setUsername(event.currentTarget.value)}
                />
              </label>
              <label className="app-dialog__field">
                <span>{dialog.passwordLabel}</span>
                <input
                  type="password"
                  value={password}
                  placeholder={dialog.passwordPlaceholder}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
              </label>
            </div>
          )}
        </div>
        <div className="app-dialog__actions">
          <button className="app-dialog__secondary" type="button" onClick={cancel}>{dialog.cancelLabel}</button>
          <button className="app-dialog__primary" type="submit">{dialog.confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

function ProjectWelcome({ config, daemon, projects, onRefreshProjects, onSelectWorkspace, onOpenProject, onAbandonDownload, onCloneProject, onImportFolderByDrop, onUploadLocalProject, onDismissDiscovered, pendingClicks }: ProjectWelcomeProps) {
  const { t } = useI18n();
  const [gitUrl, setGitUrl] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [cloudLoadingHold, setCloudLoadingHold] = useState(false);
  const cloudLoadingStartedAtRef = useRef<number | null>(null);
  const projectItems = projects?.projects || [];
  const projectsLoading = projects === null;
  // Importing placeholders use the __importing__ synthetic path prefix
  // (see App.makeImportingPlaceholder). Their presence means the user
  // just dropped something and is waiting to see the new card show
  // up. Don't let the "loading cloud projects" splash screen swallow
  // them — without this gate the LUNAR_SYNC_MIN_VISIBLE_MS sticky hold
  // keeps the loading screen up for ~750ms after projects finish
  // loading, and any drop that lands inside that window has its
  // placeholder hidden behind CloudProjectLoading.
  const hasImportingPlaceholder = projectItems.some((p) => p.path?.startsWith('__importing__'));
  const cloudSyncLoading = projectItems.length === 0 && (projectsLoading || daemon.transferCount > 0);
  const showCloudSyncLoading = (cloudSyncLoading || cloudLoadingHold) && !hasImportingPlaceholder;
  const projectRoot = projects?.workspaceId || config.workspaceId || t('welcome.projectRootFallback');
  // Count openable projects via connectionState. Covers syncthing
  // Branch A mirrors where existsLocal=false yet openable=true.
  const syncedCount = projectItems.filter(
    (project) => project.connectionState?.openable === true
  ).length;

  useEffect(() => {
    if (cloudSyncLoading) {
      cloudLoadingStartedAtRef.current = Date.now();
      setCloudLoadingHold(true);
      return;
    }
    if (!cloudLoadingHold) return;
    const startedAt = cloudLoadingStartedAtRef.current ?? Date.now();
    const remaining = Math.max(0, LUNAR_SYNC_MIN_VISIBLE_MS - (Date.now() - startedAt));
    const timer = window.setTimeout(() => {
      cloudLoadingStartedAtRef.current = null;
      setCloudLoadingHold(false);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [cloudSyncLoading, cloudLoadingHold]);

  const submitClone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextURL = gitUrl.trim();
    if (!nextURL) return;
    onCloneProject(nextURL);
    setGitUrl('');
  };

  // Drag-folder-onto-welcome: forward every dropped path. Main owns the
  // durable FIFO queue, so multiple project drops are processed in
  // order even if the app is restarted.
  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const paths = droppedFilePaths(event.dataTransfer?.files || [], window.kari.pathForFile);
    if (paths.length) onImportFolderByDrop(paths);
  };
  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };
  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    // Only clear when the drag truly leaves the panel — dragleave
    // also fires when crossing into child elements; relatedTarget
    // tells us where it went.
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setIsDragOver(false);
  };

  return (
    <main
      className={isDragOver ? 'project-welcome project-welcome--drop-target' : 'project-welcome'}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <section className="welcome-hero">
        <div className="welcome-hero__copy">
          <div className="welcome-eyebrow">
            <Sparkles size={14} />
            <span>{t('welcome.eyebrow')}</span>
          </div>
          <h1>{t('welcome.title')}</h1>
          <p>{t('welcome.description')}</p>
          <div className="welcome-path" title={projectRoot}>{projectRoot}</div>
        </div>
        <form className="welcome-clone" onSubmit={submitClone}>
          <label htmlFor="welcome-git-url">{t('welcome.gitClone')}</label>
          <div className="welcome-clone__row">
            <input
              id="welcome-git-url"
              value={gitUrl}
              onChange={(event) => setGitUrl(event.currentTarget.value)}
              placeholder="https://github.com/org/repo.git"
            />
            <button type="submit">
              <GitBranch size={15} />
              <span>{t('common.clone')}</span>
            </button>
          </div>
          <button className="welcome-secondary-action" type="button" onClick={onSelectWorkspace}>
            <FolderOpen size={15} />
            <span>{t('welcome.pickLocalProject')}</span>
          </button>
        </form>
      </section>

      <section className="welcome-projects">
        <div className="welcome-projects__head">
          <div>
            <strong>{t('welcome.projectsTitle')}</strong>
            <span>{showCloudSyncLoading ? t('welcome.projectsLoadingSummary') : projectItems.length ? t('welcome.projectsSummary', { total: projectItems.length, synced: syncedCount }) : t('welcome.projectsEmptySummary')}</span>
          </div>
          <button className="welcome-refresh" type="button" onClick={onRefreshProjects}>
            <RefreshCw size={14} />
            <span>{t('common.refresh')}</span>
          </button>
        </div>
        {projects?.cloudError && <div className="warning-line">{t('welcome.cloudError', { error: projects.cloudError })}</div>}
        {showCloudSyncLoading ? (
          <CloudProjectLoading />
        ) : projectItems.length === 0 ? (
          <div className="welcome-empty">
            <FolderOpen size={24} />
            <strong>{t('welcome.emptyTitle')}</strong>
            <span>{t('welcome.emptyDesc')}</span>
            <button className="welcome-secondary-action" type="button" onClick={onSelectWorkspace}>
              <FolderOpen size={14} />
              <span>{t('welcome.chooseDirectory')}</span>
            </button>
          </div>
        ) : (
          <div className="welcome-project-grid">
            {projectItems.map((project) => (
              <WelcomeProjectCard
                key={project.workspaceName || project.name || project.path}
                project={project}
                onOpenProject={onOpenProject}
                onAbandonDownload={onAbandonDownload}
                onUploadLocalProject={onUploadLocalProject}
                onDismissDiscovered={onDismissDiscovered}
                pending={pendingClicks.has(project.path)}
              />
            ))}
          </div>
        )}
      </section>
      <footer className="welcome-footer">
        <span>v{APP_VERSION}</span>
        <span>{APP_COPYRIGHT}</span>
      </footer>
    </main>
  );
}

function CloudProjectLoading() {
  const { t } = useI18n();
  return (
    <div className="welcome-empty welcome-empty--cloud-loading" aria-live="polite" aria-busy="true">
      <div className="lunar-sync-loader" aria-hidden="true">
        <div className="lunar-sync-loader__orbit">
          <div className="lunar-sync-loader__moon" />
          <div className="lunar-sync-loader__shadow" />
        </div>
      </div>
      <strong>{t('welcome.cloudSyncLoadingTitle')}</strong>
      <span>{t('welcome.cloudSyncLoadingDesc')}</span>
      <div className="lunar-sync-loader__diamonds" aria-hidden="true">
        {Array.from({ length: 20 }, (_, index) => (
          <i key={index} style={{ animationDelay: `${index * 58}ms` }} />
        ))}
      </div>
    </div>
  );
}

function WelcomeProjectCard({
  project,
  onOpenProject,
  onAbandonDownload,
  onUploadLocalProject,
  onDismissDiscovered,
  pending,
}: {
  project: ProjectItem;
  onOpenProject: (path: string, project?: ProjectItem) => void;
  onAbandonDownload: (project: ProjectItem) => void;
  onUploadLocalProject: (project: ProjectItem) => void | Promise<void>;
  onDismissDiscovered: (project: ProjectItem) => void | Promise<void>;
  pending: boolean;
}) {
  const { t } = useI18n();
  // Local "cancel-in-flight" state so the ✕ button shows a spinning
  // icon + becomes unclickable while abandonDownload's await is in
  // flight. Prevents double-clicks and gives the user feedback that
  // the click registered (without this, the button looks dead because
  // abandonDownload's daemon roundtrip takes 1-2s and the card UI
  // doesn't change until refreshProjects runs).
  const [cancelling, setCancelling] = useState(false);
  // Same idea for the "上传" affordance on a local-only card: disable +
  // spin the moment it's clicked so the user can't double-enqueue
  // before refreshProjects flips the card into the syncing state.
  const [uploading, setUploading] = useState(false);
  // Syncthing-native Phase 1c2: read connectionState (main.cjs
  // computes it via project_connection_state.cjs mapper). All card
  // decisions derive from this state model; legacy project.sync /
  // project.existsLocal reads are limited to the defensive fallbacks
  // inside the guard helpers (isCloudOnlyNotDownloaded etc.) for the
  // brief transition window before this commit lands everywhere.
  const state = project.connectionState;
  const cloudPending = isCloudOnlyNotDownloaded(project);
  const downloadActive = isCloudDownloadActive(project);
  const openable = state?.openable === true;
  const provisioning = state?.availability === 'provisioning';
  const syncStateKind = state?.syncState ?? 'idle';
  // retry (↻) appears on a provisioning row whose latest result was
  // paused (user cancelled, partial kept) or error (daemon-reported
  // failure). cancel (✕) appears while provisioning is actively in
  // flight (syncing / scanning). The two never coexist.
  const retryAvailable = provisioning && (syncStateKind === 'paused' || syncStateKind === 'error');
  const cancelAvailable = provisioning && !retryAvailable;
  // "上传" (↑) appears on a local-only card — a discovered orphan the
  // user dropped into kari-drive, or any unpublished local project —
  // ONLY in settled states (idle/paused/error). An allowlist (not a
  // !=='syncing' denylist) is deliberate: while an import is in flight
  // the projectsWithPlaceholders overlay flips this card's syncState to
  // queued/migrating/uploading/running/scanning, none of which are in
  // the allowlist, so the button hides and can't re-enqueue. (The queue
  // store also dedupes by source path as the durable backstop.) paused/
  // error stay eligible so a failed upload can be retried. Never
  // coexists with retry/cancel — those are provisioning-only.
  // Single-tenant OSS: there is no "upload to cloud" action — opening a
  // project auto-pairs it with the server (Syncthing). The publish/upload
  // affordance is a cloud-model artifact, so it is never shown.
  const uploadAvailable = false
    && state?.availability === 'local_only'
    && (syncStateKind === 'idle' || syncStateKind === 'paused' || syncStateKind === 'error');
  // "忽略" (eye-off) appears only on a discovered (untagged) orphan, so
  // the user can hide a folder they don't want synced without deleting
  // it. Owned/uploaded local projects are never `discovered`, so they
  // never offer dismiss.
  const dismissAvailable = project.discovered === true;
  // CSS continuity: preserve the existing --phase-<phase>::after
  // shimmer rules by mapping the connectionState back to a CSS-key.
  // 'attaching' → downloading shimmer; 'publishing' → uploading
  // shimmer; otherwise syncState verbatim. Phase 1d will rework the
  // CSS to use --sync-<state> directly and drop this shim.
  const phaseClassName =
    state?.connectionIntent === 'attaching'
      ? 'downloading'
      : state?.connectionIntent === 'publishing'
        ? 'uploading'
        : syncStateKind;
  // availability='connected' = bound to cloud AND has a local mirror.
  // Highlighted with a dark-gold ring so it's instantly distinguishable
  // from cloud-only (no local) and local-only (not published) cards.
  const dualSynced = state?.availability === 'connected';
  const className = [
    'welcome-project-card',
    openable ? 'welcome-project-card--local' : '',
    cloudPending ? 'welcome-project-card--cloud-pending' : '',
    downloadActive ? 'welcome-project-card--downloading' : '',
    dualSynced ? 'welcome-project-card--dual-synced' : '',
    pending ? 'welcome-project-card--pending' : '',
    `welcome-project-card--phase-${phaseClassName}`,
  ].filter(Boolean).join(' ');
  const baseTitle = cloudPending
    ? t('project.downloadTitle', { path: project.remoteWorkdir || project.path })
    : project.path;
  // Surface lastError on card hover even when the chip is suppressed
  // (cloud_only Branch B = syncthing feed unavailable: chip is hidden
  // per plan §B but the user still needs to know the build doesn't
  // surface Syncthing state). Codex round 7 P2 pin.
  const titleText = state?.lastError
    ? `${baseTitle} — ${localizeI18nKeyOrPassthrough(t, state.lastError)}`
    : baseTitle;
  return (
    <button
      className={className}
      type="button"
      onClick={() => onOpenProject(project.path, project)}
      title={titleText}
    >
      <ProjectStateBadge project={project} />
      <span className="welcome-project-card__icon">
        {openable ? <HardDrive size={16} /> : project.source === 'cloud' ? <Cloud size={16} /> : project.isGit ? <GitBranch size={16} /> : <FolderOpen size={16} />}
      </span>
      <span className="welcome-project-card__body">
        <strong>{project.name}</strong>
        <small>{openable ? state?.localPath || project.localPath || project.path : project.remoteWorkdir || project.path}</small>
        <ProjectPhaseChip state={state} />
      </span>
      <span className="welcome-project-card__progress">
        <ProjectSyncDiamondProgress project={project} />
      </span>
      {uploadAvailable && (
        <span
          className={uploading
            ? 'welcome-project-card__action welcome-project-card__action--upload welcome-project-card__action--uploading'
            : 'welcome-project-card__action welcome-project-card__action--upload'}
          role="button"
          tabIndex={uploading ? -1 : 0}
          aria-disabled={uploading}
          title={uploading ? t('project.uploadInFlight') : t('project.uploadTitle')}
          aria-label={uploading ? t('project.uploadInFlight') : t('project.uploadLabel')}
          onClick={(ev) => {
            ev.stopPropagation();
            if (uploading) return;
            setUploading(true);
            // No await on the parent handler — refreshProjects there
            // flips the card into syncing (button hides). Coarse timeout
            // resets the spinner if the entry lingers in local_only
            // (e.g. enqueue failed and surfaced a notice).
            Promise.resolve(onUploadLocalProject(project)).finally(() => {
              window.setTimeout(() => setUploading(false), 8000);
            });
          }}
          onKeyDown={(ev) => {
            if ((ev.key === 'Enter' || ev.key === ' ') && !uploading) {
              ev.stopPropagation();
              ev.preventDefault();
              setUploading(true);
              Promise.resolve(onUploadLocalProject(project)).finally(() => {
                window.setTimeout(() => setUploading(false), 8000);
              });
            }
          }}
        >
          {uploading ? <RefreshCw size={13} className="is-spinning" aria-hidden="true" /> : <UploadCloud size={13} aria-hidden="true" />}
        </span>
      )}
      {dismissAvailable && (
        <span
          className="welcome-project-card__action welcome-project-card__action--dismiss"
          role="button"
          tabIndex={0}
          title={t('project.dismissTitle')}
          aria-label={t('project.dismissLabel')}
          onClick={(ev) => { ev.stopPropagation(); void onDismissDiscovered(project); }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.stopPropagation();
              ev.preventDefault();
              void onDismissDiscovered(project);
            }
          }}
        >
          <EyeOff size={13} aria-hidden="true" />
        </span>
      )}
      {retryAvailable && (
        <span
          className="welcome-project-card__action welcome-project-card__action--retry"
          role="button"
          tabIndex={0}
          title={t('project.retryTitle')}
          onClick={(ev) => {
            ev.stopPropagation();
            onOpenProject(project.path, project);
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.stopPropagation();
              ev.preventDefault();
              onOpenProject(project.path, project);
            }
          }}
          aria-label={t('project.retryLabel')}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </span>
      )}
      {cancelAvailable && (
        <span
          className={cancelling
            ? 'welcome-project-card__action welcome-project-card__action--abandon welcome-project-card__action--cancelling'
            : 'welcome-project-card__action welcome-project-card__action--abandon'}
          role="button"
          tabIndex={cancelling ? -1 : 0}
          aria-disabled={cancelling}
          title={cancelling ? t('project.abandonInFlight') : t('project.abandonTitle')}
          onClick={(ev) => {
            ev.stopPropagation();
            if (cancelling) return;
            setCancelling(true);
            // No await — onAbandonDownload returns a promise (it's
            // useCallback async in App), but UI feedback should reset
            // when the parent's refreshProjects flips the card out of
            // the active-download state. Use a coarse timeout as a
            // safety net so the spinner doesn't get stuck if the
            // project entry disappears before phase change. 8s covers
            // the 5s daemon-cancel timeout + 1-2 polls.
            Promise.resolve(onAbandonDownload(project)).finally(() => {
              window.setTimeout(() => setCancelling(false), 8000);
            });
          }}
          onKeyDown={(ev) => {
            if ((ev.key === 'Enter' || ev.key === ' ') && !cancelling) {
              ev.stopPropagation();
              ev.preventDefault();
              setCancelling(true);
              Promise.resolve(onAbandonDownload(project)).finally(() => {
                window.setTimeout(() => setCancelling(false), 8000);
              });
            }
          }}
          aria-label={cancelling ? t('project.abandonInFlight') : t('project.abandonLabel')}
        >
          {cancelling ? <RefreshCw size={13} className="is-spinning" aria-hidden="true" /> : '✕'}
        </span>
      )}
    </button>
  );
}

// PR2 Phase 1 commit 6: small phase indicator chip rendered inside
// each card body. The 8 phases map to (text, modifier-class) for CSS
// styling. Idle phase renders nothing (most common state; clutter
// reduction). Failed/blocked phases additionally surface the error
// string as a hover title so power users can diagnose without
// opening the notice.
// Tries to localize a string as if it were an i18n key (e.g.
// 'state.syncthing.feed_unavailable'); falls back to the raw string
// when the key isn't registered. Used for ProjectConnectionState
// lastError surfacing — the mapper emits known structured codes for
// internal errors and raw daemon strings for runtime errors, and
// the renderer wants both to render gracefully.
function localizeI18nKeyOrPassthrough(t: (k: I18nKey) => string, message: string): string {
  if (!message) return message;
  // Cast through unknown to satisfy the strict I18nKey union — the
  // identity-on-miss behavior of t() is what makes this safe at
  // runtime even when the key isn't actually registered.
  const localized = t(message as unknown as I18nKey);
  return localized === message ? message : localized;
}

// Syncthing-native Phase 1c1: chip reads ProjectConnectionState only.
// connectionIntent ('attaching' / 'publishing') overrides syncState
// for the visible text — the user wants to see what action is in
// flight, not the underlying sync mechanic. Completion appended for
// progress-bearing states.
function ProjectPhaseChip({ state }: { state: ProjectConnectionState | undefined }) {
  const { t } = useI18n();
  if (!state) return null;
  // No chip for cloud_only: card has its own "attach" affordance,
  // and per plan §B syncState defaults to idle for cloud_only.
  // For all other availabilities, chip is suppressed ONLY when the
  // row is fully idle (no sync activity and no in-flight intent) —
  // an active or failed publish on a local_only row must still
  // surface its chip even though the row is "openable" (codex
  // round 6 P2 pin).
  if (state.availability === 'cloud_only') return null;
  if (state.syncState === 'idle' && state.connectionIntent === null) return null;

  let visible: string;
  if (state.connectionIntent === 'attaching') {
    visible = t('state.intent.attaching');
  } else if (state.connectionIntent === 'publishing') {
    visible = t('state.intent.publishing');
  } else {
    visible = t(`state.sync.${state.syncState}` as I18nKey);
  }

  // Append rounded completion when meaningful — provisioning /
  // active sync show useful progress numbers; idle hides them since
  // it's 100 by definition.
  const showCompletion =
    typeof state.completion === 'number' &&
    (state.syncState === 'syncing' ||
      state.syncState === 'scanning' ||
      state.syncState === 'paused' ||
      state.syncState === 'error');
  if (showCompletion) {
    visible = `${visible} · ${Math.round(state.completion as number)}%`;
  }

  // Tooltip: localized lastError if available; otherwise visible text.
  let tip = visible;
  if (state.lastError) {
    tip = `${visible} — ${localizeI18nKeyOrPassthrough(t, state.lastError)}`;
  }

  return (
    <span
      className={`welcome-project-card__phase-chip welcome-project-card__phase-chip--${state.syncState}`}
      title={tip}
    >
      {visible}
    </span>
  );
}

// Syncthing-native Phase 1c1: badge derived from connectionState.
// availability=local_only → local-only badge
// availability=connected → synced badge (locally bound + openable)
// availability=cloud_only / provisioning → cloud badge (not openable)
function ProjectStateBadge({ project }: { project: ProjectItem }) {
  const a = project.connectionState?.availability;
  if (a === 'local_only') return <LocalProjectBadge />;
  if (a === 'connected') return <SyncedProjectBadge />;
  // Includes cloud_only, provisioning, and any defensively-missing
  // connectionState (fall back to cloud icon — least misleading).
  return <CloudProjectBadge />;
}

// Phase 1d1: guards consume only connectionState. listProjects
// guarantees population; defensive null returns when absent rather
// than fanning back into legacy phase logic.
function isPureLocalProject(project: ProjectItem) {
  return project.connectionState?.availability === 'local_only';
}

function isCloudOnlyNotDownloaded(project: ProjectItem): boolean {
  // Fail-closed when connectionState absent (treat as cloud_only).
  if (!project.connectionState) return project.source === 'cloud';
  return project.connectionState.availability === 'cloud_only';
}

// isCloudDownloadActive: first-time attach in flight (attaching
// intent OR active provisioning sync). Used by WelcomeProjectCard
// to show the ✕ cancel affordance and by openProject to toast
// "already downloading" instead of re-POSTing.
function isCloudDownloadActive(project: ProjectItem): boolean {
  const state = project.connectionState;
  if (!state) return false;
  return (
    state.connectionIntent === 'attaching' ||
    (state.availability === 'provisioning' &&
      (state.syncState === 'syncing' || state.syncState === 'scanning'))
  );
}

function LocalProjectBadge() {
  const { t } = useI18n();
  return (
    <span className="welcome-project-card__state-badge welcome-project-card__state-badge--local" title={t('project.localBadgeTitle')} aria-label={t('project.localBadgeLabel')}>
      <HardDrive size={13} aria-hidden="true" />
    </span>
  );
}

function SyncedProjectBadge() {
  const { t } = useI18n();
  return (
    <span className="welcome-project-card__state-badge welcome-project-card__state-badge--synced" title={t('project.syncedBadgeTitle')} aria-label={t('project.syncedBadgeLabel')}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.25" y="3.25" width="11.5" height="7.5" rx="1.35" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6.25 13.25h3.5M8 10.75v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M5.25 7.15 7.1 9l3.65-4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function CloudProjectBadge() {
  const { t } = useI18n();
  // PR2 Phase 1 commit 5 round-fix: cloud-only-not-downloaded badge.
  // Title text shifts from descriptive "云端项目" to action-oriented
  // "点击下载到本机" so users understand the primary card click runs
  // the download flow, not an open-in-Files flow.
  return (
    <span className="welcome-project-card__state-badge welcome-project-card__state-badge--cloud" title={t('project.cloudBadgeTitle')} aria-label={t('project.cloudBadgeLabel')}>
      <Cloud size={13} aria-hidden="true" />
    </span>
  );
}

export default App;
