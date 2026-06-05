import {
  Clock3,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  HardDrive,
  History,
  Pencil,
  Play,
  RefreshCw,
  UploadCloud,
} from 'lucide-react';
import { useState, type DragEvent as ReactDragEvent, type Dispatch, type FormEvent, type MouseEvent as ReactMouseEvent, type SetStateAction, type SyntheticEvent as ReactSyntheticEvent } from 'react';
import type {
  DaemonStatus,
  FileNode,
  FileTreeResult,
  GitSummary,
  GitDiffSummary,
  GitDiffFileStatus,
  ProjectItem,
  ProjectListResult,
  RuntimeStatus,
  SavedConfig,
  SessionItem,
  SidebarModule,
  TerminalKind,
  TerminalMode
} from '../../shared/types';
import { droppedFilePaths } from '../../shared/drop_paths.mjs';
import { beginInternalFileDrag, endInternalFileDrag } from '../internalFileDrag';
import { useI18n, type I18nKey } from '../i18n';
import { formatFetchTime } from '../diffView';
import { reverseActionBlockedReason, reverseReadinessMessage, type ReverseAction } from '../reverseProxy';
import { ProjectSyncDiamondProgress, projectSyncDirection, projectSyncLabel } from './SyncDiamondProgress';
import {
  ConfirmReplaceDialog,
  FileContextMenu,
  SyncDispositionIcon,
  augmentNode,
  useFilePathActionRunner,
  useLazyChildrenAugment,
  type NodeAugment,
} from './FileTreeSyncVisibility';

interface SidebarProps {
  activeModule: SidebarModule;
  onModuleChange: (module: SidebarModule) => void;
  config: SavedConfig;
  daemon: DaemonStatus;
  tree: FileTreeResult | null;
  projects: ProjectListResult | null;
  sessions: SessionItem[];
  runtime: RuntimeStatus | null;
  git: GitSummary | null;
  capabilities: unknown;
  models: unknown;
  selectedFile: string;
  projectView: 'files' | 'changes';
  diffSummary: GitDiffSummary | null;
  diffLoading: boolean;
  diffLastFetchedIso: string | null;
  onProjectViewChange: (view: 'files' | 'changes') => void;
  onRefreshDiff: () => void;
  onOpenDiffFile: (path: string) => void;
  onSelectWorkspace: () => void;
  onRefreshProjects: () => void;
  onOpenProject: (path: string, project?: ProjectItem) => void;
  onCloneProject: (gitUrl: string) => void;
  // Drag-folder-into-sidebar handler. The sidebar's project list
  // accepts Finder/Explorer folder drops and forwards every path so
  // main can queue them in order.
  onImportFolderByDrop: (folderPaths: string[]) => void;
  // Upload a local-only / discovered project into the import-upload
  // queue (the "上传" affordance on a local-only sidebar row).
  onUploadLocalProject: (project: ProjectItem) => void | Promise<void>;
  // Dismiss a discovered (untagged) orphan from the list without
  // deleting it on disk (the "忽略" affordance on a discovered row).
  onDismissDiscovered: (project: ProjectItem) => void | Promise<void>;
  // Drag-files-into-file-tree handler. Drops on the tree root land
  // at the workspace root; drops on a directory node land at that
  // directory's absolute path. Files and folders both pass through
  // — main does fs.cp recursive.
  onImportFilesIntoTree: (destAbsDir: string, sourcePaths: string[]) => void;
  onRefreshFiles: () => void;
  onRefreshSessions: () => void;
  onRefreshGit: () => void;
  onRefreshSettings: () => void;
  onBindDaemon: () => void;
  onLogout: () => void;
  onForceUploadSelected: () => void;
  onReverseAction: (action: ReverseAction) => void;
  onGitBootstrap: (gitUrl: string) => void;
  onOpenFile: (path: string) => void;
  onNewTerminal: (kind: TerminalKind, mode?: TerminalMode, resumeSessionId?: string) => void;
  onResumeSession: (session: SessionItem) => void;
  onRenameSession: (session: SessionItem) => void;
}

const moduleDefs: Array<{ id: SidebarModule; labelKey: I18nKey; icon: typeof FolderOpen }> = [
  { id: 'files', labelKey: 'sidebar.files', icon: HardDrive },
  { id: 'sessions', labelKey: 'sidebar.sessions', icon: History }
];

export function Sidebar(props: SidebarProps) {
  const { t } = useI18n();
  const modules = moduleDefs.map((module) => ({ ...module, label: t(module.labelKey) }));
  const activeModule = modules.some((m) => m.id === props.activeModule) ? props.activeModule : 'files';
  const activeModuleMeta = modules.find((m) => m.id === activeModule);
  const Active = activeModuleMeta?.icon || FolderOpen;
  const showModuleHeading = activeModule !== 'files' && activeModule !== 'sessions';
  return (
    <aside className="sidebar">
      <nav className="module-nav">
        {modules.map((module) => {
          const Icon = module.icon;
          return (
            <button
              key={module.id}
              className={activeModule === module.id ? 'module-button module-button--active' : 'module-button'}
              onClick={() => props.onModuleChange(module.id)}
              title={module.label}
            >
              <Icon size={17} />
              <span>{module.label}</span>
            </button>
          );
        })}
      </nav>
      <section className={showModuleHeading ? 'module-panel' : 'module-panel module-panel--flush'}>
        {showModuleHeading && (
          <div className="module-heading">
            <Active size={17} />
            <span>{modules.find((m) => m.id === activeModule)?.label}</span>
          </div>
        )}
        {renderModule({ ...props, activeModule })}
      </section>
    </aside>
  );
}

