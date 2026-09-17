#!/usr/bin/env bash
# One-time (idempotent) provisioning of an Ubuntu 24.04 x86_64 host for AI 汽车运营官, without Docker.
# Run as root on the server. Every downloaded artifact is pinned by sha256, so mirrors (Aliyun Node.js mirror,
# GitHub download proxies for hosts that cannot reach github.com) cannot substitute a different binary.
#
#   MCP_SLOTS=5 bash deploy/server/setup.sh
#
# Layout
#   /opt/node-<ver>, /usr/local/bin/{node,npm,npx}   Node.js 24 (sha256 checked against nodejs.org)
#   /opt/xhs-mcp/bin/xiaohongshu-mcp                 pinned upstream release
#   /opt/xhs-mcp/cache/…/browser/<ver>/chrome        pinned bundled Chromium (sha256 checked)
#   /opt/xhs-operator/app                            application code (deploy/server/release.sh)
#   /var/lib/xhs-operator                            SQLite database (user xhs, 0700)
#   /var/lib/xhs-mcp/<instance>                      one login session per instance (user xhsmcp, 0700)
#   /etc/xhs-operator/app.env, mcp.env               secrets (generated once, never printed)
#   /etc/xhs-operator/mcp-<instance>.env             instance port: research 18060, slotN 18060+N
set -euo pipefail

NODE_MAJOR=24
MCP_VERSION=v2.5.0
MCP_SHA256=2695820af3a924412c0e555042b81a2598d144342539d4ebea18b17d56c85fbf
CHROMIUM_VERSION=148.0.7778.215
CHROMIUM_SHA256=a0a50ba07be7db22bd74dac79c23a9fc1f3b8cbf8a647cc2e04465ae176cdb77
CHROMIUM_URL="https://cdn.one-world.ai/browsers/$CHROMIUM_VERSION/linux-x64.tar.xz"
NODE_MIRROR=https://mirrors.aliyun.com/nodejs-release
MCP_URL="https://github.com/xpzouying/xiaohongshu-mcp/releases/download/$MCP_VERSION/xiaohongshu-mcp-linux-amd64"
# Download proxies tried in order before github.com itself (direct downloads from mainland China often stall).
MCP_URL_PREFIXES="${MCP_URL_PREFIXES:-https://ghfast.top/ https://gh-proxy.com/}"
MCP_SLOTS="${MCP_SLOTS:-5}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
MCP_BASE_PORT=18060

log() { printf '\n== %s\n' "$*"; }
die() { echo "setup: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ "$(uname -m)" == x86_64 ]] || die "x86_64 only (the upstream Chromium build is linux-x64)"
[[ "$MCP_SLOTS" =~ ^[0-9]+$ ]] || die "MCP_SLOTS must be a number"

log "packages (Chromium runtime libraries, CJK fonts)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl xz-utils rsync sqlite3 openssl \
  fonts-liberation fonts-noto-color-emoji fonts-wqy-zenhei \
  libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libexpat1 \
  libfontconfig1 libgbm1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 \
  libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 \
  libxshmfence1 libxss1 libxtst6

log "swap ($SWAP_SIZE)"
if ! swapon --show=NAME --noheadings | grep -q .; then
  fallocate -l "$SWAP_SIZE" /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/90-xhs-operator.conf
fi
swapon --show

log "service users"
id xhs >/dev/null 2>&1 || useradd --system --home-dir /var/lib/xhs-operator --shell /usr/sbin/nologin xhs
id xhsmcp >/dev/null 2>&1 || useradd --system --home-dir /var/lib/xhs-mcp --shell /usr/sbin/nologin xhsmcp

log "Node.js $NODE_MAJOR"
NODE_VERSION="$(curl -fsS -m 30 "$NODE_MIRROR/index.json" | grep -o "\"version\":\"v$NODE_MAJOR\.[0-9.]*\"" | head -1 | cut -d'"' -f4)"
[[ -n "$NODE_VERSION" ]] || die "could not resolve the latest Node.js $NODE_MAJOR release"
NODE_DIR="/opt/node-$NODE_VERSION"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tmp="$(mktemp -d)"
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsS -m 600 -o "$tmp/$tarball" "$NODE_MIRROR/$NODE_VERSION/$tarball"
  # Checksums come from nodejs.org itself, not from the mirror that served the tarball.
  want="$(curl -fsS -m 60 "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | awk -v f="$tarball" '$2 == f {print $1}')"
  [[ -n "$want" ]] || die "no checksum for $tarball on nodejs.org"
  echo "$want  $tmp/$tarball" | sha256sum -c --quiet - || die "Node.js checksum mismatch"
  mkdir -p "$NODE_DIR" && tar -xJf "$tmp/$tarball" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
for bin in node npm npx; do ln -sfn "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"; done
node --version

