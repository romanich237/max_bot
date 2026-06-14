const os = require('os');

const PRIVATE_IPV4 =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isPrivateIpv4(ip) {
  return PRIVATE_IPV4.test(ip);
}

function getLocalIpv4Addresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  return addresses;
}

function getLocalIpv4() {
  const addresses = getLocalIpv4Addresses();
  const publicAddr = addresses.find((ip) => !isPrivateIpv4(ip));
  if (publicAddr) return publicAddr;
  return addresses[0] || '127.0.0.1';
}

async function fetchPublicIpFromService(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const ip = (await response.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveServerPublicIp() {
  const envIp = String(process.env.SERVER_PUBLIC_IP || process.env.PUBLIC_IP || '').trim();
  if (envIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(envIp)) {
    return envIp;
  }

  for (const url of [
    'https://api.ipify.org?format=text',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
  ]) {
    try {
      const ip = await fetchPublicIpFromService(url);
      if (ip) return ip;
    } catch {
      /* try next */
    }
  }

  return getLocalIpv4();
}

function buildPortalUrl(ip, port, path, token) {
  const base = `http://${ip}:${port}`;
  if (!path) return base;
  const segment = token ? `${path}/${token}` : path;
  return `${base}/${segment}`;
}

module.exports = {
  isPrivateIpv4,
  getLocalIpv4,
  getLocalIpv4Addresses,
  resolveServerPublicIp,
  buildPortalUrl,
};
