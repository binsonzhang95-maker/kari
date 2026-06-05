import { Cloud, FolderOpen, HardDrive, Info, Play, RefreshCw, Settings, ShieldOff, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { DaemonStatus, ProjectItem, RuntimeStatus, SavedConfig, StorageSummary } from '../../shared/types';
import { LANGUAGE_OPTIONS, useI18n, type AppLanguage, type I18nKey } from '../i18n';
import type { ReverseAction } from '../reverseProxy';
import { SyncModePicker } from './SyncModePicker';

type SettingsSection = 'system' | 'storage' | 'projects' | 'auth' | 'about';

interface AppSettingsModalProps {
  open: boolean;
  config: SavedConfig;
  daemon: DaemonStatus;
  runtime: RuntimeStatus | null;
  capabilities: unknown;
  models: unknown;
  storage: StorageSummary | null;
  projects: ProjectItem[];
  onClose: () => void;
  onRefreshSettings: () => void;
  onBindDaemon: () => void;
  onSelectStorageBaseDir: () => Promise<void>;
  onRefreshProjects: () => void;
  onDeleteLocalProject: (project: ProjectItem) => void;
  onDeleteCloudProject: (project: ProjectItem) => void;
  onReverseAction: (action: ReverseAction) => void;
  onLogout: () => void;
}

const sectionDefs: Array<{ id: SettingsSection; labelKey: I18nKey; descriptionKey: I18nKey; icon: typeof Settings }> = [
  { id: 'system', labelKey: 'settings.section.system', descriptionKey: 'settings.section.systemDesc', icon: Settings },
  { id: 'storage', labelKey: 'settings.section.storage', descriptionKey: 'settings.section.storageDesc', icon: HardDrive },
  { id: 'projects', labelKey: 'settings.section.projects', descriptionKey: 'settings.section.projectsDesc', icon: FolderOpen },
  { id: 'auth', labelKey: 'settings.section.auth', descriptionKey: 'settings.section.authDesc', icon: ShieldOff },
  { id: 'about', labelKey: 'settings.section.about', descriptionKey: 'settings.section.aboutDesc', icon: Info }
];

export function AppSettingsModal({
  open,
  config,
  daemon,
  runtime,
  capabilities,
  models,
  storage,
  projects,
  onClose,
  onRefreshSettings,
  onBindDaemon,
  onSelectStorageBaseDir,
  onRefreshProjects,
  onDeleteLocalProject,
  onDeleteCloudProject,
  onReverseAction,
  onLogout
}: AppSettingsModalProps) {
  const { t } = useI18n();
  const [active, setActive] = useState<SettingsSection>('system');
  if (!open) return null;
  const activeSection = sectionDefs.find((section) => section.id === active) || sectionDefs[0];

  return (
    <div className="settings-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-label={t('settings.title')} onMouseDown={(event) => event.stopPropagation()}>
        <aside className="settings-modal__nav">
          <div className="settings-modal__title">
            <strong>{t('settings.title')}</strong>
            <span>{config.workspaceName || config.workspaceId || 'workspace'}</span>
          </div>
          <nav>
            {sectionDefs.map((section) => {
              const Icon = section.icon;
              const label = t(section.labelKey);
              const description = t(section.descriptionKey);
              return (
                <button
                  key={section.id}
                  className={active === section.id ? 'settings-tab settings-tab--active' : 'settings-tab'}
                  type="button"
                  onClick={() => setActive(section.id)}
                >
                  <Icon size={17} />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="settings-modal__content">
          <div className="settings-modal__head">
            <div>
              <h2>{t(activeSection.labelKey)}</h2>
              <p>{t(activeSection.descriptionKey)}</p>
            </div>
            <button className="icon-btn" type="button" onClick={onClose} title={t('settings.closeTitle')}>
              <X size={16} />
            </button>
          </div>

          {active === 'system' && (
            <SystemSettings
              config={config}
              runtime={runtime}
              capabilities={capabilities}
              models={models}
              onRefreshSettings={onRefreshSettings}
              onBindDaemon={onBindDaemon}
            />
          )}
          {active === 'storage' && (
            <StorageSettings storage={storage} onSelectStorageBaseDir={onSelectStorageBaseDir} />
          )}
          {active === 'projects' && (
            <ProjectSettings
              projects={projects}
              onRefreshProjects={onRefreshProjects}
              onDeleteLocalProject={onDeleteLocalProject}
              onDeleteCloudProject={onDeleteCloudProject}
            />
          )}
          {active === 'auth' && (
            <AuthSettings config={config} onLogout={onLogout} />
          )}
          {active === 'about' && (
            <AboutSettings config={config} />
          )}
        </div>
      </section>
    </div>
  );
}

function SystemSettings({
  config,
  runtime,
  capabilities,
  models,
  onRefreshSettings,
  onBindDaemon
}: Pick<AppSettingsModalProps, 'config' | 'runtime' | 'capabilities' | 'models' | 'onRefreshSettings' | 'onBindDaemon'>) {
  const { language, setLanguage, t } = useI18n();

  return (
    <div className="settings-panel">
      <div className="settings-action-row">
        <button className="settings-action" type="button" onClick={onRefreshSettings}>
          <RefreshCw size={14} />
          <span>{t('settings.refreshCapabilities')}</span>
        </button>
        <button className="settings-action" type="button" onClick={onBindDaemon}>
          <Play size={14} />
          <span>{t('settings.reconnect')}</span>
        </button>
      </div>

      <section className="settings-card">
        <h3>{t('settings.language.title')}</h3>
        <p>{t('settings.language.desc')}</p>
        <label className="settings-select-field">
          <span>{t('settings.language.title')}</span>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value as AppLanguage)}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </section>

      {/* Sync mode picker — Phase B B9. Global default scope (per-project
          override lives in the project card menu, FT-Task-6 follow-up). */}
      <section className="settings-card">
        <SyncModePicker scope="global" />
      </section>

      <section className="settings-card">
        <h3>{t('settings.runtime')}</h3>
        <SettingKV label="runtime" value={runtime?.ok ? runtime.platform : 'missing'} />
        <SettingKV label="kari" value={runtime?.kariPath || 'not found'} />
        <SettingKV label="syncd" value={runtime?.syncdPath || 'not found'} />
        <SettingKV label="frpc" value={runtime?.frpcPath || 'optional/missing'} />
        <SettingKV label="opencode" value={runtime?.opencodePath || 'optional/missing'} />
        {runtime?.missing?.length ? <div className="settings-warning">{t('settings.missingList', { items: runtime.missing.join(language === 'zh-CN' ? '、' : ', ') })}</div> : null}
      </section>

      <section className="settings-card">
        <h3>{t('settings.localMachine')}</h3>
        <SettingKV label="machine" value={config.machineLabel || 'unset'} />
        <SettingKV label="workspace" value={config.workspaceId || 'unset'} />
        <SettingKV label="project" value={config.workspaceName || 'unset'} />
        <SettingKV label="default cli" value={config.defaultTerminalMode || 'remote'} />
        <SettingKV label="sync policy" value="save-only" />
      </section>

      <section className="settings-card">
        <h3>{t('settings.capabilities')}</h3>
        <SettingKV label="auth" value={config.hasActivationCode ? 'stored' : 'missing'} />
        <SettingKV label="capability" value={summarizeUnknown(capabilities)} />
        <SettingKV label="models" value={summarizeModels(models)} />
      </section>
    </div>
  );
}

function StorageSettings({
  storage,
  onSelectStorageBaseDir
}: Pick<AppSettingsModalProps, 'storage' | 'onSelectStorageBaseDir'>) {
  const { t } = useI18n();
  const projectCount = storage ? String(storage.projectCount) : '—';
  const storageBase = storage?.storageBaseDir || t('settings.storage.defaultLocation');
  return (
    <div className="settings-panel">
      <section className="settings-card">
        <h3>{t('settings.storage.title')}</h3>
        <SettingKV label={t('settings.storage.projects')} value={projectCount} />
        <SettingKV label={t('settings.storage.location')} value={storageBase} />
        <SettingKV label={t('settings.storage.internal')} value={t('settings.storage.hidden')} />
        <button className="settings-action" type="button" onClick={onSelectStorageBaseDir}>
          <FolderOpen size={14} />
          <span>{t('settings.storage.choose')}</span>
        </button>
        <p>{t('settings.storage.help')}</p>
        {storage?.error && <div className="settings-warning">{storage.error}</div>}
      </section>
    </div>
  );
}

function ProjectSettings({
  projects,
  onRefreshProjects,
  onDeleteLocalProject,
  onDeleteCloudProject
}: Pick<AppSettingsModalProps, 'projects' | 'onRefreshProjects' | 'onDeleteLocalProject' | 'onDeleteCloudProject'>) {
  const { t } = useI18n();
  const rows = Array.isArray(projects) ? projects : [];
  return (
    <div className="settings-panel">
      <div className="settings-action-row">
        <button className="settings-action" type="button" onClick={onRefreshProjects}>
          <RefreshCw size={14} />
          <span>{t('settings.projects.refresh')}</span>
        </button>
      </div>
      <section className="settings-card settings-projects-card">
        <h3>{t('settings.projects.title')}</h3>
        <p>{t('settings.projects.help')}</p>
        {!rows.length && <div className="settings-hint">{t('settings.projects.empty')}</div>}
        {rows.length > 0 && (
          <div className="settings-project-list">
            {rows.map((project) => {
              const name = project.workspaceName || project.name || project.path;
              const sync = project.sync;
              const progress = projectProgress(project);
              const syncStatus = projectSettingsSyncStatus(project, progress, t);
              // Phase 1c5: lastError sourced from connectionState
              // first, then legacy sync.error. The connectionState
              // path emits i18n keys for known structured errors
              // (e.g. state.syncthing.feed_unavailable); raw daemon
              // errors come through verbatim.
              const lastError = project.connectionState?.lastError || sync?.error;
              const canDeleteLocal = Boolean(project.existsLocal || project.localPath || project.source === 'local');
              const canDeleteCloud = Boolean(project.source === 'cloud' || project.remoteWorkdir || (project.remoteBytes || 0) > 0);
              const sourceLabel = project.source === 'cloud' ? t('settings.projects.sourceCloud') : t('settings.projects.sourceLocal');
              const errorTail = lastError ? ` — ${localizeSettingsLastError(t, lastError)}` : '';
              return (
                <article className="settings-project-row" key={`${project.source || 'project'}:${project.path}:${name}`}>
                  <div className="settings-project-row__head">
                    <div className="settings-project-row__title">
                      {project.source === 'cloud' ? <Cloud size={15} /> : <HardDrive size={15} />}
                      <strong title={name}>{name}</strong>
                      <span>{sourceLabel}</span>
                    </div>
                    <div className="settings-project-row__progress" title={syncStatus + errorTail}>
                      {progress}/100
                    </div>
                  </div>
                  <div className="settings-project-grid">
                    <SettingKV label={t('settings.projects.localSize')} value={formatBytes(project.localBytes || 0)} />
                    <SettingKV label={t('settings.projects.cloudSize')} value={formatBytes(project.remoteBytes || 0)} />
                    <SettingKV label={t('settings.projects.syncProgress')} value={`${progress}/100`} />
                    <SettingKV label={t('settings.projects.syncStatus')} value={syncStatus} />
                  </div>
                  <div className="settings-project-actions">
                    <button className="settings-action" type="button" onClick={() => onDeleteLocalProject(project)} disabled={!canDeleteLocal}>
                      <Trash2 size={14} />
                      <span>{t('settings.projects.deleteLocal')}</span>
                    </button>
                    <button className="settings-danger-action" type="button" onClick={() => onDeleteCloudProject(project)} disabled={!canDeleteCloud}>
                      <Trash2 size={14} />
                      <span>{t('settings.projects.deleteCloud')}</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function AuthSettings({ config, onLogout }: Pick<AppSettingsModalProps, 'config' | 'onLogout'>) {
  const { t } = useI18n();
  return (
    <div className="settings-panel">
      <section className="settings-card settings-card--danger">
        <h3>{t('settings.auth.cancelTitle')}</h3>
        <p>{t('settings.auth.description')}</p>
        <SettingKV label="machine" value={config.machineLabel || 'unset'} />
        <SettingKV label="workspace" value={config.workspaceId || 'unset'} />
        <button className="settings-danger-action" type="button" onClick={onLogout}>
          <ShieldOff size={15} />
          <span>{t('settings.auth.cancelCurrent')}</span>
        </button>
      </section>
    </div>
  );
}

function AboutSettings({ config }: Pick<AppSettingsModalProps, 'config'>) {
  const { t } = useI18n();
  return (
    <div className="settings-panel">
      <section className="settings-card settings-about-card">
        <h3>{t('settings.about.title')}</h3>
        <p>{t('settings.about.description')}</p>
        <SettingKV label={t('settings.about.product')} value="Kari" />
        <SettingKV label={t('settings.about.version')} value={config.appVersion || 'unknown'} />
        <SettingKV label={t('settings.about.contact')} value="github.com/binsonzhang95-maker/kari" />
      </section>
    </div>
  );
}

function SettingKV({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-kv">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function localizeSettingsLastError(t: (key: I18nKey) => string, message: string): string {
  if (!message) return '';
  // Mapper emits some lastError values as i18n keys (e.g.
  // 'state.syncthing.feed_unavailable'); raw daemon errors come
  // through verbatim. translate() returns the key itself when no
  // entry exists, so the verbatim case is a graceful passthrough.
  const localized = t(message as unknown as I18nKey);
  return localized === message ? message : localized;
}

function projectProgress(project: ProjectItem) {
  // Phase 1d1: connectionState is mandatory; pre-connectionState
  // fallback removed. listProjects always populates it.
  const state = project.connectionState;
  if (!state) return 0;
  if (typeof state.completion === 'number') {
    return Math.max(0, Math.min(100, Math.round(state.completion)));
  }
  return state.openable ? 100 : 0;
}

function projectSettingsSyncStatus(project: ProjectItem, _progress: number, t: (key: I18nKey) => string) {
  // Derive status text from connectionState. cloud_only and
  // openable-idle rows show "Synced" (this row needs nothing).
  // Other states translate via state.* i18n keys (intent overrides
  // syncState for the user-facing verb).
  const state = project.connectionState;
  if (!state) return t('settings.projects.statusIdle');
  if (state.availability === 'cloud_only') return t('settings.projects.statusSynced');
  if (state.syncState === 'idle' && state.connectionIntent === null) {
    return t('settings.projects.statusSynced');
  }
  if (state.connectionIntent === 'attaching') return t('state.intent.attaching');
  if (state.connectionIntent === 'publishing') return t('state.intent.publishing');
  return t(`state.sync.${state.syncState}` as I18nKey);
}

function formatBytes(bytes: number) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let next = value / 1024;
  for (let i = 0; i < units.length; i += 1) {
    if (next < 1024 || i === units.length - 1) return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[i]}`;
    next /= 1024;
  }
  return `${value} B`;
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
