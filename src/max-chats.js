const store = require('./settings-store');

const MAX_CHAT_URL_RE = /^https:\/\/web\.max\.ru\/[-\w]+/i;

const BUILTIN_REQUIRED_CHATS = [
  {
    url: 'https://web.max.ru/35859265',
    title: 'Коды подтверждения',
  },
];

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeMaxChatUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw.split('?')[0]);
    if (/web\.max\.ru$/i.test(parsed.hostname)) {
      const segment = parsed.pathname.replace(/^\/+|\/+$/g, '');
      if (segment) return `https://web.max.ru/${segment}`;
      return 'https://web.max.ru/';
    }
  } catch {
    /* ignore */
  }

  return raw;
}

function isMaxChatUrl(url) {
  return MAX_CHAT_URL_RE.test(normalizeMaxChatUrl(url));
}

function normalizeChatTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function chatIdFromUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  const negative = normalized.match(/(-\d{5,})/);
  if (negative) return negative[1];
  const positive = normalized.match(/web\.max\.ru\/(\d{5,})/i);
  return positive ? positive[1] : '';
}

function chatLabelFromUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  const title = getChatTitle(normalized);
  if (title) return title;

  for (const required of BUILTIN_REQUIRED_CHATS) {
    if (normalizeMaxChatUrl(required.url) === normalized) {
      return required.title;
    }
  }

  const id = chatIdFromUrl(normalized);
  return id ? `Чат ${id}` : 'MAX';
}

function getChatTitles() {
  const raw = store.getPath(['max', 'chatTitles']);
  if (!raw || typeof raw !== 'object') return {};

  const titles = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizeMaxChatUrl(key);
    const clean = normalizeChatTitle(value);
    if (normalized && clean) titles[normalized] = clean;
  }
  return titles;
}

function getChatTitle(url) {
  const normalized = normalizeMaxChatUrl(url);
  return normalizeChatTitle(getChatTitles()[normalized]);
}

function setChatTitle(url, title) {
  const normalized = normalizeMaxChatUrl(url);
  const clean = normalizeChatTitle(title);
  if (!normalized || !clean) return;

  const titles = getChatTitles();
  titles[normalized] = clean;
  store.setPath(['max', 'chatTitles'], titles);
}

function removeChatTitle(url) {
  const normalized = normalizeMaxChatUrl(url);
  const titles = getChatTitles();
  if (!titles[normalized]) return;

  delete titles[normalized];
  store.setPath(['max', 'chatTitles'], titles);
}

function mergeChatTitles(entries = []) {
  for (const entry of entries) {
    if (entry?.url && entry?.title) {
      setChatTitle(entry.url, entry.title);
    }
  }
}

function chatMenuLabel(url, defaultUrl = getDefaultChatUrl()) {
  const star = url === defaultUrl ? '⭐ ' : '';
  const pin = isRequiredChatUrl(url) ? '📌 ' : '';
  const muted = isRequiredChatUrl(url) && !isChatForwardEnabled(url) ? '🔕 ' : '';
  const title = getChatTitle(url) || truncateUrl(url, 28);
  return `${star}${pin}${muted}${title}`;
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

function collectMonitorUrls() {
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

function isRequiredChatUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  return BUILTIN_REQUIRED_CHATS.some(
    (item) => normalizeMaxChatUrl(item.url) === normalized
  );
}

function getDisabledRequiredChatUrls() {
  return (store.getPath(['max', 'disabledRequiredChats']) || [])
    .map(normalizeMaxChatUrl)
    .filter(Boolean);
}

function isChatForwardEnabled(url) {
  const normalized = normalizeMaxChatUrl(url);
  if (!isRequiredChatUrl(normalized)) return true;
  return !getDisabledRequiredChatUrls().includes(normalized);
}

function setRequiredChatForwardEnabled(url, enabled) {
  const normalized = normalizeMaxChatUrl(url);
  if (!isRequiredChatUrl(normalized)) {
    return { error: 'Этот чат нельзя настроить как обязательный.' };
  }

  let disabled = getDisabledRequiredChatUrls();
  if (enabled) {
    disabled = disabled.filter((item) => item !== normalized);
  } else if (!disabled.includes(normalized)) {
    disabled.push(normalized);
  }

  store.setPath(['max', 'disabledRequiredChats'], disabled);
  return { ok: true, url: normalized, forwardEnabled: enabled };
}

function ensureRequiredChats() {
  let changed = false;
  const urls = collectMonitorUrls();
  const extras = (store.getPath(['max', 'monitorChatUrls']) || [])
    .map(normalizeMaxChatUrl)
    .filter(Boolean);

  for (const required of BUILTIN_REQUIRED_CHATS) {
    const normalized = normalizeMaxChatUrl(required.url);
    if (!getChatTitle(normalized)) {
      setChatTitle(normalized, required.title);
    }

    if (urls.includes(normalized)) continue;

    extras.push(normalized);
    changed = true;

    if (!store.getPath(['max', 'chatUrl'])) {
      store.setPath(['max', 'chatUrl'], normalized);
    }
  }

  if (changed) {
    store.setPath(['max', 'monitorChatUrls'], extras);
  }
}

function getMonitorChatUrls() {
  ensureRequiredChats();
  return collectMonitorUrls();
}

function isMonitorAllChatsEnabled() {
  return Boolean(store.getPath(['max', 'monitorAllChats']));
}

function setMonitorAllChatsEnabled(enabled) {
  store.setPath(['max', 'monitorAllChats'], Boolean(enabled));
}

function getForwardingMonitorChatUrls(discoveredUrls = null) {
  let urls;

  if (isMonitorAllChatsEnabled() && Array.isArray(discoveredUrls) && discoveredUrls.length) {
    const seen = new Set();
    urls = [];

    for (const url of discoveredUrls.map(normalizeMaxChatUrl).filter(Boolean)) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }

    for (const required of BUILTIN_REQUIRED_CHATS) {
      const normalized = normalizeMaxChatUrl(required.url);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    }
  } else {
    urls = getMonitorChatUrls();
  }

  return urls.filter(isChatForwardEnabled);
}

