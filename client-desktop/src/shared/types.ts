export type SidebarModule = 'project' | 'files' | 'sessions' | 'remote' | 'settings' | 'git';

export type TerminalKind = 'shell' | 'codex' | 'claude' | 'continue' | 'opencode';

export type TerminalMode = 'remote' | 'local';

export interface ActivationConfig {
  managementUrl: string;
  activationCode?: string;
  machineLabel?: string;
  serverAddr?: string;
  workspaceId?: string;
  workspaceName?: string;
  clientId?: string;
}

export interface RuntimeStatus {
  ok: boolean;
  platform: string;
  daemonBase: string;
  syncdPath: string;
  kariPath: string;
  frpcPath: string;
  opencodePath?: string;
  missing: string[];
}

export interface ActivationResult {
  ok: boolean;
  config: SavedConfig;
  message?: string;
}

export interface SavedConfig {
  activated: boolean;
  appVersion?: string;
  managementUrl: string;
  machineLabel: string;
  serverAddr: string;
  workspaceId: string;
  workspaceName: string;
  clientId: string;
  hasActivationCode: boolean;
  activationCodeHint?: string;
  workspaceRoot: string;
  /**
   * Per-current-workspace sync backend tag, sourced from the
   * server's `workspace_dirs.sync_backend` row when listServerProjects
   * resolves the active workspace. Persisted into the stored config so
   * out-of-band daemon binds (e.g. `daemon:bindStart` IPC) can include
   * the correct backend hint in `/v1/bind` and `/v1/sync-tasks` bodies
   * without re-querying the server. Reset to `'filesync'` (the safe
   * default) when the server omits it or when a different workspace
   * becomes current. NEVER inherited across workspaces — every
   * uploadProject / downloadProject / openProject that switches
   * workspaces re-writes this field so a stale value from a previous
   * project can't leak into the next bind.
   */
  workspaceSyncBackend?: 'syncthing' | 'filesync';
  // PR2 Phase 1.x Storage Location Boundary: user picks
  // `storageBaseDir` (any filesystem location); Kari creates a
  // controlled container ("Kari 存储") inside. `projectsRoot` is the
  // DERIVED container path, NOT a user-settable arbitrary directory.
  // Both fields are surfaced for callers but: code MUST NOT mutate
  // projectsRoot directly — only update storageBaseDir + let
  // defaultProjectsRoot recompute.
  storageBaseDir?: string;
  projectsRoot?: string;
  serverId?: string;
  frp?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
  tenantClientId?: string;
  hasTenantClientToken?: boolean;
  defaultTerminalMode?: TerminalMode;
  daemonUrl?: string;
  vscodeImportDisabled?: boolean;
  updatedAt?: string;
}


export interface StorageSummary {
  storageBaseDir: string;
  projectsRoot: string;
  bytesUsed: number;
  projectCount: number;
  error?: string;
}

// Diff Viewer commit 1 (PR3 candidate) — types for the read-only
// `Changes` review surface in Project/Files. Renderer ALWAYS goes
// through IPC; never runs `git` directly. See
// docs/diff-viewer-integration-plan.zh-CN.md for the full plan.
//
// `GitDiffSummary` intentionally has NO aggregate `patch` field —
// renderer should only consume per-file `files[i].patch`. Lazy-load
// via `gitFileDiff(path)` for files where summary returned an empty
// patch (capped / cleared).
export type GitDiffFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  // Defensive fallback when porcelain parsing fails / encounters an
  // unrecognized code. Renderer should treat as `modified`.
  | 'unknown';

export interface GitDiffFile {
  // workspace-relative path. For renames, the NEW path.
  path: string;
  // Only set when status === 'renamed' / 'copied'. Original path.
  oldPath?: string;
  status: GitDiffFileStatus;
  additions: number;
  deletions: number;
  // Unified-diff text. Empty when the file was cleared by size cap
  // (file `truncated: true`) or detected binary (`binary: true`).
  patch?: string;
  // Per-file truncation flag: this file's patch exceeded the
  // per-file or workspace cap and was cleared. Renderer shows a
  // `Diff capped, click to load full file` affordance which would
  // re-fetch via gitFileDiff.
  truncated?: boolean;
  // True when the file's contents (untracked) OR Git's diff output
  // (tracked) indicate binary. Renderer shows
  // `Binary file, diff not rendered` and does NOT pass the patch to
  // react-diff-view.
  binary?: boolean;
}

