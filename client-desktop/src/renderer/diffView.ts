// Diff Viewer commit 2 — renderer-side parse/adapter helpers. The
// shape react-diff-view consumes (FileData[] from `parseDiff`) is
// close to but not identical to GitDiffFile from the IPC layer.
// These helpers keep the adaptation in one place so the panel
// component stays declarative.

import { parseDiff } from 'react-diff-view';
import type { GitDiffFile, GitDiffFileStatus } from '../shared/types';

// FileData is react-diff-view's per-file shape:
//   { type, oldRevision, newRevision, oldPath, newPath, hunks, ... }
// We only care about a subset for rendering.
export interface AdaptedFile {
  key: string;
  status: GitDiffFileStatus;
  oldPath: string;
  newPath: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  // null when binary / truncated / patch empty — renderer branches.
  parsed: ReturnType<typeof parseDiff>[number] | null;
  // Raw unified diff string preserved so `Copy diff` can ship it
  // verbatim without round-tripping through react-diff-view AST.
  patch: string;
}

// adaptFile converts one GitDiffFile (from IPC) to the panel-side
// AdaptedFile. Files with empty patch (binary OR truncated) get
// `parsed: null` and the renderer shows a non-diff state.
export function adaptFile(file: GitDiffFile): AdaptedFile {
  const key = file.oldPath
    ? `${file.oldPath}→${file.path}`
    : file.path;
  const out: AdaptedFile = {
    key,
    status: file.status,
    oldPath: file.oldPath || file.path,
    newPath: file.path,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary === true,
    truncated: file.truncated === true,
    parsed: null,
    patch: file.patch || '',
  };
  if (out.binary || out.truncated || !out.patch) return out;
  try {
    const parsedList = parseDiff(out.patch);
    out.parsed = parsedList[0] || null;
  } catch {
    // Parse failure — show the truncated banner rather than crash.
    out.truncated = true;
    out.parsed = null;
  }
  return out;
}

// statusBadgeLabel maps the IPC status to a short locale-neutral label
// for the per-file card chip. Visible panels use i18n-aware helpers.
export function statusBadgeLabel(status: GitDiffFileStatus): string {
  switch (status) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'untracked': return 'U';
    case 'unknown':
    default: return '?';
  }
}

// formatFetchTime renders a Last-fetched timestamp (per plan §3).
// Empty input → '—' (no fetch yet).
export function formatFetchTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
