const fs = require('fs');
const net = require('net');
const path = require('path');

const PORT_RANGE_MIN = 10000;
const PORT_RANGE_MAX = 15000;
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PORT_FILE = path.join(__dirname, '..', 'data', 'portal-port.json');

function parsePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

function isPortInRange(port) {
  const n = parsePort(port);
  return n >= PORT_RANGE_MIN && n <= PORT_RANGE_MAX;
}

function envPortalPort() {
  return parsePort(process.env.SETUP_PORT || process.env.SITE_PORT);
}

function readConfigPortalPort() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return 0;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return parsePort(cfg.sitePortal?.port || cfg.setupPortal?.port);
  } catch {
    return 0;
  }
}

function readPersistedPort() {
  try {
    if (fs.existsSync(PORT_FILE)) {
      const n = parsePort(JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port);
      if (n) return n;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function readSavedPortalPort() {
  return readPersistedPort() || readConfigPortalPort();
}

function isSetupComplete() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return false;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).setupComplete === true;
  } catch {
    return false;
  }
}

function savePortalPort(port) {
  const n = parsePort(port);
  if (!n) return 0;

  fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
  fs.writeFileSync(PORT_FILE, `${JSON.stringify({ port: n }, null, 2)}\n`, 'utf8');

  if (fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg.setupPortal = cfg.setupPortal || {};
    cfg.sitePortal = cfg.sitePortal || {};
    cfg.setupPortal.port = n;
    cfg.sitePortal.port = n;
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  }

  try {
    require('./settings-store').reload();
  } catch {
    /* store может ещё не быть загружен */
  }

  return n;
}

function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close((err) => resolve(!err));
    });
  });
}

function randomPortInRange() {
  return PORT_RANGE_MIN + Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1));
}

async function pickFreePortalPort(preferred) {
  const candidate = parsePort(preferred);
  if (isPortInRange(candidate) && (await isPortFree(candidate))) {
    return candidate;
  }

  const tried = new Set(candidate ? [candidate] : []);
  for (let i = 0; i < 80; i++) {
    const port = randomPortInRange();
    if (tried.has(port)) continue;
    tried.add(port);
    if (await isPortFree(port)) return port;
  }

  throw new Error(`Не удалось найти свободный порт в диапазоне ${PORT_RANGE_MIN}-${PORT_RANGE_MAX}`);
}

function getPortalPort() {
  return envPortalPort() || readSavedPortalPort();
}

function listenOnPort(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function bindPortalPort(server, preferred, host = '0.0.0.0') {
  let port = parsePort(preferred) || (await pickFreePortalPort());
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await listenOnPort(server, port, host);
      savePortalPort(port);
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      port = await pickFreePortalPort();
    }
  }
  throw new Error(`Не удалось занять порт в диапазоне ${PORT_RANGE_MIN}-${PORT_RANGE_MAX}`);
}

async function ensureInstallPortalPort() {
  const fromEnv = envPortalPort();
  if (fromEnv) {
    const port = isPortInRange(fromEnv) ? await pickFreePortalPort(fromEnv) : fromEnv;
    savePortalPort(port);
    return port;
  }

  const saved = readSavedPortalPort();
  if (isPortInRange(saved) && (await isPortFree(saved))) {
    savePortalPort(saved);
    return saved;
  }

  if (saved && isSetupComplete() && (await isPortFree(saved))) {
    savePortalPort(saved);
    return saved;
  }

  const port = await pickFreePortalPort(isPortInRange(saved) ? saved : undefined);
  savePortalPort(port);
  return port;
}

if (require.main === module) {
  ensureInstallPortalPort()
    .then((port) => {
      process.stdout.write(String(port));
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  PORT_RANGE_MIN,
  PORT_RANGE_MAX,
  parsePort,
  isPortInRange,
  isPortFree,
  pickFreePortalPort,
  readSavedPortalPort,
  savePortalPort,
  getPortalPort,
  ensureInstallPortalPort,
  bindPortalPort,
};
