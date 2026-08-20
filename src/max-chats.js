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

const NOTIFY_TARGETS = ['dm', 'group', 'both'];

function notifyTargetLabel(target) {
  if (target === 'dm') return 'ЛС';
  if (target === 'group') return 'группа';
  return 'ЛС+группа';
}

function getNotifyTargets() {
  const raw = store.getPath(['max', 'notifyTargets']);
  if (!raw || typeof raw !== 'object') return {};
  const targets = {};
  for (const [key, value] of Object.entries(raw)) {
    const url = normalizeMaxChatUrl(key);
    if (url && NOTIFY_TARGETS.includes(value)) targets[url] = value;
  }
  return targets;
}

function getNotifyTarget(url) {
  const normalized = normalizeMaxChatUrl(url);
  const saved = getNotifyTargets()[normalized];
  if (saved) return saved;
  return isRequiredChatUrl(normalized) ? 'dm' : 'both';
}

function setNotifyTarget(url, target) {
  const normalized = normalizeMaxChatUrl(url);
  if (!normalized) return { error: 'Чат не найден.' };
  const next = NOTIFY_TARGETS.includes(target) ? target : 'both';
  const targets = getNotifyTargets();
  targets[normalized] = next;
  store.setPath(['max', 'notifyTargets'], targets);
  return { ok: true, url: normalized, target: next };
}

