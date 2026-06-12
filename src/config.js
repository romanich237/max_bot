const path = require('path');
const store = require('./settings-store');

const ROOT = path.resolve(__dirname, '..');

function resolveFromRoot(relativePath) {
  return path.resolve(ROOT, relativePath);
}

function getRaw() {
  return store.get();
}

function getTelegram() {
  const t = getRaw().telegram || {};
  return {
    ...t,
    showTime: t.showTime ?? false,
    showServiceHeader: t.showServiceHeader ?? false,
  };
}

function getAdminChatIds() {
  const t = getTelegram();
  const explicit = t.adminChatIds || [];
  if (explicit.length) return explicit.map(String);
  return (t.chatIds || []).map(String);
}

function getMax() {
  return getRaw().max || {};
}

function getProfileRotate() {
  const p = getRaw().profileRotate || {};
  return {
    enabled: p.enabled ?? false,
    intervalMs: p.intervalMs ?? 60000,
    mode: p.mode ?? 'letter',
    baseName: p.baseName ?? '',
    names: p.names ?? [],
  };
}

function getAlwaysOnline() {
  const o = getRaw().alwaysOnline || {};
  return {
    enabled: o.enabled ?? false,
    intervalMs: o.intervalMs ?? 30000,
  };
}

function getDatabase() {
  const d = getRaw().database || {};
  return {
    enabled: d.enabled ?? true,
    host: process.env.MYSQL_HOST || d.host || 'localhost',
    port: Number(process.env.MYSQL_PORT || d.port || 3306),
    user: process.env.MYSQL_USER || d.user || '',
    password: process.env.MYSQL_PASSWORD || d.password || '',
    database: process.env.MYSQL_DATABASE || d.database || '',
  };
}

function getSettings() {
  return {
    checkIntervalMs: 2000,
    headless: true,
    forwardOnStart: 3,
    userDataDir: resolveFromRoot('./max_user_data'),
    stateFile: resolveFromRoot('./state.json'),
    dataDir: resolveFromRoot('./data'),
  };
}

function isSetupComplete() {
  return getRaw().setupComplete === true;
}

module.exports = {
  ROOT,
  store,
  resolveFromRoot,
  getRaw,
  getTelegram,
  getAdminChatIds,
  getMax,
  getProfileRotate,
  getAlwaysOnline,
  getDatabase,
  getSettings,
  isSetupComplete,
};
