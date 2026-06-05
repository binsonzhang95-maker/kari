# Kari Desktop

Kari Desktop is a standalone Electron control console for Kari workspaces.
It replaces the VS Code extension shell with a CLI-like desktop surface:

- animated activation page
- modular sidebar with project, file count, sessions, remote config, settings, and git repository views
- monitor dashboard where every card can expand into the main screen
- line-numbered text editor with explicit save + sync
- xterm-based CLI dock for Shell, Codex, Claude, and Continue sessions

## Development

```bash
npm install
npm run dev
```

The app stores local config under Electron's `userData` directory. It does
not scan or sync arbitrary user files. A workspace root must be selected
explicitly before file tree, editor, and sync controls are enabled.

## Packaging

Desktop packaging notes live in [docs/packaging.zh-CN.md](docs/packaging.zh-CN.md). Read this before building Windows or macOS artifacts, especially when refreshing bundled runtime binaries.

## Runtime Notes

Remote CLI sessions use the `kari` CLI. Set `KARI_CLI_PATH` if it is not on
`PATH`. Daemon polling expects `kari-syncd` on `http://127.0.0.1:46321` unless
the app config is extended later.

