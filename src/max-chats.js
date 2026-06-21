const store = require('./settings-store');

const MAX_CHAT_URL_RE = /^https:\/\/web\.max\.ru\/[-\w]+/i;

function normalizeMaxChatUrl(url) {
  return String(url || '').trim();
}

function isMaxChatUrl(url) {
  return MAX_CHAT_URL_RE.test(normalizeMaxChatUrl(url));
}

function chatIdFromUrl(url) {
  const match = normalizeMaxChatUrl(url).match(/(-\d+)/);
  return match ? match[1] : '';
}

function chatLabelFromUrl(url) {
  const id = chatIdFromUrl(url);
  return id ? `Чат ${id}` : 'MAX';
}

function truncateUrl(url, max = 36) {
  const value = normalizeMaxChatUrl(url);
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function getDefaultChatUrl() {
  const primary = normalizeMaxChatUrl(store.getPath(['max', 'chatUrl']));
  if (primary) return primary;
  const urls = getMonitorChatUrls();
  return urls[0] || '';
}

function getMonitorChatUrls() {
  const primary = normalizeMaxChatUrl(store.getPath(['max', 'chatUrl']));
  const extra = (store.getPath(['max', 'monitorChatUrls']) || [])
    .map(normalizeMaxChatUrl)
    .filter(Boolean);

  const urls = [];
  const seen = new Set();

  if (primary) {
    urls.push(primary);
    seen.add(primary);
  }

  for (const url of extra) {
    if (!seen.has(url)) {
      urls.push(url);
      seen.add(url);
    }
  }

  return urls;
}

function scopedMessageKey(chatUrl, messageKey) {
  const prefix = chatIdFromUrl(chatUrl) || normalizeMaxChatUrl(chatUrl);
  return `${prefix}::${messageKey}`;
}

function setDefaultChatUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  if (!isMaxChatUrl(normalized)) {
    return { error: 'Нужна ссылка вида <code>https://web.max.ru/-XXXXXXXX</code>' };
  }

  const currentDefault = normalizeMaxChatUrl(store.getPath(['max', 'chatUrl']));
  let extras = (store.getPath(['max', 'monitorChatUrls']) || [])
    .map(normalizeMaxChatUrl)
    .filter((item) => item && item !== normalized);

  if (currentDefault && currentDefault !== normalized && !extras.includes(currentDefault)) {
    extras.unshift(currentDefault);
  }

  extras = extras.filter((item) => item !== normalized);
  store.setPath(['max', 'chatUrl'], normalized);
  store.setPath(['max', 'monitorChatUrls'], extras);
  return { ok: true, url: normalized };
}

function addMonitorChatUrl(url, options = {}) {
  const normalized = normalizeMaxChatUrl(url);
  if (!isMaxChatUrl(normalized)) {
    return { error: 'Нужна ссылка вида <code>https://web.max.ru/-XXXXXXXX</code>' };
  }

  if (options.asDefault) {
    return setDefaultChatUrl(normalized);
  }

  const urls = getMonitorChatUrls();
  if (urls.includes(normalized)) {
    return { ok: true, url: normalized, duplicate: true };
  }

  const extras = (store.getPath(['max', 'monitorChatUrls']) || [])
    .map(normalizeMaxChatUrl)
    .filter(Boolean);

  extras.push(normalized);
  store.setPath(['max', 'monitorChatUrls'], extras);

  if (!store.getPath(['max', 'chatUrl'])) {
    store.setPath(['max', 'chatUrl'], normalized);
  }

  return { ok: true, url: normalized };
}

function removeMonitorChatUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  const urls = getMonitorChatUrls();

  if (!urls.includes(normalized)) {
    return { error: 'Этот чат не в списке мониторинга.' };
  }

  if (urls.length === 1) {
    return { error: 'Нельзя удалить единственный чат MAX.' };
  }

  const currentDefault = normalizeMaxChatUrl(store.getPath(['max', 'chatUrl']));
  let extras = (store.getPath(['max', 'monitorChatUrls']) || [])
    .map(normalizeMaxChatUrl)
    .filter((item) => item && item !== normalized);

  if (currentDefault === normalized) {
    const nextDefault = extras.find((item) => item !== normalized) || urls.find((item) => item !== normalized);
    store.setPath(['max', 'chatUrl'], nextDefault);
    extras = extras.filter((item) => item !== nextDefault);
  }

  store.setPath(['max', 'monitorChatUrls'], extras);
  return { ok: true, url: normalized };
}

function buildMaxChatsText() {
  const urls = getMonitorChatUrls();
  const defaultUrl = getDefaultChatUrl();
  const lines = ['<b>Чаты MAX для уведомлений</b>', ''];

  if (!urls.length) {
    lines.push('Список пуст. Добавьте чат MAX по названию или ссылке.');
    return lines.join('\n');
  }

  for (const url of urls) {
    const star = url === defaultUrl ? '⭐ ' : '• ';
    lines.push(`${star}<code>${url}</code>`);
  }

  lines.push(
    '',
    '⭐ — основной чат (по умолчанию).',
    'Уведомления приходят из всех чатов списка.'
  );
  return lines.join('\n');
}

function buildMaxChatsKeyboard() {
  const urls = getMonitorChatUrls();
  const defaultUrl = getDefaultChatUrl();
  const rows = urls.map((url, index) => [
    {
      text: `${url === defaultUrl ? '⭐ ' : ''}${truncateUrl(url)}`,
      callback_data: `maxchat:view:${index}`,
    },
  ]);

  rows.push([{ text: '➕ Добавить чат', callback_data: 'maxchat:add' }]);
  rows.push([{ text: '« В меню', callback_data: 'discover:menu' }]);
  return { inline_keyboard: rows };
}

function buildMaxChatViewKeyboard(index) {
  const urls = getMonitorChatUrls();
  const url = urls[index];
  const defaultUrl = getDefaultChatUrl();
  const rows = [];

  if (url && url !== defaultUrl) {
    rows.push([{ text: '⭐ Сделать основным', callback_data: `maxchat:default:${index}` }]);
  }

  if (urls.length > 1 && url) {
    rows.push([{ text: '🗑 Удалить из списка', callback_data: `maxchat:remove:${index}` }]);
  }

  rows.push([{ text: '« К списку', callback_data: 'maxchat:list' }]);
  return { inline_keyboard: rows };
}

module.exports = {
  MAX_CHAT_URL_RE,
  isMaxChatUrl,
  normalizeMaxChatUrl,
  chatIdFromUrl,
  chatLabelFromUrl,
  truncateUrl,
  getDefaultChatUrl,
  getMonitorChatUrls,
  scopedMessageKey,
  setDefaultChatUrl,
  addMonitorChatUrl,
  removeMonitorChatUrl,
  buildMaxChatsText,
  buildMaxChatsKeyboard,
  buildMaxChatViewKeyboard,
};
