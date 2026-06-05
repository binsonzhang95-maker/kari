'use strict';

// Syncthing child-process manager (Phase 1.1 of the syncthing migration).
//
// Lifecycle:
//   1. `bootstrapHome({ homeDir, binary })` — if homeDir is empty or has
//      no config.xml, run `syncthing -generate <homeDir>` to create
//      config.xml + key.pem + cert.pem. This is the only safe way to
//      generate the device's cryptographic identity; we never invent
//      device IDs ourselves.
//   2. `readIdentity(homeDir)` — parses config.xml to extract apikey +
//      device ID (the long base32 string the BEP protocol uses for
//      peer auth).
//   3. `start({ homeDir, binary, guiPort?, listenPort?, proxyUrl? })` — spawn the
//      child, wait for /rest/system/status to return 200, then return
//      { ok, pid, guiAddress, apiKey, deviceId }.
//   4. `stop(reason)` — SIGTERM, wait up to 2s, then SIGKILL. Idempotent.
//   5. `getRunningMeta()` — current { pid, guiAddress, apiKey, deviceId }
//      or null when not running.
//
// Pure-function helpers (no IO):
//   - `parseConfigIdentity(xml)` — returns { apiKey, deviceId } from a
//     raw config.xml string. Used by readIdentity + by tests.
//   - `pickFreePort` — async, but the wrapped logic is straightforward.
//
// Watchdog policy is delegated to daemon_watchdog_policy.cjs (already
// used for kari-syncd), so a syncthing crash-loop hits the same
// 5-crashes-in-60s cooldown as the existing daemon.

const cp = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');

const watchdogPolicy = require('./daemon_watchdog_policy.cjs');

const GUI_PORT_RANGE = [21800, 21899];
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 15000;
const SHUTDOWN_GRACE_MS = 2000;

let _proc = null;
let _meta = null;
// Last successful start() options — used by the exit handler to auto-
// restart on unexpected exits without the caller having to re-supply
// homeDir / binary / listenPort / proxyUrl. Cleared on intentional stop().
let _lastStartArgs = null;
// stopReason: 'user_quit' suppresses respawn; null = healthy / running;
// 'crash' triggers respawn unless cooldown applies.
let _stopReason = null;
let _crashTimestamps = [];
let _crashCooldownUntil = 0;
let _respawnTimer = null;

function getRunningMeta() { return _meta ? { ..._meta } : null; }

function parseConfigIdentity(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    return { apiKey: null, deviceId: null };
  }
  // <apikey>...</apikey> lives inside <gui>. Match the first occurrence;
  // syncthing only writes one per config.
  const apiKeyMatch = xml.match(/<apikey>([^<]+)<\/apikey>/);
  // <device id="ABCDE-..."> — the first <device> entry in the
  // <configuration> body is the local device (-generate convention).
  // Skip elements whose id is empty or all dashes (defensive).
  const deviceMatch = xml.match(/<device\s+[^>]*\bid="([A-Z0-9-]{20,})"/);
  return {
    apiKey: apiKeyMatch ? apiKeyMatch[1].trim() : null,
    deviceId: deviceMatch ? deviceMatch[1].trim() : null,
  };
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickFreePort(start = GUI_PORT_RANGE[0], end = GUI_PORT_RANGE[1]) {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port in ${start}..${end}`);
}

async function pickEphemeralLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.once('listening', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('failed to pick loopback port'));
      });
    });
    srv.listen(0, '127.0.0.1');
  });
}

async function bootstrapHome({ homeDir, binary }) {
  await fsp.mkdir(homeDir, { recursive: true });
  const configPath = path.join(homeDir, 'config.xml');
  if (fs.existsSync(configPath)) return { ok: true, generated: false };
  await new Promise((resolve, reject) => {
    cp.execFile(binary, ['-generate', homeDir], { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`syncthing -generate failed: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });
  if (!fs.existsSync(configPath)) {
    throw new Error('syncthing -generate completed but config.xml is missing');
  }
  return { ok: true, generated: true };
}

