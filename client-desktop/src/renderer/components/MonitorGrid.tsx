import {
  Activity,
  Boxes,
  Clock3,
  GitBranch,
  Maximize2,
  Radio,
  Shield,
  TerminalSquare,
  X
} from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { DaemonStatus, FileTreeResult, SavedConfig, SessionItem, TerminalKind, TerminalMode } from '../../shared/types';
import { useI18n } from '../i18n';

interface MonitorGridProps {
  config: SavedConfig;
  daemon: DaemonStatus;
  tree: FileTreeResult | null;
  sessions: SessionItem[];
  expanded: string | null;
  onExpand: (id: string | null) => void;
  onNewTerminal: (kind: TerminalKind, mode?: TerminalMode, resumeSessionId?: string) => void;
}

export function MonitorGrid({ config, daemon, tree, sessions, expanded, onExpand, onNewTerminal }: MonitorGridProps) {
  const { t } = useI18n();
  const launchTerminal = (event: ReactMouseEvent<HTMLButtonElement>, kind: TerminalKind, mode: TerminalMode) => {
    event.currentTarget.blur();
    onNewTerminal(kind, mode);
  };

  const cards = [
    {
      id: 'connection',
      title: 'Connection',
      icon: Radio,
      metric: daemon.health,
      tone: daemon.health === 'online' ? 'ok' : 'bad',
      body: [
        ['connected', String(daemon.connected)],
        ['server', config.serverAddr || daemon.serverAddr || 'unset'],
        ['workspace', config.workspaceId || daemon.workspaceId || 'unset']
      ]
    },
    {
      id: 'files',
      title: 'File Index',
      icon: Boxes,
      metric: `${tree?.fileCount || 0}`,
      tone: tree?.fileCount ? 'ok' : 'warn',
      body: [
        ['dirs', String(tree?.directoryCount || 0)],
        ['bytes', formatBytes(tree?.totalBytes || 0)],
        ['root', config.workspaceRoot || 'unset']
      ]
    },
    {
      id: 'sync',
      title: 'Sync Queue',
      icon: Activity,
      metric: `${daemon.pendingOutbound}`,
      tone: daemon.pendingOutbound > 0 ? 'warn' : 'ok',
      body: [
        ['last_sync', formatTime(daemon.lastSyncAt)],
        ['last_activity', formatTime(daemon.lastActivityAt)],
        ['transfers', String(daemon.transferCount)]
      ]
    },
    {
      id: 'frp',
      title: 'FRP / SSH',
      icon: Shield,
      metric: daemon.frpState || 'disabled',
      tone: daemon.frpState === 'running' ? 'ok' : 'warn',
      body: [
        ['ssh', daemon.sshState],
        ['pty', String(daemon.ptyCount)],
        ['error', daemon.frpError || 'none']
      ]
    },
    {
      id: 'sessions',
      title: 'Sessions',
      icon: TerminalSquare,
      metric: `${sessions.length}`,
      tone: sessions.length > 0 ? 'ok' : 'neutral',
      body: [
        ['claude/codex', String(sessions.length)],
        ['new shell', 'available'],
        ['remote shell', 'available']
      ]
    },
    {
      id: 'git',
      title: 'Git Guard',
      icon: GitBranch,
      metric: ((daemon.raw as { uploads_paused?: boolean } | undefined)?.uploads_paused ? 'paused' : 'clear'),
      tone: (daemon.raw as { uploads_paused?: boolean } | undefined)?.uploads_paused ? 'warn' : 'ok',
      body: [
        ['local', (daemon.raw as { local_repo_url?: string } | undefined)?.local_repo_url || 'unknown'],
        ['peer', (daemon.raw as { peer_repo_url?: string } | undefined)?.peer_repo_url || 'unknown'],
        ['reason', (daemon.raw as { pause_reason?: string } | undefined)?.pause_reason || 'none']
      ]
    }
  ];

  if (expanded) {
    const card = cards.find((item) => item.id === expanded) || cards[0];
    return (
      <section className="monitor-expanded">
        <div className="monitor-expanded__head">
          <div>
            <span className="eyebrow">EXPANDED MONITOR</span>
            <h2>{card.title}</h2>
          </div>
          <button className="icon-btn" onClick={() => onExpand(null)} title={t('monitor.back')}><X size={17} /></button>
        </div>
        <div className={`mega-metric mega-metric--${card.tone}`}>{card.metric}</div>
        <div className="expanded-grid">
          {card.body.map(([label, value]) => (
            <div className="expanded-row" key={label}>
              <span>{label}</span>
              <strong title={value}>{value}</strong>
            </div>
          ))}
        </div>
        {card.id === 'sessions' && (
          <div className="quick-launch">
            <button onClick={(event) => launchTerminal(event, 'codex', 'remote')}>remote codex</button>
            <button onClick={(event) => launchTerminal(event, 'claude', 'remote')}>remote claude</button>
            <button onClick={(event) => launchTerminal(event, 'opencode', 'local')}>local opencode</button>
            <button onClick={(event) => launchTerminal(event, 'shell', 'remote')}>remote shell</button>
          </div>
        )}
        <div className="log-panel">
          <div><Clock3 size={14} /> live feed</div>
          <pre>{JSON.stringify(daemon.raw || {}, null, 2)}</pre>
        </div>
      </section>
    );
  }

  return (
    <section className="monitor-grid">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <article className={`monitor-card monitor-card--${card.tone}`} key={card.id}>
            <div className="monitor-card__head">
              <Icon size={18} />
              <span>{card.title}</span>
              <button className="icon-btn" onClick={() => onExpand(card.id)} title={t('monitor.maximize')}>
                <Maximize2 size={15} />
              </button>
            </div>
            <div className="monitor-card__metric">{card.metric}</div>
            <div className="monitor-card__body">
              {card.body.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong title={value}>{value}</strong>
                </div>
              ))}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value > 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(value: string) {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString();
}
