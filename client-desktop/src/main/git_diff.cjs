// Diff Viewer commit 1 — pure helpers used by gitDiffSummary /
// gitFileDiff IPC handlers in main.cjs. Extracted so unit tests
// can exercise the parse / detect / synthesize logic without
// Electron globals (per the upload_helpers.cjs pattern).

'use strict';

const fsp = require('fs/promises');

// Per plan §5 size caps. Constants exposed so callers + tests
// align on the same boundaries.
const MAX_PATCH_BYTES_PER_FILE = 256 * 1024; // 256 KB
const MAX_PATCH_BYTES_WORKSPACE = 2 * 1024 * 1024; // 2 MB
const BINARY_PROBE_BYTES = 8 * 1024; // 8 KB probe window for binary detect

// detectBinaryBuffer returns true when a Buffer should be treated
// as binary content. Heuristic per plan §5 (commit 1 untracked
// branch):
//   1. NUL byte in first BINARY_PROBE_BYTES → binary.
//   2. Else strict UTF-8 decode failure on the same window → binary.
// Empty buffer is NOT binary (caller may emit a zero-line synth
// patch).
function detectBinaryBuffer(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.length > BINARY_PROBE_BYTES ? buf.slice(0, BINARY_PROBE_BYTES) : buf;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

// detectBinaryPatch returns true when a `git diff HEAD` output for
// one file is one of Git's binary markers, NOT real text-based
// unified diff hunks. Used for TRACKED binary files since
// detectBinaryBuffer can't help (Git already swallowed the raw
// bytes). React-diff-view must NOT see these strings — they'd
// render as a single bogus line.
function detectBinaryPatch(patch) {
  if (!patch) return false;
  if (/^Binary files .+ and .+ differ$/m.test(patch)) return true;
  if (/^GIT binary patch$/m.test(patch)) return true;
  return false;
}

// parseUnifiedDiff splits aggregate `git diff HEAD` output into
// per-file objects. Each object:
//   { path, oldPath?, status, additions, deletions, patch, binary? }
//
// Status detection from Git's `diff --git` headers:
//   - `new file mode`     → added
//   - `deleted file mode` → deleted
//   - `rename from`/`to`  → renamed
//   - `copy from`/`to`    → copied
//   - else                → modified
//
// Untracked files are NOT in `git diff HEAD` output; they get
// synthesized separately via synthesizeUntrackedPatch.
//
// Files whose patch is one of Git's binary markers get
// `binary: true` + `patch: ''` so the renderer can branch cleanly.
function parseUnifiedDiff(aggregate) {
  if (!aggregate) return [];
  const lines = aggregate.split('\n');
  const out = [];
  let current = null;
  function flush() {
    if (current && current.path) out.push(current);
    current = null;
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      // diff --git a/<old> b/<new>. Literal UTF-8 paths parse via
      // this regex (Round-1 High #2 lock: callers MUST pass
      // `-c core.quotePath=false` to git so non-ASCII paths emerge
      // literal, not octal-quoted `"a/\NNN..."`). Quoted-form
      // paths fall through to no-match and the file is dropped —
      // a regression test (`tracked unicode quoted-form drops`)
      // pins this so a future caller forgetting the flag shows
      // up immediately.
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const newPath = m ? m[2] : '';
      const oldPath = m && m[1] !== m[2] ? m[1] : undefined;
      current = {
        path: newPath,
        oldPath,
        status: 'modified',
        additions: 0,
        deletions: 0,
        patch: line + '\n',
      };
      continue;
    }
    if (!current) continue;
    current.patch += line + '\n';
    if (line.startsWith('new file mode ')) current.status = 'added';
    else if (line.startsWith('deleted file mode ')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) current.status = 'renamed';
    else if (line.startsWith('copy from ')) current.status = 'copied';
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      // Skip — these are the patch headers, not content +/- lines.
    } else if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
  }
  flush();
  // Mark binary patches after parsing; keep status (added/modified/etc)
  // so renderer can still show the row, just not render diff body.
  for (const f of out) {
    if (detectBinaryPatch(f.patch)) {
      f.binary = true;
      f.patch = '';
    }
  }
  return out;
}

