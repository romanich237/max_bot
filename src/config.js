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

function isPrivateChatId(chatId) {
  return Number(chatId) > 0;
}

function getNotificationChatIds() {
  const t = getTelegram();
  const ids = (t.chatIds || []).map(String);
  if (!ids.length) return [];

  const admins = getAdminChatIds();
  const privateAdmin = admins.find(isPrivateChatId);
  const hasGroup = ids.some((id) => !isPrivateChatId(id));

  if (hasGroup && privateAdmin && !ids.includes(privateAdmin)) {
    return [privateAdmin, ...ids];
  }

  return [...new Set(ids)];
}

function getMax() {
  const m = getRaw().max || {};
  return {
    ...m,
    monitoringEnabled: m.monitoringEnabled !== false,
  };
}

function getMaxDisplayName() {
  const max = getMax();
  const direct = String(max.currentDisplayName || '').trim();
  if (direct) return direct;

  const names = max.ownAuthorNames || [];
  for (let i = names.length - 1; i >= 0; i--) {
    const name = String(names[i] || '').trim();
    if (name) return name;
  }

  return '';
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

function getAutoUpdate() {
  const u = getRaw().autoUpdate || {};
  return {
    enabled: true,
    intervalMs: u.intervalMs ?? 60 * 1000,
    branch: u.branch || process.env.AUTO_UPDATE_BRANCH || 'main',
  };
}

function isPortalSslEnabled() {
  const setup = getRaw().setupPortal || {};
  const site = getRaw().sitePortal || {};
  return setup.ssl !== false && site.ssl !== false;
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

const maxChats = require('./max-chats');

module.exports = {
  ROOT,
  store,
  resolveFromRoot,
  getRaw,
  getTelegram,
  getAdminChatIds,
  getNotificationChatIds,
  isPrivateChatId,
  getMax,
  getMaxDisplayName,
  getDefaultChatUrl: maxChats.getDefaultChatUrl,
  getMonitorChatUrls: maxChats.getMonitorChatUrls,
  getProfileRotate,
  getAlwaysOnline,
  getDatabase,
  getAutoUpdate,
  isPortalSslEnabled,
  getSettings,
  isSetupComplete,
};
