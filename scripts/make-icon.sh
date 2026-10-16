#!/usr/bin/env bash
# Build resources/icon.icns and resources/icon.png (1024) from design/icon.svg.
# Rasterizer, first one found wins: rsvg-convert (brew install librsvg),
# headless Google Chrome (keeps transparent corners), qlmanage (corners get masked).
# Output goes to resources/ because build/ is git-ignored; point electron-builder
# at it with directories.buildResources = "resources".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/design/icon.svg"
OUT_DIR="$ROOT/resources"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# raster <svg> <size> <out.png>
raster() {
  local svg="$1" size="$2" out="$3"
  if command -v rsvg-convert >/dev/null; then
    rsvg-convert -w "$size" -h "$size" "$svg" -o "$out"
  elif [ -x "$CHROME" ]; then
    local html="$WORK/page.html"
    printf '<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:transparent}img{display:block;width:%spx;height:%spx}</style><img src="file://%s">' \
      "$size" "$size" "$svg" > "$html"
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
      --force-device-scale-factor=1 --window-size="$size,$size" --screenshot="$out" "file://$html" >/dev/null 2>&1
  elif command -v qlmanage >/dev/null; then
    qlmanage -t -s "$size" -o "$WORK" "$svg" >/dev/null 2>&1
    mv "$WORK/$(basename "$svg").png" "$out"
  else
    echo "No SVG rasterizer found. Install one: brew install librsvg" >&2
    exit 1
  fi
}

echo "Rasterizing master (1024)..."
raster "$SRC" 1024 "$WORK/master.png"

ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
# name:pixels
for spec in icon_16x16:16 icon_16x16@2x:32 icon_32x32:32 icon_32x32@2x:64 \
            icon_128x128:128 icon_128x128@2x:256 icon_256x256:256 icon_256x256@2x:512 \
            icon_512x512:512 icon_512x512@2x:1024; do
  name="${spec%%:*}"; px="${spec##*:}"
  if [ "$px" = 1024 ]; then cp "$WORK/master.png" "$ICONSET/$name.png"
  else sips -z "$px" "$px" "$WORK/master.png" --out "$ICONSET/$name.png" >/dev/null; fi
done

mkdir -p "$OUT_DIR"
iconutil -c icns "$ICONSET" -o "$OUT_DIR/icon.icns"
cp "$WORK/master.png" "$OUT_DIR/icon.png"
echo "Wrote $OUT_DIR/icon.icns and $OUT_DIR/icon.png"
