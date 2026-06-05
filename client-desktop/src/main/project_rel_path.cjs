'use strict';

const path = require('node:path');

// projectRelPathFromRootBase derives the kari-drive-relative path of a project
// from an EXPLICIT projects-root base, returning '' when projectRoot is not
// inside that base. Base-explicit so a queued import can resolve against its
// OWN base (importResult.projectsRoot) rather than the single global config —
// otherwise parallel jobs from different bases would clobber each other's
// rel-path derivation. See the import-queue adoption plan, Phase 0.
function projectRelPathFromRootBase(projectsRoot, projectRoot) {
  const containerRoot = projectsRoot ? path.resolve(projectsRoot) : '';
  const target = projectRoot ? path.resolve(projectRoot) : '';
  if (!containerRoot || !target) return '';
  if (target === containerRoot) return '';
  const rel = path.relative(containerRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}

// resolveJobRelPathOrThrow is the import-queue contract: an unresolved rel-path
// is FATAL, never a silent success. A project that is not under its kari-drive
// base can never have its sync confirmed, so the queue must fail the job (with
// a concrete reason) rather than mark it succeeded. Replaces the old silent
// `if (!projectRelPath) return;` in waitForQueuedProjectUpload.
function resolveJobRelPathOrThrow(jobProjectsRoot, projectRoot) {
  const rel = projectRelPathFromRootBase(jobProjectsRoot, projectRoot);
  if (!rel) {
    const err = new Error(
      `import_wait_unresolved_relpath: ${projectRoot} is not under base ${jobProjectsRoot}`,
    );
    err.code = 'import_wait_unresolved_relpath';
    throw err;
  }
  return rel;
}

module.exports = {
  projectRelPathFromRootBase,
  resolveJobRelPathOrThrow,
};
