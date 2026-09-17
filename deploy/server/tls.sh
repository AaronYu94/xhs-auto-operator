#!/usr/bin/env bash
# HTTPS on the server's public IP address (no domain): nginx on :443 with a self-signed certificate whose
# SHA-256 fingerprint is pinned by the desktop app (desktop/server.json). Run as root after setup.sh.
#
#   PUBLIC_IP=203.0.113.10 bash deploy/server/tls.sh
#
# The certificate is generated once and kept across runs (a new one would break every installed desktop app);
# rotate it deliberately with ROTATE_CERT=1 after shipping a desktop build that pins both fingerprints.
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:-}"
TLS_DIR=/etc/xhs-operator/tls
CERT_DAYS="${CERT_DAYS:-1825}"

die() { echo "tls: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "set PUBLIC_IP to the server's public IPv4 address"
[[ -f /etc/xhs-operator/app.env ]] || die "run deploy/server/setup.sh first"

echo "== nginx"
export DEBIAN_FRONTEND=noninteractive
command -v nginx >/dev/null || { apt-get update -q && apt-get install -y -q --no-install-recommends nginx; }

echo "== certificate"
install -d -m 750 -o root -g www-data "$TLS_DIR"
if [[ ! -f "$TLS_DIR/server.crt" || "${ROTATE_CERT:-}" == 1 ]]; then
  [[ -f "$TLS_DIR/server.crt" ]] && cp "$TLS_DIR/server.crt" "$TLS_DIR/server.crt.$(date +%Y%m%d%H%M%S).bak"
  (
    umask 077
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days "$CERT_DAYS" \
      -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" -subj "/CN=xhs-operator $PUBLIC_IP" \
      -addext "subjectAltName=IP:$PUBLIC_IP" -addext "basicConstraints=critical,CA:FALSE" \
      -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=serverAuth"
  )
fi
chown root:www-data "$TLS_DIR/server.key" && chmod 640 "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/server.crt"
openssl x509 -in "$TLS_DIR/server.crt" -noout -checkip "$PUBLIC_IP" | grep -q 'does match' || die "certificate is not valid for $PUBLIC_IP (ROTATE_CERT=1 to replace it)"

echo "== nginx site"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -m 644 "$here/nginx/xhs-operator.conf" /etc/nginx/sites-available/xhs-operator
ln -sfn /etc/nginx/sites-available/xhs-operator /etc/nginx/sites-enabled/xhs-operator
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl reload-or-restart nginx

echo "== app configuration"
set_env() {
  local key="$1" value="$2" file=/etc/xhs-operator/app.env
  if grep -q "^$key=" "$file"; then sed -i "s|^$key=.*|$key=$value|" "$file"; else printf '%s=%s\n' "$key" "$value" >> "$file"; fi
}
set_env PUBLIC_BASE_URL "https://$PUBLIC_IP"
set_env TRUST_PROXY true
if systemctl is-active --quiet xhs-operator; then systemctl restart xhs-operator; fi

fingerprint="sha256/$(openssl x509 -in "$TLS_DIR/server.crt" -outform der | openssl dgst -sha256 -binary | base64)"
echo
echo "url:         https://$PUBLIC_IP"
echo "expires:     $(openssl x509 -in "$TLS_DIR/server.crt" -noout -enddate | cut -d= -f2)"
echo "fingerprint: $fingerprint"
echo "Open TCP 443 in the cloud security group. Put url + fingerprint into desktop/server.json."
