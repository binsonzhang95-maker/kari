'use strict';

const fsp = require('fs/promises');
const path = require('path');

const INTERNAL_ONLY_ENTRIES = new Set([
  '.kari',
  '.kari-engine',
  '.gitignore',
  '.stfolder',
  '.stignore',
  '.DS_Store',
]);

async function prepareCloneLocalTarget(projectsRoot, target, workspaceName) {
  const root = path.resolve(String(projectsRoot || ''));
  const absolute = path.resolve(String(target || ''));
  if (!isInside(root, absolute) || absolute === root) {
    return { ok: false, code: 'clone_target_outside_projects_root', error: 'clone target is outside projects root' };
  }

  const stat = await fsp.stat(absolute).catch((err) => {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat) {
    await fsp.mkdir(absolute, { recursive: true });
    return { ok: true, archived: false, created: true, path: absolute };
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'clone_target_not_directory', error: 'clone target exists but is not a directory' };
  }

  const hasContent = await hasUserProjectContent(absolute);
  if (!hasContent) {
    await fsp.rm(absolute, { recursive: true, force: true });
    await fsp.mkdir(absolute, { recursive: true });
    return { ok: true, archived: false, cleared: true, path: absolute };
  }

  const archivePath = await uniqueArchivePath(root, workspaceName || path.basename(absolute));
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  await fsp.rename(absolute, archivePath);
  await fsp.mkdir(absolute, { recursive: true });
  return { ok: true, archived: true, archivePath, path: absolute };
}

async function hasUserProjectContent(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => !INTERNAL_ONLY_ENTRIES.has(entry.name));
}

async function uniqueArchivePath(root, workspaceName) {
  const label = archiveLabel(workspaceName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(root, '.archive', `clone-replaced-${label}-${ts}`);
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    const exists = await fsp.stat(candidate).then(() => true).catch(() => false);
    if (!exists) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function archiveLabel(value) {
  return String(value || 'project')
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  prepareCloneLocalTarget,
  hasUserProjectContent,
};
