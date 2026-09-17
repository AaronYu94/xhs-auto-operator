#!/usr/bin/env bash
# Build a double-clickable macOS app: dist/AI汽车运营官.app
#
#   scripts/macos/build-app.sh [--config <env file>]
#
# The app runs this project in place (it is not a self-contained copy): it starts `node src/cli.ts serve` with the
# configuration in ~/Library/Application Support/AI汽车运营官/console.env and opens the console in its own window.
# --config installs an existing env file as that configuration (only when none exists yet).
# Rebuild after moving the project directory or changing the Node.js installation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_NAME="AI汽车运营官"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
APP="$OUT_DIR/$APP_NAME.app"
SUPPORT="$HOME/Library/Application Support/$APP_NAME"

CONFIG_SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG_SRC="${2:?--config needs a file}"; shift 2 ;;
    *) echo "usage: $0 [--config <env file>]" >&2; exit 2 ;;
  esac
done

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "build-app: node not found on PATH" >&2; exit 1; }
"$NODE_BIN" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' || { echo "build-app: Node.js >= 24 required" >&2; exit 1; }
VERSION="$("$NODE_BIN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/package.json")"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

"$NODE_BIN" -e '
  const fs = require("fs");
  const [src, dst, project, node] = process.argv.slice(1);
  fs.writeFileSync(dst, fs.readFileSync(src, "utf8").replaceAll("__PROJECT_DIR__", project).replaceAll("__NODE_BIN__", node), { mode: 0o755 });
' "$ROOT/scripts/macos/launcher.sh" "$APP/Contents/MacOS/launcher" "$ROOT" "$NODE_BIN"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>local.xhs-auto-operator.console</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

make_icon() {
  local chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  [ -x "$chrome" ] || return 1
  local tmp pid
  tmp="$(mktemp -d)"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$tmp/profile" --window-size=1024,1024 \
    --default-background-color=00000000 --screenshot="$tmp/icon.png" "file://$ROOT/scripts/macos/icon.html" >/dev/null 2>&1 &
  pid=$!
  disown "$pid" 2>/dev/null || true # headless Chrome may not exit after the screenshot; it is killed below
  for _ in $(seq 1 60); do [ -s "$tmp/icon.png" ] && break; sleep 0.5; done
  sleep 1
  kill "$pid" 2>/dev/null || true
  pkill -f "$tmp/profile" 2>/dev/null || true
  [ -s "$tmp/icon.png" ] || { rm -rf "$tmp"; return 1; }
  mkdir "$tmp/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$tmp/icon.png" --out "$tmp/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s * 2))" "$((s * 2))" "$tmp/icon.png" --out "$tmp/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$tmp/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$tmp"
}
make_icon || echo "build-app: icon skipped (Google Chrome not available for rendering)"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "build-app: ad-hoc signing skipped"

if [ -n "$CONFIG_SRC" ]; then
  mkdir -p "$SUPPORT" && chmod 700 "$SUPPORT"
  if [ -f "$SUPPORT/console.env" ]; then
    echo "build-app: kept existing configuration $SUPPORT/console.env"
  else
    install -m 600 "$CONFIG_SRC" "$SUPPORT/console.env"
    echo "build-app: installed configuration $SUPPORT/console.env"
  fi
fi

echo "built $APP"
echo "open it with: open \"$APP\"   (or drag it into /Applications / the Dock)"
