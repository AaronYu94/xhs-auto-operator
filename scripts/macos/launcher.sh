#!/bin/bash
# AI汽车运营官.app launcher (copied into Contents/MacOS by scripts/macos/build-app.sh).
#
# Starts the local console (and, with XHS_PROVIDER=mcp, the local research xiaohongshu-mcp instance when its binary
# is installed and it is not running yet), then opens the console in its own app window. Closing the window stops
# only what this launch started; an already running console is left alone.
#
# Configuration: ~/Library/Application Support/AI汽车运营官/console.env (created on first launch with a generated
# console password, chmod 600). Overrides for testing: XHS_APP_CONFIG=<env file>, XHS_APP_NO_WINDOW=1.
set -uo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PROJECT_DIR="__PROJECT_DIR__"
NODE_BIN="__NODE_BIN__"
APP_NAME="AI汽车运营官"
SUPPORT="$HOME/Library/Application Support/$APP_NAME"
CONFIG="${XHS_APP_CONFIG:-$SUPPORT/console.env}"
LOG_DIR="$SUPPORT/logs"
mkdir -p "$SUPPORT" "$LOG_DIR" && chmod 700 "$SUPPORT"

alert() {
  local icon="${2:-note}"
  if [ "${XHS_APP_NO_WINDOW:-}" = "1" ]; then echo "$1" >&2; return; fi
  /usr/bin/osascript - "$1" "$icon" "$APP_NAME" >/dev/null 2>&1 <<'OSA'
on run argv
  display dialog (item 1 of argv) with title (item 3 of argv) buttons {"好"} default button 1 with icon (item 2 of argv as text)
end run
OSA
}
port_open() { /usr/bin/nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

# ── Node.js ≥ 24 ─────────────────────────────────────────────────────────────
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=""
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c"
  done
fi
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null; then
  alert "需要 Node.js 24 或更高版本。请安装后重新打开。" stop
  exit 1
fi
if [ ! -f "$PROJECT_DIR/src/cli.ts" ]; then
  alert "找不到系统目录：$PROJECT_DIR。项目移动过位置时请重新运行 scripts/macos/build-app.sh。" stop
  exit 1
fi

# ── configuration ────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG" ]; then
  (
    umask 077
    PASS="$(openssl rand -hex 6)"
    {
      echo "APP_ENV=production"
      echo "HOST=127.0.0.1"
      echo "PORT=4173"
      echo "DATABASE_PATH=\"$PROJECT_DIR/data/xhs-operator.db\""
      echo "LOG_LEVEL=info"
      echo "SCHEDULER_ENABLED=true"
      echo "XHS_PROVIDER=mcp"
      echo "XHS_MCP_RESEARCH_URL=http://127.0.0.1:18060/mcp"
      echo "CONSOLE_PASSWORD=$PASS"
      echo "SESSION_SECRET=$(openssl rand -hex 32)"
    } > "$CONFIG"
    alert "首次启动已生成控制台密码：$PASS

登录时填写您的姓名和这个密码。密码保存在：$CONFIG" note
  )
fi
chmod 600 "$CONFIG"
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a
PORT="${PORT:-8080}"
URL="http://127.0.0.1:$PORT"
XHS_MCP_DATA="${XHS_MCP_DATA:-$HOME/xhs-mcp-data}"
STARTED_CONSOLE=""
STARTED_MCP=""

cleanup() {
  [ -n "$STARTED_CONSOLE" ] && kill "$STARTED_CONSOLE" 2>/dev/null
  [ -n "$STARTED_MCP" ] && kill "$STARTED_MCP" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 0' TERM INT

# ── research xiaohongshu-mcp instance (local, optional) ──────────────────────
if [ "${XHS_PROVIDER:-}" = "mcp" ]; then
  if [ -z "${XHS_MCP_TOKEN:-}" ] && [ -r "$XHS_MCP_DATA/token" ]; then export XHS_MCP_TOKEN="$(tr -d '[:space:]' < "$XHS_MCP_DATA/token")"; fi
  # Login window (Xiaohongshu rejects QR logins scanned from the headless instance): use the helper once it is built
  # (XHS_MCP_SRC=… XHS_MCP_DATA_DIR="$XHS_MCP_DATA" scripts/xhs-mcp-fleet.sh build-login-helper).
  if [ -z "${XHS_LOGIN_HELPER:-}" ]; then
    for c in "$XHS_MCP_DATA/.bin/xhs-visible-login" "$HOME/xhs-mcp-src/bin/xhs-visible-login"; do
      [ -x "$c" ] && export XHS_LOGIN_HELPER="$c" && break
    done
  fi
  # The console starts each account's own instance itself when it can see the binary, the state dir and the token
  # (账号 → 启动本机实例); without them a new account's instance has to be started with scripts/xhs-mcp-fleet.sh.
  if [ -z "${XHS_MCP_BIN:-}" ]; then
    for c in "$HOME/xhs-mcp-src/bin/xiaohongshu-mcp" /opt/xhs/xiaohongshu-mcp; do
      [ -x "$c" ] && export XHS_MCP_BIN="$c" && break
    done
  fi
  if [ -n "${XHS_MCP_BIN:-}" ] && [ ! -x "${XHS_MCP_BIN:-}" ]; then unset XHS_MCP_BIN; fi
  if [ -n "${XHS_LOGIN_HELPER:-}${XHS_MCP_BIN:-}" ] && [ -z "${XHS_MCP_DATA_DIR:-}" ]; then export XHS_MCP_DATA_DIR="$XHS_MCP_DATA"; fi
  if [ -n "${XHS_MCP_BIN:-}" ] && [ -z "${XHS_MCP_TOKEN:-}" ]; then
    mkdir -p "$XHS_MCP_DATA" && chmod 700 "$XHS_MCP_DATA"
    (umask 077; [ -f "$XHS_MCP_DATA/token" ] || openssl rand -hex 24 > "$XHS_MCP_DATA/token")
    export XHS_MCP_TOKEN="$(tr -d '[:space:]' < "$XHS_MCP_DATA/token")"
  fi
  case "${XHS_MCP_RESEARCH_URL:-}" in
    http://127.0.0.1:*|http://localhost:*)
      RPORT="$(printf '%s' "$XHS_MCP_RESEARCH_URL" | sed -E 's#^http://[^:]+:([0-9]+).*#\1#')"
      MCP_BIN="${XHS_MCP_BIN:-}"
      if [ -n "$MCP_BIN" ] && ! port_open "$RPORT"; then
        mkdir -p "$XHS_MCP_DATA/research" && chmod 700 "$XHS_MCP_DATA"
        cd "$XHS_MCP_DATA/research" || exit 1
        env -u XHS_PROXY -u XHS_FP_SEED COOKIES_PATH="$PWD/cookies.json" AUTH_TOKEN="$XHS_MCP_TOKEN" \
          nohup "$MCP_BIN" -port "127.0.0.1:$RPORT" -headless=true >> "$PWD/server.log" 2>&1 &
        STARTED_MCP=$!
      fi
      ;;
  esac
fi

# ── console ──────────────────────────────────────────────────────────────────
if ! curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1; then
  if port_open "$PORT"; then
    alert "端口 $PORT 已被其他程序占用，无法启动控制台。可在 $CONFIG 中修改 PORT。" stop
    exit 1
  fi
  cd "$PROJECT_DIR" || exit 1
  nohup "$NODE_BIN" src/cli.ts serve >> "$LOG_DIR/console.log" 2>&1 &
  STARTED_CONSOLE=$!
  for _ in $(seq 1 100); do
    curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1 && break
    kill -0 "$STARTED_CONSOLE" 2>/dev/null || break
    sleep 0.3
  done
  if ! curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1; then
    alert "控制台启动失败：
$(tail -n 5 "$LOG_DIR/console.log" | cut -c1-300)

完整日志：$LOG_DIR/console.log" stop
    exit 1
  fi
fi

if [ "${XHS_APP_NO_WINDOW:-}" = "1" ]; then
  echo "ready $URL"
  exit 0
fi

# ── window ───────────────────────────────────────────────────────────────────
BROWSER=""
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  [ -x "$c" ] && BROWSER="$c" && break
done
if [ -n "$BROWSER" ]; then
  # A dedicated profile makes this a separate app window; the call returns when the window is closed.
  "$BROWSER" --user-data-dir="$SUPPORT/window" --app="$URL/" --window-size=1440,960 --no-first-run --no-default-browser-check >/dev/null 2>&1
else
  open "$URL/"
  if [ -n "$STARTED_CONSOLE" ]; then
    alert "控制台已在浏览器中打开：$URL。点「好」将停止本次启动的控制台。" note
  fi
fi
exit 0
