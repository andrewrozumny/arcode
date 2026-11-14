#!/usr/bin/env bash
# Build ARcode.app and install it into /Applications.
set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -m)" in
  arm64) OUT_DIR="mac-arm64" ;;
  *) OUT_DIR="mac" ;;
esac

pnpm dist

SRC="dist/${OUT_DIR}/ARcode.app"
DEST="/Applications/ARcode.app"

if [ ! -d "$SRC" ]; then
  echo "Build output not found: $SRC" >&2
  exit 1
fi

# Quit a running instance so the bundle can be replaced safely. Not pgrep: on macOS it skips its
# own ancestors, so run from a terminal inside ARcode it never sees the app. If the quit is
# cancelled, stop: replacing the bundle under a live app leaves it running the old code.
MAIN="$DEST/Contents/MacOS/ARcode"
running() { ps -axo comm= | grep -qxF "$MAIN"; }
if running; then
  osascript -e 'quit app "ARcode"' >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    running || break
    sleep 0.5
  done
  if running; then
    echo "ARcode is still running (was the quit cancelled?); not replacing the bundle." >&2
    exit 1
  fi
fi

mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
echo "Installed $DEST"
