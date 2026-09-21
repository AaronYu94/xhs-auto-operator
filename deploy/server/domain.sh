#!/usr/bin/env bash
# HTTPS on a domain name: nginx site for DOMAIN (+ www redirect) with a Let's Encrypt certificate, renewed
# automatically by certbot's timer. Run as root after setup.sh and tls.sh.
#
#   DOMAIN=example.com ACME_EMAIL=you@example.com AGREE_ACME_TOS=1 bash deploy/server/domain.sh
#
# Preconditions it checks rather than assumes:
#   - DOMAIN and www.DOMAIN resolve to this server (an A record at the DNS provider);
#   - on a mainland-China server the domain has an ICP filing (备案). Without it the cloud provider intercepts HTTP
#     on the domain, the ACME challenge never reaches nginx, and certbot fails: the script says so instead of retrying.
# AGREE_ACME_TOS=1 is required because issuing a certificate accepts the Let's Encrypt subscriber agreement
# (https://letsencrypt.org/repository/): that is the operator's decision, not the script's.
# The IP-address site and its pinned self-signed certificate are left untouched, so desktop apps keep working.
set -euo pipefail

DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
WEBROOT=/var/www/acme
SITE=/etc/nginx/sites-available/xhs-operator-domain

die() { echo "domain: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ "$DOMAIN" =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]] || die "set DOMAIN to a lower-case domain name, e.g. example.com"
[[ "$ACME_EMAIL" == *@* ]] || die "set ACME_EMAIL (Let's Encrypt sends expiry warnings there)"
[[ "${AGREE_ACME_TOS:-}" == 1 ]] || die "set AGREE_ACME_TOS=1 to accept the Let's Encrypt subscriber agreement"
[[ -f /etc/xhs-operator/app.env ]] || die "run deploy/server/setup.sh first"
command -v nginx >/dev/null || die "nginx is missing: run deploy/server/tls.sh first"

echo "== DNS"
public_ip="${PUBLIC_IP:-$(curl -fsS -m 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || curl -fsS -m 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)}"
[[ -n "$public_ip" ]] || die "cannot tell this server's public IP; pass PUBLIC_IP=…"
for host in "$DOMAIN" "www.$DOMAIN"; do
  # getent fails when the name does not resolve at all; that is the case to explain, not to exit on silently
  got="$( (getent ahostsv4 "$host" || true) | awk '{print $1}' | sort -u | tr '\n' ' ')"
  [[ " $got " == *" $public_ip "* ]] || die "$host resolves to '${got:-nothing}', not $public_ip: add an A record for it and wait for DNS"
  echo "$host -> $public_ip"
done

echo "== certbot"
command -v certbot >/dev/null || { snap install --classic certbot && ln -sfn /snap/bin/certbot /usr/local/bin/certbot; }
install -d -m 755 "$WEBROOT"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render() { sed "s/__DOMAIN__/$DOMAIN/g" "$here/nginx/xhs-operator-domain.conf"; }

if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  # First issue: nginx cannot load the 443 blocks before the certificate exists, so serve only the challenge.
  render | awk '/^# :80 answers/{p=1} p && /^}/{print; exit} p' > "$SITE"
  ln -sfn "$SITE" /etc/nginx/sites-enabled/xhs-operator-domain
  nginx -t && systemctl reload nginx
  if ! certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" -d "www.$DOMAIN" \
      --non-interactive --agree-tos -m "$ACME_EMAIL" --keep-until-expiring; then
    rm -f /etc/nginx/sites-enabled/xhs-operator-domain && nginx -t && systemctl reload nginx
    die "certificate not issued. On a mainland-China server this almost always means the domain has no ICP filing yet (备案): the provider intercepts http://$DOMAIN before it reaches nginx. File it, then run this again."
  fi
fi

echo "== nginx site"
render > "$SITE"
ln -sfn "$SITE" /etc/nginx/sites-enabled/xhs-operator-domain
nginx -t
systemctl reload nginx

# renewals are done by certbot's own timer; nginx has to pick up the new files
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "== app configuration"
set_env() {
  local key="$1" value="$2" file=/etc/xhs-operator/app.env
  if grep -q "^$key=" "$file"; then sed -i "s|^$key=.*|$key=$value|" "$file"; else printf '%s=%s\n' "$key" "$value" >> "$file"; fi
}
set_env PUBLIC_BASE_URL "https://$DOMAIN"
set_env TRUST_PROXY true
systemctl is-active --quiet xhs-operator && systemctl restart xhs-operator

echo
echo "url:     https://$DOMAIN"
echo "expires: $(openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/cert.pem" -noout -enddate | cut -d= -f2) (renewed automatically)"
echo "The IP address still serves the console for installed desktop apps."
