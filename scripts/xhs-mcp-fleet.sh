#!/usr/bin/env bash
# Run one xiaohongshu-mcp instance per managed Xiaohongshu account (+ one research instance) on this host.
#
#   XHS_MCP_TOKEN=... scripts/xhs-mcp-fleet.sh start <platform_account_id> [<platform_account_id> …]   # ids from the 账号 page
#   scripts/xhs-mcp-fleet.sh status
#   scripts/xhs-mcp-fleet.sh stop
#   XHS_MCP_SRC=... scripts/xhs-mcp-fleet.sh build-login-helper      # once: builds tools/xhs-visible-login
#   scripts/xhs-mcp-fleet.sh login <research|platform_account_id>     # log that instance in via a visible window
#
# Login: Xiaohongshu rejects QR logins scanned from an instance's headless browser (the phone shows "fail to login").
# `login` opens a visible browser window on this host with the instance's browser + fingerprint seed, waits for the
# scan and writes the instance's cookies.json; the running instance uses them on its next call (no restart needed).
# Every instance gets its own port and COOKIES_PATH (= its own login session). Instances bind to 127.0.0.1 by default
# and require the bearer token. This script never sets XHS_PROXY or XHS_FP_SEED (no proxies, no pinned fingerprints).
#
# Environment
#   XHS_MCP_BIN        xiaohongshu-mcp binary (default: xiaohongshu-mcp on PATH)
#   XHS_MCP_DATA_DIR   state directory (default: ./data/xhs-mcp) — holds cookies.json, server.log, pid per instance
#   XHS_MCP_TOKEN      bearer token (required for start; or XHS_MCP_TOKEN_FILE)
#   XHS_MCP_BIND       bind address (default 127.0.0.1; use a private-network address only behind a firewall)
#   XHS_MCP_BASE_PORT  research instance port; accounts use BASE_PORT+1, +2, … in argument order (default 18060)
#   XHS_MCP_SRC        xiaohongshu-mcp source checkout the instances were built from (build-login-helper only)
#   XHS_LOGIN_HELPER   login helper binary (default: $XHS_MCP_DATA_DIR/.bin/xhs-visible-login)
#   XHS_LOGIN_TIMEOUT  seconds the login window waits for the scan (default 300)
set -euo pipefail

BIN="${XHS_MCP_BIN:-xiaohongshu-mcp}"
DATA_DIR="${XHS_MCP_DATA_DIR:-./data/xhs-mcp}"
BIND="${XHS_MCP_BIND:-127.0.0.1}"
BASE_PORT="${XHS_MCP_BASE_PORT:-18060}"
LOGIN_HELPER="${XHS_LOGIN_HELPER:-$DATA_DIR/.bin/xhs-visible-login}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMD="${1:-}"
shift || true

die() { echo "xhs-mcp-fleet: $*" >&2; exit 1; }

token() {
  if [[ -n "${XHS_MCP_TOKEN:-}" ]]; then printf '%s' "$XHS_MCP_TOKEN"; return; fi
  if [[ -n "${XHS_MCP_TOKEN_FILE:-}" && -r "${XHS_MCP_TOKEN_FILE}" ]]; then tr -d '[:space:]' < "$XHS_MCP_TOKEN_FILE"; return; fi
  die "set XHS_MCP_TOKEN or XHS_MCP_TOKEN_FILE (the instances hold live account sessions and must require a token)"
}

valid_name() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid instance name: $1"; }

start_one() {
  local name="$1" port="$2" tok="$3"
  valid_name "$name"
  local dir="$DATA_DIR/$name"
  mkdir -p "$dir"
  chmod 700 "$dir"
  if [[ -f "$dir/pid" ]] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$dir/pid"), port $port)"
    return
  fi
  (
    cd "$dir"
    env -u XHS_PROXY -u XHS_FP_SEED COOKIES_PATH="$PWD/cookies.json" AUTH_TOKEN="$tok" \
      nohup "$BIN" -port "$BIND:$port" -headless=true > "$PWD/server.log" 2>&1 &
    echo $! > "$PWD/pid"
    # The console reads this to recognise an instance it did not start (and never start a second one on these cookies).
    echo "$port" > "$PWD/port"
  )
  touch "$dir/cookies.json" && chmod 600 "$dir/cookies.json"
  echo "$name started on http://$BIND:$port/mcp (pid $(cat "$dir/pid"), log $dir/server.log)"
}

