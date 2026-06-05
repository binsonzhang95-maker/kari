# kari

**English** | [中文](README.zh-CN.md)

<img width="1440" height="920" alt="image" src="https://github.com/user-attachments/assets/dad0b16f-bdfa-420c-a654-ab65e701853c" />

Self-hosted backplane for **team vibe coding** — run AI coding CLIs (Claude
Code, Codex, DeepSeek, …) on one shared server, collaborating on shared projects.

Your team points at one host and runs their coding CLIs there, in remote
terminals. Open **many sessions at once**, across **many projects**; project
files sync both ways via [Syncthing](https://syncthing.net/) so everyone works
on the **same project trees** in real time; and session history is shared so you
can browse and resume past CLI runs. Each member connects with one shared secret
over an end-to-end-encrypted link — a desktop app, a web console, and a CLI all
talk to the same server.

This is the open-source, single-tenant core: **no registry, no billing, no
multi-tenant key database, no cloud, no LLM proxy, no containers.** You bring
your own CLI tools and run them on your own box.

## Components

| Component | Path | What it is |
|-----------|------|------------|
| **karid** | `cmd/karid` | The server. Speaks the gRPC FileService protocol (sync / exec / PTY) + HTTP, runs a private Syncthing sidecar, and serves the embedded web console. |
| **Desktop app** | `client-desktop/` | An Electron client: open local project folders, they sync to the server; open remote terminals; browse session history. |
| **Web console** | `client-web/` → `web/` | A single-page console embedded into `karid` at `/`. |
| **kari** | `cmd/kari` | A CLI that opens a remote PTY (`kari pty …`). |
| **kari-syncd** | `cmd/kari-syncd` | The desktop's bundled loopback control daemon. |
| **kari-mcp-bridge** | `cmd/kari-mcp-bridge` | Exposes the host shell to AI CLIs (Claude Code, Codex) over a signed loopback socket (MCP local-exec). |

## Features

- **Run coding CLIs remotely** — open a real terminal on the server and launch
  `claude`, `codex`, `deepseek`, … (PTY on POSIX, ConPTY on Windows).
- **Multi-session, multi-project** — open many concurrent terminals across many
  project trees at once; each project is its own synced folder in the workspace.
- **Shared project files** — Syncthing mirrors every member's project tree both
  ways (a private, discovery-disabled sidecar, paired on demand), so the team
  collaborates on the same code.
- **Shared session history** — browse and resume past Claude / Codex sessions
  (`~/.claude`, `~/.codex`) surfaced from the host.
- **MCP local-exec bridge** — let the AI CLI run host commands through an audited
  loopback bridge.
- **Embedded web console** — no separate web server to deploy.
- **Cross-platform** server (macOS, Linux, Windows).

## Requirements

- **Go 1.25+** to build the server / Go binaries.
- **Node 18+** to build/run the desktop app.
- **Syncthing v1.30** on the server host (and bundled with the desktop app).

  > ⚠️ **Use Syncthing v1.30, not v2.x.** The sidecar drives Syncthing's REST
  > API; the v2 API is incompatible and the health check won't come up. Pin
  > v1.30 until v2 support lands.

Syncthing is **mandatory** — the server aborts startup if it can't bring the
sidecar up, and the gRPC stream runs control-only (Syncthing is the sole file
mover). File sync is the product; there is no degrade-without-sync mode.

## Quick start (server)

The repository is a single Go module at its root. Build and run from the root:

```sh
# Syncthing v1.30 must be on PATH (or pass --syncthing-binary /abs/path)
go build -o karid ./cmd/karid
./karid --listen 0.0.0.0:8443 --sync-dir ./workspaces
```

If you don't set a secret, `karid` generates a strong one, prints it once, and
saves it to `<sync-dir>/.kari-secret` (stable across restarts):

```
no KARI_SECRET set — generated one and saved it to ./workspaces/.kari-secret:
    a6G7QTL1dpSeYIatNYJcR1B6N7KOzGpL
share it with your team; they enter it as the shared secret.
```

Open `https://<host>:8443/` for the console. Point a client at the same host and
use that secret.

## The shared secret (your team's token)

kari is **team sharing among trusted members**, not multi-tenant isolation.
There is exactly one secret per server — it *is* the access token:

- **Set it** with `KARI_SECRET` / `--secret`, or let `karid` generate one (above).
- **It's the token clients enter** (desktop "Shared secret" field, `kari --license`).
  The transport key is `SHA-256(secret)`, derived identically on both sides.
- **Generate a strong one** with any random string, e.g.
  `openssl rand -base64 24`, or just let `karid` mint + persist it.
- **Rotate / revoke** by changing the secret: every client must re-enter the new
  one, so rotating it effectively kicks everyone (there is no per-client token in
  this build — that would be a step back toward multi-tenant; see *Security*).

Treat the secret like a root password: anyone with it gets a shell on the host.

## Desktop app

```sh
cd client-desktop
npm install
# Put the runtime binaries where the app expects them:
#   bundled-runtime/<platform>/{kari-syncd, syncthing, kari}
# (build kari-syncd + kari from this repo; drop in Syncthing v1.30)
npm run dev        # or:  npm run build && npm run package
```

On first launch it shows an activation screen — enter the **server address**
(`host:8443`) and the **shared secret**. Open a project folder and it syncs to
the server; open a terminal and you get a remote shell in the same tree.

The desktop app keeps its own app-data dir (`kari-oss`) and its own daemon port
(`46331`), so it never collides with any other kari install on the same machine.

## Configuration (server)

Every flag has an environment-variable equivalent; flags win over env.

| Flag | Env | Default | Meaning |
|------|-----|---------|---------|
| `--listen` | `KARI_LISTEN_ADDR` | `0.0.0.0:8443` | Listen address |
| `--sync-dir` | `KARI_SYNC_DIR` | `./workspaces` | Root holding the synced workspace tree(s) |
| `--secret` | `KARI_SECRET` | auto-generated | Shared secret; clients use it as their token |
| `--shell` | `KARI_SHELL` | `/bin/bash` | Shell for exec / PTY |
| `--syncthing-binary` | `KARI_SYNCTHING_BINARY` | auto (PATH) | Absolute path to the Syncthing v1.30 binary |
| `--syncthing-port` | `KARI_SYNCTHING_PORT` | `22000` | BEP data port the sidecar binds (`0.0.0.0`) and clients connect to |
| `--syncthing-addr` | `KARI_SYNCTHING_ADDR` | derived from request host + port | Advertised Syncthing address for clients (overrides the derived one) |

## How it works

```
desktop / CLI ──┬─ gRPC FileService (cmux-multiplexed, AES-GCM envelope) ──► karid
                │     ├─ Sync → CONTROL channel only (bootstrap, session list,
                │     │          MCP local-exec, PTY-count) — files go via Syncthing
                │     ├─ Exec → remoteexec.Runner (streamed output)
                │     └─ Pty  → remoteexec.PtyRunner → host shell (PTY / ConPTY)
                │
                ├─ HTTP  /healthz, /v1/sessions, /v1/syncthing/pair, / (console)
                │
                └─ Syncthing (tcp :22000) ◄── private sidecar, paired per project

AI CLI in a session ──► kari-mcp-bridge ──► signed loopback socket ──► karid local-exec
```

- **One secret, one key.** The gRPC handshake carries an AES-GCM envelope keyed
  by `SHA-256(secret)`; the server's `singleKeyResolver` returns that one key for
  any `workspace_id`.
- **Workspaces & projects.** A workspace is a subtree `<sync-dir>/<workspace_id>/<workspace_name>`;
  each paired project is a Syncthing folder *inside* it, so a remote terminal at
  the workspace root sees every synced project as a subdirectory.
- **Syncthing is the file plane.** Started as a private sidecar (LAN/global
  discovery, relays, and NAT all disabled), bound on a fixed externally-reachable
  port. The gRPC `Sync` stream is control-only on both ends — it never moves files.
- **Pairing.** `POST /v1/syncthing/pair` (Bearer = secret) registers a client's
  device, creates the project folder, and returns the server's device id +
  address so the client configures its own side.

## Security notes

- Treat `KARI_SECRET` like a root password: anyone with it gets a shell on the
  host. Use a long random value and serve behind TLS.
- The server runs shells **directly on the host** — there is no sandbox in this
  open-source build. Run it on a box you're willing to give your team shell on.
- The Syncthing sidecar's home is `0700` and refuses a symlinked home; pair
  paths are validated to stay under `--sync-dir` (symlink-resolved).
- The Syncthing BEP port (`--syncthing-port`, default `22000`) is bound on all
  interfaces so remote clients can reach it; discovery/relays/NAT are off, so
  only explicitly-paired devices connect. **Pairing requires the secret**, but
  once a device is paired its Syncthing device ID is a standing credential — it
  keeps syncing without re-presenting the secret. To revoke a client, remove its
  device from the sidecar's `config.xml`. Rotating `KARI_SECRET` blocks new
  pairings and all gRPC access but does not by itself evict an already-paired
  device. (Per-client revocable tokens — an auth/data-key split — are a possible
  future addition; they're deliberately out of scope for this pure-team-sharing
  build.)

## Repository layout

```
kari/
├── cmd/karid              the server
├── cmd/kari               remote PTY CLI
├── cmd/kari-syncd         desktop's bundled control daemon
├── cmd/kari-mcp-bridge    MCP local-exec bridge
├── internal/              shared core (transport, filesync, syncthing, …)
├── web/                   embedded web console (go:embed dist)
├── client-web/            console SPA source
├── client-desktop/        Electron desktop client
└── go.mod                 module github.com/binsonzhang95-maker/kari
```

## License

kari is licensed under the **GNU AGPL-3.0** — see [LICENSE](LICENSE). This covers
the whole repository: the server, the web console (`client-web/`), and the
desktop app (`client-desktop/`). You may use, modify, and self-host it
(including commercially), but if you offer it to others as a network service you
must release your full modified source under the same license. Third-party
components and their licenses are listed in [NOTICE](NOTICE).
