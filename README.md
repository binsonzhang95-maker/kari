# kari

Self-hostable, single-tenant **team file-sharing + remote terminal** server.

kari lets a small team point their editors at one shared host: project files
sync both ways over [Syncthing](https://syncthing.net/), and any member can open
a real interactive shell or run commands on that host — all over a single
authenticated, end-to-end-encrypted connection. One shared secret gates the
whole server; workspaces are isolated by id, so several projects (and several
clients) live side by side on one box.

This is the open-source, single-tenant core: **no registry, no billing, no
multi-tenant key database, no LLM proxy, no containers.** One secret, one sync
directory, one binary that serves its own web console.

## Features

- **Bidirectional file sync** backed by Syncthing (the server runs Syncthing as
  a private, discovery-disabled sidecar and pairs client devices on demand).
- **Remote interactive terminal** — a real PTY on POSIX, ConPTY on Windows.
- **Remote command exec** with streamed output.
- **MCP local-exec bridge** — exposes the host shell to AI CLIs (Claude Code,
  Codex) running in a session via a stdlib-only `kari-mcp-bridge` over a signed
  loopback socket.
- **Session history** — surfaces existing `~/.claude` / `~/.codex` sessions to
  the console.
- **Embedded web console** — the server ships its own single-page console at
  `/`; no separate web server to deploy.
- **Cross-platform server** — builds and runs on macOS, Linux, and Windows.

## Requirements

- **Go 1.25+** to build.
- **Syncthing v1.30** on the host (or pointed at via `--syncthing-binary`).

  > ⚠️ **Use Syncthing v1.30, not v2.x.** The sidecar drives Syncthing's REST
  > API; the v2 API is incompatible and the sidecar health-check will fail to
  > come up. Pin v1.30 until v2 support lands.

Syncthing is **mandatory** — the server aborts startup if it can't bring the
sidecar up. File sync is the product; there is no degrade-without-sync mode.

## Build

The repository is a single Go module at its root. Build from the repo root:

```sh
go build -o karid            ./cmd/karid            # the server
go build -o kari-mcp-bridge  ./cmd/kari-mcp-bridge  # optional, for MCP local-exec
```

The web console under `web/dist` is compiled into the `karid` binary via
`go:embed`; there is nothing else to build or deploy for the UI.

## Run

```sh
# Syncthing v1.30 must be on PATH (or pass --syncthing-binary /abs/path/syncthing)
export KARI_SECRET='a-long-random-shared-secret'
./karid --listen 0.0.0.0:8443 --sync-dir ./workspaces
```

Open `https://<host>:8443/` for the console. Point any kari client at the same
host and use `KARI_SECRET` as its activation code / token.

## Configuration

Every flag has an environment-variable equivalent; flags win over env.

| Flag | Env | Default | Meaning |
|------|-----|---------|---------|
| `--listen` | `KARI_LISTEN_ADDR` | `0.0.0.0:8443` | Listen address |
| `--sync-dir` | `KARI_SYNC_DIR` | `./workspaces` | Root holding the synced workspace tree(s) |
| `--secret` | `KARI_SECRET` | — | Shared secret; clients use it as their token (**required**) |
| `--shell` | `KARI_SHELL` | `/bin/bash` | Shell for exec / PTY |
| `--syncthing-binary` | `KARI_SYNCTHING_BINARY` | auto (PATH) | Absolute path to the Syncthing v1.30 binary |
| `--syncthing-port` | `KARI_SYNCTHING_PORT` | `22000` | BEP data port the sidecar binds (`0.0.0.0`) and clients connect to |
| `--syncthing-addr` | `KARI_SYNCTHING_ADDR` | derived from request host + port | Advertised Syncthing address for clients (overrides the derived one) |

The client key is `SHA-256(secret)`; the same value gates every workspace on the
server. There is no per-user or per-workspace key derivation — this is
**team sharing among trusted members**, not multi-tenant isolation.

## How it works

```
client ──┬─ gRPC FileService (cmux-multiplexed, AES-GCM envelope) ──► karid
         │     ├─ Sync   → filesync engine, rooted per workspace_id under sync-dir
         │     ├─ Exec   → remoteexec.Runner (streamed command output)
         │     └─ Pty    → remoteexec.PtyRunner → host shell (PTY / ConPTY)
         │
         ├─ HTTP  /healthz, /v1/sessions, /v1/syncthing/pair, / (console)
         │
         └─ Syncthing (tcp :22000) ◄── private sidecar, paired per folder

AI CLI in a session ──► kari-mcp-bridge ──► signed loopback socket ──► karid local-exec
```

- **Transport.** One TCP port is `cmux`-split between gRPC and HTTP. The gRPC
  stream carries an authenticated handshake and an AES-GCM envelope keyed by the
  shared secret.
- **Workspaces.** Each workspace is a subtree under `--sync-dir`, keyed by
  `workspace_id`; distinct workspaces never share a tree.
- **Syncthing.** Started as a private sidecar (LAN/global discovery, relays, and
  NAT all disabled). Folders are adopted from Syncthing's own persisted config
  on startup and added on demand by `POST /v1/syncthing/pair` as clients join.
- **MCP local-exec.** When a session advertises the capability, the server
  registers it, writes a context file (socket + signed token) the bridge reads
  from `KARI_MCP_CONTEXT`, and injects it into the PTY environment so an AI CLI
  can run host commands through the audited loopback.

## Security notes

- Treat `KARI_SECRET` like a root password: anyone with it gets a shell on the
  host. Use a long random value and serve behind TLS.
- The server runs shells **directly on the host** — there is no sandbox in this
  open-source build. Run it on a box you're willing to give your team shell on.
- The Syncthing sidecar's home is created `0700` and refuses a symlinked home;
  pair paths are validated to stay under `--sync-dir` (symlink-resolved).
- The Syncthing BEP data port (`--syncthing-port`, default `22000`) is bound on
  all interfaces so remote clients can reach it; LAN/global discovery, relays,
  and NAT traversal are disabled, so only explicitly-paired devices connect.
  **Pairing requires the shared secret** (the `/v1/syncthing/pair` endpoint is
  token-gated), but once a device is paired its Syncthing device ID becomes a
  second, standing credential: it keeps syncing without re-presenting the
  secret. To revoke a client, remove its device from the sidecar's
  `config.xml` (a built-in revoke endpoint is a planned follow-up). Rotating
  `KARI_SECRET` blocks *new* pairings and all gRPC (PTY/exec/control) access,
  but does not by itself evict an already-paired Syncthing device.

## License

The server is licensed under the **GNU AGPL-3.0** — see [LICENSE](LICENSE). The
web console (`client-web/`) is available under the **MIT License**. Third-party
components and their licenses are listed in [NOTICE](NOTICE).