export interface GitDiffSummary {
  ok: boolean;
  // false when the workspace is not a Git repo. Renderer renders
  // empty-state.
  isGit: boolean;
  // Absolute resolved workspace root.
  root: string;
  files: GitDiffFile[];
  // Workspace-level truncation: total aggregate patch size crossed
  // the 2 MB cap; some files have `truncated: true` with empty
  // patch. Renderer shows a workspace banner.
  truncated?: boolean;
  // Non-empty on errors that should be surfaced to the user (e.g.
  // workspace path missing).
  error?: string;
}

// Sync phase enum — single authoritative source is the daemon's
// /v1/sync-tasks API. Desktop main mirrors task state into this enum
// via sync_task_tracker; renderer reads it through ProjectItem.sync.
//
//   - scanning / binding: Desktop-side preparation BEFORE a task is
//     posted (du-walk, bind, upload-intent).
//   - uploading / downloading: daemon task is running (progress comes
//     from the task's bytes_done / bytes_total).
//   - synced: daemon task reached succeeded terminal (barrier
//     conditions: manifest exchanged, queues empty, hash commit /
//     peer ack, 1s quiet window, no FileStatusError).
//   - failed: daemon task reported failed OR Desktop-side prep error.
//   - cancelled: user invoked abandonDownload; daemon cancel returned.
//     Partial files preserved; marker retained for retry; card shows
//     a retry/cancel chip.
//   - blocked: daemon offline ≥ 2 polls OR daemon too old
//     (sync-tasks API missing) OR upload-intent quota_exceeded /
//     workspace_name_conflict / server_unavailable.
//   - idle: no recent activity; cache default state.
export type ProjectSyncPhase =
  | 'idle'
  | 'scanning'
  | 'binding'
  | 'uploading'
  | 'downloading'
  | 'syncing'
  | 'synced'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface ProjectSyncState {
  phase: ProjectSyncPhase;
  progress: number; // 0..100
  status: string; // user-facing text
  error?: string;
  bytesDone?: number;
  bytesTotal?: number;
  // Active daemon sync task ID, if one is currently tracked for
  // this project. Used by the renderer's abandon-download flow.
  taskId?: string;
  updatedAt: string; // ISO timestamp
}

// Sync task state mirrored from daemon /v1/sync-tasks (see plan §A2
// for the daemon-side barrier conditions that decide `succeeded`).
export type SyncTaskState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type SyncTaskDirection = 'upload' | 'download' | 'both';

export interface SyncTaskRecord {
  taskId: string;
  workspaceId: string;
  workspaceName: string;
  direction: SyncTaskDirection;
  state: SyncTaskState;
  bytesDone: number;
  bytesTotal: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  initiator: string;
}

export interface AbandonDownloadResult {
  ok: boolean;
  code?: string;
  error?: string;
  // True when the daemon-side cancel call returned ok (best effort;
  // false simply means we didn't reach an active task, not that the
  // overall cancel failed — the local marker is still kept).
  daemonCancelled?: boolean;
  // Always true on ok responses: the .kari-engine/desktop-download-
  // incomplete marker is intentionally retained so the project stays
  // un-openable and the user can retry incrementally.
  markerKept?: boolean;
}

export interface ProjectItem {
  name: string;
  path: string;
  workspaceName?: string;
  remoteWorkdir?: string;
  localPath?: string;
  repoUrl?: string;
  source?: 'cloud' | 'local';
  existsLocal?: boolean;
  // True when this local dir was found under the active base's
  // kari-drive but carries NO ownership tag — i.e. the user dropped it
  // in by hand (or it predates ownership tagging). Surfaced as a
  // local-only "discovered" card with an Upload affordance; clicking
  // Upload writes the tag + enqueues the import. Set by main.cjs
  // listLocalProjects. Tagged-and-owned local projects leave it false.
  discovered?: boolean;
  localBytes?: number;
  remoteBytes?: number;
  isGit: boolean;
  modifiedAt: string;
  current: boolean;
  // Legacy fields — pre-PR2-commit-5 renderer reads these. Kept for
  // backward compat; new renderer code prefers ProjectItem.sync.
  syncProgress?: number;
  syncStatus?: string;
  // Per-workspace backend tag, surfaced by listServerProjects from
  // the server-side workspace row. Used by main.cjs to route the
  // ProjectConnectionState mapper. Cloud-source rows whose server
  // doesn't yet surface the field default to 'filesync' in main;
  // pure-local projects leave this undefined (no backend bound yet).
  syncBackend?: 'syncthing' | 'filesync';
  /**
   * @deprecated Renderer must read `connectionState` instead.
   *
   * Populated by main.cjs `syncStateCache.injectIntoProjects` on
   * every listProjects call for one-release back-compat with IPC
   * consumers that haven't migrated yet (other electron windows,
   * tests, external tooling). All renderer surfaces in this repo
   * were migrated off `sync.*` reads in syncthing-native Phase 1c
   * (see /Users/kari/.claude-work/plans/hidden-soaring-mist.md).
   * The field will be removed after one shipped release; new code
   * MUST NOT read it.
   */
  sync?: ProjectSyncState;
  // syncthing-native Phase 1 (hidden-soaring-mist plan):
  // backend-agnostic project state for the renderer. Populated by
  // src/main/project_connection_state.cjs mapper. Renderer reads
  // this directly; never reads `sync.phase` / marker / sync_task
  // internals.
  connectionState?: ProjectConnectionState;
}

