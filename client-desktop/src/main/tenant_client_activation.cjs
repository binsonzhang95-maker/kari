function isTenantClientInviteToken(value) {
  return String(value || '').trim().startsWith('ki_');
}

function tenantClientRegisterBody({ inviteToken, machineLabel, clientVersion, platform, metadata } = {}) {
  return {
    invite_token: String(inviteToken || '').trim(),
    name: String(machineLabel || '').trim(),
    client_version: String(clientVersion || '').trim(),
    platform: String(platform || '').trim(),
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  };
}

function tenantClientActivationConfig({ payload, registration, managementUrl, machineLabel, fallbackClientId } = {}) {
  const body = registration || {};
  const client = body.client || {};
  const workspace = body.workspace || client.workspace || {};
  const clientId = String(client.client_id || fallbackClientId || '').trim();
  // server address can arrive at multiple field paths depending on the
  // mgmt API shape (legacy `server_url` at top-level, new `client.server_url`,
  // or the structured `client.server.addr`). Strip any URL scheme so the
  // value matches what the daemon expects (`host:port` only — daemon
  // doesn't accept `http://host:port`).
  const rawServerAddr = String(
    (payload && payload.serverAddr) ||
    body.server_url ||
    body.serverUrl ||
    client.server_url ||
    (body.server && body.server.addr) ||
    (client.server && client.server.addr) ||
    ''
  ).trim();
  const serverAddr = rawServerAddr.replace(/^https?:\/\//i, '');
  const workspaceName = String(
    (payload && payload.workspaceName) ||
    workspace.name ||
    body.workspace_name ||
    'workspace'
  ).trim() || 'workspace';
  // workspace_id can land at multiple paths — registration response,
  // nested workspace object, top-level field, or carry over from
  // payload if Desktop passed it. Empty means mgmt hasn't assigned
  // this tenant client to a workspace yet (user action needed:
  // operator panel → create workspace → assign tenant client).
  const workspaceId = String(
    (payload && payload.workspaceId) ||
    workspace.id ||
    workspace.workspace_id ||
    body.workspace_id ||
    client.workspace_id ||
    ''
  ).trim();
  return {
    activated: true,
    managementUrl,
    machineLabel,
    clientId,
    serverAddr,
    workspaceId,
    workspaceName,
    workspaceSyncBackend: 'syncthing',
    serverId: String(client.server_id || body.server_id || '').trim(),
    frp: body.frp || null,
    capabilities: null,
    tenantClientId: clientId,
    hasTenantClientToken: Boolean(body.client_token),
    tenantClientTokenPlain: String(body.client_token || ''),
    // activation_code is the TC-style data-plane credential mgmt mints
    // into the keys table at tenant client registration time. trans-server
    // gates upload/download/sync on SHA-256(activation_code) so Desktop
    // must hold it for uploads to work. tenantClientTokenPlain (kc_...)
    // is reserved for tenant-management API calls.
    activationCodePlain: String(body.activation_code || client.activation_code || '').trim(),
    vscodeImportDisabled: false
  };
}

module.exports = {
  isTenantClientInviteToken,
  tenantClientRegisterBody,
  tenantClientActivationConfig
};