case "$CMD" in
  start)
    command -v "$BIN" >/dev/null 2>&1 || [[ -x "$BIN" ]] || die "xiaohongshu-mcp binary not found ($BIN); build it: go build -o xiaohongshu-mcp . in the upstream repo"
    tok="$(token)"
    start_one research "$BASE_PORT" "$tok"
    port="$BASE_PORT"
    accounts=""
    for account in "$@"; do
      port=$((port + 1))
      start_one "$account" "$port" "$tok"
      accounts="${accounts:+$accounts,}$account=http://$BIND:$port/mcp"
    done
    echo
    echo "Configure the operator (tokens stay in env, never in the database):"
    echo "  XHS_PROVIDER=mcp"
    echo "  XHS_MCP_RESEARCH_URL=http://$BIND:$BASE_PORT/mcp"
    [[ -n "$accounts" ]] && echo "  XHS_MCP_ACCOUNTS=$accounts"
    echo "  XHS_MCP_TOKEN=<the same token>"
    echo "Then log every instance in through a visible login window (Xiaohongshu rejects headless QR logins):"
    echo "  $0 login <research|platform_account_id>    (build the helper once: XHS_MCP_SRC=... $0 build-login-helper)"
    echo "or from the console (账号 → 扫码登录（登录窗口）) with XHS_LOGIN_HELPER and XHS_MCP_DATA_DIR set."
    ;;
  stop)
    [[ -d "$DATA_DIR" ]] || exit 0
    for pidfile in "$DATA_DIR"/*/pid; do
      [[ -f "$pidfile" ]] || continue
      pid="$(cat "$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "stopped $(basename "$(dirname "$pidfile")") (pid $pid)"; fi
      rm -f "$pidfile"
    done
    ;;
  status)
    [[ -d "$DATA_DIR" ]] || { echo "no instances in $DATA_DIR"; exit 0; }
    for dir in "$DATA_DIR"/*/; do
      name="$(basename "$dir")"
      if [[ -f "$dir/pid" ]] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
        echo "$name: running (pid $(cat "$dir/pid")) — last log: $(tail -n 1 "$dir/server.log" 2>/dev/null | cut -c1-160)"
      else
        echo "$name: stopped"
      fi
    done
    ;;
  build-login-helper)
    src="${XHS_MCP_SRC:-}"
    [[ -n "$src" && -f "$src/go.mod" ]] || die "set XHS_MCP_SRC to the xiaohongshu-mcp source checkout the instances were built from"
    command -v go >/dev/null 2>&1 || die "Go is required to build the login helper"
    src="$(cd "$src" && pwd)"
    mkdir -p "$(dirname "$LOGIN_HELPER")"
    out="$(cd "$(dirname "$LOGIN_HELPER")" && pwd)/$(basename "$LOGIN_HELPER")"
    build="$(mktemp -d)"
    trap 'rm -rf "$build"' EXIT
    # Built against the local source so browser binary and fingerprint seed handling match the running instances.
    cp "$SCRIPT_DIR/../tools/xhs-visible-login/main.go" "$build/"
    { sed 's#^module .*#module xhs-visible-login#' "$src/go.mod"
      printf '\nrequire github.com/xpzouying/xiaohongshu-mcp v0.0.0\n\nreplace github.com/xpzouying/xiaohongshu-mcp => %s\n' "$src"; } > "$build/go.mod"
    cp "$src/go.sum" "$build/go.sum"
    (cd "$build" && GOFLAGS=-mod=mod go build -o "$out" .)
    echo "built $out"
    echo "Console login window: set XHS_LOGIN_HELPER=$out and XHS_MCP_DATA_DIR=$(cd "$DATA_DIR" 2>/dev/null && pwd || echo "$DATA_DIR")"
    ;;
  login)
    name="${1:-}"
    [[ -n "$name" ]] || die "usage: $0 login <research|platform_account_id>"
    valid_name "$name"
    [[ -x "$LOGIN_HELPER" ]] || die "login helper not found ($LOGIN_HELPER); build it once: XHS_MCP_SRC=<xiaohongshu-mcp source> $0 build-login-helper"
    dir="$DATA_DIR/$name"
    [[ -d "$dir" ]] || die "no instance $name in $DATA_DIR (start it first: $0 start …)"
    echo "Opening a login window for $name: scan the QR code in that window with this account's own Xiaohongshu app,"
    echo "and leave the window open until it closes itself."
    env -u XHS_PROXY -u XHS_FP_SEED COOKIES_PATH="$(cd "$dir" && pwd)/cookies.json" "$LOGIN_HELPER" -timeout "${XHS_LOGIN_TIMEOUT:-300}"
    echo "Done. The running instance uses the new session on its next call; check it in the console (账号 → 检测登录状态)."
    ;;
  *)
    die "usage: $0 start <platform_account_id>... | stop | status | build-login-helper | login <name>"
    ;;
esac
