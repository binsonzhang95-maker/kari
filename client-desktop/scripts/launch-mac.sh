#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_APP="$APP_ROOT/node_modules/electron/dist/Electron.app"
ELECTRON_BIN="$ELECTRON_APP/Contents/MacOS/Electron"

cd "$APP_ROOT"

npm run build

if [[ -d "$ELECTRON_APP" ]]; then
  xattr -cr "$ELECTRON_APP" || true
  codesign --force --deep --sign - "$ELECTRON_APP" >/dev/null
fi

exec "$ELECTRON_BIN" "$APP_ROOT"
