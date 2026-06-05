// Tiny daemon HTTP helpers — extracted from main.cjs so the status-
// based "endpoint missing?" detection has a real test surface.
//
// Return shapes (intentional):
//   { ok: true,  status, data }
//   { ok: false, status, error }   // HTTP error response (4xx/5xx)
//   { ok: false, error }           // network/abort/non-HTTP failure (no status)
//
// Callers MUST use the status field to distinguish "endpoint missing"
// (404/405) from "transient" — see isDaemonEndpointMissing below.
// The pre-rewrite code regex-matched the error string ("HTTP 404"),
// which silently broke on Go's net/http 404 body ("404 page not
// found\n") and other servers' custom 404 envelopes. Status is the
// only stable source.

'use strict';

function createDaemonHttp(options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('daemon_http: baseUrl required');
  // fetch + AbortController are global in Node 18+; allow overrides
  // so tests can inject mocks if useful.
  const fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : fetch;

  async function getDaemon(route, timeoutMs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const response = await fetchImpl(`${baseUrl}${route}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, status: response.status, error: text || `HTTP ${response.status}` };
      }
      return { ok: true, status: response.status, data: await response.json() };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  async function postDaemon(route, body, timeoutMs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const response = await fetchImpl(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, status: response.status, error: text || `HTTP ${response.status}` };
      }
      return { ok: true, status: response.status, data: await response.json().catch(() => ({})) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  return { getDaemon, postDaemon };
}

// isDaemonEndpointMissing: stable predicate the upgrade-gating code
// uses to flip daemonSyncTaskSupported=false. The contract is "HTTP
// 404 (not found) or 405 (method not allowed) means the daemon
// build predates the /v1/sync-tasks rollout". Any other failure —
// timeout, network unreachable, 5xx — is treated as transient.
function isDaemonEndpointMissing(resp) {
  if (!resp || resp.ok !== false) return false;
  return resp.status === 404 || resp.status === 405;
}

module.exports = {
  createDaemonHttp,
  isDaemonEndpointMissing,
};
