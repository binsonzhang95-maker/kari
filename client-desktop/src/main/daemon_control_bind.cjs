'use strict';

function clean(value) {
  return String(value || '').trim();
}

function isSyncthingBackend(_cfg) {
  // Single-tenant OSS: Syncthing is the only/mandatory backend, so the daemon
  // control session is always bound (the stored workspaceSyncBackend may be a
  // stale 'filesync' from a per-open rewrite). The bind body still sends
  // sync_backend:'syncthing', so the daemon runs control-only correctly.
  return true;
}

// kariSyncdAddrFor strips the URL scheme from a stored serverAddr so
// kari-syncd's gRPC dial gets a plain host:port. Recent grpc-go releases
// reject "http://host:port" with "too many colons in address" because
// the scheme prefix is treated as part of the authority. Stored configs
// (written by older desktop builds) frequently carry "http://" so we
// normalise at the bind boundary rather than asking users to re-enter
// activation. Trailing slashes also removed — they'd render as
// "host:port/" inside grpc, which is equally invalid.
function kariSyncdAddrFor(rawAddr) {
  let addr = clean(rawAddr);
  if (!addr) return addr;
  addr = addr.replace(/^https?:\/\//i, '');
  addr = addr.replace(/\/+$/, '');
  return addr;
}

function buildDaemonControlBindRequest(cfg, opts = {}) {
  const activationCode = clean(opts.activationCode);
  if (!cfg || !isSyncthingBackend(cfg)) return null;
  const workspaceRoot = clean(cfg.workspaceRoot);
  const serverAddr = kariSyncdAddrFor(cfg.serverAddr);
  const workspaceId = clean(cfg.workspaceId);
  if (!workspaceRoot || !serverAddr || !workspaceId || !activationCode) return null;
  const clientId = clean(cfg.clientId) || clean(opts.fallbackClientId);
  return {
    workspace_root: workspaceRoot,
    server_addr: serverAddr,
    workspace_id: workspaceId,
    activation_code: activationCode,
    management_url: clean(cfg.managementUrl),
    client_id: clientId,
    rescan_seconds: Number.isFinite(Number(opts.rescanSeconds)) && Number(opts.rescanSeconds) > 0
      ? Number(opts.rescanSeconds)
      : 30,
    frp: cfg.frp || null,
    frpc_path: clean(opts.frpcPath),
    sync_backend: 'syncthing',
    workspace_name: clean(cfg.workspaceName) || 'workspace',
  };
}

function daemonControlBindKey(req) {
  if (!req) return '';
  return [
    clean(req.server_addr),
    clean(req.workspace_id),
    clean(req.workspace_root),
    clean(req.workspace_name),
    clean(req.client_id),
    clean(req.sync_backend),
  ].join('|');
}

module.exports = {
  buildDaemonControlBindRequest,
  daemonControlBindKey,
  kariSyncdAddrFor,
};
