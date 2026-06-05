'use strict';

function normalizeServerCloneFailure(body, fallback) {
  const source = isObject(body) ? body : {};
  const bootstrap = isObject(source.bootstrap) ? { ...source.bootstrap } : null;
  const code =
    text(bootstrap && bootstrap.status) ||
    text(source.code) ||
    'clone_failed';
  const baseError =
    text(bootstrap && bootstrap.error) ||
    text(source.error) ||
    text(fallback) ||
    'server clone failed';
  const logTail = text(bootstrap && bootstrap.log_tail);
  const error = appendLogTail(baseError, logTail);
  return {
    code,
    error,
    ...(bootstrap ? { bootstrap } : {}),
  };
}

function isAuthRequiredCloneFailure(error, bootstrap) {
  const message = [
    text(error),
    text(bootstrap && bootstrap.error),
    text(bootstrap && bootstrap.log_tail),
  ].filter(Boolean).join('\n');
  return isAuthRequiredError(message);
}

function makeServerCloneError(body, fallback) {
  const failure = normalizeServerCloneFailure(body, fallback);
  const err = new Error(failure.error);
  err.cloneFailure = failure;
  return err;
}

function isAuthRequiredError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  if (m.includes('authentication failed')) return true;
  if (m.includes('could not read username')) return true;
  if (m.includes('terminal prompts disabled')) return true;
  if (m.includes('invalid username or password')) return true;
  if (m.includes('http 401') || m.includes('401 unauthorized')) return true;
  if (m.includes('http 403') || m.includes('403 forbidden')) return true;
  if (m.includes('permission denied')) return true;
  if (m.includes('repository not found')) return true;
  return false;
}

function appendLogTail(error, logTail) {
  const base = text(error) || 'server clone failed';
  const tail = text(logTail);
  if (!tail || base.includes(tail)) return base;
  return `${base}\n${tail}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  normalizeServerCloneFailure,
  isAuthRequiredCloneFailure,
  makeServerCloneError,
};