// ============================================================
// Syncthing-native UI redesign (hidden-soaring-mist Phase 1)
// ============================================================
//
// ProjectConnectionState is the renderer/main boundary. Renderer
// reads ONLY this shape — no `project.sync.phase`, no marker, no
// sync_task internals. main.cjs assembles it from durable signals
// (sync_state_cache + sync_task_tracker + marker presence + cloud
// project listing) via project_connection_state.cjs.
//
// Three orthogonal state machines:
//   availability — what's this project's cloud-binding situation
//   syncState    — what is sync doing for this project right now
//   connectionIntent — what user action is in flight
//
// Plus a derived `openable` convenience field. See plan
// /Users/kari/.claude-work/plans/hidden-soaring-mist.md for full
// semantics + cross-machine rules.

// "is this project openable, and how is it bound to the cloud"
//   cloud_only:    server has it; local has nothing  (not openable)
//   local_only:    local has it; not bound to cloud   (openable)
//   provisioning:  first-time cloud→local mirror creation
//                  in flight                          (not openable)
//   connected:     both sides bound + lease active    (openable iff
//                                                      localPath
//                                                      exists)
export type ProjectAvailability =
  | 'cloud_only'
  | 'local_only'
  | 'provisioning'
  | 'connected';

// "what is sync doing for this project right now"
// Meaningful when availability ∈ {provisioning, connected}.
// For cloud_only / local_only, syncState defaults to 'idle' and the
// renderer suppresses the sync chip for those availabilities.
export type ProjectSyncStateKind =
  | 'idle'
  | 'queued'
  | 'migrating'
  | 'scanning'
  | 'syncing'
  | 'paused'
  | 'error'
  | 'conflict';

// "what user-initiated action is in flight" — independent of
// availability + syncState. Derived from durable state (NOT from
// click-time memory); see project_connection_state.cjs for rules.
export type ProjectConnectionIntent = 'attaching' | 'publishing' | null;

export interface ProjectConnectionState {
  // Composite identity — workspace_id alone is not unique, multiple
  // projects can share a workspaceId under different names.
  workspaceId: string;
  workspaceName: string;
  // Display name for chips / labels.
  name: string;
  // Present iff there's a local mirror dir on disk.
  localPath?: string;
  // Which backend served this state. Renderer doesn't branch on
  // this directly — included for diagnostics + future Phase 2
  // syncthing surfaces.
  syncBackend: 'syncthing' | 'filesync';
  availability: ProjectAvailability;
  // Convenience field, computed in main per derivation rules.
  // Renderer reads this; does not re-derive.
  openable: boolean;
  syncState: ProjectSyncStateKind;
  connectionIntent: ProjectConnectionIntent;
  // 0..100 integer (matches kari-syncd /v1/status syncthing.completion
  // + migration doc §3.2). Filesync mapper formula in mapper header.
  // Renderer must NEVER recompute from bytesDone/bytesTotal.
  completion?: number;
  // Conflict count for chip tooltip. 0 unless syncState === 'conflict'.
  // Filesync mapper always produces 0 today (no conflict concept);
  // syncthing mapper (Phase 2) derives from scan or control-plane.
  conflictCount?: number;
  // Single primary error string, non-empty iff syncState === 'error'.
  // Surfaced in chip tooltip.
  lastError?: string;
}

export interface ProjectListResult {
  root: string;
  workspaceId?: string;
  cloudError?: string;
  projects: ProjectItem[];
}

export type ProjectImportQueueState = 'queued' | 'migrating' | 'uploading' | 'running' | 'succeeded' | 'failed';

