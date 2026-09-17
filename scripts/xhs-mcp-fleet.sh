#!/usr/bin/env bash
# Run one xiaohongshu-mcp instance per managed Xiaohongshu account (+ one research instance) on this host.
#
#   XHS_MCP_TOKEN=... scripts/xhs-mcp-fleet.sh start <platform_account_id> [<platform_account_id> …]   # ids from the 账号 page
#   scripts/xhs-mcp-fleet.sh status
#   scripts/xhs-mcp-fleet.sh stop
#
# Every instance gets its own port and COOKIES_PATH (= its own login session). Instances bind to 127.0.0.1 by default
# and require the bearer token. This script never sets XHS_PROXY or XHS_FP_SEED (no proxies, no pinned fingerprints).
#
# Environment
#   XHS_MCP_BIN        xiaohongshu-mcp binary (default: xiaohongshu-mcp on PATH)
#   XHS_MCP_DATA_DIR   state directory (default: ./data/xhs-mcp) — holds cookies.json, server.log, pid per instance
#   XHS_MCP_TOKEN      bearer token (required for start; or XHS_MCP_TOKEN_FILE)
#   XHS_MCP_BIND       bind address (default 127.0.0.1; use a private-network address only behind a firewall)
#   XHS_MCP_BASE_PORT  research instance port; accounts use BASE_PORT+1, +2, … in argument order (default 18060)
set -euo pipefail

BIN="${XHS_MCP_BIN:-xiaohongshu-mcp}"
DATA_DIR="${XHS_MCP_DATA_DIR:-./data/xhs-mcp}"
BIND="${XHS_MCP_BIND:-127.0.0.1}"
BASE_PORT="${XHS_MCP_BASE_PORT:-18060}"
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
    echo "Then log every instance in from the console (账号 → 扫码登录) with that account's own Xiaohongshu app."
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
  *)
    die "usage: $0 start <platform_account_id>... | stop | status"
    ;;
esac