log "xiaohongshu-mcp $MCP_VERSION"
install -d -m 755 /opt/xhs-mcp/bin
if ! echo "$MCP_SHA256  /opt/xhs-mcp/bin/xiaohongshu-mcp" | sha256sum -c --quiet - 2>/dev/null; then
  tmp="$(mktemp -d)"
  ok=""
  for prefix in $MCP_URL_PREFIXES ""; do
    echo "trying ${prefix:-github.com}"
    if curl -fsSL -m 300 --connect-timeout 10 -o "$tmp/mcp" "$prefix$MCP_URL" \
      && echo "$MCP_SHA256  $tmp/mcp" | sha256sum -c --quiet -; then ok=1; break; fi
  done
  [[ -n "$ok" ]] || die "could not download xiaohongshu-mcp $MCP_VERSION with the pinned checksum"
  install -m 755 "$tmp/mcp" /opt/xhs-mcp/bin/xiaohongshu-mcp
  rm -rf "$tmp"
fi

log "Chromium $CHROMIUM_VERSION (bundled browser of xiaohongshu-mcp)"
BROWSER_DIR="/opt/xhs-mcp/cache/xiaohongshu-mcp/browser/$CHROMIUM_VERSION"
if [[ ! -x "$BROWSER_DIR/chrome" ]]; then
  tmp="$(mktemp -d)"
  curl -fsS -m 1800 --retry 3 -o "$tmp/browser.tar.xz" "$CHROMIUM_URL"
  echo "$CHROMIUM_SHA256  $tmp/browser.tar.xz" | sha256sum -c --quiet - || die "Chromium checksum mismatch"
  mkdir -p "$BROWSER_DIR" && tar -xJf "$tmp/browser.tar.xz" -C "$BROWSER_DIR" --strip-components=1
  rm -rf "$tmp"
  [[ -x "$BROWSER_DIR/chrome" ]] || die "chrome binary not found after extraction"
fi
chmod -R go-w,a+rX /opt/xhs-mcp

log "directories"
install -d -m 755 /opt/xhs-operator /opt/xhs-operator/app
install -d -m 700 -o xhs -g xhs /var/lib/xhs-operator
install -d -m 700 -o xhsmcp -g xhsmcp /var/lib/xhs-mcp
install -d -m 755 /etc/xhs-operator

log "secrets (generated once; never printed)"
umask 077
if [[ ! -f /etc/xhs-operator/mcp.env ]]; then
  printf 'AUTH_TOKEN=%s\n' "$(openssl rand -hex 24)" > /etc/xhs-operator/mcp.env
fi
MCP_TOKEN="$(sed -n 's/^AUTH_TOKEN=//p' /etc/xhs-operator/mcp.env)"
if [[ ! -f /etc/xhs-operator/app.env ]]; then
  cat > /etc/xhs-operator/app.env <<EOF
APP_ENV=production
HOST=127.0.0.1
PORT=8080
DATABASE_PATH=/var/lib/xhs-operator/xhs-operator.db
LOG_LEVEL=info
CONSOLE_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
SESSION_SECRET=$(openssl rand -hex 32)
PUBLIC_BASE_URL=
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000
XHS_PROVIDER=mcp
XHS_MCP_RESEARCH_URL=http://127.0.0.1:$MCP_BASE_PORT/mcp
# Empty on purpose: bind each account to its instance in the console (账号 → 实例地址, http://127.0.0.1:1806N/mcp).
XHS_MCP_ACCOUNTS=
XHS_MCP_TOKEN=$MCP_TOKEN
XHS_MCP_TIMEOUT_MS=120000
ANTHROPIC_API_KEY=
JUGUANG_WEBHOOK_TOKEN=
JUGUANG_DEFAULT_DEALER_ID=
EOF
fi
chown root:xhs /etc/xhs-operator/app.env && chmod 640 /etc/xhs-operator/app.env
chown root:xhsmcp /etc/xhs-operator/mcp.env && chmod 640 /etc/xhs-operator/mcp.env

instances=(research)
for ((i = 1; i <= MCP_SLOTS; i++)); do instances+=("slot$i"); done
for name in "${instances[@]}"; do
  if [[ "$name" == research ]]; then port=$MCP_BASE_PORT; else port=$((MCP_BASE_PORT + ${name#slot})); fi
  printf 'XHS_MCP_PORT=%s\n' "$port" > "/etc/xhs-operator/mcp-$name.env"
  chmod 644 "/etc/xhs-operator/mcp-$name.env"
done
umask 022

log "systemd units"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -m 644 "$here/systemd/xhs-mcp@.service" /etc/systemd/system/xhs-mcp@.service
install -m 644 "$here/systemd/xhs-operator.service" /etc/systemd/system/xhs-operator.service
systemctl daemon-reload
for name in "${instances[@]}"; do systemctl enable --now "xhs-mcp@$name.service"; done
systemctl enable xhs-operator.service

log "done — instances"
for name in "${instances[@]}"; do
  printf '  %-9s http://127.0.0.1:%s/mcp  %s\n' "$name" "$(sed -n 's/^XHS_MCP_PORT=//p' "/etc/xhs-operator/mcp-$name.env")" "$(systemctl is-active "xhs-mcp@$name")"
done
echo "Next: deploy/server/release.sh installs the application and starts xhs-operator."
