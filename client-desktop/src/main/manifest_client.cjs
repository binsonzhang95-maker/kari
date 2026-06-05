'use strict';

// Manifest client (file-tree visibility plan, FT-Task-MC).
//
// Fetches the latest COMMITTED manifest for a workspace from the
// user's SERVER (trans-server / self-hosted), NOT from mgmt. Per the
// server-first architecture: mgmt only owns account/auth/activation;
// the sync data plane (workdirs, manifests, staging, verify) is
// owned by the user's server, which for self-hosted / intranet
// deployments may be the only reachable endpoint. Desktop sync
// decisions must not depend on managementUrl.
//
// Endpoint:
//   GET {serverAddr}/api/v2/workdirs/{workspaceName}/latest-manifest
//   Authorization: Bearer <activationCode>
//   →  { manifest_id: string, entries: [{relPath, size, mtimeNs, sha256}, ...] }
//   →  404 if no committed manifest yet (project never uploaded, or
//      every prior manifest is still in 'pending' state)
//   →  401/403 on auth failure
//
// Server endpoint may not exist yet in some deployments. ALL non-200
// outcomes (404, network failure, auth failure, malformed response) are
// graceful: we return an empty manifest entries Set. The classifier
// treats an empty manifest as "not hydrated" (per its documented
// semantics) and skips the cloud/local divergence labels, falling back
// to ignored/included for the rendered badge. No false labels.
//
// Cache layer: per-(serverAddr, workspaceId, workspaceName) cache with
// a configurable TTL (default 30 seconds). Manifest commits happen at
// most a few times per hour for an active project; refetching on every
// files:listChildren IPC is wasteful. Cache invalidation:
//   - TTL expiry (the default mechanism)
//   - Explicit invalidate() call (e.g. after a path-scoped upload
//     commits — FT-Task-6 will wire this)
//   - Project switch (key change → automatic cache miss)
//
// Returns the entries as both an Array (for size accounting / future
// use) AND a Set<string> of relPaths (the only thing the classifier
// actually needs). The Set is what the IPC handler should pass through
// to listFileTreeChildren as manifestPaths.

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 30 * 1000;
// Shorter TTL for failure responses (network errors, 5xx) so a transient
// connectivity blip doesn't paint stale local_only badges for the full
// 30s success window. 5s is short enough that recovery is fast, long
// enough to avoid hammering during a persistent outage.
const DEFAULT_FAILURE_TTL_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

// Project identity → cache key. Includes BOTH the project identity
// AND a hash of the auth dimensions (serverAddr + activationCode).
// Without the auth hash, a re-activation that rotates activationCode
// against the same serverAddr would serve the OLD tenant's manifest
// paths until the 30s TTL expired. serverAddr is already in the
// project-identity tuple, but including it in the hash documents
// that the auth dimensions are (server, code) — managementUrl
// deliberately NOT involved (server-first architecture: sync
// decisions don't depend on mgmt). Hashing instead of inlining
// avoids leaking the secret into in-memory cache keys / debug logs.
function identityKey({ serverAddr, workspaceId, workspaceName, activationCode }) {
  const authHash = crypto
    .createHash('sha256')
    .update(String(serverAddr || ''))
    .update('|')
    .update(String(activationCode || ''))
    .digest('hex')
    .slice(0, 16);  // 16 hex chars = 64 bits — collision-resistant enough for cache keying
  return [
    encodeURIComponent(String(serverAddr || '')),
    encodeURIComponent(String(workspaceId || '')),
    encodeURIComponent(String(workspaceName || '')),
    authHash,
  ].join('|');
}

function emptyManifest(reason) {
  return {
    ok: false,
    manifestId: null,
    paths: new Set(),
    entries: [],
    fetchedAt: 0,
    reason: reason || 'empty',
  };
}

function isCompleteIdentity({ serverAddr, workspaceName, activationCode }) {
  return typeof serverAddr === 'string' && serverAddr.length > 0
    && typeof workspaceName === 'string' && workspaceName.length > 0
    && typeof activationCode === 'string' && activationCode.length > 0;
}

