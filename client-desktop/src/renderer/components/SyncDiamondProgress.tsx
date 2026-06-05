import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProjectItem } from '../../shared/types';
import { translate, useI18n, type AppLanguage } from '../i18n';

export type SyncDirection = 'upload' | 'download';

// Per-card throttle interval for the percent segment animation.
// Background sync still runs continuously; the segment fill just
// repaints at most once per this window so the list doesn't flicker
// every poll tick. Direction / status pass through immediately so
// transitions stay snappy.
const PROGRESS_REPAINT_THROTTLE_MS = 60_000;

export function ProjectSyncDiamondProgress({
  project,
  fallback = 0,
  language,
  directional = false,
}: {
  project?: ProjectItem | null;
  fallback?: number;
  language?: AppLanguage;
  directional?: boolean;
}) {
  // Pull active language from context when caller doesn't pass one
  // explicitly. Pre-fix the default was 'zh' so English users saw
  // mixed-language UI for any non-idle connectionState. Codex round
  // 9 P3 pin.
  const ctx = useI18n();
  const effectiveLanguage = language ?? ctx.language;
  const liveValue = projectSyncProgress(project, fallback);
  const status = projectSyncStatus(project, effectiveLanguage);
  const direction = directional ? projectSyncDirection(project) : null;
  const displayedValue = useThrottledPercent(liveValue, status, direction);
  return (
    <SyncDiamondProgress
      value={displayedValue}
      status={status}
      direction={direction}
    />
  );
}

// useThrottledPercent gates segment-fill repaints to one per
// PROGRESS_REPAINT_THROTTLE_MS for steady-state percent drift. Edge
// transitions — initial render, status/direction change, reaching
// 100, dropping to 0 — pass through so the user still sees real
// state changes immediately.
function useThrottledPercent(value: number, status: string, direction: SyncDirection | null) {
  const [displayed, setDisplayed] = useState(value);
  const lastUpdateRef = useRef<number | null>(null);
  const lastEdgeKeyRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // latestValueRef holds whatever the parent most recently rendered
  // with. The timer's callback reads this ref so it always paints the
  // CURRENT value, not the value captured when the timer was armed.
  // Without this, a 1 Hz value-stream + 60 s throttle would freeze the
  // display on the first sample: every value tick re-runs the effect,
  // the cleanup kills the pending timer before it can fire, and the
  // new timer's `60s - elapsed` window keeps sliding forward as long
  // as fresh values keep arriving.
  const latestValueRef = useRef<number>(value);
  latestValueRef.current = value;
  useEffect(() => {
    const edgeKey = `${status}|${direction ?? ''}`;
    const now = Date.now();
    const edgeChanged = edgeKey !== lastEdgeKeyRef.current;
    const isTerminal = value >= 100 || value <= 0;
    const lastUpdate = lastUpdateRef.current;
    // Edge-transitions, first sample, and terminal values bypass the
    // throttle entirely — these are the moments the user MUST see
    // immediately (sync just started, sync just finished, state
    // changed direction).
    if (lastUpdate === null || edgeChanged || isTerminal) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastUpdateRef.current = now;
      lastEdgeKeyRef.current = edgeKey;
      setDisplayed(value);
      return;
    }
    // Steady-state percent drift: if a timer is already pending, leave
    // it alone — it'll fire at the original deadline and paint
    // whatever latestValueRef holds at that moment. If no timer is
    // armed yet, arm one for the remaining throttle window.
    if (timerRef.current !== null) return;
    const elapsed = now - lastUpdate;
    if (elapsed >= PROGRESS_REPAINT_THROTTLE_MS) {
      lastUpdateRef.current = now;
      setDisplayed(value);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastUpdateRef.current = Date.now();
      setDisplayed(latestValueRef.current);
    }, PROGRESS_REPAINT_THROTTLE_MS - elapsed);
  }, [value, status, direction]);
  // Clean up only on unmount — within-mount value churn must NOT kill
  // the in-flight timer (that's the whole bug we just fixed).
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);
  return displayed;
}

export function projectSyncProgress(project?: ProjectItem | null, fallback = 0) {
  if (!project) return normalizeSyncProgress(fallback) ?? 0;
  // Phase 1d1: connectionState is now mandatory — main.cjs's
  // listProjects always populates it. When absent (test fixtures,
  // direct ProjectItem construction outside the pipeline), fall
  // back to the caller's fallback rather than re-implementing the
  // legacy phase-driven heuristic.
  const state = project.connectionState;
  if (!state) return normalizeSyncProgress(fallback) ?? 0;
  if (typeof state.completion === 'number') {
    return Math.max(0, Math.min(100, state.completion));
  }
  return state.openable ? 100 : (normalizeSyncProgress(fallback) ?? 0);
}

export function projectSyncStatus(project?: ProjectItem | null, language: AppLanguage = 'zh-CN') {
  if (!project) return '';
  const state = project.connectionState;
  if (!state) return '';
  if (state.availability === 'cloud_only') return '';
  if (state.syncState === 'idle' && state.connectionIntent === null) return '';
  if (state.connectionIntent === 'attaching') return translate(language, 'state.intent.attaching');
  if (state.connectionIntent === 'publishing') return translate(language, 'state.intent.publishing');
  return translate(language, `state.sync.${state.syncState}`);
}

export function projectSyncDirection(project?: ProjectItem | null): SyncDirection | null {
  const state = project?.connectionState;
  if (!state) return null;
  if (state.syncState !== 'syncing' && state.syncState !== 'scanning') return null;
  if (state.connectionIntent === 'attaching') return 'download';
  if (state.connectionIntent === 'publishing') {
    if (state.availability === 'provisioning' && state.openable === false) return 'download';
    return 'upload';
  }
  return null;
}

export function projectSyncLabel(
  project?: ProjectItem | null,
  fallback = 0,
  language: AppLanguage = 'zh-CN',
  opts: { directional?: boolean } = {},
) {
  const percent = Math.round(projectSyncProgress(project, fallback));
  const direction = opts.directional ? projectSyncDirection(project) : null;
  if (direction === 'upload') return translate(language, 'sync.direction.uploading', { percent });
  if (direction === 'download') return translate(language, 'sync.direction.downloading', { percent });
  const status = projectSyncStatus(project, language);
  if (status) return status + ' · ' + percent + '%';
  if (percent >= 100) return translate(language, 'sync.synced');
  if (percent > 0) return translate(language, 'sync.syncing', { percent });
  return translate(language, 'sync.waiting');
}

function normalizeSyncProgress(value: unknown) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
}

export function SyncDiamondProgress({ value, status, direction }: { value: number; status?: string; direction?: SyncDirection | null }) {
  const segmentCount = 20;
  const percent = Math.round(Math.max(0, Math.min(100, value)));
  const filled = Math.round((percent / 100) * segmentCount);
  const title = status ? status + ' · ' + percent + '%' : percent + '%';
  const rootClass = [
    'sync-diamond-progress',
    direction ? 'sync-diamond-progress--active' : '',
    direction ? `sync-diamond-progress--${direction}` : '',
  ].filter(Boolean).join(' ');
  return (
    <span className={rootClass} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} title={title}>
      {Array.from({ length: segmentCount }, (_, index) => (
        <span
          key={index}
          className={index < filled ? 'sync-diamond-progress__segment sync-diamond-progress__segment--filled' : 'sync-diamond-progress__segment'}
          style={{
            '--sync-segment-index': index,
            '--sync-segment-reverse-index': segmentCount - index - 1,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}
