#!/usr/bin/env bash
set -euo pipefail
DOMAIN="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/config.json"
[ -f "$CFG" ] || { echo "config.json не найден" >&2; exit 3; }

DOMAIN="$(node - "$DOMAIN" <<'NODE'
const {domainToASCII}=require('url');
const raw=String(process.argv[2]||'').trim().toLowerCase().replace(/^https?:\/\//,'').split(/[\/?#]/)[0].replace(/\.$/,'');
const d=domainToASCII(raw);
const labels=d.split('.');
const ok=d.length<=253&&labels.length>=2&&labels.every(x=>x.length>0&&x.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(x));
if(!ok)process.exit(2);
process.stdout.write(d);
NODE
)" || { echo "Некорректный домен" >&2; exit 2; }

PORT="$(node -e "const c=require(process.argv[1]);const p=Number(c.webPanel&&c.webPanel.port);if(!Number.isInteger(p)||p<1024||p>65535)process.exit(2);process.stdout.write(String(p))" "$CFG")"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; elif sudo -n true 2>/dev/null; then SUDO="sudo -n"; else echo "Автонастройке SSL нужны root-права. Запустите PM2/бот с разрешённым helper через sudoers." >&2; exit 4; fi

if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then
  command -v apt-get >/dev/null || { echo "nginx/certbot не установлены и apt-get недоступен" >&2; exit 5; }
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
fi

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
cat >"$TMP" <<EOF
server {
  listen 80;
  listen [::]:80;
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

CERT_NAME="max-tg-$DOMAIN"
if ! $SUDO certbot --nginx --cert-name "$CERT_NAME" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect --keep-until-expiring; then
  echo "Certbot nginx не смог выпустить сертификат" >&2
  exit 6
fi

$SUDO nginx -t
$SUDO systemctl reload nginx
CERT="/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"
[ -e "$CERT" ] || { echo "Certbot завершился без fullchain.pem" >&2; exit 7; }
CHECK="$($SUDO openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null || true)"
printf '%s' "$CHECK" | grep -Fq "DNS:$DOMAIN" || { echo "Полученный сертификат не содержит DNS:$DOMAIN" >&2; exit 8; }

# Проверяем сертификат, который реально отдаёт nginx по SNI, а не только файл на диске.
LIVE="$(printf '' | openssl s_client -connect "127.0.0.1:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)"
printf '%s' "$LIVE" | grep -Fq "DNS:$DOMAIN" || { echo "nginx всё ещё отдаёт чужой сертификат для $DOMAIN" >&2; exit 9; }

echo "SSL подтверждён: $DOMAIN"
