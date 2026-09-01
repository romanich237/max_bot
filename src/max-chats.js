const store = require('./settings-store');
const { withTgEmoji, withOnOffEmoji, BUTTONS } = require('./bot-texts');

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

function extractMaxChatUrlsFromText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];

  const urls = new Set();
  for (const match of raw.matchAll(/https?:\/\/web\.max\.ru\/[^\s<>"']+/gi)) {
    const normalized = normalizeMaxChatUrl(match[0].replace(/[),.;!?]+$/g, ''));
    if (isMaxChatUrl(normalized)) urls.add(normalized);
  }
  for (const match of raw.matchAll(/(?:^|[\s(])web\.max\.ru\/([-\w]+)/gi)) {
    const normalized = normalizeMaxChatUrl(`https://web.max.ru/${match[1]}`);
    if (isMaxChatUrl(normalized)) urls.add(normalized);
  }
  return [...urls];
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

function requiredTitleForUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  const required = BUILTIN_REQUIRED_CHATS.find(
    (item) => normalizeMaxChatUrl(item.url) === normalized
  );
  return required ? required.title : '';
}

const GROUP_SUBTITLE_SELECTOR = [
  '.openedChat .header .subtitleWrapper',
  '.openedChat .subtitleWrapper',
].join(', ');

const GROUP_SUBTITLE_PATTERN =
  String.raw`(?:\d{1,3}(?:[ \u00a0,.\u202f']\d{3})*|\d+(?:[.,]\d+)?\s*[kKmMкК]?)\s*(?:followers?|подписчик(?:а|ов|и)?|members?|участник(?:а|ов|и)?|subscribers?)`;
const GROUP_SUBTITLE_RE = new RegExp(GROUP_SUBTITLE_PATTERN, 'i');

const PERSONAL_SUBTITLE_PATTERN =
  String.raw`(?:last\s+seen|online|typing|был[аои]?|в\s+сети|печатает|только\s+что|недавно)`;
const PERSONAL_SUBTITLE_RE = new RegExp(PERSONAL_SUBTITLE_PATTERN, 'i');

const PERSONAL_ONLINE_SELECTOR = [
  '.openedChat .header .subtitleWrapper .online',
  '.openedChat .subtitleWrapper .online',
  '.openedChat span.online',
].join(', ');

function kindFromSubtitleText(text) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';
  if (GROUP_SUBTITLE_RE.test(value)) return 'group';
  if (PERSONAL_SUBTITLE_RE.test(value)) return 'personal';
  return '';
}

function getChatKinds() {
  const raw = store.getPath(['max', 'chatKinds']);
  if (!raw || typeof raw !== 'object') return {};
  const kinds = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizeMaxChatUrl(key);
    if (normalized && (value === 'group' || value === 'personal')) {
      kinds[normalized] = value;
    }
  }
  return kinds;
}

function getStoredChatKind(url) {
  return getChatKinds()[normalizeMaxChatUrl(url)] || '';
}

function setChatKind(url, kind) {
  const normalized = normalizeMaxChatUrl(url);
  if (!normalized || isRequiredChatUrl(normalized)) return;
  if (kind !== 'group' && kind !== 'personal') return;

  const kinds = getChatKinds();
  if (kinds[normalized] === kind) return;
  kinds[normalized] = kind;
  store.setPath(['max', 'chatKinds'], kinds);
}

function removeChatKind(url) {
  const normalized = normalizeMaxChatUrl(url);
  const kinds = getChatKinds();
  if (!kinds[normalized]) return;
  delete kinds[normalized];
  store.setPath(['max', 'chatKinds'], kinds);
}

function kindFromUrlFallback(url) {
  const id = chatIdFromUrl(url);
  if (!id) return '';
  return String(id).startsWith('-') ? 'group' : 'personal';
}

function getChatKind(url) {
  const normalized = normalizeMaxChatUrl(url);
  if (isRequiredChatUrl(normalized)) return 'service';
  return getStoredChatKind(normalized) || kindFromUrlFallback(normalized);
}

function isPersonalMaxChat(url) {
  return getChatKind(url) === 'personal';
}

