'use strict';

const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ACTIVE_STATES = new Set(['queued', 'migrating', 'uploading', 'running']);

function createProjectImportQueueStore({ dbPath, execFile, now } = {}) {
  if (!dbPath) throw new Error('project_import_queue_store: dbPath is required');
  const exec = typeof execFile === 'function' ? execFile : cp.execFile;
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();
  let sqliteChain = Promise.resolve();

  function runSql(sql) {
    const task = sqliteChain.then(() => sqliteExec(exec, dbPath, sql));
    sqliteChain = task.catch(() => {});
    return task;
  }

  async function init() {
    await fsp.mkdir(path.dirname(dbPath), { recursive: true });
    await runSql([
      // WAL (write context; stdout not parsed) so the shared config.sqlite
      // lets the config read and queue writes proceed without blocking.
      'PRAGMA journal_mode=WAL;',
      'create table if not exists ProjectImportQueue (',
      'id text primary key,',
      'source_path text not null,',
      'workspace_name text not null,',
      'state text not null,',
      'attempts integer not null default 0,',
      'payload_json text not null,',
      'error text not null default \'\',',
      'created_at text not null,',
      'updated_at text not null,',
      'started_at text not null default \'\',',
      'finished_at text not null default \'\'',
      ');',
      'create index if not exists idx_project_import_queue_state_order on ProjectImportQueue(state, created_at, id);',
    ].join('\n'));
    await fsp.chmod(dbPath, 0o600).catch(() => null);
  }

  async function enqueue(input) {
    await init();
    const sourcePath = String(input && input.sourcePath || '');
    const workspaceName = String(input && input.workspaceName || '');
    if (!sourcePath) throw new Error('project_import_queue_store: sourcePath is required');
    if (!workspaceName) throw new Error('project_import_queue_store: workspaceName is required');
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    const createdAt = clock();
    const payload = input && input.payload && typeof input.payload === 'object'
      ? input.payload
      : { sourcePath, workspaceName };
    // Durable, atomic dedupe: insert ONLY when no non-terminal job
    // already exists for this exact source path. Doing it as a single
    // `insert ... select ... where not exists` (not a read-then-insert
    // pair) is what makes it race-safe — runSql serializes whole
    // statements on sqliteChain, so two concurrent same-path enqueues
    // run in series and the second's guard sees the first's row and
    // suppresses the duplicate. Guards against double-clicks, a
    // re-enqueue from another window, and the Upload-button race where
    // the card's sync state hasn't yet caught up to "import in flight".
    // Terminal jobs (succeeded/failed) don't block a fresh re-import.
    const activeIn = [...ACTIVE_STATES].map(sqliteString).join(',');
    await runSql([
      'insert into ProjectImportQueue(id, source_path, workspace_name, state, attempts, payload_json, error, created_at, updated_at, started_at, finished_at)',
      `select ${sqliteString(id)}, ${sqliteString(sourcePath)}, ${sqliteString(workspaceName)}, 'queued', 0, ${sqliteString(JSON.stringify(payload))}, '', ${sqliteString(createdAt)}, ${sqliteString(createdAt)}, '', ''`,
      `where not exists (select 1 from ProjectImportQueue where source_path=${sqliteString(sourcePath)} and state in (${activeIn}));`,
    ].join(' '));
    // Resolve the job that now represents this path. Prefer an active one
    // (the row we just inserted, or the pre-existing active dup the guard
    // kept us from duplicating). The fallback to the path's latest row
    // closes the narrow window where a worker transitions the row to a
    // terminal state between the insert above and this read (separate
    // sqliteChain links): we still return a real, just-finished job for
    // the path rather than null.
    const pathRows = await selectRows(`where source_path=${sqliteString(sourcePath)}`);
    const activeForPath = pathRows.filter((job) => ACTIVE_STATES.has(job.state));
    return activeForPath.find((job) => job.id === id)
      || activeForPath[0]
      || pathRows[pathRows.length - 1]
      || getById(id);
  }

  async function recoverInterrupted() {
    await init();
    const before = await listByStates(['running', 'migrating', 'uploading']);
    if (before.length === 0) return 0;
    const updatedAt = clock();
    await runSql([
      'update ProjectImportQueue',
      `set state='queued', updated_at=${sqliteString(updatedAt)}, started_at='', error=''`,
      "where state in ('running','migrating','uploading');",
    ].join(' '));
    return before.length;
  }

  async function claimNext() {
    await init();
    const queued = await listByStates(['queued']);
    const job = queued[0] || null;
    if (!job) return null;
    const updatedAt = clock();
    await runSql([
      'update ProjectImportQueue',
      `set state='migrating', attempts=attempts+1, updated_at=${sqliteString(updatedAt)}, started_at=${sqliteString(updatedAt)}, error=''`,
      `where id=${sqliteString(job.id)} and state='queued';`,
    ].join(' '));
    return getById(job.id);
  }

  async function markUploading(id) {
    await init();
    const updatedAt = clock();
    await runSql([
      'update ProjectImportQueue',
      `set state='uploading', updated_at=${sqliteString(updatedAt)}, error=''`,
      `where id=${sqliteString(id)} and state in ('running','migrating','uploading');`,
    ].join(' '));
    return getById(id);
  }

  async function markSucceeded(id) {
    await init();
    const updatedAt = clock();
    await runSql([
      'update ProjectImportQueue',
      `set state='succeeded', updated_at=${sqliteString(updatedAt)}, finished_at=${sqliteString(updatedAt)}, error=''`,
      `where id=${sqliteString(id)};`,
    ].join(' '));
    return getById(id);
  }

  async function markFailed(id, error) {
    await init();
    const updatedAt = clock();
    await runSql([
      'update ProjectImportQueue',
      `set state='failed', updated_at=${sqliteString(updatedAt)}, finished_at=${sqliteString(updatedAt)}, error=${sqliteString(error)}`,
      `where id=${sqliteString(id)};`,
    ].join(' '));
    return getById(id);
  }

  async function getById(id) {
    await init();
    const rows = await selectRows(`where id=${sqliteString(id)}`);
    return rows[0] || null;
  }

  async function listActive() {
    await init();
    return listByStates([...ACTIVE_STATES]);
  }

  async function listByStates(states) {
    const clean = states.map((state) => String(state || '')).filter(Boolean);
    if (!clean.length) return [];
    const quoted = clean.map(sqliteString).join(',');
    return selectRows(`where state in (${quoted})`);
  }

  async function selectRows(whereClause) {
    if (!fs.existsSync(dbPath)) return [];
    const sql = [
      "select id || char(31) || source_path || char(31) || workspace_name || char(31) || state || char(31) || attempts || char(31) || created_at || char(31) || updated_at || char(31) || started_at || char(31) || finished_at || char(31) || error || char(31) || payload_json",
      'from ProjectImportQueue',
      whereClause || '',
      'order by created_at asc, id asc;',
    ].join(' ');
    const stdout = await runSql(sql);
    return parseRows(stdout);
  }

  return {
    init,
    enqueue,
    recoverInterrupted,
    claimNext,
    markUploading,
    markSucceeded,
    markFailed,
    getById,
    listActive,
  };
}

function parseRows(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\x1f');
    if (parts.length < 11) continue;
    const payloadRaw = parts.slice(10).join('\x1f');
    let payload = {};
    try {
      payload = JSON.parse(payloadRaw || '{}');
    } catch {
      payload = {};
    }
    rows.push({
      id: parts[0],
      sourcePath: parts[1],
      workspaceName: parts[2],
      state: parts[3],
      attempts: Number(parts[4] || 0),
      createdAt: parts[5],
      updatedAt: parts[6],
      startedAt: parts[7],
      finishedAt: parts[8],
      error: parts[9],
      payload,
    });
  }
  return rows;
}

function sqliteExec(execFile, dbPath, sql) {
  return new Promise((resolve, reject) => {
    // SILENT `.timeout` dot-command — a `PRAGMA busy_timeout=...;` would echo
    // "5000" into stdout and corrupt parsed reads (it shares config.sqlite with
    // the config layer). WAL is set via write-only SQL at init.
    execFile('sqlite3', ['-batch', '-noheader', '-cmd', '.timeout 5000', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout || '');
    });
  });
}

function sqliteString(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

module.exports = {
  createProjectImportQueueStore,
};
