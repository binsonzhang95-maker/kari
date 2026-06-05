import { useState } from 'react';
import { CloudUpload } from 'lucide-react';
import type { DaemonStatus, ProjectItem, SavedConfig, SyncthingState } from '../../shared/types';
import { useI18n } from '../i18n';
import { WindowControls, useWindowState } from './WindowChrome';

interface StatusBarProps {
  config: SavedConfig;
  daemon: DaemonStatus;
  // Phase 4.3 (syncthing migration): live event-folded state from
  // main's syncthing_event_subscriber. null until first push lands.
  syncthingState: SyncthingState | null;
  statusLine: string;
  onBackToProjects: () => void;
  showBackToProjects: boolean;
  // Current project context — null when on the project-list view (the
  // "上传到云端" button hides without it). When non-null, the button
  // is rendered to the LEFT of WindowControls (i.e. top-right of the
  // status bar, just inside the window-chrome buttons).
  currentProject?: ProjectItem | null;
  // Async upload handler — App.tsx wires this to window.kari.
  // uploadProject(currentProject.path, currentProject). The handler
  // is responsible for surfacing success/failure toasts itself; this
  // component only manages the local "in-flight" state for the
  // button's disabled visual.
  onUploadCurrentToCloud?: (project: ProjectItem) => Promise<void>;
}

