#!/usr/bin/env bash
# Install the code staged in /opt/xhs-operator/incoming (uploaded by scripts/deploy.sh) and restart the service.
# The release is refused unless typecheck + unit tests + build check pass on the server's own Node.js.
# The database is backed up before every restart; migrations run automatically at startup.
set -euo pipefail

STAGE=/opt/xhs-operator/incoming
APP=/opt/xhs-operator/app
DB=/var/lib/xhs-operator/xhs-operator.db
BACKUPS=/var/lib/xhs-operator/backups

[[ $EUID -eq 0 ]] || { echo "release: run as root" >&2; exit 1; }
[[ -f "$STAGE/package.json" ]] || { echo "release: nothing staged in $STAGE" >&2; exit 1; }

echo "== build check (node $(node --version))"
cd "$STAGE"
npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com
npm run build

echo "== database backup"
if [[ -f "$DB" ]]; then
  install -d -m 700 -o xhs -g xhs "$BACKUPS"
  out="$BACKUPS/xhs-operator-$(date +%Y%m%d-%H%M%S).db"
  runuser -u xhs -- sqlite3 "$DB" ".backup '$out'"
  ls -1t "$BACKUPS"/xhs-operator-*.db | tail -n +15 | xargs -r rm -f   # keep the 14 newest
  echo "backup: $out"
else
  echo "no database yet"
fi

echo "== install"
install -m 644 deploy/systemd/xhs-operator.service /etc/systemd/system/xhs-operator.service
install -m 644 deploy/systemd/xhs-mcp@.service /etc/systemd/system/xhs-mcp@.service
systemctl daemon-reload
rsync -a --delete "$STAGE/" "$APP/"
chown -R root:root "$APP" && chmod -R go-w,a+rX "$APP"

echo "== restart"
systemctl restart xhs-operator.service
for _ in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:8080/readyz >/dev/null 2>&1; then break; fi
  sleep 1
done
systemctl --no-pager --lines=0 status xhs-operator.service | head -5
curl -sS -m 5 http://127.0.0.1:8080/readyz; echo
runuser -u xhs -- bash -c "set -a && . /etc/xhs-operator/app.env && set +a && cd '$APP' && /usr/local/bin/node src/cli.ts doctor" || true
