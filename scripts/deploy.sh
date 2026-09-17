#!/usr/bin/env bash
# Deploy to an Ubuntu 24.04 server over SSH (bare metal + systemd; see docs/DEPLOYMENT.md §3a).
#
#   scripts/deploy.sh setup   <ssh-host>   first time: upload code, provision the host (pinned downloads happen on the server)
#   scripts/deploy.sh release <ssh-host>   upload code, build check on the server, back up the DB, restart
#   scripts/deploy.sh tls <ssh-host> <ip>  HTTPS on the public IP (nginx + self-signed cert pinned by desktop/)
#
# Nothing local is uploaded besides source: no data/, databases, .env, cookies, dist/ or node_modules.
set -euo pipefail

CMD="${1:-}"
HOST="${2:-}"
[[ "$CMD" =~ ^(setup|release|tls)$ && -n "$HOST" ]] || { echo "usage: $0 setup|release <ssh-host> | tls <ssh-host> <public-ip>" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

upload_code() {
  ssh "$HOST" 'install -d -m 755 /opt/xhs-operator/incoming'
  rsync -az --delete --no-owner --no-group \
    --exclude=.git --exclude=/desktop --exclude=node_modules --exclude=data --exclude=dist --exclude=coverage --exclude=.nodi-wiki \
    --include='.env.example' --exclude='.env' --exclude='.env.*' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
    --exclude='cookies*.json' --exclude='xhs-login-*.png' --exclude=.DS_Store \
    "$ROOT/" "$HOST:/opt/xhs-operator/incoming/"
}

case "$CMD" in
  setup)
    upload_code
    ssh "$HOST" 'bash /opt/xhs-operator/incoming/deploy/server/setup.sh'
    ;;
  release)
    upload_code
    ssh "$HOST" 'bash /opt/xhs-operator/incoming/deploy/server/release.sh'
    ;;
  tls)
    ip="${3:?usage: $0 tls <ssh-host> <public-ip>}"
    upload_code
    ssh "$HOST" "PUBLIC_IP='$ip' bash /opt/xhs-operator/incoming/deploy/server/tls.sh"
    ;;
esac