// Ephemeral live progress for an in-flight import job (main re-derives it each
// run; not persisted). Surfaced so the project card shows real progress.
export interface ProjectImportQueueProgress {
  // 'scanning' (hashing the local tree) → 'syncing' (uploading) → 'idle' (done).
  phase: 'scanning' | 'syncing' | 'idle';
  scanPercent: number | null;   // 0..100 during the scan phase, else null
  completion: number | null;    // 0..100 transfer completion to the peer
  needBytes: number;
  needItems: number;
  state: string;                // raw syncthing folder state
}

export interface ProjectImportQueueJob {
  id: string;
  sourcePath: string;
  workspaceName: string;
  state: ProjectImportQueueState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  progress?: ProjectImportQueueProgress;
}

// File-tree sync visibility — per-node disposition (plan §SyncDisposition).
//
// 'partially_included' and 'pending_upload' are DIRECTORY-only in normal
// usage; files always resolve to one of the singular states. The classifier
// can also surface 'pending_upload' for an individual FILE under a
// committed override when the file post-dates the commit (newly created
// after the override anchor was committed).
export type SyncDisposition =
  | 'included'
  | 'partially_included'
  | 'pending_upload'
  | 'excluded'
  | 'hard_ignored'
  | 'local_only'
  | 'cloud_only'
  | 'conflict';

export interface FileTreeNodeSummary {
  included: number;
  partiallyIncluded: number;
  // Distinct from partiallyIncluded: pending_upload is a data-safety
  // signal ("override exists, cloud has never seen this") not just an
  // informational "subtree mixes children" indicator. UI should drive
  // the yellow/pulsing cloud color from this count, not from
  // partiallyIncluded, so the user can tell at a glance whether a
  // directory has in-flight uploads (potential data-loss risk if they
  // delete locally) vs. just mixed committed children.
  pendingUpload: number;
  excluded: number;
  hardIgnored: number;
  localOnly: number;
  cloudOnly: number;
  conflict: number;
}

export interface FileTreeChildrenRequest {
  // Absolute path to the directory to list. Omitted → workspace root.
  dirPath?: string;
  // Offset cursor returned from a prior page response. Omitted → page 0.
  cursor?: string;
  // Max entries to return (clamped 1..1000 by the listing impl).
  limit?: number;
  // Server-side filter (round-2 codex: must be applied in the IPC, not
  // client-side, otherwise filtered views appear empty on the wrong page).
  filter?: 'all' | 'included' | 'excluded' | 'local_only' | 'cloud_only';
}

export interface FileTreeChildrenResult {
  root: string;
  dirPath: string;
  nodes: FileNode[];
  nextCursor?: string;
  hasMore: boolean;
  // IMMEDIATE-children summary (NOT recursive subtree total — that would
  // require an O(full walk) per page-load. Recursive counts come from the
  // renderer accumulating child listings as the user expands.)
  summary: FileTreeNodeSummary;
  // Populated when the IPC handler caught an unexpected throw and
  // returned an empty result. Renderer can show a toast / retry UI
  // instead of silently rendering an empty tree.
  error?: string;
}

// Path-scoped context menu actions. Three actions exactly per plan
// (UI mapping: 强制上传一次 / 始终同步此路径 / 取消始终同步).
export type FileTreePathAction =
  | 'force_upload_once'
  | 'always_sync_path'
  | 'stop_always_syncing';

// Project-scoped override row (persisted by sync_override_store). Mirrors
// the JS shape in sync_override_store.cjs.
export interface ProjectSyncOverride {
  serverAddr: string;
  workspaceId: string;
  workspaceName: string;
  // POSIX, canonical form (no leading "/", no trailing "/", no `..`)
  relPath: string;
  action: 'include';  // future-proof; only 'include' today
  // 'pending_upload' = override exists, no committed manifest yet contains
  // this anchor → yellow cloud in UI.
  // 'committed' = at least one /api/v2/manifests/{id}/commit succeeded with
  // this anchor in scope → green cloud (classifier still cross-checks
  // manifestPaths before painting green; stale committed rows fall through
  // to local_only).
  state: 'pending_upload' | 'committed';
  committedManifestId: string | null;
  createdAt: string;  // ISO 8601
  updatedAt: string;  // ISO 8601
}

export interface FileNode {
  name: string;
  path: string;
  relPath: string;
  type: 'file' | 'directory' | 'symlink';  // symlinks surfaced as excluded
  size: number;
  children?: FileNode[];
  gitStatus?: string;
  gitBadge?: string;
  // File-tree sync visibility additions:
  syncDisposition?: SyncDisposition;
  syncReason?: string;
  syncSummary?: FileTreeNodeSummary;
  hasMoreChildren?: boolean;
  nextCursor?: string;
  // True if THIS node has its own project-level "always sync" override row.
  // Drives the "Stop always-syncing" menu visibility.
  hasOverride?: boolean;
  // If some ANCESTOR directory has an override that covers this path, the
  // anchor relPath of that ancestor. Drives the "inherited override"
  // indicator on descendants.
  overrideInheritedFrom?: string;
}