function renderModule(props: SidebarProps) {
  switch (props.activeModule) {
    case 'project':
      return <ProjectModule {...props} />;
    case 'files':
      return <FilesModule {...props} />;
    case 'sessions':
      return <SessionsModule {...props} />;
    case 'remote':
      return <RemoteModule {...props} />;
    case 'settings':
      return <SettingsModule {...props} />;
    case 'git':
      return <GitModule {...props} />;
  }
}

function ProjectModule({ config, projects, onSelectWorkspace, onRefreshProjects, onOpenProject, onCloneProject, onImportFolderByDrop, onUploadLocalProject, onDismissDiscovered }: SidebarProps) {
  const { t } = useI18n();
  const [dropTarget, setDropTarget] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const gitUrl = String(data.get('gitUrl') || '').trim();
    if (!gitUrl) return;
    onCloneProject(gitUrl);
    event.currentTarget.reset();
  };

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropTarget(false);
    const paths = allDroppedPaths(event);
    if (paths.length) onImportFolderByDrop(paths);
  };

  return (
    <div
      className={dropTarget ? 'project-module project-module--drop-target' : 'project-module'}
      onDrop={handleDrop}
      onDragOver={(e) => acceptFileDrag(e) && setDropTarget(true)}
      onDragLeave={(e) => leaveDrag(e) && setDropTarget(false)}
    >
      <section className="project-section">
        <div className="project-section__head">
          <strong>{t('sidebar.newProject')}</strong>
          <span>git clone</span>
        </div>
        <form className="inline-form" onSubmit={submit}>
          <input name="gitUrl" placeholder="https://github.com/org/repo.git" />
          <button>
            <GitBranch size={13} />
            {t('common.clone')}
          </button>
        </form>
        <button className="mini-action" type="button" onClick={onSelectWorkspace}>
          <FolderOpen size={13} />
          <span>{t('sidebar.pickLocalProject')}</span>
        </button>
      </section>

      <section className="project-section project-section--grow">
        <div className="project-section__head">
          <strong>{t('sidebar.openProject')}</strong>
          <button className="icon-mini" type="button" onClick={onRefreshProjects} title={t('sidebar.refreshProjects')}>
            <RefreshCw size={13} />
          </button>
        </div>
        <KV label={t('sidebar.cloudSpace')} value={projects?.workspaceId || config.workspaceId || 'Kari storage'} />
        {projects?.cloudError && <div className="warning-line">{t('sidebar.cloudListError', { error: projects.cloudError })}</div>}
        <div className="project-list">
          {!projects || projects.projects.length === 0 ? (
            <div className="empty-state">{t('sidebar.emptyProjects')}</div>
          ) : (
            projects.projects.map((project) => (
              <ProjectRow key={project.workspaceName || project.name || project.path} project={project} onOpenProject={onOpenProject} onUploadLocalProject={onUploadLocalProject} onDismissDiscovered={onDismissDiscovered} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

// Shared drop helpers. dataTransfer.types includes "Files" when the
// drag originated from the OS (Finder / Explorer). dropEffect=copy
// gives the user the "+" cursor so the intent is clear.
function acceptFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
  if (!event.dataTransfer) return false;
  const types = Array.from(event.dataTransfer.types);
  if (!types.includes('Files')) return false;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  return true;
}

// dragleave fires when crossing into nested children too — guard by
// asking whether relatedTarget (the new hover element) is still
// inside us. Only true leave clears the highlight.
function leaveDrag(event: ReactDragEvent<HTMLElement>): boolean {
  const next = event.relatedTarget as Node | null;
  if (next && event.currentTarget.contains(next)) return false;
  return true;
}

function firstDroppedPath(event: ReactDragEvent<HTMLElement>): string {
  return droppedFilePaths(event.dataTransfer?.files || [], window.kari.pathForFile)[0] || '';
}

function allDroppedPaths(event: ReactDragEvent<HTMLElement>): string[] {
  return droppedFilePaths(event.dataTransfer?.files || [], window.kari.pathForFile);
}

function ProjectRow({ project, onOpenProject, onUploadLocalProject, onDismissDiscovered }: { project: ProjectItem; onOpenProject: (path: string, project?: ProjectItem) => void; onUploadLocalProject: (project: ProjectItem) => void | Promise<void>; onDismissDiscovered: (project: ProjectItem) => void | Promise<void> }) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);
  const dismissAvailable = project.discovered === true;
  // Openable derived from connectionState. listProjects always
  // populates it; defensive false return if absent.
  const openable = project.connectionState?.openable === true;
  // "上传" on a local-only sidebar row — mirrors the welcome card's
  // affordance so a discovered orphan is uploadable once the user is
  // past the welcome screen too. Same settled-state allowlist; the
  // queue store dedupes by path as the durable backstop.
  const syncStateKind = project.connectionState?.syncState ?? 'idle';
  const uploadAvailable =
    project.connectionState?.availability === 'local_only'
    && (syncStateKind === 'idle' || syncStateKind === 'paused' || syncStateKind === 'error');
  const triggerUpload = () => {
    if (uploading) return;
    setUploading(true);
    Promise.resolve(onUploadLocalProject(project)).finally(() => {
      window.setTimeout(() => setUploading(false), 8000);
    });
  };
  return (
    <button
      className={project.current ? 'project-row project-row--active' : 'project-row'}
      type="button"
      onClick={() => onOpenProject(project.path, project)}
      title={project.path}
    >
      <span className="project-row__main">
        <strong>{project.name}</strong>
        <small>
          {project.source === 'cloud' ? t('sidebar.cloud') : t('sidebar.local')}
          {' · '}
          {!openable ? t('sidebar.cloudOpenable') : project.isGit ? t('sidebar.syncedGit') : t('sidebar.synced')}
          {' · '}
          {formatProjectTime(project.modifiedAt)}
        </small>
      </span>
      {uploadAvailable && (
        <span
          className={uploading ? 'project-row__upload project-row__upload--uploading' : 'project-row__upload'}
          role="button"
          tabIndex={uploading ? -1 : 0}
          aria-disabled={uploading}
          title={uploading ? t('project.uploadInFlight') : t('project.uploadTitle')}
          aria-label={uploading ? t('project.uploadInFlight') : t('project.uploadLabel')}
          onClick={(ev) => { ev.stopPropagation(); triggerUpload(); }}
          onKeyDown={(ev) => {
            if ((ev.key === 'Enter' || ev.key === ' ') && !uploading) {
              ev.stopPropagation();
              ev.preventDefault();
              triggerUpload();
            }
          }}
        >
          {uploading ? <RefreshCw size={13} className="is-spinning" aria-hidden="true" /> : <UploadCloud size={13} aria-hidden="true" />}
        </span>
      )}
      {dismissAvailable && (
        <span
          className="project-row__upload project-row__dismiss"
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
      {project.current && <span className="project-row__tag">open</span>}
    </button>
  );
}

function formatProjectTime(value: string) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
}

function FilesModule({ config, tree, projects, selectedFile, projectView, diffSummary, diffLoading, diffLastFetchedIso, onProjectViewChange, onRefreshFiles, onRefreshDiff, onOpenFile, onOpenDiffFile, onImportFilesIntoTree }: SidebarProps) {
  const { language, t } = useI18n();
  const [rootDropTarget, setRootDropTarget] = useState(false);
  // File-tree sync visibility state (FT-Task-4):
  //   - context menu position + node
  //   - lazy augmentation map (per-node SyncDisposition fetched via
  //     listFileChildren when a directory expands)
  //   - confirm-replace dialog for the would_dominate path
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; flipUp: boolean; node: FileNode } | null>(null);
  // Right-click clipboard for copy/paste. Single-slot — holds the path
  // most recently "copied" by the user. Cleared when paste consumes it
  // (so a stale clipboard doesn't leak across project switches).
  const [pathClipboard, setPathClipboard] = useState<{ path: string; name: string; isDir: boolean } | null>(null);
  // Toast: position-flip detects whether the trigger was in the bottom
  // half of the viewport so a long toast doesn't get clipped by the
  // window edge or status bar.
  const [actionToast, setActionToast] = useState<{ text: string; bottom: boolean } | null>(null);
  // Custom delete-confirm modal — replaces window.confirm which Electron
  // renderers can refuse silently (the previous user-reported "delete
  // didn't do anything" was this: window.confirm returned false without
  // showing UI). The modal carries the node and a callback the caller
  // resolves with.
  const [deleteConfirm, setDeleteConfirm] = useState<{ node: FileNode; resolve: (ok: boolean) => void } | null>(null);
  const workspaceRoot = tree?.root;
  const augment = useLazyChildrenAugment(workspaceRoot);
  const pathRunner = useFilePathActionRunner({
    onActionApplied: () => {
      // After any successful path action, re-fetch the root listing so
      // the badges reflect the new override / pending state. Renderer
      // doesn't know which specific subdir to refresh; root + open
      // directories would be ideal, but the lazy hook's per-dir fetch
      // is cheap so refreshing the root is sufficient here.
      if (workspaceRoot) void augment.fetchAndApply(workspaceRoot);
    },
  });
  if (!tree || !tree.root) {
    return <div className="empty-state">{t('sidebar.chooseProjectFirst')}</div>;
  }
  const projectName = currentProjectName(config, tree);
  const currentProject = currentProjectForTree(projects, tree, config);
  const syncDirection = projectSyncDirection(currentProject);

  // Root-level drop = workspace root path. A directory node inside
  // the tree will stopPropagation in its own handler so we don't
  // double-fire; bubble-up to here means the user dropped on the
  // empty area / between nodes.
  const handleRootDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    setRootDropTarget(false);
    const paths = allDroppedPaths(event);
    if (paths.length) onImportFilesIntoTree(tree.root, paths);
  };

  return (
    <div className="file-module file-module--compact">
      <div className="file-tree-header">
        <div className="file-tree-project" title={tree.root}>
          <Folder size={14} />
          <span>{projectName}</span>
        </div>
        <button className="icon-btn file-tree-refresh" type="button" onClick={onRefreshFiles} title={t('sidebar.files')}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="project-subtabs project-subtabs--file-tree" role="tablist" aria-label={`${t('tabs.files')} / ${t('tabs.changes')}`}>
        <button
          type="button"
          role="tab"
          aria-selected={projectView === 'files'}
          className={projectView === 'files' ? 'is-active' : ''}
          onClick={() => onProjectViewChange('files')}
        >
          {t('tabs.files')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={projectView === 'changes'}
          className={projectView === 'changes' ? 'is-active' : ''}
          onClick={() => onProjectViewChange('changes')}
        >
          {t('tabs.changes')}
        </button>
      </div>
      {projectView === 'files' ? (
        <>
          <div
            className={rootDropTarget ? 'file-tree file-tree--drop-target' : 'file-tree'}
            onDrop={handleRootDrop}
            onDragOver={(e) => acceptFileDrag(e) && setRootDropTarget(true)}
            onDragLeave={(e) => leaveDrag(e) && setRootDropTarget(false)}
          >
            {tree.nodes.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                selectedFile={selectedFile}
                onOpenFile={onOpenFile}
                onImportFilesIntoTree={onImportFilesIntoTree}
                depth={0}
                augments={augment.augments}
                fetchedChildren={augment.fetchedChildren}
                onExpandDir={augment.fetchAndApply}
                onOpenMenu={(event, node) => {
                  event.preventDefault();
                  // Flip menu upward if the click is in the bottom half
                  // of the viewport. Crude but effective — prevents the
                  // menu (which can be 5-6 items tall) from clipping
                  // past the window edge or under the status bar.
                  const flipUp = event.clientY > window.innerHeight / 2;
                  setFileMenu({ x: event.clientX, y: event.clientY, flipUp, node });
                }}
              />
            ))}
          </div>
          {fileMenu && (
            <FileContextMenu
              node={fileMenu.node}
              x={fileMenu.x}
              y={fileMenu.y}
              flipUp={fileMenu.flipUp}
              onClose={() => setFileMenu(null)}
              onRun={pathRunner.runAction}
              clipboard={pathClipboard}
              onCopy={(n) => {
                const isDir = n.type === 'directory';
                setPathClipboard({ path: n.path, name: n.name, isDir });
                showToast(setActionToast, t('fileAction.toast.copied').replace('{name}', n.name), !fileMenu.flipUp, 1500);
              }}
              onDelete={async (n) => {
                // Custom modal — window.confirm is unreliable in
                // Electron renderer (returns false without showing
                // UI). The dialog renders below; await its resolution.
                const ok = await new Promise<boolean>((resolve) => {
                  setDeleteConfirm({ node: n, resolve });
                });
                if (!ok) return;
                const res = await window.kari.deleteFileTreeNode(n.path);
                let toastText: string;
                if (!res || !res.ok) {
                  toastText = t('fileAction.toast.deleteFailed') + ': ' + ((res as { error?: string })?.error || 'unknown');
                } else if (res.upload && res.upload.ok === false) {
                  toastText = t('fileAction.toast.deletedLocalSyncFailed').replace('{name}', n.name) + ': ' + (res.upload.error || res.upload.code || '');
                } else {
                  toastText = t('fileAction.toast.deleted').replace('{name}', n.name);
                }
                showToast(setActionToast, toastText, !fileMenu.flipUp, 3000);
                if (workspaceRoot) void augment.fetchAndApply(workspaceRoot);
              }}
              onPaste={async (targetDirNode) => {
                if (!pathClipboard) return;
                const targetDirPath = targetDirNode.type === 'directory' ? targetDirNode.path : workspaceRoot || '';
                if (!targetDirPath) return;
                const res = await window.kari.pasteFileTreeNode(pathClipboard.path, targetDirPath);
                let toastText: string;
                if (!res || !res.ok) {
                  toastText = t('fileAction.toast.pasteFailed') + ': ' + ((res as { error?: string })?.error || 'unknown');
                } else if (res.upload && res.upload.ok === false) {
                  toastText = t('fileAction.toast.pastedLocalSyncFailed').replace('{name}', pathClipboard.name) + ': ' + (res.upload.error || res.upload.code || '');
                } else {
                  toastText = t('fileAction.toast.pasted').replace('{name}', pathClipboard.name);
                  setPathClipboard(null);
                }
                showToast(setActionToast, toastText, !fileMenu.flipUp, 3000);
                if (workspaceRoot) void augment.fetchAndApply(workspaceRoot);
              }}
              onShowInFinder={async (n) => {
                const res = await window.kari.showFileTreeNodeInFinder(n.path);
                if (!res || !res.ok) {
                  showToast(setActionToast, t('fileAction.toast.showInFinderFailed') + ': ' + (res?.error || 'unknown'), !fileMenu.flipUp, 2000);
                }
              }}
            />
          )}
          {actionToast && (
            <div className={'file-action-toast' + (actionToast.bottom ? ' file-action-toast--bottom' : ' file-action-toast--top')} role="status">{actionToast.text}</div>
          )}
          {deleteConfirm && (
            <DeleteConfirmDialog
              node={deleteConfirm.node}
              onConfirm={() => {
                deleteConfirm.resolve(true);
                setDeleteConfirm(null);
              }}
              onCancel={() => {
                deleteConfirm.resolve(false);
                setDeleteConfirm(null);
              }}
            />
          )}
          {pathRunner.confirmReplace && (
            <ConfirmReplaceDialog
              state={pathRunner.confirmReplace}
              onAccept={pathRunner.confirmReplaceAccept}
              onCancel={pathRunner.confirmReplaceCancel}
            />
          )}
        </>
      ) : (
        <ChangesTreeList
          summary={diffSummary}
          loading={diffLoading}
          lastFetchedIso={diffLastFetchedIso}
          onRefresh={onRefreshDiff}
          onOpenFile={onOpenDiffFile}
        />
      )}
      <div className={[
        'file-tree-sync-progress',
        syncDirection ? `file-tree-sync-progress--${syncDirection}` : '',
      ].filter(Boolean).join(' ')}>
        <div className="file-tree-sync-progress__label">
          <span>{projectSyncLabel(currentProject, 100, language, { directional: true })}</span>
        </div>
        <ProjectSyncDiamondProgress project={currentProject} fallback={100} directional />
      </div>
      <div className="file-tree-footer" title={tree.root}>
        <HardDrive size={13} aria-hidden="true" />
        <span>{tree.root}</span>
      </div>
    </div>
  );
}