function scopedMessageKey(chatUrl, messageKey) {
  const prefix = chatIdFromUrl(chatUrl) || normalizeMaxChatUrl(chatUrl);
  return `${prefix}::${messageKey}`;
}

function setDefaultChatUrl(url, options = {}) {
  const normalized = normalizeMaxChatUrl(url);
  if (!isMaxChatUrl(normalized)) {
    return { error: 'Нужна ссылка вида <code>https://web.max.ru/35859265</code> или <code>https://web.max.ru/-XXXXXXXX</code>' };
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
  if (options.title) setChatTitle(normalized, options.title);
  return { ok: true, url: normalized };
}

function addMonitorChatUrl(url, options = {}) {
  const normalized = normalizeMaxChatUrl(url);
  if (!isMaxChatUrl(normalized)) {
    return { error: 'Нужна ссылка вида <code>https://web.max.ru/35859265</code> или <code>https://web.max.ru/-XXXXXXXX</code>' };
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

  if (options.title) {
    setChatTitle(normalized, options.title);
  }

  return { ok: true, url: normalized };
}

function removeMonitorChatUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  const urls = getMonitorChatUrls();

  if (!urls.includes(normalized)) {
    return { error: 'Этот чат не в списке мониторинга.' };
  }

  if (isRequiredChatUrl(normalized)) {
    return {
      error: 'Этот чат обязателен. Отключите пересылку в карточке чата, если не нужны уведомления.',
    };
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
  removeChatTitle(normalized);
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
    const pin = isRequiredChatUrl(url) ? '📌 ' : '';
    const title = escapeHtml(chatLabelFromUrl(url));
    const forwardNote =
      isRequiredChatUrl(url) && !isChatForwardEnabled(url) ? ' · <i>пересылка выкл.</i>' : '';
    lines.push(`${star}${pin}<b>${title}</b>${forwardNote}`);
    lines.push(`   <code>${url}</code>`);
  }

  if (isMonitorAllChatsEnabled()) {
    lines.push(
      '',
      '🌐 <b>Режим «все чаты» включён</b> — пересылаются сообщения из всех чатов в списке MAX.',
      'Список ниже — для основного чата и ручного добавления; при отключении режима используется только он.'
    );
  }

  lines.push(
    '',
    '⭐ — основной чат (по умолчанию).',
    '📌 — обязательный чат (нельзя удалить, пересылку можно выключить).',
    isMonitorAllChatsEnabled()
      ? 'Уведомления приходят из всех чатов MAX (кроме с выключенной пересылкой).'
      : 'Уведомления приходят из всех чатов с включённой пересылкой.'
  );
  return lines.join('\n');
}

function buildMaxChatsKeyboard() {
  const urls = getMonitorChatUrls();
  const defaultUrl = getDefaultChatUrl();
  const rows = urls.map((url, index) => [
    {
      text: chatMenuLabel(url, defaultUrl),
      callback_data: `maxchat:view:${index}`,
    },
  ]);

  rows.unshift([
    {
      text: isMonitorAllChatsEnabled() ? '🌐 Все чаты: ✅' : '🌐 Все чаты: ❌',
      callback_data: 'maxchat:toggleAll',
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

  if (url && isRequiredChatUrl(url)) {
    const enabled = isChatForwardEnabled(url);
    rows.push([
      {
        text: enabled ? '🔕 Отключить пересылку' : '🔔 Включить пересылку',
        callback_data: `maxchat:toggleRequired:${index}`,
      },
    ]);
  }

  if (url && url !== defaultUrl) {
    rows.push([{ text: '⭐ Сделать основным', callback_data: `maxchat:default:${index}` }]);
  }

  if (urls.length > 1 && url && !isRequiredChatUrl(url)) {
    rows.push([{ text: '🗑 Удалить из списка', callback_data: `maxchat:remove:${index}` }]);
  }

  rows.push([{ text: '« К списку', callback_data: 'maxchat:list' }]);
  return { inline_keyboard: rows };
}

module.exports = {
  MAX_CHAT_URL_RE,
  BUILTIN_REQUIRED_CHATS,
  isMaxChatUrl,
  normalizeMaxChatUrl,
  chatIdFromUrl,
  chatLabelFromUrl,
  chatMenuLabel,
  getChatTitles,
  getChatTitle,
  setChatTitle,
  removeChatTitle,
  mergeChatTitles,
  truncateUrl,
  getDefaultChatUrl,
  getMonitorChatUrls,
  getForwardingMonitorChatUrls,
  isMonitorAllChatsEnabled,
  setMonitorAllChatsEnabled,
  isRequiredChatUrl,
  isChatForwardEnabled,
  setRequiredChatForwardEnabled,
  ensureRequiredChats,
  scopedMessageKey,
  setDefaultChatUrl,
  addMonitorChatUrl,
  removeMonitorChatUrl,
  buildMaxChatsText,
  buildMaxChatsKeyboard,
  buildMaxChatViewKeyboard,
};