export interface FileTreeResult {
  root: string;
  nodes: FileNode[];
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  truncated: boolean;
  isGit?: boolean;
  gitRoot?: string;
}

export interface ReadFileResult {
  path: string;
  relPath: string;
  content: string;
  size: number;
  language: string;
  baseContent?: string;
  baseKind?: 'git-head' | 'empty' | 'none';
  gitStatus?: string;
  gitBadge?: string;
}

export interface SaveFileResult {
  ok: boolean;
  synced: boolean;
  // Phase 4: syncthing-backed workspaces enqueue saves through the local
  // upload scheduler. syncQueued=true means the change was durably
  // recorded (dirty marker on disk) and the scheduler will drive the
  // actual upload — the renderer can present this as "saved, syncing"
  // rather than the all-or-nothing synced/unsynced toast.
  syncQueued?: boolean;
  syncError?: string;
  file?: ReadFileResult;
}

export interface DaemonStatus {
  health: 'online' | 'offline';
  connected: boolean;
  running: boolean;
  lastError: string;
  workspaceRoot: string;
  workspaceId: string;
  serverAddr: string;
  lastSyncAt: string;
  lastActivityAt: string;
  ptyCount: number;
  pendingOutbound: number;
  frpState: string;
  frpError: string;
  sshState: string;
  sshAvailable: boolean;
  sshPlatform: string;
  sshInstallSupported: boolean;
  transferCount: number;
  // Phase 4: snapshot of the local upload scheduler for the
  // currently-bound workspace. null when no workspace is bound or no
  // schedule call has landed yet. StatusBar / MonitorGrid can read this
  // to render syncing / "daemon offline, change recorded" without
  // polling listProjects.
  desktopUpload?: DesktopUploadState | null;
  raw?: unknown;
}

// Phase 2 / 4.3 (syncthing migration): the derived state cache the
// renderer subscribes to via window.kari.onSyncthingState. Mirrors
// the shape produced by src/main/syncthing_event_subscriber.cjs.
export interface SyncthingPeerState {
  connected: boolean;
  address?: string;
  lastSeen?: string;
  inBytesTotal?: number;
  outBytesTotal?: number;
}

export interface SyncthingFolderState {
  state?: string;          // 'idle' | 'scanning' | 'syncing' | 'error' | ...
  completion?: number;     // 0..1, inSyncFiles / globalFiles
  globalFiles?: number;
  inSyncFiles?: number;
  lastItemAt?: string;
  errors?: { path: string; error: string }[];
  lastError?: string;
}

export interface SyncthingState {
  peers: Record<string, SyncthingPeerState>;
  folders: Record<string, SyncthingFolderState>;
  traffic?: {
    inBytesTotal: number;
    outBytesTotal: number;
    inBytesPerSec: number;
    outBytesPerSec: number;
    at: string | null;
  };
  events: {
    lastEventId: number;
    lastFetchAt: string | null;
    fetchOk: boolean;
  };
}

export interface DesktopUploadState {
  pending: boolean;
  running: boolean;
  lastChangeAt: string | null;
  lastUploadStartedAt: number;
  uploadedChangeAt: string | null;
  backoffMs: number;
  nextAttemptAt: number;
}

export interface SessionItem {
  id: string;
  source: string;
  title: string;
  originalTitle?: string;
  customTitle?: boolean;
  project?: string;
  lastActiveAt?: string;
}

export interface TerminalCreateRequest {
  kind: TerminalKind;
  mode: TerminalMode;
  rows: number;
  cols: number;
  resumeSessionId?: string;
}

export interface TerminalCreateResult {
  id: string;
  title: string;
  kind: TerminalKind;
  mode: TerminalMode;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  code: number | null;
  signal?: number | string;
}

export interface GitSummary {
  remote: unknown;
  status: unknown;
  bootstrap: unknown;
  errors: Record<string, string>;
}

export interface GitWorkingTreeStatus {
  isGit: boolean;
  gitRoot?: string;
  statuses: Record<string, { status: string; badge: string }>;
}

export type UsageRange = 'month' | 'week' | 'today' | 'all';

export interface UsageModelEntry {
  total: number;
  in: number | null;
  out: number | null;
}

export interface UsageSnapshot {
  deepseek: UsageModelEntry;
  kimi: UsageModelEntry;
  asOf: number;
  range: UsageRange;
}