// Mirrors main.cjs:kariServerBaseUrl. Self-hosted / intranet users
// commonly pair against a bare hostport like '192.168.1.10:9000' or
// 'kari.local:8080'. Without scheme normalization, fetch() throws
// TypeError on a non-absolute URL, the call-site .catch swallows it,
// and the file-tree silently degrades to local-only — exactly the
// deployment shape the server-first migration is supposed to support.
// Inlined here so this module stays self-contained (no main.cjs dep);
// the implementation MUST stay in sync with main.cjs's version.
function normalizeServerBaseUrl(serverAddr) {
  const raw = String(serverAddr || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

// Normalize relPath the same way the file-tree classifier normalizes
// local paths (see file_tree_sync_disposition.normalizeRel). Without
// this, a server emitting `./src/foo` or `src/foo/` would silently
// fail the classifier's `manifestPaths.has(relPath)` check and the
// file would mis-classify as local_only (round-1 codex #3).
function normalizeManifestRelPath(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (s.length === 0) return null;
  // Reject `..` segments (paths that escape the workspace are
  // malformed manifest entries; classify silently skips them rather
  // than letting the Set membership match against them).
  for (const seg of s.split('/')) {
    if (seg === '..') return null;
  }
  return s;
}

function createManifestClient(opts) {
  const o = opts || {};
  const fetchImpl = typeof o.fetch === 'function' ? o.fetch : fetch;
  const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
  const ttlMs = Number.isFinite(o.ttlMs) ? Math.max(0, Math.floor(o.ttlMs)) : DEFAULT_TTL_MS;
  const failureTtlMs = Number.isFinite(o.failureTtlMs)
    ? Math.max(0, Math.floor(o.failureTtlMs))
    : DEFAULT_FAILURE_TTL_MS;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? Math.max(100, Math.floor(o.timeoutMs)) : REQUEST_TIMEOUT_MS;

  // cache: identityKey → ManifestResult
  const cache = new Map();
  // In-flight dedupe: identityKey → Promise<ManifestResult>. Without
  // this, N concurrent files:listChildren IPCs for the same project
  // during initial-load would each fire a separate HTTP request.
  const inflight = new Map();
  // Generation counter per key — bumped by invalidate(). Round-2 codex
  // Important #2: an in-flight GET that resolves AFTER a commit's
  // invalidate would otherwise re-populate the cache with pre-commit
  // (stale) data via the IIFE's cache.set, defeating the post-commit
  // invalidate. The IIFE captures generations.get(key) at fetch start
  // and only calls cache.set if the generation is unchanged at fetch
  // end — if invalidate bumped it during the fetch, the result is
  // returned to the immediate caller but NOT cached.
  const generations = new Map();
  function bumpGeneration(key) {
    generations.set(key, (generations.get(key) || 0) + 1);
  }

  async function fetchLatestManifest(identity) {
    const ident = identity || {};
    // Identity must include serverAddr + workspaceName + activationCode
    // (the bearer auth). The manifest endpoint lives on serverAddr
    // (trans-server / user's self-hosted server), NOT managementUrl —
    // server-first architecture: sync data plane is server-owned so
    // intranet / mgmt-unreachable deployments still work.
    //
    // Handle BEFORE touching cache / inflight: a synchronous return
    // path inside the IIFE below would let the finally clause delete
    // from inflight before the outer `inflight.set` ran, leaving a
    // stale entry that subsequent calls served from. By rejecting
    // incomplete identity up front we guarantee the IIFE always has
    // at least one `await` before any return.
    if (!isCompleteIdentity(ident)) {
      return emptyManifest('incomplete_identity');
    }
    const key = identityKey(ident);
    const cached = cache.get(key);
    if (cached) {
      // Two TTLs: success entries cached for the full ttlMs (manifest
      // doesn't change minute-by-minute); failure entries (network /
      // 5xx / 404) cached for a shorter failureTtlMs so transient
      // outages don't paint stale local_only badges for the full
      // 30s window (round-1 codex #4 design fix).
      const effectiveTtl = cached.ok ? ttlMs : failureTtlMs;
      if (nowFn() - cached.fetchedAt < effectiveTtl) {
        // Tag with fromCache so callers can gate expensive follow-on
        // work (e.g. auto-commit of pending overrides) to fresh
        // fetches only — round-2 codex #1 on FT-Task-MC2.
        return { ...cached, fromCache: true };
      }
    }
    const existing = inflight.get(key);
    if (existing) return existing;

    // Round-2 codex Important #2: capture generation at fetch START so
    // we can detect an invalidate() that ran during our fetch and skip
    // cache.set in that case. setMaybe is the SOLE cache writer inside
    // the IIFE — every prior cache.set is now routed through it.
    //
    // Pre-seed generations.set(key, 0) on first observation of a key so
    // invalidate(no-arg) — which iterates `generations.keys()` — can bump
    // EVEN IF no prior invalidate ran for this key. Without the seed,
    // invalidate(no-arg) misses keys that were freshly fetched but never
    // individually invalidated.
    if (!generations.has(key)) generations.set(key, 0);
    const genAtStart = generations.get(key);
    const setMaybe = (result) => {
      if ((generations.get(key) || 0) === genAtStart) {
        cache.set(key, result);
      }
      // else: invalidate() bumped during our fetch — return the result
      // to the immediate caller (this Promise's awaiters) but don't
      // poison the cache for future callers.
    };

    const promise = (async () => {
      try {
        // Use normalizeServerBaseUrl so bare hostports (intranet /
        // self-hosted) get the implicit http:// scheme. Without this
        // fetch() throws TypeError on a non-absolute URL.
        const baseUrl = normalizeServerBaseUrl(ident.serverAddr);
        const route = `/api/v2/workdirs/${encodeURIComponent(ident.workspaceName)}/latest-manifest`;
        const ctrl = new AbortController();
        // Single timer covers BOTH the headers fetch AND the body parse
        // (round-1 codex #2). Previously the timer was cleared right
        // after headers arrived, so a slow-loris body would hang
        // response.json() forever — the IIFE's finally never ran, the
        // inflight slot leaked, and every subsequent call for this
        // identity deduped to the stuck promise. Clear only in the
        // outer finally so abort fires on slow body too.
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          let response;
          try {
            response = await fetchImpl(`${baseUrl}${route}`, {
              headers: { authorization: `Bearer ${ident.activationCode}` },
              signal: ctrl.signal,
            });
          } catch (err) {
            // Network failure (timeout, offline, DNS). Graceful: empty
            // manifest, classifier falls back to non-divergence labels.
            const result = emptyManifest('network_error');
            result.fetchedAt = nowFn();
            setMaybe(result);
            return result;
          }
          if (response.status === 404) {
            // Endpoint missing OR no committed manifest yet — both
            // surface as empty. Cached so subsequent calls don't hammer.
            const result = emptyManifest('not_found');
            result.fetchedAt = nowFn();
            setMaybe(result);
            return result;
          }
          if (response.status === 401 || response.status === 403) {
            // Auth failure — don't cache, let next call retry after the
            // user (potentially) re-activates.
            return emptyManifest('unauthorized');
          }
          if (!response.ok) {
            // Any other HTTP error (5xx). Cache briefly so we don't
            // hammer the server while it's down.
            const result = emptyManifest('http_error');
            result.fetchedAt = nowFn();
            setMaybe(result);
            return result;
          }
          let body;
          try {
            body = await response.json();
          } catch {
            return emptyManifest('malformed_response');
          }
          if (!body || typeof body !== 'object' || !Array.isArray(body.entries)) {
            // Server returned non-manifest shape. Defensive: empty + don't
            // cache (transient bug → retry next call).
            return emptyManifest('malformed_response');
          }
          const paths = new Set();
          const entries = [];
          for (const e of body.entries) {
            if (!e || typeof e !== 'object') continue;
            // Normalize the relPath the SAME way the file-tree
            // classifier normalizes local paths (round-1 codex #3 —
            // a server emitting './src/foo' or 'src/foo/' would silently
            // fail manifestPaths.has() and mis-classify the file as
            // local_only). normalizeManifestRelPath also rejects
            // entries that resolve outside the workspace via `..`.
            const norm = normalizeManifestRelPath(e.relPath);
            if (!norm) continue;
            paths.add(norm);
            entries.push({ ...e, relPath: norm });
          }
          const result = {
            ok: true,
            manifestId: typeof body.manifest_id === 'string' ? body.manifest_id : null,
            paths,
            entries,
            fetchedAt: nowFn(),
            reason: null,
          };
          setMaybe(result);
          return result;
        } finally {
          clearTimeout(timer);
        }
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  // Explicit invalidation — clear the cache for one project (or all,
  // when called with no arg). FT-Task-6 calls this after a path-scoped
  // upload commits so the next listChildren reflects the new manifest.
  function invalidate(identity) {
    if (!identity) {
      cache.clear();
      // Bump every known key's generation so any in-flight fetches
      // landed against the cleared keys skip cache.set on completion.
      for (const k of generations.keys()) {
        bumpGeneration(k);
      }
      return;
    }
    const key = identityKey(identity);
    cache.delete(key);
    bumpGeneration(key);
  }

  // --- Write side (B6 / B7 snapshot pipeline) ---------------------------
  //
  // postManifest + commitManifest implement the two-phase manifest
  // lifecycle from plan Phase C C3b (round 3 r2 P0 #1):
  //
  //   buildUploadSnapshot
  //     → POST /api/v2/manifests           (state='pending'; latest pointer UNCHANGED)
  //     → upload-intent (with manifest_id) (already wired in main.cjs's callUploadIntent)
  //     → bind + sync-task + /v1/sync-verify
  //     → POST /api/v2/manifests/{id}/commit  (only NOW does latest_manifest_id advance)
  //
  // Both endpoints live on serverAddr (NOT mgmt) per server-first
  // architecture — matches the GET path above.
  //
  // Graceful degradation: when the server hasn't shipped the manifest
  // registry yet, BOTH endpoints return 404. Callers treat 404 as
  // 'endpoint_missing' and fall back to the legacy upload flow (transport-
  // only verify, no manifest commit). This lets the Desktop snapshot
  // pipeline ship NOW while the cross-repo server work catches up; once
  // the server endpoints exist, the same code path automatically gets
  // the stronger commit-after-verify gate without a Desktop release.

  async function postRaw(route, ident, body) {
    if (!isCompleteIdentity(ident)) {
      return { ok: false, status: 0, code: 'incomplete_identity', error: 'missing serverAddr/workspaceName/activationCode' };
    }
    const baseUrl = normalizeServerBaseUrl(ident.serverAddr);
    if (!baseUrl) {
      return { ok: false, status: 0, code: 'incomplete_identity', error: 'serverAddr resolved to empty base url' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${route}`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${ident.activationCode}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return { ok: false, status: 0, code: 'network_error', error: msg };
      }
      // 404 specifically means the endpoint isn't deployed yet — caller
      // falls back to the legacy upload flow rather than treating this
      // as a hard failure. Distinct from generic 4xx so the caller
      // can distinguish "your server is older" from "your request is
      // wrong".
      if (response.status === 404) {
        return { ok: false, status: 404, code: 'endpoint_missing', error: '404 from ' + route };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, code: 'unauthorized', error: 'auth rejected by server' };
      }
      let parsed = null;
      try {
        const text = await response.text();
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON body — still report status so caller can decide.
      }
      if (!response.ok) {
        const msg = (parsed && (parsed.error || parsed.message)) || ('http ' + response.status);
        const code = (parsed && parsed.code) || 'http_error';
        return { ok: false, status: response.status, code, error: String(msg), body: parsed };
      }
      return { ok: true, status: response.status, body: parsed || {} };
    } finally {
      clearTimeout(timer);
    }
  }

  // Submit a manifest (state='pending'). Idempotent on manifest_id —
  // re-POSTing the same content returns the existing row (Round 3 r2
  // P1 #6). Body matches plan Phase C C3b:
  //   { manifest_id, workspace_id, workspace_name, upload_session_id, entries }
  // Server authoritatively derives workspace_id from the Bearer token;
  // body workspace_id is sent for consistency-check only (Round 3 r3 P1 #3).
  async function postManifest(identity, manifest) {
    const m = manifest || {};
    if (!m.manifestId || typeof m.manifestId !== 'string') {
      return { ok: false, status: 0, code: 'missing_manifest_id', error: 'manifest.manifestId is required' };
    }
    if (!Array.isArray(m.entries)) {
      return { ok: false, status: 0, code: 'missing_entries', error: 'manifest.entries must be an array' };
    }
    const uploadSessionId = typeof m.uploadSessionId === 'string' ? m.uploadSessionId : '';
    if (!uploadSessionId) {
      return { ok: false, status: 0, code: 'missing_upload_session_id', error: 'manifest.uploadSessionId is required' };
    }
    const body = {
      manifest_id: m.manifestId,
      workspace_id: identity.workspaceId || '',
      workspace_name: identity.workspaceName || '',
      upload_session_id: uploadSessionId,
      entries: m.entries,
    };
    const result = await postRaw('/api/v2/manifests', identity, body);
    if (!result.ok) return result;
    const respBody = result.body || {};
    return {
      ok: true,
      status: result.status,
      manifestId: typeof respBody.manifest_id === 'string' ? respBody.manifest_id : m.manifestId,
      totalBytes: Number.isFinite(respBody.total_bytes) ? respBody.total_bytes : null,
      state: typeof respBody.state === 'string' ? respBody.state : 'pending',
      body: respBody,
    };
  }

  // Flip a manifest from 'pending' → 'committed'. ONLY called after
  // /v1/sync-verify returns ok. Idempotent — re-committing an already-
  // committed manifest returns 200 no-op (Round 3 r2 P0 #1). Server
  // atomically updates workspace_dirs.latest_manifest_id on success.
  //
  // CAS contract (plan lines 2441-2489): body MUST carry
  // `previous_manifest_id` — the latest_manifest_id the Desktop saw
  // when it built its snapshot. Server CAS:
  //   if workspace_dirs.latest_manifest_id != request.previous_manifest_id:
  //     return 409 { code: 'commit_race', current_latest: <id> }
  // This prevents two concurrent committers (project upload + path-
  // scoped upload) from losing each other's manifests via last-writer-
  // wins. Caller passes the latest id observed at snapshot-build time
  // via opts.previousManifestId (null on a fresh workspace with no
  // prior committed manifest).
  //
  // On 409 we surface `code: 'commit_race'` + `currentLatest` so the
  // caller can run the CAS-retry loop documented in the plan
  // (rebuild snapshot on top of currentLatest, re-POST, max 3
  // attempts).
  async function commitManifest(identity, manifestId, opts) {
    if (!manifestId || typeof manifestId !== 'string') {
      return { ok: false, status: 0, code: 'missing_manifest_id', error: 'manifestId is required' };
    }
    // Phase 2a Milestone 2 — server's commit endpoint now requires
    // body.workspace_name. manifest_id is per-project (composite key
    // workspace_id + workspace_name + manifest_id), so the Bearer
    // token alone (which only authorizes a workspace_id) can't
    // disambiguate which project's manifest to commit. workspace_name
    // comes from identity which the caller always supplies; verify
    // here so a malformed identity surfaces as a clear missing_field
    // error rather than the server's 400 missing_workspace_name.
    //
    // Round-1 codex M1 — trim the workspaceName check too. Server
    // does `strings.TrimSpace(...) == ""` (manifests_route.go), so a
    // whitespace-only client value would server-side 400; the client
    // guard's whole purpose is to fail fast with the SAME diagnostic
    // before the network roundtrip, so it must trim to match.
    if (!identity
        || typeof identity.workspaceName !== 'string'
        || identity.workspaceName.trim().length === 0) {
      return {
        ok: false,
        status: 0,
        code: 'missing_workspace_name',
        error: 'commitManifest requires identity.workspaceName (server commit endpoint requires body.workspace_name; manifest_id is per-project)',
      };
    }
    const o = opts || {};
    // null is a legitimate value (fresh workspace, no prior committed
    // manifest). Use `in` to distinguish "caller passed null explicitly"
    // from "caller forgot to pass anything" — the latter is a bug we
    // want to surface, not silently coerce to null.
    if (!('previousManifestId' in o)) {
      return {
        ok: false,
        status: 0,
        code: 'missing_previous_manifest_id',
        error: 'commitManifest requires opts.previousManifestId (pass null for fresh workspace, string for CAS)',
      };
    }
    const prev = o.previousManifestId;
    if (prev !== null && typeof prev !== 'string') {
      return {
        ok: false,
        status: 0,
        code: 'invalid_previous_manifest_id',
        error: 'opts.previousManifestId must be string or null',
      };
    }
    // C-2 post-commit materialize: send the server the name of the
    // staging directory it should atomically promote to the canonical
    // workspace dir after the commit CAS succeeds. Optional —
    // omitting it (or sending '') makes the server skip the promote
    // step (response.materialized=false) which matches the pre-C-2
    // behaviour. We always send it when caller has it so the bytes
    // actually land where other clients can find them.
    const stagingWsName = typeof o.stagingWorkspaceName === 'string' ? o.stagingWorkspaceName.trim() : '';
    const route = `/api/v2/manifests/${encodeURIComponent(manifestId)}/commit`;
    const body = {
      previous_manifest_id: prev,
      workspace_name: identity.workspaceName,
    };
    if (stagingWsName) {
      body.staging_workspace_name = stagingWsName;
    }
    const result = await postRaw(route, identity, body);
    if (!result.ok) {
      // 409 → commit_race — server CAS rejected because latest_manifest_id
      // moved between our snapshot-build and our commit. Pluck currentLatest
      // out of the server's body so caller doesn't have to re-fetch just
      // to know what to rebuild against.
      if (result.status === 409) {
        const respBody = result.body || {};
        const currentLatest = typeof respBody.current_latest === 'string' ? respBody.current_latest : null;
        return {
          ok: false,
          status: 409,
          code: 'commit_race',
          currentLatest,
          error: 'CAS rejected: latest_manifest_id moved during snapshot build',
          body: respBody,
        };
      }
      return result;
    }
    // Successful commit invalidates our cached latest-manifest for this
    // workspace so the next file-tree listChildren picks up the new
    // committed pointer. invalidate() bumps the per-key generation, so
    // any in-flight GET that resolves AFTER us skips its cache.set —
    // closes the race that would otherwise re-poison the cache with
    // pre-commit data (round-2 codex Important #2).
    invalidate(identity);
    return { ok: true, status: result.status, manifestId, body: result.body || {} };
  }

  // --- Phase 2b: abandon ----------------------------------------------
  //
  // POST /api/v2/manifests/{id}/abandon — flip a pending manifest to
  // 'abandoned' so the server can GC orphan rows from cancelled
  // upload sessions. Server contract (round-1 codex fold):
  //   - pending  → flipped, body {already_abandoned: false}
  //   - abandoned → idempotent no-op, body {already_abandoned: true}
  //   - committed → 409 manifest_not_pending (committed is immutable)
  //   - missing  → 404 not_found
  //   - 404 with no body code OR endpoint not deployed → endpoint_missing
  //
  // Body shape: {workspace_name} — manifest_id is composite-key so
  // server needs both. identity.workspaceName fills it; we apply the
  // same trim+type guard commitManifest uses (round-1 codex M1 / M3)
  // so a malformed identity fails fast client-side with the same
  // missing_workspace_name diagnostic.
  async function abandonManifest(identity, manifestId) {
    if (!manifestId || typeof manifestId !== 'string') {
      return { ok: false, status: 0, code: 'missing_manifest_id', error: 'manifestId is required' };
    }
    if (!identity
        || typeof identity.workspaceName !== 'string'
        || identity.workspaceName.trim().length === 0) {
      return {
        ok: false,
        status: 0,
        code: 'missing_workspace_name',
        error: 'abandonManifest requires identity.workspaceName (server endpoint requires body.workspace_name; manifest_id is per-project)',
      };
    }
    const route = `/api/v2/manifests/${encodeURIComponent(manifestId)}/abandon`;
    const body = { workspace_name: identity.workspaceName };
    const result = await postRaw(route, identity, body);
    if (!result.ok) {
      // 404 endpoint_missing is already mapped by postRaw's bare-404 arm.
      // For us, that's the legitimate "server doesn't have Phase 2b
      // deployed" graceful — caller can fall back to "don't worry about
      // server-side cleanup, the row will be GC'd by other means".
      return result;
    }
    const respBody = result.body || {};
    return {
      ok: true,
      status: result.status,
      manifestId,
      alreadyAbandoned: respBody.already_abandoned === true,
      body: respBody,
    };
  }

  // Convenience: just the paths Set (the only thing the file-tree
  // classifier needs). Same caching behavior. Caller treats null as
  // "no manifest data available" (vs. an empty Set which could ambiguously
  // mean "manifest exists but is empty" — though in practice the API
  // wouldn't ever commit an empty manifest, so the distinction rarely
  // matters).
  async function getManifestPaths(identity) {
    const result = await fetchLatestManifest(identity);
    return result.paths;
  }

  return {
    fetchLatestManifest,
    getManifestPaths,
    invalidate,
    postManifest,
    commitManifest,
    abandonManifest,
    _internals: { cache, inflight },
  };
}

// Return the subset of `overrideAnchors` for which the manifest
// contains at least one entry that equals the anchor OR descends from
// it with a "/" boundary. Used by main.cjs's listChildren handler to
// auto-commit pending overrides when a manifest refresh reveals their
// content has landed in the cloud (regardless of HOW the upload
// happened — legacy filesync, future path-scoped, manual).
//
// "/"-boundary so anchor "node_modules/foo" matches
// "node_modules/foo/index.js" but NOT "node_modules/foo-bar".
//
// KNOWN EDGE: An override on an EMPTY directory (or one whose only
// contents are hard-ignored / .kariignored) won't auto-commit via
// this helper because manifests only record files, not empty
// directories. The override row stays in pending_upload forever
// until the user adds a file under the anchor. This is acceptable
// because the user-visible badge (yellow CloudUpload) accurately
// reflects reality: nothing has actually been uploaded to the cloud
// (because there's nothing to upload). FT-Task-6's immediate-upload
// flow can address this by emitting an explicit "empty anchor"
// commit marker when the snapshot is empty; out of scope here.
function computeOverrideAnchorsInManifest(manifestPaths, overrideAnchors) {
  const out = new Set();
  if (!manifestPaths || manifestPaths.size === 0) return out;
  if (!overrideAnchors || overrideAnchors.size === 0) return out;
  for (const anchor of overrideAnchors) {
    if (manifestPaths.has(anchor)) {
      out.add(anchor);
      continue;
    }
    const prefix = anchor + '/';
    for (const p of manifestPaths) {
      if (p.startsWith(prefix)) {
        out.add(anchor);
        break;
      }
    }
  }
  return out;
}

module.exports = {
  createManifestClient,
  identityKey,
  isCompleteIdentity,
  emptyManifest,
  normalizeManifestRelPath,
  normalizeServerBaseUrl,
  computeOverrideAnchorsInManifest,
  DEFAULT_TTL_MS,
  DEFAULT_FAILURE_TTL_MS,
};