export function StatusBar({ daemon, syncthingState, onBackToProjects, showBackToProjects, currentProject, onUploadCurrentToCloud }: StatusBarProps) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);
  const windowState = useWindowState();
  const isMac = windowState.platform === 'darwin';
  // Phase 4.4 (syncthing migration cleanup): the explicit "upload to
  // cloud" gesture is obsolete once syncthing is active — every save
  // auto-propagates via BEP. daemon.raw.syncthing.running surfaces
  // the live syncthing child state from main process.
  const syncthingActive = Boolean(
    (daemon as DaemonStatus & { raw?: { syncthing?: { running?: boolean } } })
      .raw?.syncthing?.running,
  );
  const canUpload = !syncthingActive && !!currentProject && !!onUploadCurrentToCloud && currentProject.source === 'local' && !uploading;
  const handleUploadClick = async () => {
    if (!currentProject || !onUploadCurrentToCloud) return;
    setUploading(true);
    try {
      await onUploadCurrentToCloud(currentProject);
    } finally {
      setUploading(false);
    }
  };
  const brand = (
    <div className="status-brand" aria-label="Kari">
      <svg className="status-brand__moon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <defs>
          <linearGradient id="status-brand-moon-light" x1="4" y1="2" x2="14" y2="16" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff8df" />
            <stop offset=".55" stopColor="#d1a85c" />
            <stop offset="1" stopColor="#b58b46" />
          </linearGradient>
          <mask id="status-brand-moon-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
            <rect width="18" height="18" fill="black" />
            <circle cx="8.4" cy="9.2" r="6.4" fill="white" />
            <circle className="brand-moon__shadow" cx="11.6" cy="7.8" r="6.3" fill="black" />
          </mask>
        </defs>
        <g transform="rotate(-18 9 9)">
          <rect width="18" height="18" fill="url(#status-brand-moon-light)" mask="url(#status-brand-moon-mask)" />
        </g>
      </svg>
      <span>KARI</span>
    </div>
  );
  const backToProjects = showBackToProjects ? (
    <button className="status-back-projects" type="button" onClick={onBackToProjects} title={t('status.backToProjectsTitle')}>
      {t('status.backToProjects')}
    </button>
  ) : null;
  // syncthing's BEP-peer view, collapsed to one of three labels:
  //   disconnected — process down, OR no peers configured, OR every
  //     known peer's connected=false (server unreachable)
  //   connecting   — at least one peer in config, none yet handshaked
  //                  (typical for the ~1s window after pair-info)
  //   connected    — at least one peer with connected=true
  // peerCount==0 maps to 'disconnected' rather than a separate
  // "未配置" state because, post-PTY-driven-sync, the only way to
  // have zero peers is "nothing is paired yet" — visually identical
  // to "no server reachable" for the user's purposes.
  const peerEntries = syncthingState ? Object.values(syncthingState.peers) : [];
  const peerCount = peerEntries.length;
  const peerUp = peerEntries.filter((p) => p && p.connected).length;
  const syncStateKey: 'syncthing.disconnected' | 'syncthing.connecting' | 'syncthing.connected' =
    !syncthingState
      ? 'syncthing.disconnected'
      : peerCount === 0 || peerUp === 0
        ? (peerCount === 0 ? 'syncthing.disconnected' : 'syncthing.connecting')
        : 'syncthing.connected';
  const syncTone: 'ok' | 'warn' | 'bad' =
    syncStateKey === 'syncthing.connected' ? 'ok'
    : syncStateKey === 'syncthing.connecting' ? 'warn'
    : 'bad';
  const inRate = syncthingState?.traffic?.inBytesPerSec || 0;
  const outRate = syncthingState?.traffic?.outBytesPerSec || 0;
  const hasTraffic = inRate > 0 || outRate > 0;
  const daemonValueKey: 'statusbar.daemon.online' | 'statusbar.daemon.offline' | 'statusbar.daemon.unknown' =
    daemon.health === 'online' ? 'statusbar.daemon.online'
    : daemon.health === 'offline' ? 'statusbar.daemon.offline'
    : 'statusbar.daemon.unknown';
  const pills = (
    <>
      <StatusPill label={t('statusbar.label.daemon')} value={t(daemonValueKey)} tone={daemon.health === 'online' ? 'ok' : 'bad'} />
      <StatusPill label={t('statusbar.label.sync')} value={t(syncStateKey)} tone={syncTone} />
      {syncthingState && (
        <StatusPill
          label={t('statusbar.label.net')}
          value={`↑${formatRate(outRate)} ↓${formatRate(inRate)}`}
          tone={hasTraffic ? 'ok' : 'neutral'}
          title={t('statusbar.net.title')}
        />
      )}
      <StatusPill label={t('statusbar.label.pty')} value={String(daemon.ptyCount)} tone={daemon.ptyCount > 0 ? 'ok' : 'neutral'} />
    </>
  );
  const uploadAffordance = !syncthingActive && currentProject && currentProject.source === 'local' && onUploadCurrentToCloud ? (
    <button
      className="status-upload-cloud"
      type="button"
      onClick={handleUploadClick}
      disabled={!canUpload}
      title={uploading ? t('status.uploadingToCloudTitle') : t('status.uploadToCloudTitle')}
    >
      <CloudUpload size={14} aria-hidden="true" />
      <span>{uploading ? t('status.uploadingToCloud') : t('status.uploadToCloud')}</span>
    </button>
  ) : null;
  const autoSyncPill = syncthingActive && currentProject && currentProject.source === 'local' ? (
    <span className="status-pill status-pill--ok" title={t('sync.autoSyncing')} aria-label={t('sync.autoSyncing')}>
      <span>sync</span>
      <strong>{t('sync.auto')}</strong>
    </span>
  ) : null;
  const windowControls = <WindowControls state={windowState} />;
  // macOS: traffic-light buttons on the LEFT, info area (status pills,
  // upload affordance, sync pill) in the middle, KARI brand pinned to
  // the right edge. Mirrors the system convention where window chrome
  // lives on the left.
  // Non-mac: brand on the LEFT, info area middle, chrome buttons on the
  // RIGHT (Windows/Linux convention).
  if (isMac) {
    return (
      <header className="status-bar status-bar--mac" data-mac-fullscreen={windowState.fullscreen ? 'true' : undefined}>
        {windowControls}
        {backToProjects}
        {pills}
        <div className="status-spacer" />
        {uploadAffordance}
        {autoSyncPill}
        {brand}
      </header>
    );
  }
  return (
    <header className="status-bar">
      {brand}
      {backToProjects}
      {pills}
      <div className="status-spacer" />
      {uploadAffordance}
      {autoSyncPill}
      {windowControls}
    </header>
  );
}

function StatusPill({ label, value, tone, title }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; title?: string }) {
  return (
    <div className={`status-pill status-pill--${tone}`} title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatRate(bytesPerSecond: number): string {
  const bytes = Math.max(0, Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0);
  if (bytes < 1024) return `${Math.round(bytes)}B/s`;
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)}${units[unitIndex]}`;
}
