#!/usr/bin/env bash
# Kari Desktop — full uninstall (macOS).
#
# Quits the app, removes /Applications/Kari.app, and deletes every
# location the app writes to under the user's home directory. After
# this script finishes, installing a fresh build produces the same
# state a first-time user would see.
#
# Usage:
#   bash uninstall-mac.sh           # interactive — asks before deleting
#   bash uninstall-mac.sh --yes     # non-interactive — proceeds silently

set -u

APP_BUNDLE_ID="com.kari.desktop"
APP_PRODUCT_NAME="Kari"
APP_BUNDLE="/Applications/${APP_PRODUCT_NAME}.app"

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    *) echo "unknown arg: $arg"; exit 2 ;;
  esac
done

paths=(
  "${APP_BUNDLE}"
  "${HOME}/Library/Application Support/${APP_PRODUCT_NAME}"
  "${HOME}/Library/Caches/${APP_BUNDLE_ID}"
  "${HOME}/Library/Caches/${APP_BUNDLE_ID}.ShipIt"
  "${HOME}/Library/Caches/${APP_PRODUCT_NAME}"
  "${HOME}/Library/Logs/${APP_PRODUCT_NAME}"
  "${HOME}/Library/Logs/${APP_BUNDLE_ID}"
  "${HOME}/Library/Preferences/${APP_BUNDLE_ID}.plist"
  "${HOME}/Library/Preferences/${APP_BUNDLE_ID}.helper.plist"
  "${HOME}/Library/Saved Application State/${APP_BUNDLE_ID}.savedState"
  "${HOME}/Library/HTTPStorages/${APP_BUNDLE_ID}"
  "${HOME}/Library/HTTPStorages/${APP_BUNDLE_ID}.binarycookies"
  "${HOME}/Library/WebKit/${APP_BUNDLE_ID}"
  "${HOME}/.kari"
)

echo "Kari Desktop uninstall will remove the following if present:"
for p in "${paths[@]}"; do
  if [ -e "$p" ]; then
    size=$(du -sh "$p" 2>/dev/null | awk '{print $1}')
    printf "  [%s]\t%s\n" "${size:-?}" "$p"
  else
    printf "  [---]\t%s (already absent)\n" "$p"
  fi
done

if [ "$YES" -ne 1 ]; then
  printf "\nProceed? [y/N] "
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 1 ;;
  esac
fi

echo
echo "Stopping ${APP_PRODUCT_NAME} if running..."
osascript -e "tell application \"${APP_PRODUCT_NAME}\" to quit" 2>/dev/null || true
sleep 1
pkill -f "${APP_BUNDLE}/Contents/MacOS/${APP_PRODUCT_NAME}" 2>/dev/null || true
pkill -f "kari-syncd" 2>/dev/null || true
pkill -f "${HOME}/.kari/runtime" 2>/dev/null || true
# Syncthing child uses the app's bundled binary; match the home dir
# rather than the binary so we don't kill a syncthing the user runs
# for other reasons.
pkill -f "syncthing.*Application Support/${APP_PRODUCT_NAME}/syncthing-config" 2>/dev/null || true
sleep 1

echo "Removing app data..."
for p in "${paths[@]}"; do
  if [ -e "$p" ]; then
    rm -rf -- "$p" && echo "  removed: $p" || echo "  FAILED:  $p"
  fi
done

echo
echo "Done. To install a new build, double-click the .dmg and drag ${APP_PRODUCT_NAME} to Applications."
