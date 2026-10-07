#!/usr/bin/env bash
set -euo pipefail
DOMAIN="${1:-}"
[[ "$DOMAIN" =~ ^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$ ]] || { echo "Некорректный домен" >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/config.json"
[ -f "$CFG" ] || { echo "config.json не найден" >&2; exit 3; }
PORT="$(node -e "const c=require(process.argv[1]);const p=Number(c.webPanel&&c.webPanel.port);if(!Number.isInteger(p)||p<1024||p>65535)process.exit(2);process.stdout.write(String(p))" "$CFG")"
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then SUDO=sudo; else echo "Нужен root или passwordless sudo для nginx/certbot" >&2; exit 4; fi
else SUDO=""; fi
command -v nginx >/dev/null || { echo "nginx не установлен" >&2; exit 5; }
command -v certbot >/dev/null || { echo "certbot не установлен" >&2; exit 6; }
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
cat >"$TMP" <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
$SUDO install -o root -g root -m 0644 "$TMP" /etc/nginx/sites-available/max-tg-panel
$SUDO ln -sfn /etc/nginx/sites-available/max-tg-panel /etc/nginx/sites-enabled/max-tg-panel
$SUDO nginx -t
$SUDO systemctl reload nginx
$SUDO certbot --nginx --cert-name "max-tg-$DOMAIN" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect --keep-until-expiring
$SUDO nginx -t
$SUDO systemctl reload nginx
CERT="/etc/letsencrypt/live/max-tg-$DOMAIN/fullchain.pem"
[ -r "$CERT" ] || CERT="/etc/letsencrypt/live/max-tg-$DOMAIN/fullchain.pem"
CHECK="$($SUDO openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null || true)"
printf '%s' "$CHECK" | grep -Fq "DNS:$DOMAIN" || { echo "Сертификат не содержит DNS:$DOMAIN" >&2; exit 7; }
$SUDO chmod 700 /etc/letsencrypt/archive /etc/letsencrypt/live 2>/dev/null || true
echo "SSL подтверждён для $DOMAIN"
