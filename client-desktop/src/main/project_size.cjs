'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function normalizeRel(relPath) {
  return String(relPath || '').split(path.sep).join('/');
}

function isSyncthingLocalOnlyRel(relPath) {
  const rel = normalizeRel(relPath);
  return rel === '.stignore' || rel === '.stfolder' || rel.startsWith('.stfolder/');
}

async function directoryFileBytes(root, options = {}) {
  try {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  const shouldIgnore = typeof options.shouldIgnore === 'function'
    ? options.shouldIgnore
    : null;
  let total = 0;
  async function walk(dir, relDir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRel = relDir ? relDir + '/' + entry.name : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (shouldIgnore && shouldIgnore(childRel, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(childAbs).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  }
  await walk(root, '');
  return total;
}

async function directorySyncableFileBytes({ root, ignoreMatcher } = {}) {
  return directoryFileBytes(root, {
    shouldIgnore: (relPath, isDir) => {
      if (isSyncthingLocalOnlyRel(relPath)) return true;
      if (typeof ignoreMatcher === 'function') {
        return Boolean(ignoreMatcher(relPath, isDir));
      }
      return false;
    },
  });
}

module.exports = {
  directoryFileBytes,
  directorySyncableFileBytes,
  isSyncthingLocalOnlyRel,
};