function isGroupMaxChat(url) {
  return getChatKind(url) === 'group';
}

function allowsMaxReply(url) {
  return isPersonalMaxChat(url);
}

function defaultNotifyTarget(url) {
  if (isRequiredChatUrl(url) || isPersonalMaxChat(url)) return 'dm';
  return 'both';
}

function chatKindFromUrl(url) {
  return getChatKind(url);
}

function chatLabelFromUrl(url) {
  const normalized = normalizeMaxChatUrl(url);
  const requiredTitle = requiredTitleForUrl(normalized);
  if (requiredTitle) return requiredTitle;

  const title = getChatTitle(normalized);
  if (title) return title;

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
  const requiredTitle = requiredTitleForUrl(normalized);
  const clean = requiredTitle || normalizeChatTitle(title);
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

function findChatUrlByTitle(title) {
  const needle = normalizeChatTitle(title).toLowerCase();
  if (!needle || isJunkChatTitle(title) || /^https:\/\/web\.max\.ru\//i.test(title)) return '';

  const matches = [];
  for (const [url, stored] of Object.entries(getChatTitles())) {
    if (normalizeChatTitle(stored).toLowerCase() === needle) matches.push(url);
  }
  return matches.length === 1 ? matches[0] : '';
}

function hydrateChatsWithStoredTitles(chats = []) {
  const titles = getChatTitles();
  const byName = new Map();
  for (const [url, stored] of Object.entries(titles)) {
    const key = normalizeChatTitle(stored).toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(url);
  }

  return (chats || []).map((chat) => {
    const next = { ...chat };
    const url = normalizeMaxChatUrl(next.url);
    const listedTitle = normalizeChatTitle(next.title);
    const listedIsUrl = !listedTitle || isJunkChatTitle(listedTitle) || /^https:\/\/web\.max\.ru\//i.test(listedTitle);

    if (url) {
      next.url = url;
      if (listedTitle && !listedIsUrl) {
        setChatTitle(url, listedTitle);
        next.title = listedTitle;
      } else if (titles[url]) {
        next.title = titles[url];
      }
    } else if (listedTitle && !listedIsUrl) {
      const urls = byName.get(listedTitle.toLowerCase()) || [];
      if (urls.length === 1) {
        next.url = urls[0];
        next.title = titles[urls[0]] || listedTitle;
      }
    }

    return next;
  });
}

function mergeChatTitles(entries = []) {
  for (const entry of entries) {
    if (
      entry?.url &&
      entry?.title &&
      !isJunkChatTitle(entry.title) &&
      !/^https:\/\/web\.max\.ru\//i.test(entry.title)
    ) {
      setChatTitle(entry.url, entry.title);
    }
    if (entry?.url && entry?.kind) {
      setChatKind(entry.url, entry.kind);
    }
  }
}

const NOTIFY_TARGETS = ['dm', 'group', 'both'];
const DEST_PAGE_SIZE = 6;

function isPrivateTelegramId(chatId) {
  return Number(chatId) > 0;
}

function getAdminTelegramUserIds() {
  const t = store.getPath(['telegram']) || {};
  const admins = (t.adminChatIds || []).map(String).filter(isPrivateTelegramId);
  if (admins.length) return [...new Set(admins)];
  return [...new Set((t.chatIds || []).map(String).filter(isPrivateTelegramId))];
}

function isAdminTelegramUser(chatId) {
  return getAdminTelegramUserIds().includes(String(chatId || ''));
}

function getNotifyReplyUserIds() {
  const raw = store.getPath(['telegram', 'notifyReplyUserIds']);
  const ids = Array.isArray(raw) ? raw : [];
  return [...new Set(ids.map((id) => String(id || '')).filter(isPrivateTelegramId))];
}

function canTelegramUserReply(chatId) {
  const id = String(chatId || '');
  if (!isPrivateTelegramId(id)) return false;
  if (isAdminTelegramUser(id)) return true;
  return getNotifyReplyUserIds().includes(id);
}

function setNotifyUserCanReply(chatId, enabled) {
  const id = String(chatId || '');
  if (!isPrivateTelegramId(id)) {
    return { error: 'Ответы можно включить только пользователю.' };
  }
  if (isAdminTelegramUser(id)) {
    return { ok: true, enabled: true, unchanged: true };
  }
  const ids = new Set(getNotifyReplyUserIds());
  if (enabled) ids.add(id);
  else ids.delete(id);
  store.setPath(['telegram', 'notifyReplyUserIds'], [...ids]);
  return { ok: true, enabled: ids.has(id) };
}

function toggleNotifyUserCanReply(chatId) {
  return setNotifyUserCanReply(chatId, !canTelegramUserReply(chatId));
}

function pruneNotifyReplyUserId(chatId) {
  const id = String(chatId || '');
  if (!id) return;
  const current = getNotifyReplyUserIds();
  const next = current.filter((item) => item !== id);
  if (next.length !== current.length) {
    store.setPath(['telegram', 'notifyReplyUserIds'], next);
  }
}

function getBoundTelegramIds() {
  const t = store.getPath(['telegram']) || {};
  const ids = (t.chatIds || []).map(String).filter(Boolean);
  const result = [];
  for (const id of ids) {
    if (!result.includes(id)) result.push(id);
  }
  for (const id of getAdminTelegramUserIds()) {
    if (!result.includes(id)) result.unshift(id);
  }
  return result;
}

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
  return defaultNotifyTarget(normalized);
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

function getNotifyChatIdsMap() {
  const raw = store.getPath(['max', 'notifyChatIds']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map = {};
  for (const [key, value] of Object.entries(raw)) {
    const url = normalizeMaxChatUrl(key);
    if (!url || !Array.isArray(value)) continue;
    map[url] = [...new Set(value.map((id) => String(id || '')).filter(Boolean))];
  }
  return map;
}

function hasExplicitNotifyChatIds(url) {
  const raw = store.getPath(['max', 'notifyChatIds']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const normalized = normalizeMaxChatUrl(url);
  if (Object.prototype.hasOwnProperty.call(raw, normalized)) return true;
  return Object.keys(raw).some((key) => normalizeMaxChatUrl(key) === normalized);
}

function idsForNotifyTarget(target) {
  const bound = getBoundTelegramIds();
  const groups = bound.filter((id) => !isPrivateTelegramId(id));
  const adminDm = bound.filter(isAdminTelegramUser);
  if (target === 'dm') return adminDm;
  if (target === 'group') return groups;
  return [...adminDm, ...groups];
}

function inferNotifyTarget(ids) {
  const list = (ids || []).map(String);
  const hasDm = list.some(isPrivateTelegramId);
  const hasGroup = list.some((id) => !isPrivateTelegramId(id));
  if (hasDm && hasGroup) return 'both';
  if (hasGroup) return 'group';
  return 'dm';
}

function getNotifyChatIdsForMaxChat(url) {
  const bound = getBoundTelegramIds();
  const normalized = normalizeMaxChatUrl(url);
  if (!normalized) return bound;
  if (hasExplicitNotifyChatIds(normalized)) {
    const wanted = new Set((getNotifyChatIdsMap()[normalized] || []).map(String));
    return bound.filter((id) => wanted.has(String(id)));
  }
  return idsForNotifyTarget(getNotifyTarget(normalized));
}

function setNotifyChatIds(url, ids) {
  const normalized = normalizeMaxChatUrl(url);
  if (!normalized) return { error: 'Чат не найден.' };
  const bound = new Set(getBoundTelegramIds());
  const next = [...new Set((ids || []).map(String))].filter((id) => bound.has(id));
  const map = getNotifyChatIdsMap();
  map[normalized] = next;
  store.setPath(['max', 'notifyChatIds'], map);
  setNotifyTarget(normalized, inferNotifyTarget(next));
  return { ok: true, url: normalized, ids: next };
}

function toggleNotifyChatId(url, chatId) {
  const bound = getBoundTelegramIds();
  const id = String(chatId || '');
  if (!id || !bound.includes(id)) return { error: 'Чат Telegram не найден.' };
  const selected = new Set(getNotifyChatIdsForMaxChat(url).map(String));
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return setNotifyChatIds(url, bound.filter((item) => selected.has(item)));
}

function getDefaultNotifyChatIds() {
  return getBoundTelegramIds().filter(isAdminTelegramUser);
}

function addNotifyChatId(url, chatId) {
  const bound = getBoundTelegramIds();
  const id = String(chatId || '');
  if (!id || !bound.includes(id)) return { error: 'Чат Telegram не найден.' };
  const selected = new Set(getNotifyChatIdsForMaxChat(url).map(String));
  selected.add(id);
  return setNotifyChatIds(url, bound.filter((item) => selected.has(item)));
}

function applyNotifyRouting(url, options = {}) {
  const normalized = normalizeMaxChatUrl(url);
  if (!normalized) return;

  if (Array.isArray(options.notifyChatIds)) {
    setNotifyChatIds(normalized, options.notifyChatIds);
    return;
  }

  if (options.notifyTarget && NOTIFY_TARGETS.includes(options.notifyTarget)) {
    setNotifyChatIds(normalized, idsForNotifyTarget(options.notifyTarget));
    return;
  }

  if (!getNotifyTargets()[normalized] && !hasExplicitNotifyChatIds(normalized)) {
    setNotifyTarget(normalized, defaultNotifyTarget(normalized));
  }
}

function removeNotifyChatIds(url) {
  const normalized = normalizeMaxChatUrl(url);
  const map = getNotifyChatIdsMap();
  if (!Object.prototype.hasOwnProperty.call(map, normalized)) return;
  delete map[normalized];
  store.setPath(['max', 'notifyChatIds'], map);
}

function pruneNotifyChatId(chatId) {
  const id = String(chatId || '');
  if (!id) return;
  pruneNotifyReplyUserId(id);
  const map = getNotifyChatIdsMap();
  let changed = false;
  for (const [url, ids] of Object.entries(map)) {
    const next = ids.filter((item) => item !== id);
    if (next.length !== ids.length) {
      map[url] = next;
      changed = true;
    }
  }
  if (changed) store.setPath(['max', 'notifyChatIds'], map);
}

function knownChatTitle(id) {
  try {
    const { getKnownChat } = require('./tg-chats');
    const known = getKnownChat(id);
    if (known?.title && known.title !== 'Без названия') return known.title;
    if (known?.username) return `@${known.username}`;
  } catch {
    /* ignore */
  }
  return '';
}

function userWroteToBot(id) {
  try {
    const { hasWrittenToBot } = require('./tg-chats');
    return hasWrittenToBot(id);
  } catch {
    return false;
  }
}

function telegramChatTitle(id, max = 28) {
  if (isAdminTelegramUser(id)) return 'ЛС';
  const known = knownChatTitle(id);
  if (known) return truncateButtonText(known, max);
  if (isPrivateTelegramId(id)) return truncateButtonText(`Пользователь ${id}`, max);
  return truncateButtonText(`Группа ${id}`, max);
}

function notifyDestTitle(id, max = 60) {
  if (isAdminTelegramUser(id)) return 'ЛС';
  const name = telegramChatTitle(id, max);
  if (!isPrivateTelegramId(id)) return name;
  return userWroteToBot(id) ? `${name} · писал в бота` : `${name} · ещё не писал в бота`;
}

function destButtonTitle(id) {
  if (isAdminTelegramUser(id)) return 'ЛС';
  if (!isPrivateTelegramId(id)) return telegramChatTitle(id, 28);
  const name = telegramChatTitle(id, 20);
  return truncateButtonText(`${userWroteToBot(id) ? '✅' : '❌'} ${name}`, 28);
}

function describeNotifyDest(id) {
  const sid = String(id);
  if (isAdminTelegramUser(sid)) return { id: sid, kind: 'admin', title: destButtonTitle(sid) };
  if (isPrivateTelegramId(sid)) return { id: sid, kind: 'user', title: destButtonTitle(sid) };
  return { id: sid, kind: 'group', title: destButtonTitle(sid) };
}

function formatNotifyDestLabel(url, max = 42) {
  const ids = getNotifyChatIdsForMaxChat(url);
  if (!ids.length) return 'никуда';
  const names = ids.map((id) => telegramChatTitle(id, 18));
  return truncateButtonText(names.join(', ') || 'никуда', max);
}

function listNotifyDestTitles(url) {
  return getNotifyChatIdsForMaxChat(url).map((id) => notifyDestTitle(id, 60));
}

function destToggleButton(item, on, callbackData) {
  const button = {
    text: item.title,
    callback_data: callbackData,
  };
  if (on) button.style = 'success';
  if (on) return withTgEmoji(button, 'check');
  if (item.kind === 'group') return withTgEmoji(button, 'group');
  return button;
}

function destSettingsButton(item, callbackData) {
  return {
    text: BUTTONS.userSettings,
    callback_data: callbackData,
  };
}

function buildTelegramDestRows(selectedIds, callbackForId, page = 0, settingsCallbackForId = null) {
  const selected = new Set((selectedIds || []).map(String));
  const dests = getBoundTelegramIds().map(describeNotifyDest);
  const sticky = dests.filter((item) => item.kind === 'admin');
  const rest = dests.filter((item) => item.kind !== 'admin');
  const totalPages = Math.max(1, Math.ceil(rest.length / DEST_PAGE_SIZE) || 1);
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  const slice = rest.slice(safePage * DEST_PAGE_SIZE, (safePage + 1) * DEST_PAGE_SIZE);
  const rows = [];

  for (const item of sticky) {
    rows.push([destToggleButton(item, selected.has(item.id), callbackForId(item.id, safePage))]);
  }
  for (const item of slice) {
    const row = [destToggleButton(item, selected.has(item.id), callbackForId(item.id, safePage))];
    if (item.kind === 'user' && typeof settingsCallbackForId === 'function') {
      row.push(destSettingsButton(item, settingsCallbackForId(item.id, safePage)));
    }
    rows.push(row);
  }

  return { rows, page: safePage, totalPages, groupsCount: rest.length, destCount: dests.length };
}
function chatMenuLabel(url) {
  const title = chatLabelFromUrl(url) || truncateUrl(url, 22);
  return truncateButtonText(title, 40);
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
    setChatTitle(normalized, required.title);
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

  for (const url of collectMonitorUrls()) {
    if (!isPersonalMaxChat(url) || getNotifyTargets()[url]) continue;
    setNotifyTarget(url, 'dm');
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

function isMonitorPersonalChatsEnabled() {
  return Boolean(store.getPath(['max', 'monitorPersonalChats']));
}

function setMonitorPersonalChatsEnabled(enabled) {
  store.setPath(['max', 'monitorPersonalChats'], Boolean(enabled));
}

function needsDiscoveredChats() {
  return isMonitorAllChatsEnabled() || isMonitorPersonalChatsEnabled();
}

function uniqueMonitorUrls(list) {
  const seen = new Set();
  const urls = [];
  for (const url of list.map(normalizeMaxChatUrl).filter(Boolean)) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function getForwardingMonitorChatUrls(discoveredUrls = null) {
  let urls;

  if (isMonitorAllChatsEnabled() && Array.isArray(discoveredUrls) && discoveredUrls.length) {
    urls = uniqueMonitorUrls([
      ...discoveredUrls,
      ...BUILTIN_REQUIRED_CHATS.map((item) => item.url),
    ]);
  } else if (
    isMonitorPersonalChatsEnabled() &&
    Array.isArray(discoveredUrls) &&
    discoveredUrls.length
  ) {
    const personal = discoveredUrls.filter(
      (url) => isPersonalMaxChat(url) || isRequiredChatUrl(url)
    );
    urls = uniqueMonitorUrls([...getMonitorChatUrls(), ...personal]);
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
  applyNotifyRouting(normalized, options);
  return { ok: true, url: normalized };
}

function addMonitorChatUrl(url, options = {}) {
  const normalized = normalizeMaxChatUrl(url);
  if (!isMaxChatUrl(normalized)) {
    return { error: 'Нужна ссылка вида <code>https://web.max.ru/35859265</code> или <code>https://web.max.ru/-XXXXXXXX</code>' };
  }

  if (options.asDefault) {
    return setDefaultChatUrl(normalized, options);
  }

  const urls = getMonitorChatUrls();
  if (urls.includes(normalized)) {
    if (options.title) setChatTitle(normalized, options.title);
    applyNotifyRouting(normalized, options);
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

  applyNotifyRouting(normalized, options);
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
  removeNotifyChatIds(normalized);
  removeChatTitle(normalized);
  removeChatKind(normalized);
  return { ok: true, url: normalized };
}

function buildMaxChatsText() {
  const urls = getMonitorChatUrls();
  const lines = ['<b>Чаты MAX</b>', ''];

  if (!urls.length) {
    lines.push('Список пуст. Нажмите «Добавить чат» — по названию или ссылке.');
    return lines.join('\n');
  }

  lines.push('Бот шлёт в Telegram сообщения из чатов со статусом «отправлять».', '');
  lines.push('Нажмите чат MAX — там можно выбрать ЛС, пользователей и группы Telegram.', '');

  for (const url of urls) {
    const pin = isRequiredChatUrl(url) ? '📌 ' : '• ';
    const title = escapeHtml(chatLabelFromUrl(url));
    const forward = isChatForwardEnabled(url) ? 'отправлять' : 'не отправлять';
    const where = escapeHtml(formatNotifyDestLabel(url));
    lines.push(`${pin}<b>${title}</b> — ${forward} · ${where}`);
  }

  lines.push('');
  if (isMonitorAllChatsEnabled()) {
    lines.push('Сейчас бот читает <b>все чаты в MAX</b>, не только список.');
  } else if (isMonitorPersonalChatsEnabled()) {
    lines.push('Сейчас бот читает <b>все личные сообщения MAX</b> и чаты из списка.');
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

function buildDestNavRow(page, totalPages, prevData, nextData) {
  if (totalPages <= 1) return null;
  const nav = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: prevData });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'maxchat:noop' });
  if (page < totalPages - 1) nav.push({ text: '▶️', callback_data: nextData });
  return nav;
}

function canRemoveMaxChat(url, urls) {
  return Boolean(url) && !isRequiredChatUrl(url) && urls.length > 1;
}

function maxChatNameButton(url, index, maxLen = 22) {
  const button = {
    text: truncateButtonText(chatLabelFromUrl(url) || truncateUrl(url, maxLen), maxLen),
    callback_data: `maxchat:view:${index}`,
  };
  if (isRequiredChatUrl(url)) return withTgEmoji(button, 'pin');
  if (isGroupMaxChat(url)) return withTgEmoji(button, 'group');
  return button;
}

function maxChatDeleteButton(index) {
  return withTgEmoji({ text: 'Удалить', callback_data: `maxchat:remove:${index}` }, 'trash');
}

function maxChatForwardButton(url, index) {
  const forwardOn = isChatForwardEnabled(url);
  return withOnOffEmoji(
    {
      text: 'Отправлять',
      callback_data: `maxchat:forward:${index}`,
      style: forwardOn ? 'success' : 'danger',
    },
    forwardOn
  );
}

function buildMaxChatActionButtons(url, index) {
  return [maxChatForwardButton(url, index)];
}

function buildMaxChatListRow(url, index, urls) {
  const row = [maxChatNameButton(url, index), maxChatForwardButton(url, index)];
  if (canRemoveMaxChat(url, urls)) {
    row.push(maxChatDeleteButton(index));
  }
  return row;
}

function buildMaxChatsKeyboard() {
  const urls = getMonitorChatUrls();
  const all = isMonitorAllChatsEnabled();
  const personal = isMonitorPersonalChatsEnabled();
  const rows = [
    [
      withOnOffEmoji(
        {
          text: 'Все чаты',
          callback_data: 'maxchat:toggleAll',
          style: all ? 'success' : 'danger',
        },
        all
      ),
      withOnOffEmoji(
        {
          text: 'Личные сообщения',
          callback_data: 'maxchat:togglePersonal',
          style: personal ? 'success' : 'danger',
        },
        personal
      ),
    ],
  ];

  urls.forEach((url, index) => {
    rows.push(buildMaxChatListRow(url, index, urls));
  });

  rows.push([
    withTgEmoji({ text: 'Добавить', callback_data: 'maxchat:add' }, 'plus'),
    { text: '« Меню', callback_data: 'discover:menu' },
  ]);
  return { inline_keyboard: rows };
}

const TG_BUTTON_TEXT_MAX = 64;
const MAX_CHAT_PICK_PAGE = 15;

function truncateButtonText(text, max = TG_BUTTON_TEXT_MAX) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function isJunkChatTitle(title) {
  return /^(группа|group|groups|канал|channel|чаты|chats|чат|личные|personal|online|в сети)$/i.test(
    String(title || '').replace(/\s+/g, ' ').trim()
  );
}

function pickButtonLabel(chat) {
  const title = String(chat?.title || '').replace(/\s+/g, ' ').trim();
  if (title && !isJunkChatTitle(title) && !/^https:\/\/web\.max\.ru\//i.test(title)) {
    return truncateButtonText(title);
  }
  const url = String(chat?.url || '').trim();
  if (url) return truncateButtonText(chatLabelFromUrl(url) || url);
  return '';
}

function isSelectedPickChat(url) {
  const normalized = normalizeMaxChatUrl(url);
  if (!normalized) return false;
  return getMonitorChatUrls().some((item) => normalizeMaxChatUrl(item) === normalized);
}

function uniquePickItems(chats = []) {
  const chosen = new Map();
  const hydrated = hydrateChatsWithStoredTitles(chats);
  for (let i = 0; i < hydrated.length; i++) {
    const url = String(hydrated[i]?.url || '').trim();
    const title = pickButtonLabel(hydrated[i]);
    if (!title) continue;
    const key = url || title.toLowerCase();
    const prev = chosen.get(key);
    if (!prev || (!prev.url && url)) {
      chosen.set(key, { i, title, url });
    }
  }
  return [...chosen.values()];
}

function buildMaxChatPickKeyboard(chats = [], page = 0) {
  const all = uniquePickItems(chats);
  const totalPages = Math.max(1, Math.ceil(all.length / MAX_CHAT_PICK_PAGE));
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  const slice = all.slice(safePage * MAX_CHAT_PICK_PAGE, (safePage + 1) * MAX_CHAT_PICK_PAGE);

  const rows = slice.map((item) => {
    const selected = isSelectedPickChat(item.url);
    const label = item.title || `Чат ${item.i + 1}`;
    const button = {
      text: selected ? truncateButtonText(label) : label,
      callback_data: chatIdFromUrl(item.url) ? `maxchat:p:${chatIdFromUrl(item.url)}` : `maxchat:pick:${item.i}`,
    };
    if (selected) {
      button.style = 'success';
      return [withTgEmoji(button, 'check')];
    }
    return [button];
  });

  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: '◀️', callback_data: `maxchat:pickpage:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'maxchat:noop' });
    if (safePage < totalPages - 1) nav.push({ text: '▶️', callback_data: `maxchat:pickpage:${safePage + 1}` });
    rows.push(nav);
  }

  rows.push([{ text: '« Отмена', callback_data: 'maxchat:canceladd' }]);
  return { inline_keyboard: rows };
}

function buildMaxChatPickWhereKeyboard(selectedIds = [], page = 0) {
  const selected = (selectedIds || []).map(String);
  const { rows, totalPages, page: safePage } = buildTelegramDestRows(
    selected,
    (id, destPage) => `maxchat:adddest:${destPage}:${id}`,
    page,
    (id, destPage) => `maxchat:adduserset:${destPage}:${id}`
  );

  const nav = buildDestNavRow(
    safePage,
    totalPages,
    `maxchat:adddestpage:${safePage - 1}`,
    `maxchat:adddestpage:${safePage + 1}`
  );
  if (nav) rows.push(nav);
  rows.push([{ text: 'Добавить группу Telegram', callback_data: 'action:notifyChat' }]);
  rows.push([{ text: 'Добавить пользователя', callback_data: 'maxchat:adduser' }]);
  rows.push([{ text: 'Готово', callback_data: 'maxchat:addwhere:done', style: 'success' }]);
  rows.push([{ text: '« Назад', callback_data: 'maxchat:pickback' }]);
  return { inline_keyboard: rows };
}

function buildMaxChatViewKeyboard(index, destPage = 0) {
  const urls = getMonitorChatUrls();
  const url = urls[index];
  const rows = [];
  if (url) {
    const selected = getNotifyChatIdsForMaxChat(url);
    const { rows: destRows, totalPages, page: safePage } = buildTelegramDestRows(
      selected,
      (id, page) => `maxchat:dest:${index}:${page}:${id}`,
      destPage,
      (id, page) => `maxchat:userset:${index}:${page}:${id}`
    );
    rows.push(...destRows);
    const nav = buildDestNavRow(
      safePage,
      totalPages,
      `maxchat:destpage:${index}:${safePage - 1}`,
      `maxchat:destpage:${index}:${safePage + 1}`
    );
    if (nav) rows.push(nav);
    rows.push([{ text: 'Добавить группу Telegram', callback_data: 'action:notifyChat' }]);
    rows.push([{ text: 'Добавить пользователя', callback_data: `maxchat:adduser:${index}:${safePage}` }]);
  }
  const actions = url ? [...buildMaxChatActionButtons(url, index)] : [];
  if (url && canRemoveMaxChat(url, urls)) actions.push(maxChatDeleteButton(index));
  if (actions.length) rows.push(actions);
  rows.push([{ text: '« К списку', callback_data: 'maxchat:list' }]);
  return { inline_keyboard: rows };
}

Object.assign(module.exports, {
  MAX_CHAT_URL_RE,
  BUILTIN_REQUIRED_CHATS,
  isMaxChatUrl,
  normalizeMaxChatUrl,
  extractMaxChatUrlsFromText,
  chatIdFromUrl,
  chatLabelFromUrl,
  chatMenuLabel,
  GROUP_SUBTITLE_SELECTOR,
  GROUP_SUBTITLE_PATTERN,
  GROUP_SUBTITLE_RE,
  PERSONAL_SUBTITLE_PATTERN,
  PERSONAL_SUBTITLE_RE,
  PERSONAL_ONLINE_SELECTOR,
  kindFromSubtitleText,
  chatKindFromUrl,
  getChatKind,
  getStoredChatKind,
  setChatKind,
  removeChatKind,
  isPersonalMaxChat,
  isGroupMaxChat,
  allowsMaxReply,
  defaultNotifyTarget,
  getChatTitles,
  getChatTitle,
  setChatTitle,
  removeChatTitle,
  mergeChatTitles,
  findChatUrlByTitle,
  hydrateChatsWithStoredTitles,
  truncateUrl,
  getDefaultChatUrl,
  getMonitorChatUrls,
  getForwardingMonitorChatUrls,
  isMonitorAllChatsEnabled,
  setMonitorAllChatsEnabled,
  isMonitorPersonalChatsEnabled,
  setMonitorPersonalChatsEnabled,
  needsDiscoveredChats,
  isRequiredChatUrl,
  isChatForwardEnabled,
  setChatForwardEnabled,
  setRequiredChatForwardEnabled,
  getBoundTelegramIds,
  isAdminTelegramUser,
  canTelegramUserReply,
  toggleNotifyUserCanReply,
  setNotifyUserCanReply,
  getNotifyTarget,
  setNotifyTarget,
  cycleNotifyTarget,
  notifyTargetLabel,
  getNotifyChatIdsForMaxChat,
  setNotifyChatIds,
  toggleNotifyChatId,
  addNotifyChatId,
  getDefaultNotifyChatIds,
  formatNotifyDestLabel,
  listNotifyDestTitles,
  telegramChatTitle,
  pruneNotifyChatId,
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
});