function ChangesTreeList({
  summary,
  loading,
  lastFetchedIso,
  onRefresh,
  onOpenFile
}: {
  summary: GitDiffSummary | null;
  loading: boolean;
  lastFetchedIso: string | null;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const status = (message: string, tone: 'empty' | 'warning' = 'empty') => (
    <div className={tone === 'warning' ? 'warning-line file-changes-message' : 'empty-state file-changes-message'}>
      <span>{message}</span>
      <button className="icon-mini" type="button" onClick={onRefresh} title={t('diff.refresh')}>
        <RefreshCw size={13} className={loading ? 'is-spinning' : ''} />
      </button>
    </div>
  );

  if (!summary) return status(t('diff.empty'));
  if (!summary.ok) return status(t('diff.loadFailed', { error: summary.error || t('diff.unknownError') }), 'warning');
  if (!summary.isGit) return status(t('diff.notGit'));
  if (!summary.files.length) return status(t('diff.noChanges'));

  return (
    <div className="file-changes-list" role="list" aria-label={t('diff.ariaLabel')}>
      <div className="file-changes-meta">
        <span>{summary.files.length}{t('diff.fileCount')}</span>
        <button className="icon-mini" type="button" onClick={onRefresh} title={t('diff.refresh')}>
          <RefreshCw size={13} className={loading ? 'is-spinning' : ''} />
        </button>
      </div>
      {summary.truncated && <div className="warning-line file-changes-warning">{t('diff.previewTruncated')}</div>}
      {summary.files.map((file) => (
        <button
          key={`${file.status}:${file.oldPath || ''}:${file.path}`}
          className={`file-change-row file-change-row--${file.status}`}
          type="button"
          title={file.path}
          onClick={() => onOpenFile(file.path)}
          role="listitem"
        >
          <span className={`file-change-row__status file-change-row__status--${file.status}`}>{diffStatusLabel(file.status, t)}</span>
          <span className="file-change-row__path">{file.path}</span>
          <span className="file-change-row__counts">
            <span className="file-change-row__add">+{file.additions}</span>
            <span className="file-change-row__del">-{file.deletions}</span>
          </span>
        </button>
      ))}
      <div className="file-changes-footer">{t('diff.lastFetched', { time: formatFetchTime(lastFetchedIso) })}</div>
    </div>
  );
}

function diffStatusLabel(status: GitDiffFileStatus, t: ReturnType<typeof useI18n>['t']) {
  const key = `diff.status.${status}` as I18nKey;
  return t(key);
}

function currentProjectName(config: SavedConfig, tree: FileTreeResult) {
  const configured = String(config.workspaceName || '').trim();
  if (configured && configured !== 'workspace') return configured;
  return baseNameFromPath(tree.root) || configured || 'workspace';
}

function currentProjectForTree(projects: ProjectListResult | null, tree: FileTreeResult, config: SavedConfig) {
  const items = projects?.projects || [];
  const configuredName = String(config.workspaceName || '').trim();
  return items.find((project) => project.current)
    || items.find((project) => sameProjectPath(project.localPath, tree.root) || sameProjectPath(project.path, tree.root) || sameProjectPath(project.remoteWorkdir, tree.root))
    || items.find((project) => configuredName && String(project.workspaceName || project.name || '').trim() === configuredName)
    || null;
}

function sameProjectPath(left?: string, right?: string) {
  const a = normalizeProjectPath(left);
  const b = normalizeProjectPath(right);
  return Boolean(a && b && a === b);
}

function normalizeProjectPath(value?: string) {
  return String(value || '').split('\\').join('/').replace(/\/+$/, '');
}

function baseNameFromPath(value: string) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function TreeNode({
  node: rawNode,
  selectedFile,
  onOpenFile,
  onImportFilesIntoTree,
  depth,
  augments,
  fetchedChildren,
  onExpandDir,
  onOpenMenu,
}: {
  node: FileNode;
  selectedFile: string;
  onOpenFile: (path: string) => void;
  onImportFilesIntoTree: (destAbsDir: string, sourcePaths: string[]) => void;
  depth: number;
  augments: Map<string, NodeAugment>;
  fetchedChildren: Map<string, FileNode[]>;
  onExpandDir: (dirPath: string) => Promise<void> | void;
  onOpenMenu: (event: ReactMouseEvent<HTMLElement>, node: FileNode) => void;
}) {
  // Augment the node with disposition data fetched lazily from
  // listFileChildren (FT-Task-4). Wraps without mutation so the parent's
  // props stay clean across renders. Lazy-tree expansion: when this
  // directory's children have been fetched, augmentNode substitutes them
  // in for the empty `children: []` that scanWorkspace returns by default.
  const node = augmentNode(rawNode, augments, fetchedChildren);
  const [dropTarget, setDropTarget] = useState(false);

  const handleDragStart = (event: ReactDragEvent<HTMLElement>) => {
    // Side-channel marker so PTY pane drop handlers can tell this is
    // an internal file-tree drag vs an external Finder drop. Set
    // BEFORE startFileDrag because Electron's OS-level drag wins the
    // drop event and strips the HTML5 dataTransfer the renderer set
    // up — the module-level flag is what survives the handoff.
    beginInternalFileDrag(node.path);
    const ok = window.kari.startFileDrag(node.path);
    if (ok) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', node.path);
  };
  // Cleanup the side-channel even when the drag is cancelled (Esc,
  // dropped outside any target). Without onDragEnd a cancelled drag
  // would leave activePath set, and the next click that lands inside
  // a PTY pane's drop zone would falsely look like an internal drop.
  const handleDragEnd = () => {
    endInternalFileDrag();
  };

  if (node.type === 'directory') {
    // Drop on the directory's <summary> lands files at this node's
    // absolute path. stopPropagation so the file-tree root doesn't
    // also fire (we already handled it here).
    const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(false);
      const paths = allDroppedPaths(event);
      if (paths.length) onImportFilesIntoTree(node.path, paths);
    };
    const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
      if (!acceptFileDrag(event)) return;
      event.stopPropagation();
      setDropTarget(true);
    };
    // <details>/<summary> doesn't expose a clean "expand" event in
    // React, so wire to onToggle on the <details>. We refetch even on
    // collapse → re-expand to pick up any changes since the last
    // listing (cheap; lazy hook dedups by absolute path).
    const handleToggle = (event: ReactSyntheticEvent<HTMLDetailsElement>) => {
      if (event.currentTarget.open) {
        void onExpandDir(node.path);
      }
    };
    return (
      <details
        className={dropTarget ? 'tree-dir tree-dir--drop-target' : 'tree-dir'}
        onToggle={handleToggle}
      >
        <summary
          style={{ paddingLeft: 8 + depth * 12 }}
          draggable
          onDragStart={handleDragStart}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={(e) => leaveDrag(e) && setDropTarget(false)}
          onContextMenu={(e) => onOpenMenu(e, node)}
        >
          <SyncDispositionIcon node={node} />
          <Folder className="tree-node-icon tree-node-icon--folder" size={14} aria-hidden="true" />
          <span className="tree-node-name">{node.name}</span>
          {node.gitBadge && <GitBadge badge={node.gitBadge} />}
        </summary>
        {(node.children || []).map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            selectedFile={selectedFile}
            onOpenFile={onOpenFile}
            onImportFilesIntoTree={onImportFilesIntoTree}
            depth={depth + 1}
            augments={augments}
            fetchedChildren={fetchedChildren}
            onExpandDir={onExpandDir}
            onOpenMenu={onOpenMenu}
          />
        ))}
      </details>
    );
  }
  // File node: HTML5 drag source → Electron startFileDrag. When the
  // main process accepts the path, preventDefault lets Electron's
  // native startDrag own the operation; otherwise fall back to text.
  return (
    <button
      className={selectedFile === node.path ? 'tree-file tree-file--active' : 'tree-file'}
      style={{ paddingLeft: 18 + depth * 12 }}
      onClick={() => onOpenFile(node.path)}
      title={node.relPath}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onContextMenu={(e) => onOpenMenu(e, node)}
    >
      <SyncDispositionIcon node={node} />
      <FileText className="tree-node-icon tree-node-icon--file" size={14} aria-hidden="true" />
      <span className="tree-node-name">{node.name}</span>
      {node.gitBadge && <GitBadge badge={node.gitBadge} />}
    </button>
  );
}