async function readIdentity(homeDir) {
  const configPath = path.join(homeDir, 'config.xml');
  const xml = await fsp.readFile(configPath, 'utf8');
  return parseConfigIdentity(xml);
}

function serverAddrHostPort(serverAddr) {
  const raw = String(serverAddr || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    return u.host;
  } catch {
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  }
}

function buildSOCKS5ProxyUrl({ serverAddr, activationCode } = {}) {
  const host = serverAddrHostPort(serverAddr);
  const code = String(activationCode || '');
  if (!host || !code) return '';
  return `socks5://${encodeURIComponent('kari')}:${encodeURIComponent(code)}@${host}`;
}

function buildSyncthingProcessEnv(baseEnv = process.env, { proxyUrl } = {}) {
  const env = {
    ...(baseEnv || {}),
    STNORESTART: '1',
    STNOUPGRADE: '1',
  };
  if (proxyUrl) {
    env.ALL_PROXY = proxyUrl;
    env.all_proxy = proxyUrl;
    env.NO_PROXY = '';
    env.no_proxy = '';
  }
  return env;
}

// Patch config.xml to set <gui address> + ensure raw listen address is
// what we want. consoleZ's sidecar_config.go does a full RMW preserving
// unknown elements; we do a narrower string replacement on just the
// elements we care about (Phase 1.1 keeps it minimal; full RMW lands
// when Phase 1.3 needs to write <folder> entries).
async function patchConfigGui({ homeDir, guiAddress, listenAddress }) {
  const configPath = path.join(homeDir, 'config.xml');
  let xml = await fsp.readFile(configPath, 'utf8');
  // <gui ...><address>...</address> — replace the inner <address>.
  xml = xml.replace(
    /(<gui[^>]*>[\s\S]*?<address>)[^<]*(<\/address>)/,
    `$1${guiAddress}$2`,
  );
  // <options><listenAddress>...</listenAddress> — there can be multiple;
  // we replace the FIRST one. If no <listenAddress> element exists,
  // append one inside <options>.
  if (listenAddress) {
    if (/<listenAddress>/.test(xml)) {
      xml = xml.replace(
        /<listenAddress>[^<]*<\/listenAddress>/,
        `<listenAddress>${listenAddress}</listenAddress>`,
      );
    } else {
      xml = xml.replace(
        /<\/options>/,
        `    <listenAddress>${listenAddress}</listenAddress>\n  </options>`,
      );
    }
  }
  // Disable global discovery + relays for local-only testing? Leave on
  // by default — production needs them. The test harness can patch
  // further if needed.
  const tmp = configPath + '.tmp-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(tmp, xml, 'utf8');
  await fsp.rename(tmp, configPath);
}

