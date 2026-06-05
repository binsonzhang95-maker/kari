// sync_verify_client — Desktop poll loop against daemon's
// GET /v1/sync-verify. Sits between "daemon reports sync-task
// succeeded" and the snapshot commit/promote pipeline call so a
// race-condition or daemon-self-reported error (pull_errors,
// pending_outbound, etc.) can hold the commit instead of poisoning
// the snapshot.
//
// HTTP contract (daemon side, trans repo win-edit branch):
//   - 200 + {ok: true}                   → safe to commit
//   - 200 + {ok: false, reason: <set>}   → daemon's verdict; see below
//   - 400                                → caller-side query bug
//   - 404 / 405                          → endpoint missing (old daemon)
//   - 5xx / network / timeout            → transient; retry within window
//
// Reasons (returned in 200 + ok=false body):
//   TERMINAL (bail; do NOT commit):
//     staging_id_superseded   another Bind has replaced this staging
//     task_not_succeeded      task regressed from succeeded (shouldn't happen)
//     pull_errors             one or more transfer rows have Error
//     daemon_not_bound        daemon has no current bind
//     no_task                 bound + matched, no sync-task in manager
//   SKIP (no verify signal — fall through to commit, same as old-daemon path):
//     no_match                staging_id doesn't match daemon's current bind.
//                             Happens when the workspace was re-bound
//                             between the staging upload and verify poll
//                             (workspace bind replaces staging bind in
//                             daemon — observed in production: daemon
//                             /v1/status shows workspace_root=<project>
//                             with no staging_id by the time verify runs).
//                             It's NOT evidence of failure — daemon just
//                             doesn't remember the staging anymore. Falling
//                             through is safe because the snapshot commit
//                             has its own server-side CAS checks
//                             (previousManifestId) that detect real races.
//   RETRY (keep polling within timeout):
//     pending_outbound        Status.PendingOutbound > 0
//     active_transfers        non-error in-flight transfer rows
//     need_items_remaining    download task with items still to fetch
//     quiet_window_not_reached LastActivityAt too recent (< 3s)
//
// Outcomes pollSyncVerify returns:
//   { outcome: 'ok' }
//     → daemon says safe to commit
//   { outcome: 'bail', reason }
//     → caller MUST NOT commit; cancel/cleanup the session
//   { outcome: 'skip', why: 'endpoint_missing' }
//     → old daemon; fall through to commit (verify gate is best-effort,
//       this is the backward-compat path)
//   { outcome: 'skip', why: 'bind_no_match' }
//     → daemon doesn't recognise this staging_id anymore (workspace
//       re-bind raced our verify). Fall through to commit — same
//       reasoning as endpoint_missing: no verify signal, but no
//       evidence of failure either.
//   { outcome: 'bail', reason: 'timeout:<last_reason>' }
//     → exhausted retry window without ok=true; codex plan-review must-fix
//       — daemon negative signals (pull_errors etc.) must NOT be silently
//       committed through on timeout
//   { outcome: 'bail', reason: 'bad_request:<msg>' }
//     → daemon rejected the query (shouldn't happen if stagingId is valid)
//   { outcome: 'bail', reason: 'unknown_reason:<reason>' }
//     → daemon emitted a reason this client doesn't recognise (forward-
//       compat trap: assume bail, surface to operator)

'use strict';

const { isDaemonEndpointMissing } = require('./daemon_http.cjs');

const TERMINAL_REASONS = new Set([
  'staging_id_superseded',
  'task_not_succeeded',
  'pull_errors',
  'daemon_not_bound',
  'no_task',
]);

// SKIP_REASONS — daemon returned 200+ok=false with one of these reasons,
// and we treat them like endpoint_missing: fall through to commit. The
// difference from TERMINAL is intent: TERMINAL means "daemon checked
// and reports a problem"; SKIP means "daemon CAN'T verify, no failure
// signal." Right now this is just no_match (staging bind replaced by
// workspace bind before verify ran — bind_no_match).
const SKIP_REASONS = new Map([
  ['no_match', 'bind_no_match'],
]);

const RETRY_REASONS = new Set([
  'pending_outbound',
  'active_transfers',
  'need_items_remaining',
  'quiet_window_not_reached',
]);

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_INTERVAL_MS = 1000;
// Per-request fetch timeout — picked so that 5xx/timeout on a single
// poll doesn't eat the entire window. Capped at 5s to keep the
// per-iteration latency bounded.
const PER_REQUEST_TIMEOUT_CAP_MS = 5000;

async function pollSyncVerify(stagingId, opts) {
  if (!stagingId) {
    throw new Error('pollSyncVerify: stagingId required');
  }
  const o = opts || {};
  const getDaemon = o.getDaemon;
  if (typeof getDaemon !== 'function') {
    throw new Error('pollSyncVerify: getDaemon required');
  }
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : DEFAULT_INTERVAL_MS;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const sleep = typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const route = `/v1/sync-verify?staging_id=${encodeURIComponent(stagingId)}`;
  const perRequestTimeout = Math.min(Math.max(intervalMs * 2, 1000), PER_REQUEST_TIMEOUT_CAP_MS);
  const deadline = now() + timeoutMs;

  let lastReason = '';
  for (;;) {
    // Defensive try/catch — daemon_http.getDaemon documents that it
    // catches all errors and returns {ok:false, error}, but a future
    // change or a test mock that bypasses createDaemonHttp could
    // throw. Treat a throw as a transient failure (same as 5xx) so a
    // single bad poll doesn't take down the verify gate.
    let resp;
    try {
      resp = await getDaemon(route, perRequestTimeout);
    } catch (err) {
      resp = { ok: false, error: String(err && err.message || err) };
    }
    if (resp && resp.ok === true) {
      const body = resp.data || {};
      if (body.ok === true) {
        return { outcome: 'ok' };
      }
      lastReason = String(body.reason || '');
      if (TERMINAL_REASONS.has(lastReason)) {
        return { outcome: 'bail', reason: lastReason };
      }
      if (SKIP_REASONS.has(lastReason)) {
        return { outcome: 'skip', why: SKIP_REASONS.get(lastReason) };
      }
      if (lastReason && !RETRY_REASONS.has(lastReason)) {
        // Forward-compat: an unrecognised reason MUST NOT be silently
        // retried-and-then-committed. Future daemon could emit a new
        // terminal reason this client doesn't know about.
        return { outcome: 'bail', reason: 'unknown_reason:' + lastReason };
      }
      // RETRY case (known retry reason or empty reason on ok=false):
      // fall through to sleep + next iteration.
    } else if (resp && resp.ok === false) {
      if (isDaemonEndpointMissing(resp)) {
        return { outcome: 'skip', why: 'endpoint_missing' };
      }
      if (resp.status === 400) {
        return { outcome: 'bail', reason: 'bad_request:' + (resp.error || '') };
      }
      // 5xx / network / timeout — transient. Sleep and retry within
      // the window. lastReason untouched so the eventual timeout
      // surfaces whatever the LAST successful body said (or "no_response"
      // if every poll failed).
    }
    if (now() >= deadline) {
      return { outcome: 'bail', reason: 'timeout:' + (lastReason || 'no_response') };
    }
    await sleep(intervalMs);
  }
}

module.exports = {
  pollSyncVerify,
  TERMINAL_REASONS,
  RETRY_REASONS,
  SKIP_REASONS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
};
