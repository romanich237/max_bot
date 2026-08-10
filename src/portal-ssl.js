const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ROOT } = require('./config');
const { getLocalIpv4Addresses, resolveServerPublicIp } = require('./server-ip');

const SSL_DIR = path.join(ROOT, 'data', 'portal-ssl');
const CERT_PATH = path.join(SSL_DIR, 'cert.pem');
const KEY_PATH = path.join(SSL_DIR, 'key.pem');
const CERT_DAYS = 90;

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

function certNeedsRenewal() {
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
    return true;
  }

  try {
    const out = execSync(`openssl x509 -in "${CERT_PATH}" -noout -enddate`, {
      encoding: 'utf8',
      shell: true,
    });
    const match = out.match(/notAfter=(.+)/);
    if (!match) return true;
    const expires = new Date(match[1]);
    return expires.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function collectSanIps(publicIp) {
  const ips = new Set(['127.0.0.1']);
  if (publicIp) ips.add(publicIp);
  for (const ip of getLocalIpv4Addresses()) {
    ips.add(ip);
  }
  return [...ips];
}

async function ensurePortalSsl(publicIp) {
  if (!commandExists('openssl')) {
    console.warn('portal-ssl: openssl не найден, HTTPS недоступен');
    return null;
  }

  const ip = publicIp || (await resolveServerPublicIp());
  fs.mkdirSync(SSL_DIR, { recursive: true });

  if (!certNeedsRenewal()) {
    return {
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
      expiresInDays: CERT_DAYS,
    };
  }

  const san = collectSanIps(ip)
    .map((entry) => `IP:${entry}`)
    .join(',');

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days ${CERT_DAYS} -subj "/CN=MAX Portal" -addext "subjectAltName=${san}"`,
      { stdio: 'pipe', shell: true }
    );
    console.log(`portal-ssl: временный сертификат на ${CERT_DAYS} дней (${ip})`);
    return {
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
      expiresInDays: CERT_DAYS,
    };
  } catch (err) {
    console.warn(`portal-ssl: не удалось создать сертификат: ${err.message}`);
    return null;
  }
}

function createPortalServer(handler, tlsOptions) {
  if (tlsOptions) {
    const https = require('https');
    return https.createServer(tlsOptions, handler);
  }
  const http = require('http');
  return http.createServer(handler);
}

module.exports = {
  CERT_DAYS,
  ensurePortalSsl,
  createPortalServer,
};
