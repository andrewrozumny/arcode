#!/usr/bin/env bash
# Build Acode.app and install it into /Applications.
set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -m)" in
  arm64) OUT_DIR="mac-arm64" ;;
  *) OUT_DIR="mac" ;;
esac

pnpm dist

SRC="dist/${OUT_DIR}/Acode.app"
DEST="/Applications/Acode.app"

if [ ! -d "$SRC" ]; then
  echo "Build output not found: $SRC" >&2
  exit 1
fi

# Quit a running instance so the bundle can be replaced safely.
if pgrep -x Acode >/dev/null 2>&1; then
  osascript -e 'quit app "Acode"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x Acode >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -x Acode >/dev/null 2>&1 || true
fi

mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
echo "Installed $DEST"