function httpGetWithApiKey({ host, port, pathStr, apiKey, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    const req = http.request({
      host,
      port,
      path: pathStr,
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    req.end();
  });
}

async function waitHealthy({ guiAddress, apiKey, timeoutMs = HEALTH_POLL_TIMEOUT_MS }) {
  const [host, portStr] = guiAddress.split(':');
  const port = Number(portStr);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await httpGetWithApiKey({ host, port, pathStr: '/rest/system/status', apiKey });
    if (r.ok) return true;
    await new Promise((s) => setTimeout(s, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

// reapStaleSyncthing kills any syncthing process still bound to our home dir
// that we don't own. This happens when a previous Kari instance crashed (or was
// force-killed) without running stop(): its syncthing child is orphaned
// (reparented to launchd) and keeps the index-DB lock + GUI port. The next
// launch then fails to start its own syncthing ("Failed to acquire lock" →
// health_timeout), and the UI shows "disconnected" even though an orphan is
// actually connected. We only reach here with _proc === null (start() returns
// early otherwise), so any match is genuinely stale and safe to kill.
async function reapStaleSyncthing(homeDir) {
  if (process.platform === 'win32') return; // pgrep/SIGTERM not available; TODO if needed
  const pattern = `syncthing -home ${homeDir}`;
  const findPids = () => {
    try {
      return cp.execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    } catch {
      return []; // pgrep exits non-zero when there's no match
    }
  };
  const pids = findPids();
  if (!pids.length) return;
  console.warn(`[syncthing] reaping ${pids.length} stale syncthing process(es) holding ${homeDir}: ${pids.join(',')}`);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  // Wait up to ~3s for them to exit and release the index-DB lock.
  for (let i = 0; i < 15 && findPids().length; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const pid of findPids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (findPids().length) await new Promise((r) => setTimeout(r, 300));
}

async function start({ homeDir, binary, guiPort, listenPort, proxyUrl } = {}) {
  if (_proc) return { ok: false, reason: 'already_running', meta: getRunningMeta() };
  if (!homeDir) throw new Error('start: homeDir required');
  if (!binary) throw new Error('start: binary required');

  // Clear any orphaned syncthing from a previously-crashed instance that still
  // holds this home dir's lock, or our spawn will health_timeout.
  await reapStaleSyncthing(homeDir);

  await bootstrapHome({ homeDir, binary });
  const port = guiPort != null ? guiPort : await pickFreePort();
  const guiAddress = `127.0.0.1:${port}`;
  const privateListenPort = listenPort != null ? Number(listenPort) : await pickEphemeralLoopbackPort();
  if (!Number.isFinite(privateListenPort) || privateListenPort <= 0 || privateListenPort > 65535) {
    throw new Error(`start: invalid listenPort ${listenPort}`);
  }
  const listenAddress = `tcp://127.0.0.1:${privateListenPort}`;
  await patchConfigGui({ homeDir, guiAddress, listenAddress });

  // Re-read after patch: apikey + deviceId come from config.xml.
  const ident = await readIdentity(homeDir);
  if (!ident.apiKey || !ident.deviceId) {
    throw new Error('start: failed to parse apikey/deviceId from config.xml after bootstrap');
  }

  const args = [
    '-home', homeDir,
    '-gui-address', guiAddress,
    '-no-browser',
    '-no-restart',
    '-no-default-folder',
    '-no-upgrade',
  ];
  const proc = cp.spawn(binary, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSyncthingProcessEnv(process.env, { proxyUrl }),
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout.on('data', (d) => {
    stdoutBuf += String(d);
    if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(-4096);
  });
  proc.stderr.on('data', (d) => {
    stderrBuf += String(d);
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  _proc = proc;

  const healthy = await waitHealthy({ guiAddress, apiKey: ident.apiKey });
  if (!healthy) {
    const tail = (stderrBuf + '\n' + stdoutBuf).slice(-1024);
    await stop('health_timeout');
    return { ok: false, reason: 'health_timeout', stderrTail: tail };
  }

  // Publish _meta ONLY after the REST API is confirmed reachable. Otherwise a
  // concurrent activate() that reads getRunningMeta() mid-startup would try to
  // PUT devices/folders against a not-yet-listening GUI port and fail with
  // ECONNREFUSED (the pre-fix "apply_pair_failed" on first launch).
  _meta = {
    pid: proc.pid,
    guiAddress,
    apiKey: ident.apiKey,
    deviceId: ident.deviceId,
    homeDir,
    binary,
    listenPort: privateListenPort,
    listenAddress,
    proxyUrl: proxyUrl || '',
  };

  // Cache the start args so the exit watchdog can respawn without
  // re-deriving them from caller state. Also clear stopReason so the
  // next unintentional exit is treated as a crash.
  _lastStartArgs = { homeDir, binary, guiPort, listenPort: privateListenPort, proxyUrl };
  _stopReason = null;

  proc.once('exit', (code, signal) => {
    console.warn(`[syncthing] child exit code=${code} signal=${signal} stopReason=${_stopReason || 'crash'}`);
    if (_proc !== proc) return; // superseded by a newer spawn — let it own state
    const wasIntentional = _stopReason === 'user_quit' || _stopReason === 'health_timeout';
    _proc = null;
    _meta = null;
    if (wasIntentional) return;
    // Crash path: record + check cooldown via the shared watchdog
    // policy. Respawn after DEFAULT_RESPAWN_DELAY_MS unless we hit
    // 5-crashes-in-60s, in which case sit out the cooldown window.
    const now = Date.now();
    _crashTimestamps = watchdogPolicy.recordCrash(_crashTimestamps, now);
    let delayMs = watchdogPolicy.DEFAULT_RESPAWN_DELAY_MS;
    if (watchdogPolicy.shouldEnterCooldown(_crashTimestamps)) {
      _crashCooldownUntil = watchdogPolicy.computeCooldownUntil(now);
      delayMs = Math.max(delayMs, _crashCooldownUntil - now);
      console.warn(`[syncthing] crash-loop cooldown until ${new Date(_crashCooldownUntil).toISOString()}; respawn scheduled after cooldown`);
    }
    if (_respawnTimer) clearTimeout(_respawnTimer);
    _respawnTimer = setTimeout(() => {
      _respawnTimer = null;
      if (!_lastStartArgs) return;
      void start({ ..._lastStartArgs }).catch((err) => {
        console.warn('[syncthing] respawn failed:', err && err.message ? err.message : err);
      });
    }, delayMs);
  });

  return { ok: true, ...getRunningMeta() };
}

async function stop(reason) {
  const proc = _proc;
  // Suppress any pending respawn from a prior crash + clear start
  // args so the exit listener treats this as intentional.
  _stopReason = (reason === 'app_quit' || reason === 'user_quit' || reason === 'test_teardown') ? 'user_quit' : (reason || 'user_quit');
  _lastStartArgs = null;
  if (_respawnTimer) { clearTimeout(_respawnTimer); _respawnTimer = null; }
  if (!proc) return { ok: true, reason: 'not_running' };
  _proc = null;
  _meta = null;
  const pid = proc.pid;
  // Windows: Node's proc.kill() maps to TerminateProcess which only
  // terminates the immediate child. syncthing spawns itself as a
  // parent-supervisor + worker-kid pair, so killing only the parent
  // leaves the worker as an orphan that keeps the binary file open —
  // breaking the next electron-builder run with "Access is denied"
  // when it tries to overwrite syncthing.exe. taskkill /T walks the
  // whole tree by ppid; /F is the Windows equivalent of SIGKILL.
  // POSIX path keeps the existing SIGTERM → grace → SIGKILL logic.
  if (process.platform === 'win32') {
    if (pid) {
      try {
        cp.execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 5_000, windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
    await new Promise((resolve) => {
      let done = false;
      proc.once('exit', () => { if (!done) { done = true; resolve(); } });
      setTimeout(() => { if (!done) { done = true; resolve(); } }, 1_500);
    });
    return { ok: true };
  }
  try { proc.kill('SIGTERM'); } catch {}
  const exited = await new Promise((resolve) => {
    let done = false;
    proc.once('exit', () => { if (!done) { done = true; resolve(true); } });
    setTimeout(() => { if (!done) { done = true; resolve(false); } }, SHUTDOWN_GRACE_MS);
  });
  if (!exited) {
    try { proc.kill('SIGKILL'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: true };
}

module.exports = {
  start,
  stop,
  getRunningMeta,
  // Helpers exposed for tests + Phase 1.2/1.3 callers.
  parseConfigIdentity,
  pickFreePort,
  pickEphemeralLoopbackPort,
  bootstrapHome,
  readIdentity,
  serverAddrHostPort,
  buildSOCKS5ProxyUrl,
  buildSyncthingProcessEnv,
  patchConfigGui,
  GUI_PORT_RANGE,
  HEALTH_POLL_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
};
