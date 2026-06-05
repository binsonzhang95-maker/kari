// Diff Viewer commit 2 — read-only Changes review surface.
//
// Component contract (declarative, no IPC inside):
//   - `summary` is the GitDiffSummary from `window.kari.gitDiffSummary()`.
//     Parent (App.tsx, commit 3) owns fetch + cache + refresh; this
//     component just renders.
//   - `loading` shows a spinner-like header chip.
//   - `lastFetchedIso` powers the "Last fetched at HH:MM:SS" line.
//   - `onRefresh` / `onOpenFile` / `onCopyDiff` wire the actions in
//     commit 3.
//
// The view is unified by default per plan §3 (mobile-first). Split
// view is opt-in via the toggle and only meaningful when the parent
// container is wide.

import { useMemo, useState, useCallback } from 'react';
import { Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { Cloud, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import type { GitDiffFile, GitDiffFileStatus, GitDiffSummary } from '../../shared/types';
import { adaptFile, formatFetchTime } from '../diffView';
import { useI18n, type I18nKey } from '../i18n';

type DiffViewMode = 'unified' | 'split';

// Round-1 High fix: onCopyDiff must see file metadata so the parent
// can enforce plan §3 "Copy diff truncated/binary must warn or
// refuse". Pre-fix signature passed only the raw patch string, so
// commit 3 couldn't tell whether the patch is partial. With the
// metadata payload the parent can prepend a warning header or
// outright reject.
export interface DiffCopyRequest {
  patch: string;
  path: string;
  truncated: boolean;
  binary: boolean;
}

interface DiffReviewPanelProps {
  summary: GitDiffSummary | null;
  loading?: boolean;
  lastFetchedIso?: string | null;
  onRefresh?: () => void;
  onOpenFile?: (relPath: string) => void;
  onCopyDiff?: (request: DiffCopyRequest) => void;
}

export function DiffReviewPanel({
  summary,
  loading = false,
  lastFetchedIso = null,
  onRefresh,
  onOpenFile,
  onCopyDiff,
}: DiffReviewPanelProps) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified');
  const adapted = useMemo(() => {
    if (!summary || !summary.files) return [];
    return summary.files.map(adaptFile);
  }, [summary]);

  // Header counts
  const fileCount = adapted.length;
  const totalAdditions = adapted.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = adapted.reduce((sum, f) => sum + f.deletions, 0);

  const handleOpen = useCallback((file: GitDiffFile) => {
    if (onOpenFile) onOpenFile(file.path);
  }, [onOpenFile]);
  const handleCopy = useCallback((req: DiffCopyRequest) => {
    if (onCopyDiff) onCopyDiff(req);
  }, [onCopyDiff]);

  if (!summary) {
    return (
      <div className="diff-review-panel diff-review-panel--empty" role="status" aria-live="polite">
        <p>{t('diff.empty')}</p>
        {onRefresh && (
          <button className="diff-review-action" type="button" onClick={onRefresh}>
            <RefreshCw size={13} />
            <span>{t('diff.refresh')}</span>
          </button>
        )}
      </div>
    );
  }

  if (!summary.ok) {
    return (
      <div className="diff-review-panel diff-review-panel--empty" role="status" aria-live="polite">
        <p>{t('diff.loadFailed', { error: summary.error || t('diff.unknownError') })}</p>
        {onRefresh && (
          <button className="diff-review-action" type="button" onClick={onRefresh}>
            <RefreshCw size={13} />
            <span>{t('diff.retry')}</span>
          </button>
        )}
      </div>
    );
  }

  if (!summary.isGit) {
    return (
      <div className="diff-review-panel diff-review-panel--empty" role="status" aria-live="polite">
        <Cloud size={20} aria-hidden="true" />
        <p>{t('diff.notGit')}</p>
      </div>
    );
  }

  if (fileCount === 0) {
    return (
      <div className="diff-review-panel diff-review-panel--empty" role="status" aria-live="polite">
        <p>{t('diff.noChanges')}</p>
        <div className="diff-review-panel__fetched">
          <span>{t('diff.lastFetched', { time: formatFetchTime(lastFetchedIso) })}</span>
          {onRefresh && (
            <button className="diff-review-action" type="button" onClick={onRefresh}>
              <RefreshCw size={13} />
              <span>{t('diff.refresh')}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="diff-review-panel" role="tabpanel" aria-label={t('diff.ariaLabel')}>
      <header className="diff-review-panel__header">
        <div className="diff-review-panel__title">
          <strong>{fileCount}</strong>
          <span>{t('diff.fileCount')}</span>
          <span className="diff-review-panel__add">+{totalAdditions}</span>
          <span> / </span>
          <span className="diff-review-panel__del">-{totalDeletions}</span>
        </div>
        <div className="diff-review-panel__header-actions">
          <span className="diff-review-panel__fetched-inline">
            {t('diff.lastFetched', { time: formatFetchTime(lastFetchedIso) })}
          </span>
          <div className="diff-review-panel__view-toggle">
            <button
              type="button"
              className={viewMode === 'unified' ? 'is-active' : ''}
              aria-pressed={viewMode === 'unified'}
              onClick={() => setViewMode('unified')}
            >
              {t('diff.unified')}
            </button>
            <button
              type="button"
              className={viewMode === 'split' ? 'is-active' : ''}
              aria-pressed={viewMode === 'split'}
              onClick={() => setViewMode('split')}
            >
              {t('diff.split')}
            </button>
          </div>
          {onRefresh && (
            <button
              className="diff-review-action"
              type="button"
              onClick={onRefresh}
              disabled={loading}
              title={loading ? t('diff.loadingTitle') : t('diff.refresh')}
            >
              <RefreshCw size={13} className={loading ? 'is-spinning' : ''} />
              <span>{loading ? t('diff.loading') : t('diff.refresh')}</span>
            </button>
          )}
        </div>
      </header>

      {summary.truncated && (
        <div className="diff-review-panel__banner diff-review-panel__banner--warning" role="status" aria-live="polite">
          {t('diff.previewTruncated')}
        </div>
      )}

      <div className="diff-review-panel__files">
        {adapted.map((file) => {
          // Diff Viewer commit 4 polish: sourceFile is the unmapped
          // GitDiffFile that backs this AdaptedFile. Used to fire
          // onOpenFile with the canonical path (incl. correct
          // oldPath for renames). Pre-fix the Open button used a
          // `summary.files[0]` fallback which would open file #0 if
          // the path match failed — a real bug for missing entries.
          // Now sourceFile is exhaustively matched and missing →
          // synthesizes from AdaptedFile (still no fallback to a
          // different file).
          const sourceFile: GitDiffFile = summary.files.find((candidate) => (
            candidate.path === file.newPath
              && (candidate.oldPath || candidate.path) === file.oldPath
          )) || summary.files.find((candidate) => candidate.path === file.newPath) || {
            path: file.newPath,
            oldPath: file.oldPath !== file.newPath ? file.oldPath : undefined,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch,
            truncated: file.truncated,
            binary: file.binary,
          };
          return (
          <article
            key={file.key}
            className={`diff-file-card diff-file-card--${file.status}`}
            tabIndex={0}
            aria-label={`${file.newPath}, ${diffStatusLabel(file.status, t)}, +${file.additions}, -${file.deletions}`}
          >
            <header className="diff-file-card__header">
              <span className={`diff-file-card__status diff-file-card__status--${file.status}`}>
                {diffStatusLabel(file.status, t)}
              </span>
              <span className="diff-file-card__path" title={file.newPath}>
                {file.oldPath !== file.newPath ? (
                  <>
                    <s>{file.oldPath}</s>
                    {' → '}
                    {file.newPath}
                  </>
                ) : (
                  file.newPath
                )}
              </span>
              <span className="diff-file-card__counts">
                <span className="diff-review-panel__add">+{file.additions}</span>
                {' '}
                <span className="diff-review-panel__del">-{file.deletions}</span>
              </span>
              <div className="diff-file-card__actions">
                {onOpenFile && (
                  <button
                    type="button"
                    className="diff-review-action diff-review-action--compact"
                    onClick={() => handleOpen(sourceFile)}
                    title={t('diff.openInEditor')}
                    aria-label={t('diff.openInEditor')}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
                {onCopyDiff && file.patch && !file.binary && (
                  <button
                    type="button"
                    className="diff-review-action diff-review-action--compact"
                    onClick={() => handleCopy({
                      patch: file.patch,
                      path: file.newPath,
                      truncated: file.truncated,
                      binary: file.binary,
                    })}
                    title={file.truncated ? t('diff.copyTruncated') : t('diff.copy')}
                    aria-label={file.truncated ? t('diff.copyTruncated') : t('diff.copy')}
                  >
                    <Copy size={12} />
                  </button>
                )}
              </div>
            </header>

            <div className="diff-file-card__body">
              {file.binary && (
                <div className="diff-file-card__notice">
                  {t('diff.binary')}
                </div>
              )}
              {file.truncated && !file.binary && (
                <div className="diff-file-card__notice diff-file-card__notice--truncated">
                  {t('diff.fileTruncated')}
                </div>
              )}
              {file.parsed && !file.binary && !file.truncated && (
                <Diff
                  viewType={viewMode}
                  diffType={file.parsed.type}
                  hunks={file.parsed.hunks}
                >
                  {(hunks) => hunks.map((hunk) => (
                    <Hunk key={hunk.content} hunk={hunk} />
                  ))}
                </Diff>
              )}
            </div>
          </article>
          );
        })}
      </div>
    </div>
  );
}

function diffStatusLabel(status: GitDiffFileStatus, t: (key: I18nKey) => string): string {
  const key = `diff.status.${status}` as I18nKey;
  return t(key) || t('diff.status.unknown');
}