// synthesizeUntrackedPatch builds a synthetic `--- /dev/null +++ b/<path>`
// unified diff for an untracked file so react-diff-view can render it
// as an added file.
//
// Round-1 High fix #1 (memory bound): NEVER reads the full file
// into memory. Pre-fix used fsp.readFile() which would slurp a
// multi-GB untracked file before checking the size cap — easy OOM
// on user's repo with a vendored binary. Post-fix: open a file
// handle, read at most MAX_PATCH_BYTES_PER_FILE + 1 bytes (the +1
// lets us detect overflow without reading more). Binary probe
// reuses the same buffer (only needs first BINARY_PROBE_BYTES).
//
// Behaviours:
//   - File missing / unreadable → empty patch, not binary, not truncated.
//   - First BINARY_PROBE_BYTES window flagged binary → empty patch,
//     `binary: true`. (Memory note: the read window is
//     MAX_PATCH_BYTES_PER_FILE + 1 = 256 KB + 1 bytes regardless,
//     since one bounded read serves both the binary probe and the
//     subsequent patch emit. The point is the read is always
//     bounded — never the full file.)
//   - File length > MAX_PATCH_BYTES_PER_FILE → `truncated: true`,
//     content cut at the cap.
//   - File length ≤ cap → full content emitted.
async function synthesizeUntrackedPatch(absPath, relPath) {
  const base = {
    path: relPath,
    status: 'untracked',
    additions: 0,
    deletions: 0,
    patch: '',
    truncated: false,
    binary: false,
  };
  const stat = await fsp.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) return base;

  // Open handle so we can read a bounded window regardless of file
  // size. Read cap + 1 so a single byte over the cap surfaces as
  // truncated (we'd see bytesRead === cap + 1 only when stat.size
  // is also that — but the +1 read protects against stat being
  // stale).
  const readCap = MAX_PATCH_BYTES_PER_FILE + 1;
  let fh;
  try {
    fh = await fsp.open(absPath, 'r');
  } catch {
    return base;
  }
  let buf;
  try {
    const ab = Buffer.alloc(readCap);
    const { bytesRead } = await fh.read(ab, 0, readCap, 0);
    buf = ab.slice(0, bytesRead);
  } catch {
    await fh.close().catch(() => {});
    return base;
  } finally {
    await fh.close().catch(() => {});
  }
  if (buf.length === 0) {
    // Empty file — emit header-only patch (matches deleted-file
    // shape but inverted; renderer shows "new empty file").
    return {
      ...base,
      patch: `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n`,
    };
  }
  if (detectBinaryBuffer(buf)) {
    return { ...base, binary: true };
  }
  let truncated = false;
  let working = buf;
  if (buf.length > MAX_PATCH_BYTES_PER_FILE) {
    truncated = true;
    working = buf.slice(0, MAX_PATCH_BYTES_PER_FILE);
  }
  const text = working.toString('utf8');
  const hasTrailingNewline = text.endsWith('\n');
  const contentLines = text.length === 0
    ? []
    : (hasTrailingNewline ? text.slice(0, -1).split('\n') : text.split('\n'));
  const additions = contentLines.length;
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n`;
  const hunkHeader = additions > 0 ? `@@ -0,0 +1,${additions} @@\n` : '';
  const body = contentLines.map((l) => '+' + l).join('\n');
  const patch = additions > 0 ? header + hunkHeader + body + '\n' : header;
  return {
    ...base,
    additions,
    patch,
    truncated,
  };
}

// statusFromPorcelain maps `git status --porcelain=v1` two-char
// status codes to the GitDiffFile.status enum. Both staged (X) and
// unstaged (Y) columns are considered — plan §5 lock: Phase 1 shows
// changes since HEAD (staged + unstaged), so any non-space in
// either column means the file has changes worth showing.
function statusFromPorcelain(code) {
  if (!code || code.length < 2) return 'unknown';
  if (code === '??') return 'untracked';
  const x = code[0];
  const y = code[1];
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'M' || y === 'M') return 'modified';
  return 'unknown';
}

// applyWorkspaceCap zeroes out individual file patches once the
// running total has crossed MAX_PATCH_BYTES_WORKSPACE. Mutates each
// file in place, returns true when the cap was hit (summary should
// then carry truncated:true).
function applyWorkspaceCap(files) {
  let total = 0;
  let capHit = false;
  for (const f of files) {
    if (!f.patch) continue;
    if (f.patch.length > MAX_PATCH_BYTES_PER_FILE) {
      f.truncated = true;
      f.patch = '';
      continue;
    }
    if (total + f.patch.length > MAX_PATCH_BYTES_WORKSPACE) {
      capHit = true;
      f.truncated = true;
      f.patch = '';
      continue;
    }
    total += f.patch.length;
  }
  return capHit;
}

module.exports = {
  MAX_PATCH_BYTES_PER_FILE,
  MAX_PATCH_BYTES_WORKSPACE,
  BINARY_PROBE_BYTES,
  detectBinaryBuffer,
  detectBinaryPatch,
  parseUnifiedDiff,
  synthesizeUntrackedPatch,
  statusFromPorcelain,
  applyWorkspaceCap,
};