function GitBadge({ badge }: { badge: string }) {
  const normalized = badge.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'other';
  return <span className={`git-badge git-badge--${normalized}`} title={`Git ${badge}`}>{badge}</span>;
}

function SessionsModule({ sessions, onRefreshSessions, onResumeSession, onRenameSession }: SidebarProps) {
  const { t } = useI18n();
  return (
    <div className="session-module session-module--compact">
      <div className="session-compact-header">
        <span className="session-compact-title">Remote history</span>
        <button className="icon-btn session-refresh" type="button" onClick={onRefreshSessions} title={t('sidebar.refreshHistory')}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="session-list session-list--compact">
        {sessions.length === 0 && <div className="empty-state">{t('sidebar.emptySessions')}</div>}
        {sessions.map((session) => (
          <div className="session-row session-row--compact" key={`${session.source}-${session.id}`}>
            <button className="session-row-main" type="button" onClick={() => onResumeSession(session)} title={t('sidebar.resumeSession')}>
              <span>{session.source}{session.customTitle ? ` · ${t('sidebar.custom')}` : ''}</span>
              <strong>{session.title}</strong>
              <small><Clock3 size={12} /> {formatSessionTime(session.lastActiveAt)}{session.project ? ` · ${session.project}` : ''}</small>
            </button>
            <button className="icon-btn session-rename" type="button" onClick={() => onRenameSession(session)} title={t('sidebar.renameSession')}>
              <Pencil size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatSessionTime(value?: string) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function RemoteModule({ config, daemon, runtime, onReverseAction }: SidebarProps) {
  const { language, t } = useI18n();
  const startReason = reverseActionBlockedReason('start', config, daemon, runtime, language);
  const refreshReason = reverseActionBlockedReason('refresh', config, daemon, runtime, language);
  const stopReason = reverseActionBlockedReason('stop', config, daemon, runtime, language);
  const copyReason = reverseActionBlockedReason('copy', config, daemon, runtime, language);
  const readiness = reverseReadinessMessage(config, daemon, runtime, language);
  return (
    <div className="module-stack">
      <div className="session-actions">
        <button onClick={() => onReverseAction('start')} disabled={Boolean(startReason)} title={startReason || t('settings.remote.startTitle')}><Play size={14} /> {t('sidebar.remote.start')}</button>
        <button onClick={() => onReverseAction('refresh')} disabled={Boolean(refreshReason)} title={refreshReason || t('settings.remote.refreshTitle')}><RefreshCw size={14} /> {t('sidebar.remote.refresh')}</button>
        <button onClick={() => onReverseAction('stop')} disabled={Boolean(stopReason)} title={stopReason || t('settings.remote.stopTitle')}>{t('sidebar.remote.stop')}</button>
        <button onClick={() => onReverseAction('copy')} disabled={Boolean(copyReason)} title={copyReason || t('settings.remote.copyTitle')}>{t('sidebar.remote.copy')}</button>
      </div>
      <KV label="mgmt" value={config.managementUrl || 'unset'} />
      <KV label="server" value={config.serverAddr || daemon.serverAddr || 'unset'} />
      <KV label="workspace" value={config.workspaceId || daemon.workspaceId || 'unset'} />
      <KV label="client" value={config.clientId || 'unset'} />
      <KV label="frp" value={daemon.frpState || 'disabled'} />
      <KV label="ssh" value={daemon.sshState || 'unknown'} />
      <KV label="frpc" value={runtime?.frpcPath || 'missing'} />
      {readiness && <div className={startReason ? 'warning-line' : 'hint-line'}>{readiness}</div>}
      {daemon.frpError && <div className="warning-line">{daemon.frpError}</div>}
    </div>
  );
}

function SettingsModule({ config, runtime, capabilities, models, onRefreshSettings, onLogout }: SidebarProps) {
  const { t } = useI18n();
  const capState = summarizeUnknown(capabilities);
  const modelState = summarizeModels(models);
  return (
    <div className="module-stack">
      <button className="mini-action" onClick={onRefreshSettings}><RefreshCw size={14} /> {t('settings.refreshCapabilities')}</button>
      <KV label="runtime" value={runtime?.ok ? runtime.platform : 'missing'} />
      <KV label="kari" value={runtime?.kariPath || 'not found'} />
      <KV label="syncd" value={runtime?.syncdPath || 'not found'} />
      <KV label="frpc" value={runtime?.frpcPath || 'optional/missing'} />
      <KV label="opencode" value={runtime?.opencodePath || 'optional/missing'} />
      <KV label="machine" value={config.machineLabel || 'unset'} />
      <KV label="auth" value={config.hasActivationCode ? 'stored' : 'missing'} />
      <KV label="capability" value={capState} />
      <KV label="models" value={modelState} />
      <KV label="default cli" value="remote" />
      <KV label="sync policy" value="save-only" />
      <button className="danger-action" onClick={onLogout}>{t('sidebar.logoutKey')}</button>
      <div className="micro-log">
        <span>renderer_fs_access=false</span>
        <span>main_ipc_guard=workspace_root</span>
      </div>
    </div>
  );
}

function summarizeUnknown(value: unknown) {
  if (!value) return 'unknown';
  if (typeof value === 'object' && value !== null && 'error' in value) {
    return String((value as { error?: unknown }).error || 'error');
  }
  if (typeof value === 'object' && value !== null && 'ok' in value && 'data' in value) {
    const data = (value as { data?: unknown }).data;
    if (data && typeof data === 'object') return `${Object.keys(data as Record<string, unknown>).length} keys`;
    return String(data ?? 'ok');
  }
  if (typeof value === 'object') return `${Object.keys(value as Record<string, unknown>).length} keys`;
  return String(value);
}

function summarizeModels(value: unknown) {
  if (!value) return 'unknown';
  if (typeof value === 'object' && value !== null && 'error' in value) {
    return String((value as { error?: unknown }).error || 'error');
  }
  const data = typeof value === 'object' && value !== null && 'data' in value ? (value as { data?: unknown }).data : value;
  if (Array.isArray(data)) return `${data.length} models`;
  if (data && typeof data === 'object') return `${Object.keys(data as Record<string, unknown>).length} keys`;
  return String(data ?? 'unknown');
}

function GitModule({ config, daemon, git, onRefreshGit, onGitBootstrap }: SidebarProps) {
  const { t } = useI18n();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const url = String(data.get('gitUrl') || '').trim();
    if (url) onGitBootstrap(url);
  };
  const remote = git?.remote as { url?: string; remote_url?: string; peer_repo_url?: string } | null;
  const gitStatus = git?.status as { enabled?: boolean } | null;
  const bootstrap = git?.bootstrap as { status?: string; error?: string } | null;
  return (
    <div className="module-stack">
      <button className="mini-action" onClick={onRefreshGit}><RefreshCw size={14} /> {t('sidebar.refreshGit')}</button>
      <form className="inline-form" onSubmit={submit}>
        <input name="gitUrl" placeholder="https://github.com/org/repo.git" />
        <button>clone</button>
      </form>
      <KV label="root" value={config.workspaceRoot || 'unset'} />
      <KV label="git ctl" value={gitStatus?.enabled ? 'enabled' : 'disabled'} />
      <KV label="remote" value={remote?.url || remote?.remote_url || 'unknown'} />
      <KV label="bootstrap" value={bootstrap?.status || 'unknown'} />
      <KV label="local repo" value={(daemon.raw as { local_repo_url?: string } | undefined)?.local_repo_url || 'unknown'} />
      <KV label="peer repo" value={(daemon.raw as { peer_repo_url?: string } | undefined)?.peer_repo_url || 'unknown'} />
      <KV label="guard" value={(daemon.raw as { uploads_paused?: boolean } | undefined)?.uploads_paused ? 'paused' : 'clear'} />
      {bootstrap?.error && <div className="warning-line">{bootstrap.error}</div>}
      {(daemon.raw as { pause_reason?: string } | undefined)?.pause_reason && (
        <div className="warning-line">{(daemon.raw as { pause_reason?: string }).pause_reason}</div>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

// showToast schedules a toast that auto-clears after `durationMs`.
// `bottom` controls vertical placement — true = near bottom (default),
// false = near top. Caller flips to top when the originating click was
// in the bottom half of the viewport so the toast doesn't overlap with
// what the user just clicked.
function showToast(
  setter: Dispatch<SetStateAction<{ text: string; bottom: boolean } | null>>,
  text: string,
  bottom: boolean,
  durationMs: number,
) {
  setter({ text, bottom });
  window.setTimeout(() => setter(null), durationMs);
}

// DeleteConfirmDialog renders Kari's custom modal for the right-click
// "Delete" confirm — replaces window.confirm (which Electron renderer
// silently rejects under some configurations, so the previous "delete
// did nothing" bug was actually "confirm dialog never appeared").
// Copy differs for file vs folder so the user knows when a recursive
// delete is about to happen.
function DeleteConfirmDialog({
  node,
  onConfirm,
  onCancel,
}: {
  node: FileNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const isDir = node.type === 'directory';
  const title = isDir ? t('fileAction.confirm.deleteFolderTitle') : t('fileAction.confirm.deleteFileTitle');
  const body = (isDir ? t('fileAction.confirm.deleteFolderBody') : t('fileAction.confirm.deleteFileBody')).replace('{name}', node.name);
  return (
    <div className="kari-modal-overlay" role="dialog" aria-modal="true">
      <div className="kari-modal kari-modal--danger">
        <h3 className="kari-modal__title">{title}</h3>
        <p className="kari-modal__body">{body}</p>
        <div className="kari-modal__actions">
          <button type="button" className="kari-modal__btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="kari-modal__btn kari-modal__btn--danger" onClick={onConfirm} autoFocus>
            {t('fileAction.confirm.deleteOK')}
          </button>
        </div>
      </div>
    </div>
  );
}