function removeNotifyTarget(url) {
  const normalized = normalizeMaxChatUrl(url);
  const targets = getNotifyTargets();
  if (!targets[normalized]) return;
  delete targets[normalized];
  store.setPath(['max', 'notifyTargets'], targets);
}
function chatMenuLabel(url) {
  const pin = isRequiredChatUrl(url) ? '📌 ' : '';
  const title = getChatTitle(url) || truncateUrl(url, 22);
  return truncateButtonText(`${pin}${title}`, 40);
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

function getDisabledForwardChatUrls() {
  return (store.getPath(['max', 'disabledRequiredChats']) || [])
    .map(normalizeMaxChatUrl)
    .filter(Boolean);
}

function isChatForwardEnabled(url) {
  const normalized = normalizeMaxChatUrl(url);
  return !getDisabledForwardChatUrls().includes(normalized);
}

function setChatForwardEnabled(url, enabled) {
  const normalized = normalizeMaxChatUrl(url);
  if (!normalized) return { error: 'Чат не найден.' };

  let disabled = getDisabledForwardChatUrls();
  if (enabled) {
    disabled = disabled.filter((item) => item !== normalized);
  } else if (!disabled.includes(normalized)) {
    disabled.push(normalized);
  }

  store.setPath(['max', 'disabledRequiredChats'], disabled);
  return { ok: true, url: normalized, forwardEnabled: enabled };
}

function setRequiredChatForwardEnabled(url, enabled) {
  return setChatForwardEnabled(url, enabled);
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
    if (!getNotifyTargets()[normalized]) {
      setNotifyTarget(normalized, 'dm');
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
    if (options.title) setChatTitle(normalized, options.title);
    if (options.notifyTarget) setNotifyTarget(normalized, options.notifyTarget);
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

  if (options.notifyTarget) {
    setNotifyTarget(normalized, options.notifyTarget);
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
      error: 'Этот чат обязателен. Выключите пересылку, если не нужны уведомления.',
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
  store.setPath(['max', 'disabledRequiredChats'], getDisabledForwardChatUrls().filter((item) => item !== normalized));
  removeNotifyTarget(normalized);
  removeChatTitle(normalized);
  return { ok: true, url: normalized };
}

function buildMaxChatsText() {
  const urls = getMonitorChatUrls();
  const lines = ['<b>Чаты MAX</b>', ''];

  if (!urls.length) {
    lines.push('Список пуст. Нажмите «Добавить чат» — по названию или ссылке.');
    return lines.join('\n');
  }

  lines.push('Бот шлёт в Telegram сообщения из чатов со статусом «слать».', '');
  lines.push('Куда слать (ЛС / группа) выбирается при добавлении чата или в его карточке.', '');

  for (const url of urls) {
    const pin = isRequiredChatUrl(url) ? '📌 ' : '• ';
    const title = escapeHtml(chatLabelFromUrl(url));
    const forward = isChatForwardEnabled(url) ? 'слать' : 'не слать';
    const where = notifyTargetLabel(getNotifyTarget(url));
    lines.push(`${pin}<b>${title}</b> — ${forward} · ${where}`);
  }

  lines.push('');
  if (isMonitorAllChatsEnabled()) {
    lines.push('Сейчас бот читает <b>все чаты в MAX</b>, не только список.');
  } else {
    lines.push('Сейчас: только чаты из списка.');
  }
  lines.push('📌 обязательный — удалить нельзя');
  return lines.join('\n');
}

function cycleNotifyTarget(url) {
  const order = ['dm', 'group', 'both'];
  const current = getNotifyTarget(url);
  const i = order.indexOf(current);
  const next = order[i < 0 ? 0 : (i + 1) % order.length];
  return setNotifyTarget(url, next);
}

function buildNotifyTargetButtons(url, index) {
  const current = getNotifyTarget(url);
  const options = [
    { id: 'dm', text: 'ЛС' },
    { id: 'group', text: 'Группа' },
    { id: 'both', text: 'Оба' },
  ];

  return options.map((item) => {
    const active = current === item.id;
    const button = {
      text: active ? `${item.text} ✅` : item.text,
      callback_data: `maxchat:where:${index}:${item.id}`,
    };
    if (active) button.style = 'success';
    return button;
  });
}

function buildMaxChatActionButtons(url, index, urls) {
  const actions = [];
  const forwardOn = isChatForwardEnabled(url);

  actions.push({
    text: forwardOn ? 'Слать ✅' : 'Слать ❌',
    callback_data: `maxchat:forward:${index}`,
    style: forwardOn ? 'success' : 'danger',
  });

  if (!isRequiredChatUrl(url) && urls.length > 1) {
    actions.push({ text: '🗑', callback_data: `maxchat:remove:${index}` });
  }

  return actions;
}

function buildMaxChatsKeyboard() {
  const urls = getMonitorChatUrls();
  const all = isMonitorAllChatsEnabled();
  const rows = [
    [
      {
        text: all ? 'Все чаты ✅' : 'Все чаты ❌',
        callback_data: 'maxchat:toggleAll',
        style: all ? 'success' : 'danger',
      },
    ],
  ];

  urls.forEach((url, index) => {
    rows.push([
      {
        text: chatMenuLabel(url),
        callback_data: `maxchat:view:${index}`,
      },
    ]);
    rows.push(buildMaxChatActionButtons(url, index, urls));
  });

  rows.push([
    { text: '➕ Добавить', callback_data: 'maxchat:add' },
    { text: '« Меню', callback_data: 'discover:menu' },
  ]);
  return { inline_keyboard: rows };
}

const TG_BUTTON_TEXT_MAX = 64;
const MAX_CHAT_PICK_BUTTONS = 40;

function truncateButtonText(text, max = TG_BUTTON_TEXT_MAX) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function buildMaxChatPickKeyboard(chats = []) {
  const rows = [];
  const chosen = new Map();

  for (let i = 0; i < chats.length; i++) {
    const title = truncateButtonText(chats[i]?.title);
    if (!title) continue;
    const key = title.toLowerCase();
    const prev = chosen.get(key);
    if (!prev || (!prev.url && chats[i].url)) {
      chosen.set(key, { i, title, url: chats[i].url });
    }
  }

  for (const item of chosen.values()) {
    rows.push([{ text: item.title, callback_data: `maxchat:pick:${item.i}` }]);
    if (rows.length >= MAX_CHAT_PICK_BUTTONS) break;
  }

  rows.push([{ text: '« Отмена', callback_data: 'maxchat:canceladd' }]);
  return { inline_keyboard: rows };
}

function buildMaxChatPickWhereKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '💬 ЛС', callback_data: 'maxchat:addwhere:dm' },
        { text: '📣 Группа', callback_data: 'maxchat:addwhere:group' },
        { text: '💬📣 Оба', callback_data: 'maxchat:addwhere:both' },
      ],
      [{ text: '« Назад', callback_data: 'maxchat:pickback' }],
    ],
  };
}

function buildMaxChatViewKeyboard(index) {
  const urls = getMonitorChatUrls();
  const url = urls[index];
  const rows = [];
  if (url) rows.push(buildNotifyTargetButtons(url, index));
  const actions = url ? buildMaxChatActionButtons(url, index, urls) : [];
  if (actions.length) rows.push(actions);
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
  setChatForwardEnabled,
  setRequiredChatForwardEnabled,
  getNotifyTarget,
  setNotifyTarget,
  cycleNotifyTarget,
  notifyTargetLabel,
  ensureRequiredChats,
  scopedMessageKey,
  setDefaultChatUrl,
  addMonitorChatUrl,
  removeMonitorChatUrl,
  buildMaxChatsText,
  buildMaxChatsKeyboard,
  buildMaxChatPickKeyboard,
  buildMaxChatPickWhereKeyboard,
  buildMaxChatViewKeyboard,
};
