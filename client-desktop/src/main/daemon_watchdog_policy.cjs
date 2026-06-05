'use strict';

// Daemon watchdog policy — pure decision logic for crash-loop guarding.
//
// The integration side (main.cjs) owns the actual cp.spawn + exit
// listener + ensureDaemonRunning loop. This module owns the rules:
// "given these crash timestamps, should we cooldown? when can we
// retry?" Pure functions, no side effects, deterministically
// unit-testable with a fake clock.
//
// Defaults match the plan:
//   - sliding window 60s
//   - 5 crashes in that window → enter cooldown
//   - cooldown 5 minutes
//
// All time values are epoch milliseconds.

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_CRASH_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RESPAWN_DELAY_MS = 1_000;

// recordCrash returns a new timestamps array containing only entries
// within the window ending at `now`. Caller appends `now` first, then
// passes the resulting array back through here on subsequent calls.
function pruneCrashTimestamps(timestamps, now, windowMs = DEFAULT_WINDOW_MS) {
  if (!Array.isArray(timestamps)) return [];
  const cutoff = now - windowMs;
  return timestamps.filter((t) => typeof t === 'number' && t >= cutoff);
}

function recordCrash(timestamps, now, windowMs = DEFAULT_WINDOW_MS) {
  const pruned = pruneCrashTimestamps(timestamps, now, windowMs);
  pruned.push(now);
  return pruned;
}

// shouldEnterCooldown returns true when the windowed crash count
// crosses the threshold. Threshold is inclusive: hitting exactly N
// crashes triggers cooldown.
function shouldEnterCooldown(timestamps, threshold = DEFAULT_CRASH_THRESHOLD) {
  if (!Array.isArray(timestamps)) return false;
  return timestamps.length >= threshold;
}

function computeCooldownUntil(now, cooldownMs = DEFAULT_COOLDOWN_MS) {
  return now + cooldownMs;
}

// canSpawnNow takes the current decision state and returns:
//   { ok: true } — safe to spawn
//   { ok: false, reason: 'user_stopped' } — user intentionally killed
//   { ok: false, reason: 'cooldown', until } — in crash cooldown
//   { ok: false, reason: 'external_daemon' } — KARI_SYNCD_URL/ADDR set
function canSpawnNow({
  now,
  daemonStopReason,
  crashCooldownUntil,
  hasCustomDaemonUrl,
} = {}) {
  if (hasCustomDaemonUrl) return { ok: false, reason: 'external_daemon' };
  if (daemonStopReason === 'user_quit') return { ok: false, reason: 'user_stopped' };
  if (typeof crashCooldownUntil === 'number' && now < crashCooldownUntil) {
    return { ok: false, reason: 'cooldown', until: crashCooldownUntil };
  }
  return { ok: true };
}

module.exports = {
  pruneCrashTimestamps,
  recordCrash,
  shouldEnterCooldown,
  computeCooldownUntil,
  canSpawnNow,
  DEFAULT_WINDOW_MS,
  DEFAULT_CRASH_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_RESPAWN_DELAY_MS,
};
