const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { File } = require('node:buffer');
const {
  store,
  getTelegram,
  getAdminChatIds,
  getMax,
  getMaxDisplayName,
  getProfileBio,
  getAlwaysOnline,
  getMonitorChatUrls,
  getNotificationChatIds,
  isPrivateChatId,
  getSettings,
  getDatabase,
  getAutoUpdate,
  getRaw,
} = require('./config');
const {
  setDefaultChatUrl,
  addMonitorChatUrl,
  removeMonitorChatUrl,
  extractMaxChatUrlsFromText,
  setChatTitle,
  findChatUrlByTitle,
  buildMaxChatsText,
  buildMaxChatsKeyboard,
  buildMaxChatPickKeyboard,
  buildMaxChatPickWhereKeyboard,
  buildMaxChatViewKeyboard,
  chatLabelFromUrl,
  chatIdFromUrl,
  isRequiredChatUrl,
  isPersonalMaxChat,
  isGroupMaxChat,
  allowsMaxReply,
  canTelegramUserReply,
  toggleNotifyUserCanReply,
  getStoredChatKind,
  setChatKind,
  isChatForwardEnabled,
  setChatForwardEnabled,
  setNotifyTarget,
  cycleNotifyTarget,
  setNotifyChatIds,
  toggleNotifyChatId,
  addNotifyChatId,
  getDefaultNotifyChatIds,
  formatNotifyDestLabel,
  listNotifyDestTitles,
  isMonitorAllChatsEnabled,
  setMonitorAllChatsEnabled,
  isMonitorPersonalChatsEnabled,
  setMonitorPersonalChatsEnabled,
  telegramChatTitle,
  getDeleteSyncMode,
  setDeleteSyncMode,
} = require('./max-chats');
const { resolveMaxChatInput } = require('./max-chat-picker');
const {
  deleteWebhook,
  deleteMessage,
  setBotCommands,
  setBotDescription,
  setBotShortDescription,
  sendMessage,
  api,
  pinChatMessage,
  answerCallback,
  editMessageText,
  getChat,
  pollUpdates,
  sendPhotoBuffer,
  editPhotoBuffer,
  editMessageCaption,
  downloadTelegramFile,
  checkTelegramConnectivity,
} = require('./tg-api');
const {
  TOGGLES,
  FORWARDING_TOGGLE,
  buildToggleButton,
  saveProfileBioCity,
  saveProfileBioTemplate,
  saveProfileBioEventDate,
  buildBioTemplatePromptText,
  buildBioTemplateKeyboard,
  buildEventCalendarKeyboard,
  eventCalendarTitle,
  parseYearMonth,
  PROFILE_BIO_CITY_HINT,
  PROFILE_BIO_TEMPLATE_HINT,
  MAX_BIO_LENGTH,
} = require('./tg-settings');
const { previewBioTemplate, renderBioDescription, formatEventDateRu, daysUntilEvent } = require('./profile-bio');
const replyStore = require('./reply-store');
const outbox = require('./tg-outbox');
const { formatAppVersion } = require('./app-version');
const { buildChatExport } = require('./chat-export');
const { refreshAuthScreenshot, isAuthSessionActive, buildAuthModeKeyboard, buildPhoneAuthWarningMessage, buildActiveSessionMessage } = require('./auth-qr');
const {
  recordChatFromUpdate,
  recordChat,
  listKnownChats,
  getKnownChat,
  buildDiscoverKeyboard,
  buildDiscoverEmptyText,
  buildChatInfoText,
  buildChatInfoKeyboard,
  buildNotifyChatText,
  buildNotifyChatKeyboard,
  buildNotifyGroupViewText,
  buildNotifyGroupViewKeyboard,
  buildNotifyUserViewText,
  buildNotifyUserViewKeyboard,
  buildBindGroupReplyKeyboard,
  buildBindUserReplyKeyboard,
  bindNotificationChat,
  unbindNotificationChat,
  setDmOnlyNotifications,
  refreshTelegramChat,
  refreshNotificationChatStatuses,
  getBotAdminStatus,
  isBotAdminStatus,
  buildMissingAdminKeyboard,
  NOTIFY_GROUP_REQUEST_ID,
  NOTIFY_USER_REQUEST_ID,
  resolveTelegramPeerFromText,
  hasWrittenToBot,
} = require('./tg-chats');
const { buildEventMessage } = require('./tg-events');
const {
  COMMANDS,
  BUTTONS,
  HINTS,
  START,
  STATUS,
  AUTH,
  REPLY,
  MONITORING,
  CHATS,
  SAVED,
  ERRORS,
  UPDATES,
  BOT_ABOUT,
  LINKS,
  runWithPremiumEmoji,
  withTgEmoji,
} = require('./bot-texts');
const {
  buildBrowserPasswordAcceptedMessage,
  buildBrowserPasswordSavedMessage,
  buildBrowserPasswordPromptMessage,
  acceptBrowserPassword,
  parseBrowserPasswordCommand,
  getBrowserPassword,
} = require('./auth-browser');
const { clearInputPrompt, sendInputPrompt, deleteMessageQuiet } = require('./tg-step-chat');
const { getAccess: getWebAccess, setEnabled: setWebEnabled, url: webUrl, resetLogin: resetWebLogin, resetProfile: resetWebProfile } = require('./web-panel-access');

const SETTABLE = {
  biointerval: { path: ['profileBio', 'intervalMs'], type: 'int', min: 10000, max: 3600000 },
  biocity: { path: ['profileBio', 'city'], type: 'string' },
  biotemplate: { path: ['profileBio', 'template'], type: 'string' },
  onlineinterval: { path: ['alwaysOnline', 'intervalMs'], type: 'int', min: 5000, max: 300000 },
};

const BOT_COMMANDS = [
  { command: 'start', description: COMMANDS.start },
  { command: 'menu', description: COMMANDS.menu },
  { command: 'reauth', description: COMMANDS.reauth },
  { command: 'status', description: 'Диагностика бота' },
  { command: 'link', description: 'Веб-панель' },
];

let reauthHandler = null;
let sessionCheckHandler = null;
let replyHandler = null;
let stopHandler = null;
let startHandler = null;
let maxChatPickerHandler = null;
let maxChatResolveHandler = null;
let maxChatKindHandler = null;
let maxChatStatsHandler = null;
let isAuthBusyCheck = () => false;
const waitingInput = new Map();
const maxChatAddCache = new Map();
const bindUserContext = new Map();
const userSettingsContext = new Map();
const pendingProfileBioEnable = new Set();

function waitingInputFile() {
  return path.join(getSettings().dataDir, 'waiting-input.json');
}

function persistWaitingInput() {
  try {
    fs.mkdirSync(getSettings().dataDir, { recursive: true });
    fs.writeFileSync(waitingInputFile(), `${JSON.stringify(Object.fromEntries(waitingInput))}\n`);
  } catch (err) {
    console.warn('waitingInput:', err.message);
  }
}

const waitingInputSet = waitingInput.set.bind(waitingInput);
const waitingInputDelete = waitingInput.delete.bind(waitingInput);
waitingInput.set = (key, value) => {
  const result = waitingInputSet(key, value);
  persistWaitingInput();
  return result;
};
waitingInput.delete = (key) => {
  const result = waitingInputDelete(key);
  persistWaitingInput();
  return result;
};

function loadWaitingInput() {
  try {
    const raw = JSON.parse(fs.readFileSync(waitingInputFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    for (const [key, value] of Object.entries(raw)) {
      if (key && value) waitingInputSet(String(key), String(value));
    }
  } catch {
    /* nop */
  }
}

function looksLikeBioTemplate(text) {
  return /\{(час|минута|день|месяц|погода|температура|дни_до|дней_до|дни_до_события|непрочитанные_чаты|непрочитанные_сообщения|чаты|сообщения)\}/i.test(
    String(text || '')
  );
}

let authInputWaiter = null;

function registerAuthInputWaiter(waiter) {
  authInputWaiter = waiter;
}

function clearAuthInputWaiter() {
  authInputWaiter = null;
}

function setReauthHandler(fn) {
  reauthHandler = fn;
}

function setSessionCheckHandler(fn) {
  sessionCheckHandler = typeof fn === 'function' ? fn : null;
}

async function ensureCanStartReauth(chatId) {
  if (!sessionCheckHandler) return true;

  try {
    const active = await sessionCheckHandler();
    if (active) {
      await sendMessage(chatId, buildActiveSessionMessage());
      return false;
    }
  } catch (err) {
    console.warn('Проверка сессии MAX:', err.message);
  }

  return true;
}

function setAuthBusyCheck(fn) {
  isAuthBusyCheck = typeof fn === 'function' ? fn : () => false;
}

function setReplyHandler(fn) {
  replyHandler = fn;
}

function setStopHandler(fn) {
  stopHandler = fn;
}

function setStartHandler(fn) {
  startHandler = fn;
}

function setMaxChatPickerHandler(fn) {
  maxChatPickerHandler = typeof fn === 'function' ? fn : null;
}

function setMaxChatResolveHandler(fn) {
  maxChatResolveHandler = typeof fn === 'function' ? fn : null;
}

function setMaxChatKindHandler(fn) {
  maxChatKindHandler = typeof fn === 'function' ? fn : null;
}

function setMaxChatStatsHandler(fn) {
  maxChatStatsHandler = typeof fn === 'function' ? fn : null;
}

async function clearMaxChatAddPrompt(chatId, userMessageId) {
  const key = String(chatId);
  const cache = maxChatAddCache.get(key);
  if (cache?.photoMessageId) {
    await deleteMessageQuiet(chatId, cache.photoMessageId);
  }
  if (cache?.pickMessageId) {
    await deleteMessageQuiet(chatId, cache.pickMessageId);
  }
  maxChatAddCache.delete(key);
  await clearInputPrompt(chatId, userMessageId);
}

function buildMaxChatAddCaption(chats = []) {
  const count = Array.isArray(chats) ? chats.length : 0;
  if (!count) return CHATS.addPromptNoScreenshot;
  return `${CHATS.addPrompt}\n\nНайдено чатов: <b>${count}</b>`;
}

async function beginMaxChatAdd(chatId) {
  const key = String(chatId);
  maxChatAddCache.delete(key);

  if (!maxChatPickerHandler) {
    await sendInputPrompt(chatId, CHATS.addPromptNoScreenshot);
    return;
  }

  if (isAuthBusyCheck()) {
    await sendInputPrompt(chatId, CHATS.addPickerBusy);
    return;
  }

  try {
    const { chats, screenshot } = await maxChatPickerHandler();
    const keyboard = buildMaxChatPickKeyboard(chats, 0);
    const caption = buildMaxChatAddCaption(chats);
    let photoMessageId = null;

    if (screenshot) {
      const result = await sendPhotoBuffer(chatId, screenshot, 'Чаты в MAX');
      photoMessageId = result?.result?.message_id || null;
    }

    const sent = await sendInputPrompt(chatId, caption, { reply_markup: keyboard });
    if (!sent?.ok) {
      throw new Error(sent?.description || 'Telegram не принял список кнопок');
    }
    maxChatAddCache.set(key, {
      chats,
      photoMessageId,
      pickMessageId: sent?.result?.message_id || null,
      pickPage: 0,
    });
  } catch (err) {
    await sendInputPrompt(chatId, CHATS.addPickerFail(escapeHtml(err.message)));
  }
}

function isMonitoringEnabled() {
  return getMax().monitoringEnabled !== false;
}

let previousCpuSample = null;
function formatGb(value) { return (Number(value || 0) / 1073741824).toFixed(1); }
function formatServerUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d ? `${d}д` : '', h ? `${h}ч` : '', `${m}м`].filter(Boolean).join(' ');
}
function serverLoadText() {
  const cpus = os.cpus();
  const total = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a,b)=>a+b,0), 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  let cpu = 0;
  if (previousCpuSample) {
    const dt = total - previousCpuSample.total, di = idle - previousCpuSample.idle;
    if (dt > 0) cpu = Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  previousCpuSample = { total, idle };
  let diskUsed = 0, diskTotal = 0;
  try {
    const stat = fs.statfsSync('/');
    diskTotal = stat.blocks * stat.bsize;
    diskUsed = diskTotal - stat.bavail * stat.bsize;
  } catch {}
  const ramTotal = os.totalmem(), ramUsed = ramTotal - os.freemem();
  return [
    `v${cpus.length}CPU: ${cpu.toFixed(1)}%`,
    `Диск: ${formatGb(diskUsed)} ГБ / ${formatGb(diskTotal)} ГБ (${diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(1) : '0.0'}%)`,
    `RAM: ${formatGb(ramUsed)} ГБ / ${formatGb(ramTotal)} ГБ (${ramTotal > 0 ? ((ramUsed / ramTotal) * 100).toFixed(1) : '0.0'}%)`,
    `Uptime: ${formatServerUptime(os.uptime())}`,
  ].join('\n');
}

async function sendHtmlDocument(chatId, html, filename, caption) {
  const { token } = getTelegram();
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new File([Buffer.from(html, 'utf8')], filename, { type: 'text/html' }));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || 'Telegram не принял файл');
  return data;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function previewText(text, max = 80) {
  const value = (text || '').trim();
  if (!value) return '—';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function collectTelegramImageFileIds(message) {
  const ids = [];
  if (Array.isArray(message.photo) && message.photo.length) {
    ids.push(message.photo[message.photo.length - 1].file_id);
  }
  const doc = message.document;
  if (doc?.file_id && /^image\//i.test(doc.mime_type || '')) {
    ids.push(doc.file_id);
  }
  return ids;
}

function collectTelegramReplyFileIds(message) {
  const ids = collectTelegramImageFileIds(message);
  const doc = message.document;
  if (doc?.file_id && !ids.includes(doc.file_id)) {
    ids.push(doc.file_id);
  }
  return ids;
}

function unlinkQuiet(files) {
  for (const file of files || []) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

async function downloadReplyImages(fileIds) {
  if (!fileIds.length) return [];
  const dir = path.join(getSettings().dataDir, 'reply-uploads');
  const photos = [];
  for (const id of fileIds) {
    photos.push(await downloadTelegramFile(id, dir));
  }
  return photos;
}

const replyAlbumBuffers = new Map();

function clearReplyAlbums(chatId) {
  const prefix = `${chatId}:`;
  for (const [key, buf] of replyAlbumBuffers) {
    if (key.startsWith(prefix)) {
      clearTimeout(buf.timer);
      replyAlbumBuffers.delete(key);
    }
  }
}

function normalizeReplyPayload(payload) {
  if (typeof payload === 'string' || payload == null) {
    return { text: String(payload || ''), photos: [] };
  }
  return {
    text: String(payload.text || ''),
    photos: Array.isArray(payload.photos) ? payload.photos.filter(Boolean) : [],
  };
}

async function dispatchMaxReply(chatId, target, payload) {
  const { text, photos } = normalizeReplyPayload(payload);

  if (!isPrivateChatId(chatId)) {
    unlinkQuiet(photos);
    return;
  }

  if (!canTelegramUserReply(chatId)) {
    unlinkQuiet(photos);
    await sendMessage(chatId, 'Ответы в боте для вас выключены.');
    return;
  }

  if (!target) {
    unlinkQuiet(photos);
    await sendMessage(chatId, REPLY.stale);
    return;
  }

  if (!allowsMaxReply(target.maxChatUrl)) {
    unlinkQuiet(photos);
    return;
  }

  if (!replyHandler) {
    unlinkQuiet(photos);
    await sendMessage(chatId, REPLY.unavailable);
    return;
  }

  try {
    await replyHandler(target, { text, photos });
    await sendMessage(
      chatId,
      buildEventMessage({
        ...REPLY.sent(escapeHtml(target.author || 'пользователя')),
        status: 'done',
      })
    );
  } catch (err) {
    await sendMessage(
      chatId,
      buildEventMessage({
        ...REPLY.failed(escapeHtml(err.message)),
        status: 'fail',
      })
    );
  } finally {
    unlinkQuiet(photos);
  }
}

async function flushReplyAlbum(key) {
  const buf = replyAlbumBuffers.get(key);
  if (!buf) return;
  replyAlbumBuffers.delete(key);
  clearTimeout(buf.timer);
  waitingInput.delete(String(buf.chatId));

  let photos = [];
  try {
    photos = await downloadReplyImages(buf.fileIds);
    await clearInputPrompt(buf.chatId, buf.userMessageId);
    await dispatchMaxReply(buf.chatId, buf.target, { text: buf.caption, photos });
    photos = [];
  } catch (err) {
    unlinkQuiet(photos);
    await sendMessage(
      buf.chatId,
      buildEventMessage({
        ...REPLY.failed(escapeHtml(err.message)),
        status: 'fail',
      })
    );
  }
}

async function handleReplyWaitContent(chatId, message, waitKey) {
  const fileIds = collectTelegramReplyFileIds(message);
  let replyText = (message.caption || message.text || '').trim();

  if (/^\/cancel$/i.test(replyText)) return false;
  if (replyText.startsWith('/')) {
    if (!fileIds.length) return false;
    replyText = '';
  }
  if (!fileIds.length && !replyText) return false;

  const target = replyStore.get(waitKey.slice('reply:'.length));
  const mediaGroupId = message.media_group_id;

  if (mediaGroupId && fileIds.length) {
    const key = `${chatId}:${mediaGroupId}`;
    let buf = replyAlbumBuffers.get(key);
    if (!buf) {
      buf = {
        fileIds: [...fileIds],
        caption: replyText,
        target,
        chatId,
        userMessageId: message.message_id,
        timer: null,
      };
      replyAlbumBuffers.set(key, buf);
    } else {
      buf.fileIds.push(...fileIds);
      if (replyText) buf.caption = buf.caption || replyText;
      buf.userMessageId = message.message_id;
    }
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      flushReplyAlbum(key).catch((err) => {
        console.error('Ошибка отправки альбома в MAX:', err.message);
      });
    }, 800);
    return true;
  }

  waitingInput.delete(String(chatId));
  let photos = [];
  try {
    photos = await downloadReplyImages(fileIds);
    await clearInputPrompt(chatId, message.message_id);
    await dispatchMaxReply(chatId, target, { text: replyText, photos });
  } catch (err) {
    unlinkQuiet(photos);
    await sendMessage(
      chatId,
      buildEventMessage({
        ...REPLY.failed(escapeHtml(err.message)),
        status: 'fail',
      })
    );
  }
  return true;
}

function onFlag(value) {
  return value ? `✅ ${STATUS.on}` : `❌ ${STATUS.off}`;
}

function formatInterval(ms) {
  const sec = Math.max(1, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return `каждые ${sec} сек`;
  const min = Math.round(sec / 60);
  if (min === 1) return 'каждую минуту';
  if (min < 60) return `каждые ${min} мин`;
  const hours = Math.round(min / 60);
  if (hours === 1) return 'каждый час';
  return `каждые ${hours} ч`;
}

function formatNotifyTarget(id) {
  const known = getKnownChat(id);
  const title = String(known?.title || '').trim();
  const unnamed = !title || title === 'Без названия';
  if (isPrivateChatId(id)) {
    return unnamed
      ? `Личка <code>${escapeHtml(id)}</code>`
      : `Личка: <b>${escapeHtml(title)}</b>`;
  }
  return unnamed
    ? `Группа без названия <code>${escapeHtml(id)}</code>`
    : `Группа: <b>${escapeHtml(title)}</b> <code>${escapeHtml(id)}</code>`;
}

async function buildStatusText() {
  const profileBio = getProfileBio();
  const online = getAlwaysOnline();
  const maxName = getMaxDisplayName();
  const monitorUrls = getMonitorChatUrls();
  const notifyIds = getNotificationChatIds();
  let chatStats = { personal: 0, groups: 0, channels: 0, service: 0 };
  if (maxChatStatsHandler) {
    try {
      chatStats = { ...chatStats, ...(await maxChatStatsHandler()) };
    } catch (err) {
      console.warn('Статистика чатов MAX:', err.message);
    }
  }

  const lines = [
    STATUS.header,
    '',
    '<b>Бот</b>',
    `${STATUS.monitoring}: ${onFlag(isMonitoringEnabled())}${isMonitoringEnabled() ? '' : ' · на паузе'}`,
    `${STATUS.forwarding}: ${onFlag(getMax().forwardingEnabled !== false)}`,
    `${STATUS.alwaysOnline}: ${onFlag(online.enabled)}${online.enabled ? ` · ${formatInterval(online.intervalMs)}` : ''}`,
    '',
    '<b>Профиль MAX</b>',
  ];

  lines.push(
    `${STATUS.profileBio}: ${onFlag(profileBio.enabled)}${profileBio.enabled ? ` · ${formatInterval(profileBio.intervalMs)}` : ''}`
  );

  if (profileBio.enabled) {
    lines.push(profileBio.city ? `Город: <code>${escapeHtml(profileBio.city)}</code>` : STATUS.cityUnset);
    let currentDescription = '';
    try {
      currentDescription = (await renderBioDescription(profileBio)).text || '';
    } catch {
      currentDescription = '';
    }
    lines.push(`Шаблон: <code>${escapeHtml(profileBio.template)}</code>`);
    if (currentDescription) {
      lines.push(`Сейчас: <code>${escapeHtml(currentDescription)}</code>`);
    }
    if (profileBio.eventDate) {
      lines.push(
        `Событие: <code>${escapeHtml(formatEventDateRu(profileBio.eventDate))}</code> · дней до: <code>${daysUntilEvent(profileBio.eventDate)}</code>`
      );
    }
  }

  lines.push(maxName ? `Сейчас имя: <code>${escapeHtml(maxName)}</code>` : STATUS.nameAuto);
  lines.push('', `<b>${STATUS.chatsHeader}</b>`);
  lines.push(
    `Личные чаты: <code>${Number(chatStats.personal) || 0}</code>`,
    `Групповые чаты: <code>${Number(chatStats.groups) || 0}</code>`,
    `Каналы: <code>${Number(chatStats.channels) || 0}</code>`,
    `Сервисные уведомления: <code>${Number(chatStats.service) || 0}</code>`,
    ''
  );

  if (isMonitorAllChatsEnabled()) {
    lines.push('Режим: все чаты в MAX');
  } else {
    lines.push('Режим: только список');
  }

  if (!monitorUrls.length) {
    lines.push(STATUS.chatsUnset);
  } else {
    for (const url of monitorUrls) {
      const title = escapeHtml(chatLabelFromUrl(url));
      const pin = isRequiredChatUrl(url) ? '📌 ' : '• ';
      const forward = isChatForwardEnabled(url) ? 'отправлять' : 'не отправлять';
      const where = escapeHtml(formatNotifyDestLabel(url));
      lines.push(`${pin}<b>${title}</b> — ${forward} · ${where}`);
    }
  }

  lines.push('', '<b>Куда слать в Telegram</b>');
  if (!notifyIds.length) {
    lines.push(STATUS.notifyUnset);
  } else {
    for (const id of notifyIds) {
      lines.push(formatNotifyTarget(id));
    }
  }

  return lines.filter((line) => line != null).join('\n');
}

function buildLinksInlineRow() {
  return [
    { text: BUTTONS.ourChannel, url: LINKS.channel },
    { text: BUTTONS.support, url: LINKS.support },
    { text: BUTTONS.github, url: LINKS.github },
  ];
}

function buildAboutLinksKeyboard() {
  return { inline_keyboard: [buildLinksInlineRow()] };
}

function buildAboutKeyboard() {
  return {
    inline_keyboard: [
      buildLinksInlineRow(),
      [{ text: 'Логи', callback_data: 'action:logs' }],
      [{ text: BUTTONS.backToMenu, callback_data: 'discover:menu' }],
    ],
  };
}

function hasPinnedAbout(chatId) {
  const ids = store.getPath(['telegram', 'aboutPinnedChatIds']) || [];
  return ids.map(String).includes(String(chatId));
}

function markPinnedAbout(chatId) {
  const ids = [...new Set([...(store.getPath(['telegram', 'aboutPinnedChatIds']) || []).map(String), String(chatId)])];
  store.setPath(['telegram', 'aboutPinnedChatIds'], ids);
}

async function sendPinnedAboutOnce(chat) {
  const chatId = chat?.id;
  if (!chatId || !isPrivateChatId(chatId) || hasPinnedAbout(chatId)) return false;

  const sent = await sendMessage(chatId, START.about, {
    reply_markup: buildAboutLinksKeyboard(),
  });
  if (!sent?.ok || !sent.result?.message_id) return false;

  markPinnedAbout(chatId);
  void pinChatMessage(chatId, sent.result.message_id).catch((err) => {
    console.warn('pin about:', err.message);
  });
  return true;
}

function getMenuImageBuffer() {
  const candidates = [
    path.resolve(__dirname, '..', 'menu.png'),
    path.resolve(process.cwd(), 'menu.png'),
  ];
  const imagePath = candidates.find((candidate) => fs.existsSync(candidate));
  return imagePath ? fs.readFileSync(imagePath) : null;
}

async function sendMainMenu(chatId) {
  const image = getMenuImageBuffer();
  if (image) {
    const result = await sendPhotoBuffer(chatId, image, START.panel, undefined, {
      reply_markup: buildMenuKeyboard(),
    });
    if (result?.ok) return result;
    console.warn('Не удалось отправить menu.png:', result?.description || 'Telegram API error');
  }
  return sendMessage(chatId, START.panel, {
    reply_markup: buildMenuKeyboard(),
  });
}

function buildMenuKeyboard() {
  const prefix = 'toggle:';
  const rows = [
    [
      buildToggleButton(prefix, TOGGLES[0]),
      {
        text: TOGGLES[1].label,
        callback_data: 'action:profileBio',
        style: getProfileBio().enabled ? 'success' : 'danger',
      },
    ],
    [
      { text: BUTTONS.maxChats, callback_data: 'maxchat:list' },
      { text: 'Веб панель', callback_data: 'action:webPanel' },
    ],
  ];

  const statusRow = [
    buildToggleButton(prefix, FORWARDING_TOGGLE),
  ];
  if (isMonitoringEnabled()) {
    statusRow.push({ text: BUTTONS.stopMax, callback_data: 'action:stopMax', style: 'danger' });
  } else {
    statusRow.push({ text: BUTTONS.startMax, callback_data: 'action:startMax', style: 'success' });
  }
  rows.push(statusRow);
  rows.push([
    withTgEmoji({ text: BUTTONS.checkUpdates, callback_data: 'action:checkUpdate' }, 'refresh'),
    { text: BUTTONS.about, callback_data: 'action:about' },
  ]);

  return { inline_keyboard: rows };
}

async function replaceMenuPhotoWithText(query, text, extra = {}) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const hasPhoto = Array.isArray(query.message.photo) && query.message.photo.length > 0;
  if (hasPhoto) {
    await deleteMessage(chatId, messageId).catch(() => {});
    return sendMessage(chatId, text, extra);
  }
  return editMessageText(chatId, messageId, text, extra);
}

function buildProfileBioKeyboard() {
  return {
    inline_keyboard: [
      [buildToggleButton('toggle:', TOGGLES[1])],
      [
        { text: BUTTONS.bioTemplate, callback_data: 'action:profileBioTemplate' },
        { text: BUTTONS.bioCity, callback_data: 'action:profileBioCity' },
      ],
      [{ text: BUTTONS.backToMenu, callback_data: 'discover:menu' }],
    ],
  };
}

function buildProfileBioText() {
  const bio = getProfileBio();
  return [
    '<b>Смена описания</b>',
    '',
    `Статус: ${bio.enabled ? 'включена' : 'выключена'}`,
    `Город для погоды: <code>${escapeHtml(String(bio.city || '').trim() || 'не задан')}</code>`,
    '',
    'Шаблон описания:',
    `<code>${escapeHtml(String(bio.template || '').trim())}</code>`,
  ].join('\n');
}

function isAdmin(chatId, userId) {
  const ids = getAdminChatIds();
  if (userId != null && ids.includes(String(userId))) return true;
  if (chatId != null && isPrivateChatId(chatId) && ids.includes(String(chatId))) return true;
  return false;
}

function canUseMaxReply(chatId, userId) {
  if (!isPrivateChatId(chatId)) return false;
  if (userId != null && String(userId) !== String(chatId)) return false;
  return canTelegramUserReply(chatId);
}

async function showBoundUserSettings(chatId, messageId, userId, backData = 'action:notifyChat') {
  const targetId = String(userId);
  userSettingsContext.set(String(chatId), { userId: targetId, backData: backData || 'action:notifyChat' });
  await refreshTelegramChat(targetId).catch(() => null);
  const extra = { reply_markup: buildNotifyUserViewKeyboard(targetId, backData) };
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, buildNotifyUserViewText(targetId), extra);
      return;
    } catch (err) {
      console.warn('showBoundUserSettings edit:', err.message);
    }
  }
  await sendMessage(chatId, buildNotifyUserViewText(targetId), extra);
}

async function goUserSettingsBack(chatId, messageId, backData = 'action:notifyChat') {
  const data = backData || 'action:notifyChat';
  if (data.startsWith('maxchat:destpage:')) {
    const parts = data.split(':');
    const index = Number.parseInt(parts[2], 10) || 0;
    const page = Number.parseInt(parts[3], 10) || 0;
    await showMaxChatView(chatId, messageId, index, page);
    return;
  }
  if (data.startsWith('maxchat:adddestpage:')) {
    const page = Number.parseInt(data.slice('maxchat:adddestpage:'.length), 10) || 0;
    const cache = maxChatAddCache.get(String(chatId));
    await showMaxChatWherePrompt(chatId, { ...cache?.pending, destPage: page });
    return;
  }
  await showNotifyChats(chatId, messageId);
}

async function handleReplyCallback(query) {
  const chatId = query.message?.chat?.id;
  const data = query.data || '';
  const target = replyStore.get(data.slice('reply:'.length));
  if (!target) {
    await answerCallback(query.id, 'Сообщение устарело');
    return;
  }

  if (!isPrivateChatId(chatId) || !canUseMaxReply(chatId, query.from?.id) || !allowsMaxReply(target.maxChatUrl)) {
    await answerCallback(query.id, REPLY.groupsDisabledShort);
    return;
  }

  waitingInput.set(String(chatId), data);
  await answerCallback(query.id, 'Жду ответ');
  await sendInputPrompt(
    chatId,
    [
      `<b>Ответ для ${escapeHtml(target.author || 'пользователя')}</b>`,
      `<i>${escapeHtml(previewText(target.body))}</i>`,
      '',
      'Напишите текст или отправьте фото.',
      'Отмена: /cancel',
    ].join('\n')
  );
}

async function handleReplyOperatorMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const waitKey = waitingInput.get(String(chatId));
  const userMessageId = message.message_id;

  if (/^\/cancel$/i.test(text)) {
    waitingInput.delete(String(chatId));
    clearReplyAlbums(chatId);
    await clearInputPrompt(chatId, userMessageId);
    await sendMessage(chatId, ERRORS.cancelled);
    return;
  }

  if (waitKey?.startsWith('reply:') && (await handleReplyWaitContent(chatId, message, waitKey))) {
    return;
  }

  if (text && !text.startsWith('/') && !waitKey && message.reply_to_message?.message_id) {
    const target = replyStore.getByTelegramMessage(chatId, message.reply_to_message.message_id);
    if (target) return;
  }

  if (text && !text.startsWith('/')) {
    await sendMessage(
      chatId,
      'Чтобы ответить в MAX, нажмите «Ответить» под уведомлением.'
    );
  }
}

function isGroupChat(chat) {
  const type = chat?.type;
  return type === 'group' || type === 'supergroup';
}

const noAccessSent = new Set();

async function rejectUnauthorized(chat, userId, { callbackId } = {}) {
  if (callbackId) {
    await answerCallback(callbackId, 'Нет доступа').catch(() => {});
  }
  if (isGroupChat(chat)) return;

  const key = String(userId || chat?.id || '');
  if (!key || noAccessSent.has(key)) return;
  noAccessSent.add(key);
  if (chat?.id) {
    await sendMessage(chat.id, ERRORS.noAccess).catch(() => {});
  }
}

function parseSetCommand(text) {
  const match = text.match(/^\/set\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;

  const key = match[1].toLowerCase();
  const rawValue = (match[2] || '').trim();

  if (key === 'chaturl') {
    if (!rawValue) return { error: ERRORS.chatUrlRequired };
    const result = setDefaultChatUrl(rawValue);
    if (result.error) return { error: result.error };
    return { ok: true, key, value: result.url };
  }

  if (key === 'browserpassword') {
    if (!rawValue) return { prompt: true, key };
    const result = acceptBrowserPassword(rawValue);
    if (!result.ok) return { error: result.error };
    return { ok: true, key, secret: true, delivered: result.delivered };
  }

  const rule = SETTABLE[key];
  if (!rule) {
    return {
      error: ERRORS.unknownKey(`chaturl, browserpassword, biocity, biotemplate, biointerval, ${Object.keys(SETTABLE).join(', ')}`),
    };
  }

  let value = rawValue;
  if (rule.type === 'int') {
    value = Number.parseInt(rawValue, 10);
    if (Number.isNaN(value)) return { error: ERRORS.numberRequired };
    if (rule.min != null && value < rule.min) return { error: `Минимум: ${rule.min}` };
    if (rule.max != null && value > rule.max) return { error: `Максимум: ${rule.max}` };
  } else if (!rawValue) {
    return { error: ERRORS.valueRequired };
  }

  store.setPath(rule.path, value);
  return { ok: true, key, value };
}

async function handleBrowserPasswordInput(chatId, text, userMessageId) {
  const password = String(text || '').trim();
  if (!password) {
    await deleteMessageQuiet(chatId, userMessageId);
    await sendInputPrompt(chatId, AUTH.passwordEmpty);
    return true;
  }

  const result = acceptBrowserPassword(password);
  waitingInput.delete(String(chatId));
  await clearInputPrompt(chatId, userMessageId);
  await sendBrowserPasswordSetResponse(chatId, result);
  return true;
}

async function sendBrowserPasswordSetResponse(chatId, result = {}) {
  const password = result.password || getBrowserPassword();

  if (authInputWaiter) {
    const waiter = authInputWaiter;
    clearAuthInputWaiter();
    waiter.onValid(password);
    await sendMessage(chatId, buildAuthInputAcceptedMessage(waiter));
    return;
  }

  const { isCaptionSessionActive } = require('./auth-caption');
  await sendMessage(
    chatId,
    buildBrowserPasswordSavedMessage({
      delivered: result.delivered || isCaptionSessionActive(),
    }),
    { reply_markup: buildMenuKeyboard() }
  );
}

async function handleProfileBioCityInput(chatId, text, userMessageId) {
  const city = String(text || '').trim();
  if (!city) {
    await deleteMessageQuiet(chatId, userMessageId);
    await sendInputPrompt(chatId, ERRORS.cityNotRecognized + PROFILE_BIO_CITY_HINT);
    return false;
  }

  const key = String(chatId);
  const shouldEnableBio = pendingProfileBioEnable.has(key);

  saveProfileBioCity(city);
  if (shouldEnableBio) {
    pendingProfileBioEnable.delete(key);
    store.setPath(['profileBio', 'enabled'], true);
  }

  waitingInput.delete(key);

  const saved = SAVED.city(escapeHtml(city));
  const lines = [...saved.lines];
  if (shouldEnableBio) {
    lines.unshift(HINTS.profileBioEnabled.trim());
  }

  await sendMessage(
    chatId,
    buildEventMessage({ ...saved, status: 'done', lines }),
    { reply_markup: buildMenuKeyboard() }
  );
  await clearInputPrompt(chatId, userMessageId);
  return true;
}

async function handleProfileBioTemplateInput(chatId, text, userMessageId) {
  const template = String(text || '').trim();
  if (!template) {
    await deleteMessageQuiet(chatId, userMessageId);
    await sendInputPrompt(chatId, ERRORS.templateNotRecognized + PROFILE_BIO_TEMPLATE_HINT, {
      reply_markup: buildBioTemplateKeyboard(),
    });
    return false;
  }

  let preview;
  try {
    const bioSettings = getProfileBio();
    preview = previewBioTemplate(template, bioSettings.city, 'Europe/Moscow', bioSettings.eventDate);
  } catch (err) {
    await sendInputPrompt(
      chatId,
      `Не удалось разобрать шаблон: ${escapeHtml(err.message)}\n\n${buildBioTemplatePromptText(template)}`,
      { reply_markup: buildBioTemplateKeyboard() }
    );
    return false;
  }

  if (preview.length > MAX_BIO_LENGTH) {
    await deleteMessageQuiet(chatId, userMessageId);
    await sendInputPrompt(
      chatId,
      `Слишком длинный результат (${preview.length} симв.). Сократите шаблон до ${MAX_BIO_LENGTH} символов.`,
      { reply_markup: buildBioTemplateKeyboard() }
    );
    return false;
  }

  try {
    saveProfileBioTemplate(template);
    waitingInput.delete(String(chatId));
    const bio = getProfileBio();
    const eventLine = bio.eventDate
      ? `Событие: <code>${escapeHtml(formatEventDateRu(bio.eventDate))}</code> · дней до: <code>${daysUntilEvent(bio.eventDate)}</code>`
      : null;
    const payload = buildEventMessage({
      title: SAVED.template(escapeHtml(preview.text)).title,
      status: 'done',
      lines: [
        'Шаблон:',
        `<code>${escapeHtml(template)}</code>`,
        '',
        'Как выглядит:',
        `<code>${escapeHtml(preview.text)}</code>`,
        `(${preview.length} симв.)`,
        eventLine,
      ].filter((line) => line != null),
    });

    let sent;
    try {
      sent = await sendMessage(chatId, payload, { reply_markup: buildMenuKeyboard() });
    } catch (err) {
      sent = { ok: false, description: err.message };
    }
    if (!sent?.ok) {
      sent = await sendMessage(
        chatId,
        `✅ Шаблон сохранён.\n\nКак выглядит:\n<pre>${escapeHtml(preview.text)}</pre>`,
        { reply_markup: buildMenuKeyboard() }
      ).catch((err) => ({ ok: false, description: err.message }));
    }
    if (!sent?.ok) {
      await sendMessage(chatId, 'Шаблон сохранён.').catch(() => {});
    }
    await clearInputPrompt(chatId, userMessageId);
    return true;
  } catch (err) {
    console.error('profileBioTemplate:', err.message);
    await sendMessage(
      chatId,
      `Не удалось сохранить шаблон: ${escapeHtml(err.message)}`
    ).catch(() => {});
    return false;
  }
}

function buildAuthInputAcceptedMessage(waiter) {
  const label = String(waiter?.label || '').toLowerCase();

  if (waiter?.field === 'password') {
    return buildEventMessage({ ...AUTH.passwordAccepted, status: 'done' });
  }

  if (/код из sms|sms/.test(label)) {
    return buildEventMessage({ ...AUTH.codeAccepted, status: 'done' });
  }

  if (/номер телефона|телефон/.test(label)) {
    return buildEventMessage({ ...AUTH.phoneProgress(''), status: 'progress', lines: ['Номер принят, продолжаю вход…'] });
  }

  return buildEventMessage({ ...AUTH.inputAccepted, status: 'done' });
}

async function handleAuthInput(chatId, text, userMessageId) {
  if (!authInputWaiter) return false;

  const chatIdStr = String(chatId);
  const allowed = new Set((authInputWaiter.chatIds || []).map(String));
  if (!allowed.has(chatIdStr)) return false;

  if (/^\/cancel$/i.test(text)) {
    const waiter = authInputWaiter;
    clearAuthInputWaiter();
    await clearInputPrompt(chatId, userMessageId);
    waiter.onCancel?.();
    return true;
  }

  const browserCmd = parseBrowserPasswordCommand(text);
  if (browserCmd?.error) {
    await deleteMessageQuiet(chatId, userMessageId);
    await sendInputPrompt(chatId, browserCmd.error);
    return true;
  }
  if (browserCmd?.password) {
    const result = acceptBrowserPassword(browserCmd.password);
    const waiter = authInputWaiter;
    clearAuthInputWaiter();
    await clearInputPrompt(chatId, userMessageId);
    waiter.onValid(result.password);
    await sendMessage(chatId, buildAuthInputAcceptedMessage(waiter));
    return true;
  }

  if (text.startsWith('/') && !/^\/cancel$/i.test(text)) {
    return false;
  }

  if (authInputWaiter.validate) {
        const validated = authInputWaiter.validate(text);
        if (validated === false || validated == null) {
          await deleteMessageQuiet(chatId, userMessageId);
          await sendInputPrompt(
            chatId,
            authInputWaiter.invalidMessage || ERRORS.invalidFormat
          );
          return true;
        }
        const waiter = authInputWaiter;
        clearAuthInputWaiter();
        await clearInputPrompt(chatId, userMessageId);
        waiter.onValid(typeof validated === 'string' ? validated : text);
        await sendMessage(chatId, buildAuthInputAcceptedMessage(waiter));
        return true;
  }

  const waiter = authInputWaiter;
  clearAuthInputWaiter();
  await clearInputPrompt(chatId, userMessageId);
  waiter.onValid(text);
        await sendMessage(chatId, buildAuthInputAcceptedMessage(waiter));
  return true;
}

async function replyChatInfo(adminChatId, targetChatId, hintTitle, chatType) {
  const chatIdStr = String(targetChatId);
  recordChat({
    id: chatIdStr,
    title: hintTitle,
    type: chatType || 'unknown',
  });

  let known = getKnownChat(chatIdStr);
  let freshTitle = known?.title || hintTitle;

  try {
    const data = await getChat(chatIdStr);
    if (data.ok && data.result) {
      recordChat(data.result);
      known = getKnownChat(chatIdStr) || known;
      freshTitle = data.result.title || data.result.first_name || freshTitle;
    }
  } catch {
    /* use cached */
  }

  if (!known) {
    known = {
      id: chatIdStr,
      title: freshTitle || 'Без названия',
      type: chatType || 'unknown',
    };
  }

  await sendMessage(adminChatId, buildChatInfoText(known, freshTitle), {
    reply_markup: buildChatInfoKeyboard(chatIdStr),
  });
}

async function showNotifyChats(chatId, messageId) {
  const statuses = await refreshNotificationChatStatuses();
  const text = buildNotifyChatText(statuses);
  const extra = { reply_markup: await buildNotifyChatKeyboard(statuses) };
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, extra);
      return;
    } catch (err) {
      console.warn('showNotifyChats edit:', err.message);
    }
  }
  await sendMessage(chatId, text, extra);
}

async function handleMyChatMember(memberUpdate) {
  const chat = memberUpdate?.chat;
  const neu = memberUpdate?.new_chat_member;
  const old = memberUpdate?.old_chat_member;
  if (!chat?.id || !neu?.user) return;

  if (chat.title || chat.username) {
    recordChat(chat);
  }

  if (!neu.user.is_bot) return;
  if (chat.type === 'private' || chat.type === 'channel') return;

  const { getBotUserId } = require('./tg-api');
  const botId = await getBotUserId();
  if (botId && neu.user.id !== botId) return;

  const actorId = String(memberUpdate.from?.id || '');
  const ourAdmin = getAdminChatIds().map(String).includes(actorId);

  const becameAdmin = isBotAdminStatus(neu) && !isBotAdminStatus(old);
  const joined =
    ['member', 'restricted', 'administrator', 'creator'].includes(neu.status) &&
    ['left', 'kicked', 'unknown', ''].includes(old?.status || '');
  const joinedWithoutAdmin =
    joined && !isBotAdminStatus(neu);

  if (!ourAdmin) return;

  if (joined || becameAdmin) {
    bindNotificationChat(chat.id, actorId);
  }

  const known = (await refreshTelegramChat(chat.id)) || getKnownChat(chat.id);
  const title = known?.title || chat.title || String(chat.id);

  if (joinedWithoutAdmin) {
    for (const adminId of getAdminChatIds()) {
      try {
        await sendMissingAdminNotice(adminId, chat.id);
      } catch (err) {
        console.warn('notify admin missing rights:', err.message);
      }
    }
    return;
  }

  if (!becameAdmin) return;

  for (const adminId of getAdminChatIds()) {
    try {
      await sendMessage(
        adminId,
        buildEventMessage({
          title: 'Группа подключена',
          status: 'done',
          lines: [
            'Бот добавлен в группу администратором.',
            `Группа: <b>${escapeHtml(title)}</b>`,
            `ID: <code>${chat.id}</code>`,
          ],
        })
      );
    } catch (err) {
      console.warn('notify admin after promote:', err.message);
    }
  }
}

async function refreshMaxChatPanel(chatId, query, index, destPage = 0) {
  const rows = query.message?.reply_markup?.inline_keyboard || [];
  const onCard = rows.some((row) => row.some((btn) => btn.callback_data === 'maxchat:list'));
  if (onCard) {
    await showMaxChatView(chatId, query.message.message_id, index, destPage);
    return;
  }
  await showMaxChats(chatId, query.message.message_id);
}

async function showMaxChats(chatId, messageId) {
  const text = buildMaxChatsText();
  const extra = { reply_markup: buildMaxChatsKeyboard() };
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, extra);
      return;
    } catch (err) {
      console.warn('showMaxChats edit:', err.message);
    }
  }
  await sendMessage(chatId, text, extra);
}

async function showMaxChatView(chatId, messageId, index, destPage = 0) {
  const urls = getMonitorChatUrls();
  const url = urls[index];
  if (!url) {
    await showMaxChats(chatId, messageId);
    return;
  }

  const title = chatLabelFromUrl(url);
  const lines = [
    `Название чата: <b>${escapeHtml(title)}</b>`,
    `Ссылка: <code>${escapeHtml(url)}</code>`,
    '',
  ];

  if (isRequiredChatUrl(url)) {
    lines.push(CHATS.requiredPinned);
  }

  lines.push('');
  lines.push(isChatForwardEnabled(url) ? CHATS.requiredForwardOn : CHATS.requiredForwardOff);
  lines.push(
    isPersonalMaxChat(url)
      ? 'Личный чат MAX — по умолчанию в ЛС.'
      : isGroupMaxChat(url)
        ? 'Группа или канал MAX — выберите ЛС, пользователей и нужные группы ниже.'
        : 'Куда слать в Telegram — отметьте кнопками ниже.'
  );
  const destTitles = listNotifyDestTitles(url);
  if (!destTitles.length) {
    lines.push(CHATS.notifyDestNone);
  } else {
    lines.push('Сейчас уходит:');
    for (const name of destTitles) {
      lines.push(`• <b>${escapeHtml(name)}</b>`);
    }
  }
  const deleteModeLabels = { delete: 'удалять в Telegram', mark: 'помечать «Сообщение удалено в MAX»', keep: 'оставлять в Telegram' };
  lines.push(`Удаление в MAX: <b>${deleteModeLabels[getDeleteSyncMode(url)]}</b>`);
  lines.push('', CHATS.notifyDestHint);

  const text = lines.join('\n');
  const extra = { reply_markup: buildMaxChatViewKeyboard(index, destPage) };
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, extra);
      return;
    } catch (err) {
      console.warn('showMaxChatView edit:', err.message);
    }
  }
  await sendMessage(chatId, text, extra);
}

async function handleMaxChatUrlInput(chatId, text, userMessageId) {
  const cache = maxChatAddCache.get(String(chatId));
  let chats = cache?.chats || [];
  let resolved = resolveMaxChatInput(text, chats);

  if (resolved.error === 'not_found' && maxChatPickerHandler && !chats.length) {
    try {
      const fresh = await maxChatPickerHandler();
      chats = fresh.chats || [];
      maxChatAddCache.set(String(chatId), {
        ...cache,
        chats,
        photoMessageId: cache?.photoMessageId || null,
      });
      resolved = resolveMaxChatInput(text, chats);
    } catch {
      /* keep not_found */
    }
  }

  if (resolved.error === 'ambiguous') {
    await deleteMessageQuiet(chatId, userMessageId);
    const titles = resolved.matches.map((chat) => escapeHtml(chat.title));
    await sendMessage(chatId, CHATS.addAmbiguous(titles));
    return false;
  }

  if (resolved.needsUrl && maxChatResolveHandler) {
    try {
      const url = await maxChatResolveHandler(resolved.title);
      if (url) {
        resolved = { url, title: resolved.title };
      } else {
        resolved = { error: 'not_found' };
      }
    } catch {
      resolved = { error: 'not_found' };
    }
  }

  if (!resolved.error && !resolved.title && chats.length) {
    const fromCache = chats.find((item) => item.url && item.url === resolved.url);
    if (fromCache?.title) resolved.title = fromCache.title;
  }

  if (resolved.error) {
    await deleteMessageQuiet(chatId, userMessageId);
    const hint =
      resolved.error === 'not_found' ? CHATS.addNotFound : CHATS.addPromptNoScreenshot;
    if (cache?.photoMessageId) {
      await sendMessage(chatId, hint);
    } else {
      await sendInputPrompt(chatId, hint);
    }
    return false;
  }

  waitingInput.set(String(chatId), 'maxchat:add');
  await deleteMessageQuiet(chatId, userMessageId);
  await proceedMaxChatAdd(chatId, { url: resolved.url, title: resolved.title });
  return true;
}

function telegramEditOk(result) {
  return Boolean(result?.ok) || /not modified/i.test(String(result?.description || ''));
}

async function editMaxChatPickMessage(chatId, text, extra = {}) {
  const key = String(chatId);
  const cache = maxChatAddCache.get(key) || {};
  const messageId = cache.pickMessageId || cache.whereMessageId;
  if (messageId) {
    try {
      const result = await editMessageText(chatId, messageId, text, extra);
      if (telegramEditOk(result)) return true;
      console.warn('maxchat pick edit:', result?.description || 'edit failed');
    } catch (err) {
      console.warn('maxchat pick edit:', err.message);
    }
  }

  const sent = await sendMessage(chatId, text, extra);
  const id = sent?.ok ? sent.result?.message_id || null : null;
  if (id) {
    maxChatAddCache.set(key, { ...cache, pickMessageId: id, whereMessageId: id });
    return true;
  }
  if (!sent?.ok) {
    console.warn('maxchat pick send:', sent?.description || 'send failed');
  }
  return false;
}

function resolvePendingChatKind(pending) {
  const url = String(pending?.url || '').trim();
  const listed = pending?.kind === 'personal' || pending?.kind === 'group' ? pending.kind : '';
  if (listed && url) setChatKind(url, listed);
  if (listed) return listed;
  if (url && isRequiredChatUrl(url)) return 'personal';
  return getStoredChatKind(url) || '';
}

async function proceedMaxChatAdd(chatId, pending) {
  const url = String(pending?.url || '').trim();
  const title = String(pending?.title || chatLabelFromUrl(url) || '').trim();
  const kind = resolvePendingChatKind(pending);
  const key = String(chatId);
  const cache = maxChatAddCache.get(key) || {};
  maxChatAddCache.set(key, {
    ...cache,
    pending: { url, title, kind },
  });

  if (url && (kind === 'personal' || isRequiredChatUrl(url))) {
    await editMaxChatPickMessage(
      chatId,
      ['<b>Добавить чат MAX</b>', '', `Добавляю в ЛС: <b>${escapeHtml(title || url)}</b>…`].join('\n')
    );
    return finishMaxChatAddWithTarget(chatId, 'dm');
  }

  waitingInput.set(key, 'maxchat:add');
  await showMaxChatWherePrompt(chatId, { url, title, kind });
  return true;
}

async function showMaxChatWherePrompt(chatId, pending) {
  const key = String(chatId);
  const cache = maxChatAddCache.get(key) || {};
  const url = String(pending?.url || cache.pending?.url || '').trim();
  const title = String(pending?.title || cache.pending?.title || chatLabelFromUrl(url) || '').trim();
  const kind = pending?.kind || cache.pending?.kind || '';
  const destPage = pending?.destPage ?? cache.pending?.destPage ?? 0;
  const destIds = Array.isArray(pending?.destIds)
    ? pending.destIds.map(String)
    : Array.isArray(cache.pending?.destIds)
      ? cache.pending.destIds.map(String)
      : getDefaultNotifyChatIds();

  maxChatAddCache.set(key, {
    ...cache,
    pending: { url, title, kind, destIds, destPage },
  });

  const selectedNames = destIds.map((id) => telegramChatTitle(id, 40));
  const text = [
    `<b>${CHATS.notifyDestWhereTitle}</b>`,
    '',
    title ? `Чат: <b>${escapeHtml(title)}</b>` : null,
    url ? `<code>${escapeHtml(url)}</code>` : null,
    '',
    CHATS.notifyDestWhereHint,
    selectedNames.length ? '' : null,
    selectedNames.length ? `Выбрано: ${selectedNames.map(escapeHtml).join(', ')}` : 'Пока ничего не выбрано — будет ЛС.',
  ]
    .filter((line) => line != null)
    .join('\n');
  const extra = { reply_markup: buildMaxChatPickWhereKeyboard(destIds, destPage) };

  if (await editMaxChatPickMessage(chatId, text, extra)) return;

  const sent = await sendMessage(chatId, text, extra);
  maxChatAddCache.set(key, {
    ...maxChatAddCache.get(key),
    pickMessageId: sent?.result?.message_id || null,
    whereMessageId: sent?.result?.message_id || null,
  });
}

async function restoreMaxChatPickPrompt(chatId) {
  const key = String(chatId);
  const cache = maxChatAddCache.get(key);
  if (!cache) {
    waitingInput.delete(key);
    await showMaxChats(chatId);
    return;
  }

  const next = { ...cache };
  delete next.pending;
  maxChatAddCache.set(key, next);

  const chats = cache.chats || [];
  const page = cache.pickPage || 0;
  const keyboard = buildMaxChatPickKeyboard(chats, page);
  const text = buildMaxChatAddCaption(chats);

  if (cache.pickMessageId) {
    try {
      await editMessageText(chatId, cache.pickMessageId, text, { reply_markup: keyboard });
      return;
    } catch (err) {
      console.warn('maxchat pickback edit:', err.message);
    }
  }

  if (cache.photoMessageId) {
    try {
      await editMessageCaption(chatId, cache.photoMessageId, text, { reply_markup: keyboard });
      return;
    } catch (err) {
      console.warn('maxchat pickback caption:', err.message);
    }
  }

  if (cache.whereMessageId) {
    try {
      await editMessageText(chatId, cache.whereMessageId, text, { reply_markup: keyboard });
      return;
    } catch (err) {
      console.warn('maxchat pickback edit:', err.message);
    }
  }

  await sendInputPrompt(chatId, text, { reply_markup: keyboard });
}

async function finishMaxChatAddWithTarget(chatId, routing) {
  const key = String(chatId);
  const cache = maxChatAddCache.get(key);
  const pending = cache?.pending;
  if (!pending?.url) {
    return { error: 'Сначала выберите чат' };
  }

  const options = typeof routing === 'string'
    ? { notifyTarget: routing }
    : routing && typeof routing === 'object'
      ? routing
      : {};

  const result = addMonitorChatUrl(pending.url, {
    title: pending.title,
    notifyTarget: options.notifyTarget,
    notifyChatIds: options.notifyChatIds || options.destIds,
  });
  if (result.error) return result;

  if (cache?.chats?.length) {
    waitingInput.set(key, 'maxchat:add');
    const next = { ...maxChatAddCache.get(key) };
    delete next.pending;
    maxChatAddCache.set(key, next);
    await restoreMaxChatPickPrompt(chatId);
    return result;
  }

  waitingInput.delete(key);
  await clearMaxChatAddPrompt(chatId);

  const destLabel = formatNotifyDestLabel(result.url);
  const lines = [
    result.duplicate
      ? CHATS.duplicate.lines[0]
      : pending.title
        ? `Чат: <b>${escapeHtml(pending.title)}</b>`
        : `Чат: <code>${escapeHtml(result.url)}</code>`,
    pending.title ? `<code>${escapeHtml(result.url)}</code>` : null,
    destLabel ? `Куда слать: ${escapeHtml(destLabel)}` : null,
    '',
    buildMaxChatsText(),
  ].filter(Boolean);

  await sendMessage(
    chatId,
    buildEventMessage({
      title: result.duplicate ? CHATS.destinationSaved.title : CHATS.added.title,
      status: 'done',
      lines,
    }),
    { reply_markup: buildMaxChatsKeyboard() }
  );
  return result;
}

async function handleMaxChatPick(chatId, chat) {
  let url = String(chat?.url || '').trim();
  const title = String(chat?.title || '').trim();
  const kind = chat?.kind === 'personal' || chat?.kind === 'group' ? chat.kind : '';

  if (!url && title) {
    url = findChatUrlByTitle(title) || '';
  }

  if (url) {
    if (title && !/^https:\/\/web\.max\.ru\//i.test(title)) setChatTitle(url, title);
    if (kind) setChatKind(url, kind);
    waitingInput.set(String(chatId), 'maxchat:add');
    await proceedMaxChatAdd(chatId, { url, title: title || chatLabelFromUrl(url), kind });
    return true;
  }

  await editMaxChatPickMessage(
    chatId,
    [
      '<b>Добавить чат MAX</b>',
      '',
      `Ищу в MAX: <b>${escapeHtml(title || 'чат')}</b>…`,
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [[{ text: '« Отмена', callback_data: 'maxchat:canceladd' }]],
      },
    }
  );

  if (title && maxChatResolveHandler) {
    try {
      url = String((await maxChatResolveHandler(title)) || '').trim();
    } catch (err) {
      console.warn('maxchat pick:', err.message);
      url = '';
    }
  }

  if (url) {
    if (title) setChatTitle(url, title);
    if (kind) setChatKind(url, kind);
    waitingInput.set(String(chatId), 'maxchat:add');
    await proceedMaxChatAdd(chatId, { url, title, kind });
    return true;
  }

  if (title) {
    return handleMaxChatUrlInput(chatId, title);
  }

  await editMaxChatPickMessage(chatId, CHATS.addNotFound);
  return false;
}

async function sendMissingAdminNotice(adminChatId, groupChatId) {
  if (!groupChatId || isPrivateChatId(groupChatId)) return false;
  const status = await getBotAdminStatus(groupChatId);
  if (status.admin) return false;

  const known = getKnownChat(groupChatId);
  const title = known?.title && known.title !== 'Без названия' ? known.title : '';
  await sendMessage(adminChatId, buildEventMessage({
    title: CHATS.notAdmin.title,
    status: 'fail',
    lines: CHATS.notAdmin.lines(title ? escapeHtml(title) : ''),
  }), { reply_markup: await buildMissingAdminKeyboard() });
  return true;
}

function collectMessageLinkText(message) {
  const chunks = [message.text, message.caption].filter(Boolean);
  const entitySources = [
    [message.text, message.entities],
    [message.caption, message.caption_entities],
  ];

  for (const [source, entities] of entitySources) {
    if (!source || !Array.isArray(entities)) continue;
    for (const entity of entities) {
      if (entity.type === 'url') {
        chunks.push(source.slice(entity.offset, entity.offset + entity.length));
      } else if (entity.type === 'text_link' && entity.url) {
        chunks.push(entity.url);
      }
    }
  }

  return chunks.join('\n');
}

async function handleAutoMaxChatLinks(chatId, message) {
  const blob = collectMessageLinkText(message);
  if (!blob.trim()) return false;

  const urls = extractMaxChatUrlsFromText(blob);
  if (!urls.length) return false;

  const added = [];
  const duplicates = [];
  const errors = [];

  for (const url of urls) {
    const result = addMonitorChatUrl(url);
    if (result.error) {
      errors.push({ url, error: result.error });
      continue;
    }
    if (result.duplicate) duplicates.push(url);
    else added.push(url);
  }

  if (!added.length && !duplicates.length && !errors.length) return false;

  const lines = [];
  if (added.length) {
    lines.push('Добавлено в мониторинг:');
    for (const url of added) lines.push(`• <code>${escapeHtml(url)}</code>`);
    lines.push('', 'Маршрут в Telegram — в «Чаты MAX».');
  }
  if (duplicates.length) {
    if (lines.length) lines.push('');
    lines.push('Уже отслеживаются:');
    for (const url of duplicates) lines.push(`• <code>${escapeHtml(url)}</code>`);
  }
  if (errors.length) {
    if (lines.length) lines.push('');
    for (const item of errors) {
      lines.push(`• <code>${escapeHtml(item.url)}</code>: ${item.error}`);
    }
  }

  await sendMessage(
    chatId,
    buildEventMessage({
      title: added.length ? CHATS.added.title : duplicates.length ? CHATS.duplicate.title : 'Не удалось добавить чат',
      status: errors.length && !added.length ? 'fail' : 'done',
      lines,
    }),
    { reply_markup: buildMaxChatsKeyboard() }
  );
  return true;
}

async function handleChatShared(adminChatId, shared) {
  const targetChatId = String(shared.chat_id);
  const title = shared.title || null;

  recordChat({
    id: targetChatId,
    title,
    type: 'unknown',
  });

  if (shared.request_id === NOTIFY_GROUP_REQUEST_ID) {
    bindNotificationChat(targetChatId, adminChatId);
    await refreshTelegramChat(targetChatId);
    const statuses = await refreshNotificationChatStatuses();
    const known = getKnownChat(targetChatId);
    await sendMessage(adminChatId, 'Группа добавлена.', {
      reply_markup: { remove_keyboard: true },
    });
    await sendMessage(
      adminChatId,
      buildEventMessage({
        title: CHATS.bound.title,
        status: 'done',
        lines: [
          known?.title && known.title !== 'Без названия'
            ? `Группа: <b>${escapeHtml(known.title)}</b>`
            : 'Группа привязана.',
          `ID: <code>${targetChatId}</code>`,
          CHATS.bound.lines(true)[0],
          '',
          buildNotifyChatText(statuses),
        ].filter(Boolean),
      }),
      { reply_markup: await buildNotifyChatKeyboard(statuses) }
    );
    await sendMissingAdminNotice(adminChatId, targetChatId);
    return;
  }

  await replyChatInfo(adminChatId, targetChatId, title);
}

function bindUserContextOf(chatId) {
  return bindUserContext.get(String(chatId)) || { mode: 'notify' };
}

async function beginBindUser(chatId, context = { mode: 'notify' }) {
  bindUserContext.set(String(chatId), context);
  waitingInput.set(String(chatId), 'notify:bindUser');
  await sendInputPrompt(chatId, CHATS.bindUserPrompt, {
    reply_markup: buildBindUserReplyKeyboard(),
  });
}

async function restoreAfterBindUser(adminChatId) {
  const ctx = bindUserContextOf(adminChatId);
  bindUserContext.delete(String(adminChatId));
  waitingInput.delete(String(adminChatId));

  if (ctx.mode === 'view') {
    const urls = getMonitorChatUrls();
    const index = Number(ctx.index) || 0;
    if (urls[index]) {
      await showMaxChatView(adminChatId, null, index, ctx.destPage || 0);
      return;
    }
  }

  if (ctx.mode === 'where') {
    const cache = maxChatAddCache.get(String(adminChatId));
    if (cache?.pending) {
      waitingInput.set(String(adminChatId), 'maxchat:add');
      await showMaxChatWherePrompt(adminChatId, cache.pending);
      return;
    }
  }

  await showNotifyChats(adminChatId);
}

async function finishBindNotifyPeer(adminChatId, peer, { userMessageId } = {}) {
  if (!peer?.id) {
    await sendInputPrompt(adminChatId, 'Не удалось определить пользователя. Попробуйте ещё раз или /cancel.');
    return false;
  }

  const targetId = String(peer.id);
  const isGroup = !isPrivateChatId(targetId);
  bindNotificationChat(targetId, adminChatId);
  if (!isGroup) await refreshTelegramChat(targetId);

  const ctx = bindUserContextOf(adminChatId);
  if (ctx.mode === 'view') {
    const urls = getMonitorChatUrls();
    const url = urls[Number(ctx.index) || 0];
    if (url) addNotifyChatId(url, targetId);
  } else if (ctx.mode === 'where') {
    const cache = maxChatAddCache.get(String(adminChatId));
    if (cache?.pending) {
      const destIds = [...new Set([...(cache.pending.destIds || getDefaultNotifyChatIds()).map(String), targetId])];
      maxChatAddCache.set(String(adminChatId), {
        ...cache,
        pending: { ...cache.pending, destIds },
      });
    }
  }

  const known = getKnownChat(targetId);
  const title = known?.title || peer.title || targetId;
  const wrote = !isGroup && hasWrittenToBot(targetId);
  await clearInputPrompt(adminChatId, userMessageId);
  await sendMessage(adminChatId, isGroup ? 'Группа добавлена.' : 'Пользователь добавлен.', {
    reply_markup: { remove_keyboard: true },
  });
  await sendMessage(
    adminChatId,
    buildEventMessage({
      title: CHATS.bound.title,
      status: 'done',
      lines: [
        isGroup
          ? `Группа: <b>${escapeHtml(title)}</b>`
          : `Пользователь: <b>${escapeHtml(title)}</b>`,
        `ID: <code>${targetId}</code>`,
        isGroup ? null : wrote ? 'Уже писал в бота — сообщения дойдут.' : 'Ещё не писал в бота — пусть откроет бота через Start.',
        isGroup ? CHATS.bound.lines(true)[0] : CHATS.bound.lines(false)[0],
      ].filter(Boolean),
    })
  );
  await restoreAfterBindUser(adminChatId);
  if (isGroup) await sendMissingAdminNotice(adminChatId, targetId);
  return true;
}

async function handleUsersShared(adminChatId, shared) {
  const users = shared.users || (shared.user_id ? [shared] : []);
  const first = users[0];
  const userId = first?.user_id || first?.id;
  if (!userId) return;

  recordChat({
    id: userId,
    first_name: first.first_name,
    last_name: first.last_name,
    username: first.username || null,
    type: 'private',
  }, { resolved: true });

  if (
    shared.request_id === NOTIFY_USER_REQUEST_ID ||
    waitingInput.get(String(adminChatId)) === 'notify:bindUser'
  ) {
    await finishBindNotifyPeer(adminChatId, { id: userId, title: getKnownChat(userId)?.title });
  }
}

async function showDiscoverChats(chatId, messageId, page = 0) {
  const chats = listKnownChats();
  const keyboard = buildDiscoverKeyboard(page);

  if (!chats.length) {
    const text = buildDiscoverEmptyText();
    if (messageId) {
      await editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: [[{ text: '« В меню', callback_data: 'discover:menu' }]] },
      });
    } else {
      await sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: [[{ text: '« В меню', callback_data: 'discover:menu' }]] },
      });
    }
    return;
  }

  const text = [
    '<b>Узнать ID чата</b>',
    '',
    CHATS.discoverHint,
  ].join('\n');

  if (messageId) {
    await editMessageText(chatId, messageId, text, { reply_markup: keyboard });
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

async function showChatInfo(chatId, messageId, targetChatId) {
  let known = getKnownChat(targetChatId);
  let freshTitle = known?.title;

  try {
    const data = await getChat(targetChatId);
    if (data.ok && data.result) {
      recordChat(data.result);
      known = getKnownChat(targetChatId) || known;
      freshTitle = data.result.title || data.result.first_name || freshTitle;
    }
  } catch {
    /* use cached */
  }

  if (!known) {
    known = {
      id: String(targetChatId),
      title: freshTitle || 'Без названия',
      type: 'unknown',
    };
  }

  const text = buildChatInfoText(known, freshTitle);
  await editMessageText(chatId, messageId, text, {
    reply_markup: buildChatInfoKeyboard(targetChatId),
  });
}

function webPanelText(){const c=getWebAccess(),u=webUrl(c);if(!c.domain)return '<b>Веб-панель</b>\n\n🌐 Домен не привязан.\nОтправьте домен следующим сообщением, например:\n<code>panel.example.com</code>\n\nОтмена: /cancel';return ['<b>Веб-панель</b>','',c.enabled!==false?'Статус: ✅ включена':'Статус: ❌ выключена','Ссылка: <code>'+escapeHtml(u)+'</code>','Логин: <code>'+escapeHtml(c.user)+'</code>','Пароль: <code>'+escapeHtml(c.pass)+'</code>','','Путь и данные доступа меняются каждые 6 часов.'].join('\n')}
function normalizeWebDomain(value){
  let domain=String(value||'').trim().toLowerCase().replace(/^https?:\/\//,'').split(/[\/?#]/,1)[0].replace(/\.$/,'');
  try{domain=require('url').domainToASCII(domain)||domain}catch{}
  return domain;
}
function isValidWebDomain(domain){
  if(!domain||domain.length>253||!domain.includes('.'))return false;
  const labels=domain.split('.');
  if(labels.some(label=>!label||label.length>63||!(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))))return false;
  const tld=labels[labels.length-1];
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(tld);
}
async function getWebPanelPublicIp(){
  const urls=['https://api.ipify.org','https://ipv4.icanhazip.com'];
  for(const url of urls){
    try{
      const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
      const value=(await response.text()).trim();
      if(response.ok&&/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))return value;
    }catch{}
  }
  return '';
}
async function configureWebPanelTls(domain){
  const script=path.resolve(__dirname,'..','scripts','configure-web-panel-tls.sh');
  if(!fs.existsSync(script))return {ok:false,error:'Скрипт автоматической настройки SSL не найден'};
  let lastError='';
  for(let attempt=1;attempt<=2;attempt++){
    try{
      const {stdout}=await execFileAsync('bash',[script,domain],{timeout:180000,maxBuffer:1024*1024});
      return {ok:true,details:String(stdout||'').trim()};
    }catch(err){
      lastError=String(err.stderr||err.stdout||err.message||'').trim().slice(0,1200);
      console.error('webPanel TLS attempt '+attempt+':',lastError);
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,2500));
    }
  }
  return {ok:false,error:lastError||'Автоматическая настройка SSL завершилась ошибкой'};
}
async function bindWebDomain(chatId,text){
  const domain=normalizeWebDomain(text);
  if(!isValidWebDomain(domain)){
    await sendInputPrompt(chatId,'❌ Некорректный домен.\n\nОтправьте домен без https:// и пути, например:\n<code>panel.example.com</code>\n\nОтмена: /cancel');
    return false;
  }

  let checking;
  try{
    checking=await sendMessage(chatId,'🔎 Проверяю домен <code>'+escapeHtml(domain)+'</code>…');
  }catch(err){
    console.error('webPanel checking message:',err.message);
  }
  const checkingMessageId=checking?.result?.message_id;
  const updateChecking=async(content,extra={})=>{
    if(checkingMessageId){
      try{return await editMessageText(chatId,checkingMessageId,content,extra)}catch{}
    }
    return sendMessage(chatId,content,extra).catch(err=>{console.error('webPanel status:',err.message);return null});
  };

  let dns=[];
  try{
    dns=await Promise.race([
      require('dns').promises.resolve4(domain),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('DNS timeout')),7000))
    ]);
  }catch{}
  const serverIp=await getWebPanelPublicIp();

  if(!serverIp){
    await updateChecking('⚠️ Не удалось определить публичный IPv4 этого сервера.\n\nПроверьте доступ сервера в интернет и отправьте домен ещё раз.\nОтмена: /cancel');
    return false;
  }

  if(!dns.includes(serverIp)){
    const current=dns.length?dns.map(ip=>'<code>'+escapeHtml(ip)+'</code>').join(', '):'<i>A-запись отсутствует</i>';
    await updateChecking([
      '❌ <b>Домен пока не направлен на этот сервер.</b>',
      '',
      'Нужно создать или изменить DNS-запись:',
      '<b>Тип:</b> <code>A</code>',
      '<b>Имя:</b> <code>'+escapeHtml(domain)+'</code>',
      '<b>Значение:</b> <code>'+escapeHtml(serverIp)+'</code>',
      '',
      '<b>Сейчас в DNS:</b> '+current,
      '<b>IP этого сервера:</b> <code>'+escapeHtml(serverIp)+'</code>',
      '',
      'Измените A-запись у регистратора/провайдера домена и дождитесь обновления DNS.',
      'После изменения просто отправьте <code>'+escapeHtml(domain)+'</code> ещё раз.',
      '',
      'Отмена: /cancel'
    ].join('\n'));
    return false;
  }

  await updateChecking('🔐 DNS подтверждён. Настраиваю отдельный SSL-сертификат для <code>'+escapeHtml(domain)+'</code>…');
  const tls=await configureWebPanelTls(domain);
  if(!tls.ok){
    await updateChecking([
      '❌ <b>Автоматическая настройка SSL не завершена.</b>',
      '',
      'Домен: <code>'+escapeHtml(domain)+'</code>',
      'Причина: <code>'+escapeHtml(tls.error)+'</code>',
      '',
      /root-права|sudoers/i.test(tls.error)
        ? 'Боту не хватает системного разрешения на управление nginx/Certbot. Это единственное действие, которое нельзя безопасно обойти из процесса без соответствующих прав.'
        : 'Бот уже повторил настройку автоматически. Отправьте домен ещё раз после устранения указанной системной причины.'
    ].join('\n'));
    return false;
  }
  const raw=getRaw(),current=raw.webPanel||{};
  store.setPath(['webPanel'],{...current,domain,tlsVerifiedAt:Date.now()});
  waitingInput.delete(String(chatId));
  await clearInputPrompt(chatId);
  const c=getWebAccess(),u=webUrl(c);
  await updateChecking([
    '✅ <b>Домен привязан</b>',
    '',
    'Домен: <code>'+escapeHtml(domain)+'</code>',
    'Статус: '+(c.enabled!==false?'✅ включена':'❌ выключена'),
    'Ссылка: <code>'+escapeHtml(u)+'</code>',
    'Логин: <code>'+escapeHtml(c.user)+'</code>',
    'Пароль: <code>'+escapeHtml(c.pass)+'</code>',
    '',
    'Путь и данные доступа меняются каждые 6 часов.'
  ].join('\n'),{reply_markup:webPanelKeyboard()});
  return true;
}
function webPanelKeyboard(){const c=getWebAccess(),u=webUrl(c),r=[];if(u&&c.enabled!==false)r.push([{text:'Открыть панель',url:u}]);r.push([{text:'🔑 Сброс входа',callback_data:'action:webPanelResetLogin'},{text:'⚙️ Настройки',callback_data:'action:webPanelSettings'}]);r.push([{text:c.enabled!==false?'Отключить сайт':'Включить сайт',callback_data:'action:webPanelToggle'}]);r.push([{text:'🗑 Полный сброс',callback_data:'action:webPanelResetProfile'}]);r.push([{text:BUTTONS.backToMenu,callback_data:'discover:menu'}]);return{inline_keyboard:r}}
async function showWebPanel(chatId,messageId){const x={reply_markup:webPanelKeyboard()};if(messageId){try{await editMessageText(chatId,messageId,webPanelText(),x);return}catch{}}await sendMessage(chatId,webPanelText(),x)}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!isAdmin(chatId, userId)) {
    if (canUseMaxReply(chatId, userId)) {
      await handleReplyOperatorMessage(message);
      return;
    }
    await rejectUnauthorized(message.chat, userId);
    return;
  }

  const text = (message.text || '').trim();

  if (message.chat_shared) {
    await handleChatShared(chatId, message.chat_shared);
    return;
  }

  if (message.users_shared || message.user_shared) {
    await handleUsersShared(chatId, message.users_shared || message.user_shared);
    return;
  }

  const waitKeyPeek = waitingInput.get(String(chatId));

  // Ввод домена веб-панели имеет приоритет над общей авторизацией MAX.
  // Иначе активный authInputWaiter может перехватить домен и бот визуально "замолчит".
  if (waitKeyPeek === 'webPanel:domain') {
    if (/^\/cancel$/i.test(text)) {
      waitingInput.delete(String(chatId));
      await clearInputPrompt(chatId, message.message_id);
      await sendMessage(chatId, ERRORS.cancelled);
      return;
    }
    if (text && !text.startsWith('/')) {
      try {
        await bindWebDomain(chatId, text);
      } catch (err) {
        console.error('webPanel domain:', err);
        await sendInputPrompt(
          chatId,
          '❌ Не удалось проверить домен: <code>'+escapeHtml(err.message || 'неизвестная ошибка')+'</code>\n\nПопробуйте отправить домен ещё раз.\nОтмена: /cancel'
        ).catch(()=>{});
      }
      return;
    }
  }

  const settingsWait =
    waitKeyPeek === 'profileBioTemplate' || waitKeyPeek === 'profileBioCity';
  const replyHasPhoto = Boolean(
    waitKeyPeek?.startsWith('reply:') && collectTelegramReplyFileIds(message).length
  );
  if (
    !replyHasPhoto &&
    !settingsWait &&
    (await handleAuthInput(chatId, text, message.message_id))
  ) {
    return;
  }

  const waitKey = waitingInput.get(String(chatId));
  const userMessageId = message.message_id;

  if (waitKey?.startsWith('reply:') && (await handleReplyWaitContent(chatId, message, waitKey))) {
    return;
  }

  if (text && !text.startsWith('/') && !waitKey && message.reply_to_message?.message_id) {
    const target = replyStore.getByTelegramMessage(chatId, message.reply_to_message.message_id);
    if (target) return;
  }

  if (waitKey === 'notify:bindUser' && text && !text.startsWith('/')) {
    const resolved = await resolveTelegramPeerFromText(text);
    if (resolved.error) {
      await sendInputPrompt(chatId, `${escapeHtml(resolved.error)}\n\n${CHATS.bindUserPrompt}`, {
        reply_markup: buildBindUserReplyKeyboard(),
      });
      return;
    }
    await finishBindNotifyPeer(chatId, resolved.chat, { userMessageId });
    return;
  }

  if (waitKey === 'profileBioCity' && text && !text.startsWith('/')) {
    await handleProfileBioCityInput(chatId, text, userMessageId);
    return;
  }

  if (
    text &&
    !text.startsWith('/') &&
    (waitKey === 'profileBioTemplate' ||
      ((!waitKey || waitKey === 'maxchat:add') && looksLikeBioTemplate(text)))
  ) {
    await handleProfileBioTemplateInput(chatId, text, userMessageId);
    return;
  }

  if (waitKey === 'browserPassword' && text && !text.startsWith('/')) {
    await handleBrowserPasswordInput(chatId, text, userMessageId);
    return;
  }

  if (!waitKey && !(text && text.startsWith('/'))) {
    if (await handleAutoMaxChatLinks(chatId, message)) return;
  }

  if (waitKey === 'maxchat:add' && text && !text.startsWith('/')) {
    await handleMaxChatUrlInput(chatId, text, userMessageId);
    return;
  }

  if (/^\/cancel$/i.test(text)) {
    const key = String(chatId);
    const bindCtx = bindUserContext.get(key);
    pendingProfileBioEnable.delete(key);
    waitingInput.delete(key);
    clearReplyAlbums(chatId);
    bindUserContext.delete(key);
    if (bindCtx) {
      await clearInputPrompt(chatId, userMessageId);
      await sendMessage(chatId, ERRORS.cancelled, { reply_markup: { remove_keyboard: true } });
      if (bindCtx.mode === 'view') {
        await showMaxChatView(chatId, null, Number(bindCtx.index) || 0, bindCtx.destPage || 0);
      } else if (bindCtx.mode === 'where') {
        const cache = maxChatAddCache.get(key);
        if (cache?.pending) {
          waitingInput.set(key, 'maxchat:add');
          await showMaxChatWherePrompt(chatId, cache.pending);
        }
      } else {
        await showNotifyChats(chatId);
      }
      return;
    }
    await clearMaxChatAddPrompt(chatId, userMessageId);
    await sendMessage(chatId, ERRORS.cancelled);
    return;
  }

  if (/^\/start$/i.test(text)) {
    waitingInput.delete(String(chatId));
    clearReplyAlbums(chatId);
    bindUserContext.delete(String(chatId));
    const firstVisit = await sendPinnedAboutOnce(message.chat);
    if (!firstVisit) {
      await sendMessage(chatId, START.welcome, {
        reply_markup: { remove_keyboard: true },
      });
    }
    await sendMainMenu(chatId);
    return;
  }

  if (/^\/menu$/i.test(text)) {
    waitingInput.delete(String(chatId));
    clearReplyAlbums(chatId);
    bindUserContext.delete(String(chatId));
    await sendMainMenu(chatId);
    return;
  }

  if (/^\/link$/i.test(text)) { const c=getWebAccess(); if(!c.domain){waitingInput.set(String(chatId),'webPanel:domain');await sendInputPrompt(chatId,webPanelText());}else await showWebPanel(chatId); return; }

  if (/^\/status$/i.test(text)) {
    let maxOk = false;
    let tgOk = false;
    let lastError = '';
    const withTimeout = (promise, ms, label) => Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: таймаут`)), ms);
        timer.unref?.();
      }),
    ]);
    const [maxResult, tgResult] = await Promise.allSettled([
      sessionCheckHandler ? withTimeout(sessionCheckHandler(), 1200, 'MAX') : Promise.resolve(false),
      withTimeout(checkTelegramConnectivity(), 1200, 'Telegram'),
    ]);
    if (maxResult.status === 'fulfilled') maxOk = Boolean(maxResult.value);
    else lastError = maxResult.reason?.message || 'MAX: ошибка проверки';
    if (tgResult.status === 'fulfilled') tgOk = true;
    else if (!lastError) lastError = tgResult.reason?.message || 'Telegram: ошибка проверки';
    const db = getDatabase();
    const autoUpdate = getAutoUpdate();
    const queue = outbox.listJobs();
    const delivered = outbox.listDelivered ? outbox.listDelivered() : [];
    const lastDelivered = delivered.length
      ? new Date(Math.max(...delivered.map((item) => Number(item.at || 0)))).toLocaleString('ru-RU')
      : 'нет данных';
    const uptimeSec = Math.floor(process.uptime());
    const uptime = uptimeSec >= 86400
      ? `${Math.floor(uptimeSec / 86400)}д ${Math.floor((uptimeSec % 86400) / 3600)}ч`
      : uptimeSec >= 3600
        ? `${Math.floor(uptimeSec / 3600)}ч ${Math.floor((uptimeSec % 3600) / 60)}м`
        : `${Math.floor(uptimeSec / 60)}м ${uptimeSec % 60}с`;
    const latency = store.getPath(['runtime', 'deliveryLatency']) || {};
    const latencyAvg = Number(latency.count || 0) ? Number(latency.sum || 0) / Number(latency.count) : null;
    const latencyText = (v) => v == null ? 'нет данных' : `${Math.round(v)} мс`;
    const diagnostic = [
      '<b>Диагностика</b>',
      '',
      `MAX: ${maxOk ? '✅ авторизован' : '❌ не авторизован'}`,
      `Telegram API: ${tgOk ? '✅ доступен' : '❌ недоступен'}`,
      `Очередь сообщений: <code>${queue.length}</code>`,
      `Задержка MIN/AVG/MAX: <code>${latencyText(latency.min)} / ${latencyText(latencyAvg)} / ${latencyText(latency.max)}</code>`,
      `Последняя успешная пересылка: <code>${escapeHtml(lastDelivered)}</code>`,
      `Последняя ошибка: ${lastError ? `<code>${escapeHtml(lastError)}</code>` : 'нет'}`,
      `Uptime: <code>${uptime}</code>`,
      `Версия: <code>${escapeHtml(formatAppVersion(require('../package.json').version))}</code>`,
      `База данных: <code>${escapeHtml(String(db.driver || 'sqlite').toUpperCase())}</code>`,
      `Автообновление: ${autoUpdate.enabled !== false ? '✅ включено' : '❌ выключено'}`,
      '',
      await buildStatusText(),
    ].join('\n');
    await sendMessage(chatId, diagnostic);
    return;
  }

  if (/^\/(stop|pause)$/i.test(text)) {
    if (!stopHandler) {
      await sendMessage(chatId, MONITORING.stopUnavailable);
      return;
    }
    stopHandler();
    await sendMessage(
      chatId,
        buildEventMessage({ ...MONITORING.stopped, status: 'done' }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (/^\/(resume|run)$/i.test(text)) {
    if (!startHandler) {
      await sendMessage(chatId, MONITORING.startUnavailable);
      return;
    }
    startHandler();
    await sendMessage(
      chatId,
        buildEventMessage({ ...MONITORING.started, status: 'done' }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (/^\/reauth$/i.test(text)) {
    if (!reauthHandler) {
      await sendMessage(
        chatId,
        ERRORS.reinstall
      );
      return;
    }

    if (!(await ensureCanStartReauth(chatId))) {
      return;
    }

    await sendMessage(
      chatId,
      buildEventMessage({ ...AUTH.chooseMode, status: 'wait', step: 1, total: 5 }),
      { reply_markup: buildAuthModeKeyboard() }
    );
    return;
  }

  if (/^\/site$/i.test(text)) {
    const { getSiteUrls } = require('./site-portal');
    const urls = getSiteUrls();
    const primary = urls.find((u) => !u.includes('127.0.0.1')) || urls[0];
    await sendMessage(
      chatId,
      [
        '<b>MAX в браузере</b>',
        '',
        primary.startsWith('https://')
          ? 'Временный HTTPS: браузер может предупредить о сертификате — продолжите вручную.'
          : null,
        'Откройте ссылку и войдите по <b>номеру телефона</b> или <b>QR-коду</b>.',
        'Если SMS не приходит — на странице нажмите «Войти по QR».',
        'После входа нажмите <b>«Сохранить сессию в бот»</b> на странице.',
        '',
        `<a href="${primary}">${primary}</a>`,
        `<code>${primary}</code>`,
      ].join('\n'),
      { disable_web_page_preview: false }
    );
    return;
  }

  if (/^\/help$/i.test(text)) {
    await sendMessage(chatId, START.help, {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (/^\/set\b/i.test(text)) {
    const result = parseSetCommand(text);
    if (result?.error) {
      await sendMessage(chatId, result.error);
      return;
    }
    if (result?.prompt && result.key === 'browserpassword') {
      waitingInput.set(String(chatId), 'browserPassword');
      await sendInputPrompt(chatId, buildBrowserPasswordPromptMessage());
      return;
    }
    if (result?.ok && result.key === 'browserpassword') {
      await sendBrowserPasswordSetResponse(chatId, result);
      return;
    }
    if (result?.ok) {
      await sendMessage(
        chatId,
        buildEventMessage({
          title: SAVED.setting(result.key, result.value).title,
          status: 'done',
          lines: [
            `<code>${result.key}</code> = <code>${result.value}</code>`,
            '',
            buildStatusText(),
          ],
        }),
        { reply_markup: buildMenuKeyboard() }
      );
      return;
    }
  }
}

async function handleManualUpdateCheck(chatId) {
  const { checkForUpdates, rememberUpdateNotices, pruneUpdateNotices } = require('./auto-update');

  const track = (sent, kind) => {
    const messageId = sent?.ok ? sent.result?.message_id : null;
    if (!messageId) return [];
    const posts = [{ chatId, messageId }];
    rememberUpdateNotices(posts, kind);
    return posts;
  };

  try {
    const preview = await checkForUpdates({ notify: false, performUpdate: false });

    if (preview.status === 'up-to-date') {
      const sent = await sendMessage(
        chatId,
        buildEventMessage({ ...UPDATES.none(preview.version), status: 'done' })
      );
      const posts = track(sent, 'none');
      await pruneUpdateNotices({ keep: posts, kinds: ['none'], chatId });
      return;
    }

    if (preview.status === 'available') {
      const sent = await sendMessage(
        chatId,
        buildEventMessage({
          ...UPDATES.updating(preview.fromVersion),
          status: 'progress',
        })
      );
      const progressPosts = track(sent, 'progress');
      const result = await checkForUpdates({
        notify: false,
        performUpdate: true,
        progressPosts,
      });
      if (result.status === 'updated') {
        if (result.doneSent) return;
        const outbox = require('./tg-outbox');
        if (outbox.getJob(`update-done:${result.fromVersion || ''}:${result.toVersion || ''}`)) return;
        if (result.fromVersion && result.toVersion && result.fromVersion !== result.toVersion) {
          const doneText = buildEventMessage({
            ...UPDATES.done(result.fromVersion, result.toVersion),
            status: 'done',
          });
          const fallback = await sendMessage(chatId, doneText);
          track(fallback, 'done');
        }
        return;
      }
      if (result.status === 'error') {
        const failText = buildEventMessage({ ...UPDATES.fail(result.message), status: 'fail' });
        const fallback = await sendMessage(chatId, failText);
        track(fallback, 'fail');
      }
      return;
    }

    if (preview.status === 'skipped') {
      const sent = await sendMessage(chatId, buildEventMessage({ ...UPDATES.skipped, status: 'fail' }));
      track(sent, 'fail');
      return;
    }

    if (preview.status === 'unavailable') {
      const sent = await sendMessage(
        chatId,
        buildEventMessage({ ...UPDATES.unavailable, status: 'info' })
      );
      track(sent, 'notice');
      return;
    }

    if (preview.status === 'error') {
      const sent = await sendMessage(
        chatId,
        buildEventMessage({ ...UPDATES.fail(preview.message), status: 'fail' })
      );
      track(sent, 'fail');
    }
  } catch (err) {
    const sent = await sendMessage(
      chatId,
      buildEventMessage({ ...UPDATES.fail(err.message), status: 'fail' })
    );
    track(sent, 'fail');
  }
}

async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const data = query.data || '';
  if (!chatId || !isAdmin(chatId, userId)) {
    if (chatId && canUseMaxReply(chatId, userId) && data.startsWith('reply:')) {
      await handleReplyCallback(query);
      return;
    }
    await rejectUnauthorized(query.message?.chat, userId, { callbackId: query.id });
    return;
  }

  if (data === 'action:webPanel') { await answerCallback(query.id,'Веб-панель'); const c=getWebAccess(); if(!c.domain){waitingInput.set(String(chatId),'webPanel:domain');if(Array.isArray(query.message.photo)&&query.message.photo.length)await deleteMessage(chatId,query.message.message_id).catch(()=>{});await sendInputPrompt(chatId,webPanelText());}else if(Array.isArray(query.message.photo)&&query.message.photo.length){await deleteMessage(chatId,query.message.message_id).catch(()=>{});await showWebPanel(chatId)}else await showWebPanel(chatId,query.message.message_id); return; }
  if (data === 'action:webPanelToggle') { const c=getWebAccess();setWebEnabled(c.enabled===false);await answerCallback(query.id,c.enabled===false?'Сайт включён':'Сайт отключён');await showWebPanel(chatId,query.message.message_id);return; }

  if (data === 'action:webPanelResetLogin') { resetWebLogin(); await answerCallback(query.id,'Данные входа изменены'); await showWebPanel(chatId,query.message.message_id); return; }
  if (data === 'action:webPanelSettings') { const c=getWebAccess(); await answerCallback(query.id,'Настройки'); await editMessageText(chatId,query.message.message_id,['<b>Настройки веб-панели</b>','','Домен: <code>'+escapeHtml(c.domain||'не задан')+'</code>','Сайт: '+(c.enabled!==false?'✅ включён':'❌ выключен'),'SSL: '+(c.tlsVerifiedAt?'✅ подтверждён':'⚠️ не подтверждён'),'Внутренний порт: <code>'+escapeHtml(c.port||'авто')+'</code>','','Сертификат и приватный ключ хранятся системно в /etc/letsencrypt и не записываются в config.json.'].join('\n'),{reply_markup:webPanelKeyboard()}); return; }
  if (data === 'action:webPanelResetProfile') { resetWebProfile(); waitingInput.set(String(chatId),'webPanel:domain'); await answerCallback(query.id,'Профиль панели сброшен'); await editMessageText(chatId,query.message.message_id,webPanelText(),{reply_markup:{inline_keyboard:[[{text:BUTTONS.backToMenu,callback_data:'discover:menu'}]]}}); return; }

  if (data === 'auth:switch:qr') {
    if (authInputWaiter?.onSwitch) {
      await answerCallback(query.id, 'Переключаю на QR');
      const waiter = authInputWaiter;
      clearAuthInputWaiter();
      if (query.message?.message_id) {
        await deleteMessageQuiet(chatId, query.message.message_id);
      }
      waiter.onSwitch();
      return;
    }
    await answerCallback(query.id, 'Сейчас нельзя');
    return;
  }

  if (data === 'auth:mode:qr' || data === 'auth:mode:phone') {
    if (!reauthHandler) {
      await answerCallback(query.id, 'Недоступно');
      await sendMessage(
        chatId,
        ERRORS.reinstall
      );
      return;
    }

    if (isAuthBusyCheck() || isAuthSessionActive()) {
      await answerCallback(query.id, AUTH.alreadyAuth);
      return;
    }

    const mode = data === 'auth:mode:phone' ? 'phone' : 'qr';
    await answerCallback(query.id, mode === 'phone' ? 'Вход по номеру' : 'Вход по QR');

    if (!(await ensureCanStartReauth(chatId))) {
      return;
    }

    if (mode === 'phone') {
      await sendMessage(chatId, buildPhoneAuthWarningMessage());
    }

    void reauthHandler({ mode })
      .then(async (result) => {
        if (result?.alreadyActive) {
          await sendMessage(chatId, buildActiveSessionMessage());
          return;
        }
        await sendMessage(
          chatId,
          buildEventMessage({ ...AUTH.loginDoneReauth, status: 'done' }),
        );
      })
      .catch(async (err) => {
        await sendMessage(
          chatId,
          buildEventMessage({ ...AUTH.loginFail(err.message), status: 'fail' }),
        );
      });
    return;
  }

  if (data === 'auth:refresh') {
    await answerCallback(query.id, 'Обновляю…');
    if (!isAuthSessionActive()) {
      await sendMessage(chatId, AUTH.refreshNoAuth);
      return;
    }

    try {
      await refreshAuthScreenshot();
    } catch (err) {
      await sendMessage(chatId, escapeHtml(err.message));
    }
    return;
  }

  if (data.startsWith('reply:')) {
    await handleReplyCallback(query);
    return;
  }

  if (data === 'action:stopMax') {
    await answerCallback(query.id, 'Бот остановлен');
    if (!stopHandler) {
      await sendMessage(chatId, MONITORING.stopUnavailable);
      return;
    }
    stopHandler();
    await sendMessage(
      chatId,
      buildEventMessage({
        title: MONITORING.stopped.title,
        status: 'done',
        lines: MONITORING.stopped.lines,
      }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (data === 'action:startMax') {
    await answerCallback(query.id, 'Бот запущен');
    if (!startHandler) {
      await sendMessage(chatId, MONITORING.startUnavailable);
      return;
    }
    startHandler();
    await sendMessage(
      chatId,
        buildEventMessage({ ...MONITORING.started, status: 'done' }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (data === 'action:checkUpdate') {
    await answerCallback(query.id, 'Проверяю…');
    void handleManualUpdateCheck(chatId);
    return;
  }

  if (data === 'action:about') {
    await answerCallback(query.id, 'О сервисе');
    const aboutText = `${START.about}\n\n<b>Нагрузка сервера</b>\n<code>${escapeHtml(serverLoadText())}</code>`;
    const image = getMenuImageBuffer();

    if (image) {
      const hasPhoto = Array.isArray(query.message.photo) && query.message.photo.length > 0;
      if (hasPhoto) {
        const result = await editPhotoBuffer(
          chatId,
          query.message.message_id,
          image,
          aboutText,
          undefined,
          { reply_markup: buildAboutKeyboard() }
        );
        if (result?.ok) return;
      }

      await deleteMessage(chatId, query.message.message_id).catch(() => {});
      const sent = await sendPhotoBuffer(chatId, image, aboutText, undefined, {
        reply_markup: buildAboutKeyboard(),
      });
      if (sent?.ok) return;
    }

    await replaceMenuPhotoWithText(query, aboutText, {
      reply_markup: buildAboutKeyboard(),
    }).catch(() => {});
    return;
  }

  if (data === 'action:logs') {
    await answerCallback(query.id, 'Готовлю логи…');
    try {
      const home = os.homedir();
      const logCandidates = [
        path.join(getSettings().dataDir, 'logs.txt'),
        path.resolve(process.cwd(), 'logs.txt'),
        path.join(home, '.pm2', 'logs', 'max-tg-out.log'),
        path.join(home, '.pm2', 'logs', 'max-tg-error.log'),
        path.join(home, '.pm2', 'logs', 'max-tg-update-out.log'),
        path.join(home, '.pm2', 'logs', 'max-tg-update-error.log'),
        path.resolve(process.cwd(), 'bot.log'),
        path.resolve(process.cwd(), 'logs', 'max-tg.log'),
      ];
      const existing = [...new Set(logCandidates)]
        .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
      let body = existing.map((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return `===== ${path.basename(file)} =====\n${text.slice(-1_000_000)}`;
      }).join('\n\n');
      if (!body.trim()) {
        body = [
          'MAX bot log snapshot',
          `Время: ${new Date().toISOString()}`,
          `PID: ${process.pid}`,
          `Uptime: ${formatServerUptime(process.uptime())}`,
          'Логи PM2 пока пусты.',
        ].join('\n');
      }
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('document', new File([Buffer.from(body.slice(-4_000_000), 'utf8')], 'logs.txt', { type: 'text/plain' }));
      const { token } = getTelegram();
      const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
      const result = await response.json();
      if (!result.ok) throw new Error(result.description || 'Telegram не принял файл');
    } catch (err) {
      await sendMessage(chatId, `Не удалось получить логи: <code>${escapeHtml(err.message)}</code>`);
    }
    return;
  }

  if (data === 'action:profileBio') {
    await answerCallback(query.id, 'Смена описания');
    await replaceMenuPhotoWithText(query, buildProfileBioText(), {
      reply_markup: buildProfileBioKeyboard(),
    }).catch(() => {});
    return;
  }

  if (data === 'action:profileBioCity') {
    waitingInput.set(String(chatId), 'profileBioCity');
    await answerCallback(query.id, 'Жду город');
    await sendInputPrompt(chatId, PROFILE_BIO_CITY_HINT);
    return;
  }

  if (data === 'action:profileBioTemplate') {
    waitingInput.set(String(chatId), 'profileBioTemplate');
    await answerCallback(query.id, 'Жду шаблон');
    await sendInputPrompt(chatId, buildBioTemplatePromptText(), {
      reply_markup: buildBioTemplateKeyboard(),
    });
    return;
  }

  if (data === 'bioevent:noop') {
    await answerCallback(query.id);
    return;
  }

  if (data === 'bioevent:open' || data === 'bioevent:back' || data.startsWith('bioevent:')) {
    waitingInput.set(String(chatId), 'profileBioTemplate');
    const messageId = query.message?.message_id;

    if (data === 'bioevent:back') {
      await answerCallback(query.id, 'Шаблон');
      await editMessageText(chatId, messageId, buildBioTemplatePromptText(), {
        reply_markup: buildBioTemplateKeyboard(),
      }).catch(() => {});
      return;
    }

    if (data === 'bioevent:clear') {
      saveProfileBioEventDate('');
      await answerCallback(query.id, 'Дата сброшена');
      await editMessageText(chatId, messageId, buildBioTemplatePromptText(), {
        reply_markup: buildBioTemplateKeyboard(),
      }).catch(() => {});
      return;
    }

    if (data.startsWith('bioevent:set:')) {
      const iso = data.slice('bioevent:set:'.length);
      saveProfileBioEventDate(iso);
      await answerCallback(query.id, 'Дата сохранена');
      await editMessageText(chatId, messageId, buildBioTemplatePromptText(), {
        reply_markup: buildBioTemplateKeyboard(),
      }).catch(() => {});
      return;
    }

    let year;
    let month;
    if (data.startsWith('bioevent:nav:')) {
      const parsed = parseYearMonth(data.slice('bioevent:nav:'.length));
      year = parsed?.year;
      month = parsed?.month;
    }
    if (!year || !month) {
      const current = getProfileBio().eventDate || '';
      const now = new Date();
      if (current) {
        const [y, m] = current.split('-');
        year = Number(y) || now.getFullYear();
        month = Number(m) || now.getMonth() + 1;
      } else {
        year = now.getFullYear();
        month = now.getMonth() + 1;
      }
    }

    await answerCallback(query.id, 'Календарь');
    await editMessageText(chatId, messageId, eventCalendarTitle(year, month), {
      reply_markup: buildEventCalendarKeyboard(year, month, getProfileBio().eventDate),
    }).catch(() => {});
    return;
  }

  if (data === 'action:notifyChat') {
    await answerCallback(query.id, 'Чат уведомлений');
    await showNotifyChats(chatId, query.message.message_id);
    return;
  }

  if (data.startsWith('notify:chat:')) {
    const targetId = data.slice('notify:chat:'.length);
    if (isPrivateChatId(targetId)) {
      await answerCallback(query.id, 'Настройки');
      await showBoundUserSettings(chatId, query.message.message_id, targetId, 'action:notifyChat');
      return;
    }
    await refreshTelegramChat(targetId);
    const status = await getBotAdminStatus(targetId);
    await answerCallback(query.id, 'Группа');
    await editMessageText(
      chatId,
      query.message.message_id,
      buildNotifyGroupViewText(targetId, status),
      { reply_markup: await buildNotifyGroupViewKeyboard(targetId, status) }
    );
    return;
  }

  if (data.startsWith('notify:reply:')) {
    const targetId = data.slice('notify:reply:'.length);
    if (!isPrivateChatId(targetId)) {
      await answerCallback(query.id, 'Только для пользователя');
      return;
    }
    const result = toggleNotifyUserCanReply(targetId);
    if (result.error) {
      await answerCallback(query.id, result.error);
      return;
    }
    await answerCallback(query.id, result.enabled ? 'Ответы включены' : 'Ответы выключены');
    const backData = userSettingsContext.get(String(chatId))?.backData || 'action:notifyChat';
    await showBoundUserSettings(chatId, query.message.message_id, targetId, backData);
    return;
  }

  if (data.startsWith('notify:remove:')) {
    const targetId = data.slice('notify:remove:'.length);
    const result = unbindNotificationChat(targetId);
    if (result.error) {
      await answerCallback(query.id, result.error);
      return;
    }
    await answerCallback(query.id, isPrivateChatId(targetId) ? 'Пользователь убран' : 'Группа удалена из рассылки');
    const ctx = userSettingsContext.get(String(chatId));
    if (ctx?.userId === String(targetId) && ctx.backData && ctx.backData !== 'action:notifyChat') {
      userSettingsContext.delete(String(chatId));
      await goUserSettingsBack(chatId, query.message.message_id, ctx.backData);
      return;
    }
    userSettingsContext.delete(String(chatId));
    await showNotifyChats(chatId, query.message.message_id);
    return;
  }

  if (data === 'notify:bindGroup') {
    await answerCallback(query.id, 'Выбор группы');
    await sendMessage(chatId, CHATS.bindGroupPrompt, {
      reply_markup: buildBindGroupReplyKeyboard(),
    });
    return;
  }

  if (data === 'notify:bindUser') {
    await answerCallback(query.id, 'Пользователь');
    await beginBindUser(chatId, { mode: 'notify' });
    return;
  }

  if (data === 'notify:dmOnly') {
    const { chatIds: boundChatIds } = setDmOnlyNotifications(chatId);
    await answerCallback(query.id, 'Только ЛС');
    const statuses = await refreshNotificationChatStatuses();
    await editMessageText(
      chatId,
      query.message.message_id,
      buildEventMessage({
        title: 'Режим уведомлений',
        status: 'done',
        lines: [
          CHATS.notifyDmMode,
          `Личные сообщения: <code>${boundChatIds[0]}</code>`,
          '',
          buildNotifyChatText(statuses),
        ],
      }),
      { reply_markup: await buildNotifyChatKeyboard(statuses) }
    );
    return;
  }

  if (data === 'maxchat:toggleAll') {
    const next = !isMonitorAllChatsEnabled();
    setMonitorAllChatsEnabled(next);
    await answerCallback(query.id, next ? 'Все чаты MAX' : 'Только список');
    await showMaxChats(chatId, query.message.message_id);
    return;
  }

  if (data === 'maxchat:togglePersonal') {
    const next = !isMonitorPersonalChatsEnabled();
    setMonitorPersonalChatsEnabled(next);
    await answerCallback(query.id, next ? 'Личные сообщения MAX' : 'Личные выкл');
    await showMaxChats(chatId, query.message.message_id);
    return;
  }

  if (data === 'maxchat:list') {
    if (Array.isArray(query.message.photo) && query.message.photo.length) {
      await deleteMessage(chatId, query.message.message_id).catch(() => {});
      await answerCallback(query.id, 'Чаты MAX');
      await showMaxChats(chatId);
      return;
    }
    await answerCallback(query.id, 'Чаты MAX');
    await showMaxChats(chatId, query.message.message_id);
    return;
  }

  if (data === 'maxchat:add') {
    waitingInput.set(String(chatId), 'maxchat:add');
    await answerCallback(query.id);
    await sendInputPrompt(chatId, CHATS.addPickerWait);
    void beginMaxChatAdd(chatId);
    return;
  }

  if (data === 'maxchat:canceladd') {
    waitingInput.delete(String(chatId));
    await answerCallback(query.id, 'Отменено');
    await clearMaxChatAddPrompt(chatId, query.message?.message_id);
    await sendMessage(chatId, buildMaxChatsText(), { reply_markup: buildMaxChatsKeyboard() });
    return;
  }

  if (data === 'maxchat:noop') {
    await answerCallback(query.id);
    return;
  }

  if (data.startsWith('maxchat:pickpage:')) {
    const page = Number.parseInt(data.slice('maxchat:pickpage:'.length), 10) || 0;
    const key = String(chatId);
    const cache = maxChatAddCache.get(key);
    if (!cache?.chats?.length) {
      await answerCallback(query.id, 'Список устарел');
      return;
    }
    maxChatAddCache.set(key, {
      ...cache,
      pickPage: page,
      pickMessageId: query.message?.message_id || cache.pickMessageId,
    });
    await answerCallback(query.id, `Страница ${page + 1}`);
    await restoreMaxChatPickPrompt(chatId);
    return;
  }

  if (data.startsWith('maxchat:p:')) {
    const id = data.slice('maxchat:p:'.length);
    const key = String(chatId);
    if (!/^-?\d{5,}$/.test(id)) {
      await answerCallback(query.id, 'Чат не найден, откройте список заново');
      return;
    }

    const url = `https://web.max.ru/${id}`;
    const cache = maxChatAddCache.get(key);
    const fromCache = cache?.chats?.find((item) => chatIdFromUrl(item.url) === id);
    const listed = String(fromCache?.title || '').trim();
    const title =
      listed && !/^https:\/\/web\.max\.ru\//i.test(listed) ? listed : chatLabelFromUrl(url);
    const chat = {
      url,
      title,
      kind: fromCache?.kind,
    };

    waitingInput.set(key, 'maxchat:add');
    if (cache) {
      maxChatAddCache.set(key, {
        ...cache,
        pickMessageId: query.message?.message_id || cache.pickMessageId,
      });
    }
    try {
      await answerCallback(query.id, chat.title || url);
    } catch (err) {
      console.warn('maxchat pick answer:', err.message);
    }
    void handleMaxChatPick(chatId, chat).catch(async (err) => {
      console.warn('maxchat pick:', err.message);
      await sendMessage(chatId, CHATS.addPickerFail(escapeHtml(err.message))).catch(() => {});
    });
    return;
  }

  if (data.startsWith('maxchat:pick:')) {
    const index = Number.parseInt(data.slice('maxchat:pick:'.length), 10);
    const key = String(chatId);
    const cache = maxChatAddCache.get(key);
    const chat = cache?.chats?.[index];
    if (!chat) {
      await answerCallback(query.id, 'Чат не найден, откройте список заново');
      return;
    }

    waitingInput.set(key, 'maxchat:add');
    maxChatAddCache.set(key, {
      ...cache,
      pickMessageId: query.message?.message_id || cache.pickMessageId,
    });
    try {
      await answerCallback(query.id, chat.title || 'Выбрано');
    } catch (err) {
      console.warn('maxchat pick answer:', err.message);
    }
    void handleMaxChatPick(chatId, chat).catch(async (err) => {
      console.warn('maxchat pick:', err.message);
      await sendMessage(chatId, CHATS.addPickerFail(escapeHtml(err.message))).catch(() => {});
    });
    return;
  }

  if (data === 'maxchat:pickback') {
    waitingInput.set(String(chatId), 'maxchat:add');
    await answerCallback(query.id, 'Выберите чат');
    await restoreMaxChatPickPrompt(chatId);
    return;
  }

  if (data === 'maxchat:adduser') {
    await answerCallback(query.id, 'Пользователь');
    await beginBindUser(chatId, { mode: 'where' });
    return;
  }

  if (data.startsWith('maxchat:adduser:')) {
    const parts = data.split(':');
    const index = Number.parseInt(parts[2], 10) || 0;
    const destPage = Number.parseInt(parts[3], 10) || 0;
    await answerCallback(query.id, 'Пользователь');
    await beginBindUser(chatId, { mode: 'view', index, destPage });
    return;
  }

  if (data.startsWith('maxchat:userset:')) {
    const rest = data.slice('maxchat:userset:'.length);
    const parts = rest.split(':');
    const index = Number.parseInt(parts[0], 10) || 0;
    const destPage = Number.parseInt(parts[1], 10) || 0;
    const targetId = parts.slice(2).join(':');
    if (!isPrivateChatId(targetId)) {
      await answerCallback(query.id, 'Только для пользователя');
      return;
    }
    await answerCallback(query.id, 'Настройки');
    await showBoundUserSettings(
      chatId,
      query.message.message_id,
      targetId,
      `maxchat:destpage:${index}:${destPage}`
    );
    return;
  }

  if (data.startsWith('maxchat:adduserset:')) {
    const rest = data.slice('maxchat:adduserset:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0) {
      await answerCallback(query.id, 'Ошибка');
      return;
    }
    const destPage = Number.parseInt(rest.slice(0, colon), 10) || 0;
    const targetId = rest.slice(colon + 1);
    if (!isPrivateChatId(targetId)) {
      await answerCallback(query.id, 'Только для пользователя');
      return;
    }
    await answerCallback(query.id, 'Настройки');
    await showBoundUserSettings(
      chatId,
      query.message.message_id,
      targetId,
      `maxchat:adddestpage:${destPage}`
    );
    return;
  }

  if (data.startsWith('maxchat:adddestpage:')) {
    const page = Number.parseInt(data.slice('maxchat:adddestpage:'.length), 10) || 0;
    const cache = maxChatAddCache.get(String(chatId));
    if (!cache?.pending?.url) {
      await answerCallback(query.id, 'Сначала выберите чат');
      return;
    }
    await answerCallback(query.id);
    await showMaxChatWherePrompt(chatId, { ...cache.pending, destPage: page });
    return;
  }

  if (data.startsWith('maxchat:adddest:')) {
    const rest = data.slice('maxchat:adddest:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0) {
      await answerCallback(query.id, 'Ошибка');
      return;
    }
    const page = Number.parseInt(rest.slice(0, colon), 10) || 0;
    const destId = rest.slice(colon + 1);
    const cache = maxChatAddCache.get(String(chatId));
    if (!cache?.pending?.url) {
      await answerCallback(query.id, 'Сначала выберите чат');
      return;
    }
    const bound = getNotificationChatIds().map(String);
    if (!destId || !bound.includes(destId)) {
      await answerCallback(query.id, 'Чат Telegram не найден');
      return;
    }
    const current = new Set((cache.pending.destIds || getDefaultNotifyChatIds()).map(String));
    if (current.has(destId)) current.delete(destId);
    else current.add(destId);
    const destIds = bound.filter((id) => current.has(id));
    await answerCallback(query.id, current.has(destId) ? 'Добавлено' : 'Убрано');
    await showMaxChatWherePrompt(chatId, { ...cache.pending, destIds, destPage: page });
    return;
  }

  if (data.startsWith('maxchat:addwhere:')) {
    const target = data.slice('maxchat:addwhere:'.length);
    if (target === 'done') {
      const cache = maxChatAddCache.get(String(chatId));
      const destIds = cache?.pending?.destIds;
      const result = await finishMaxChatAddWithTarget(chatId, {
        destIds: destIds?.length ? destIds : getDefaultNotifyChatIds(),
      });
      if (result.error) {
        await answerCallback(query.id, result.error);
        return;
      }
      await answerCallback(query.id, 'Сохранено');
      return;
    }
    if (!['dm', 'group', 'both'].includes(target)) {
      await answerCallback(query.id, 'Ошибка');
      return;
    }
    const labels = {
      dm: 'Только в ЛС',
      group: 'Только в группу',
      both: 'В ЛС и группу',
    };
    const result = await finishMaxChatAddWithTarget(chatId, target);
    if (result.error) {
      await answerCallback(query.id, result.error);
      return;
    }
    await answerCallback(query.id, labels[target] || 'Сохранено');
    return;
  }

  if (data.startsWith('maxchat:destpage:')) {
    const parts = data.split(':');
    const index = Number.parseInt(parts[2], 10) || 0;
    const page = Number.parseInt(parts[3], 10) || 0;
    await answerCallback(query.id);
    await showMaxChatView(chatId, query.message.message_id, index, page);
    return;
  }

  if (data.startsWith('maxchat:dest:')) {
    const parts = data.split(':');
    const index = Number.parseInt(parts[2], 10) || 0;
    const page = Number.parseInt(parts[3], 10) || 0;
    const destId = parts.slice(4).join(':');
    const urls = getMonitorChatUrls();
    const url = urls[index];
    if (!url) {
      await answerCallback(query.id, 'Чат не найден');
      return;
    }
    const result = toggleNotifyChatId(url, destId);
    if (result.error) {
      await answerCallback(query.id, result.error);
      return;
    }
    const on = (result.ids || []).map(String).includes(String(destId));
    await answerCallback(query.id, on ? 'Добавлено' : 'Убрано');
    await refreshMaxChatPanel(chatId, query, index, page);
    return;
  }

  if (data.startsWith('maxchat:deleteMode:')) {
    const index = Number.parseInt(data.slice('maxchat:deleteMode:'.length), 10) || 0;
    const url = getMonitorChatUrls()[index];
    if (!url) { await answerCallback(query.id, 'Чат не найден'); return; }
    const modes = ['delete', 'mark', 'keep'];
    const current = getDeleteSyncMode(url);
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    setDeleteSyncMode(url, next);
    await answerCallback(query.id, { delete: 'Удалять', mark: 'Помечать', keep: 'Оставлять' }[next]);
    await showMaxChatView(chatId, query.message.message_id, index);
    return;
  }

  if (data.startsWith('maxchat:export:')) {
    const index = Number.parseInt(data.slice('maxchat:export:'.length), 10) || 0;
    const url = getMonitorChatUrls()[index];
    if (!url) { await answerCallback(query.id, 'Чат не найден'); return; }
    await answerCallback(query.id, 'Готовлю HTML…');
    try {
      const title = chatLabelFromUrl(url);
      const exported = await buildChatExport(url, title);
      const exportTitle = exported.title || title;
      const safeName = exportTitle.replace(/[^a-zа-яё0-9_-]+/gi, '_').slice(0, 60) || 'max-chat';
      await sendHtmlDocument(chatId, exported.html, `${safeName}.html`, `MAX · ${exportTitle} · ${exported.count} сообщений`);
    } catch (err) {
      await sendMessage(chatId, `Не удалось скачать чат: <code>${escapeHtml(err.message)}</code>`);
    }
    return;
  }

  if (data.startsWith('maxchat:view:')) {
    const index = Number.parseInt(data.slice('maxchat:view:'.length), 10) || 0;
    await answerCallback(query.id, 'Чат MAX');
    await showMaxChatView(chatId, query.message.message_id, index);
    return;
  }

  if (data.startsWith('maxchat:forward:') || data.startsWith('maxchat:toggleRequired:')) {
    const index =
      Number.parseInt(data.replace(/^maxchat:(?:forward|toggleRequired):/, ''), 10) || 0;
    const urls = getMonitorChatUrls();
    const url = urls[index];
    if (!url) {
      await answerCallback(query.id, 'Чат не найден');
      return;
    }

    const next = !isChatForwardEnabled(url);
    setChatForwardEnabled(url, next);
    await answerCallback(query.id, next ? 'Пересылка включена' : 'Пересылка выключена');
    await refreshMaxChatPanel(chatId, query, index);
    return;
  }

  if (data.startsWith('maxchat:where:')) {
    const parts = data.split(':');
    const index = Number.parseInt(parts[2], 10) || 0;
    const target = parts[3];
    const urls = getMonitorChatUrls();
    const url = urls[index];
    if (!url) {
      await answerCallback(query.id, 'Чат не найден');
      return;
    }

    const result = target ? setNotifyTarget(url, target) : cycleNotifyTarget(url);
    if (result.error) {
      await answerCallback(query.id, 'Ошибка');
      return;
    }
    const bound = getNotificationChatIds();
    const ids =
      result.target === 'dm'
        ? bound.filter(isPrivateChatId)
        : result.target === 'group'
          ? bound.filter((id) => !isPrivateChatId(id))
          : bound;
    setNotifyChatIds(url, ids);

    const labels = {
      dm: 'Только в ЛС',
      group: 'Только в группу',
      both: 'В ЛС и группу',
    };
    await answerCallback(query.id, labels[result.target] || 'Сохранено');
    await refreshMaxChatPanel(chatId, query, index);
    return;
  }

  if (data.startsWith('maxchat:remove:')) {
    const index = Number.parseInt(data.slice('maxchat:remove:'.length), 10) || 0;
    const urls = getMonitorChatUrls();
    const url = urls[index];
    if (!url) {
      await answerCallback(query.id, 'Чат не найден');
      return;
    }

    const result = removeMonitorChatUrl(url);
    if (result.error) {
      await answerCallback(query.id, 'Ошибка');
      await sendMessage(chatId, result.error);
      return;
    }

    await answerCallback(query.id, 'Удалено');
    await showMaxChats(chatId, query.message.message_id);
    return;
  }

  if (data === 'discover:menu') {
    await answerCallback(query.id, 'Меню');
    await deleteMessage(chatId, query.message.message_id).catch(() => {});
    await sendMainMenu(chatId);
    return;
  }

  if (data === 'discover:noop') {
    await answerCallback(query.id);
    return;
  }

  if (data.startsWith('discover:page:')) {
    const page = Number.parseInt(data.slice('discover:page:'.length), 10) || 0;
    await answerCallback(query.id, 'Список чатов');
    await showDiscoverChats(chatId, query.message.message_id, page);
    return;
  }

  if (data.startsWith('chatinfo:')) {
    const targetChatId = data.slice('chatinfo:'.length);
    await answerCallback(query.id, 'Информация о чате');
    await showChatInfo(chatId, query.message.message_id, targetChatId);
    return;
  }

  if (data.startsWith('bindchat:')) {
    const targetChatId = data.slice('bindchat:'.length);
    const { chatIds: boundChatIds } = bindNotificationChat(targetChatId, chatId);
    await refreshTelegramChat(targetChatId);
    const known = getKnownChat(targetChatId);
    const statuses = await refreshNotificationChatStatuses();
    await answerCallback(query.id, 'Привязано');
    await sendMessage(
      chatId,
      buildEventMessage({
        title: CHATS.bound.title,
        status: 'done',
        lines: [
          known?.title ? `Название: <b>${escapeHtml(known.title)}</b>` : null,
          `ID: <code>${targetChatId}</code>`,
          boundChatIds.length > 1
            ? CHATS.bound.lines(true)[0]
            : CHATS.bound.lines(false)[0],
          '',
          buildNotifyChatText(statuses),
        ].filter(Boolean),
      }),
      { reply_markup: await buildNotifyChatKeyboard(statuses) }
    );
    await sendMissingAdminNotice(chatId, targetChatId);
    return;
    await answerCallback(query.id, 'Обновлено');
    await editMessageText(chatId, query.message.message_id, buildStatusText(), {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (data.startsWith('toggle:')) {
    const path = data.slice('toggle:'.length).split('.');
    if (path[0] === 'autoUpdate') {
      await answerCallback(query.id, 'Автообновление всегда включено');
      return;
    }
    if (path.join('.') === 'max.forwardingEnabled') {
      const next = store.getPath(path) === false;
      store.setPath(path, next);
      await answerCallback(query.id, next ? 'Сообщения идут в Telegram' : 'Сообщения в Telegram не отправляются');
      await editMessageText(chatId, query.message.message_id, 'Панель управления ботом:', {
        reply_markup: buildMenuKeyboard(),
      });
      return;
    }
    const next = store.togglePath(path);
    await answerCallback(query.id, next ? 'Включено' : 'Выключено');

    if (path.join('.') === 'profileBio.enabled' && !next) {
      pendingProfileBioEnable.delete(String(chatId));
    }

    if (path.join('.') === 'profileBio.enabled' && next) {
      const city = String(store.getPath(['profileBio', 'city']) || '').trim();
      if (!city) {
        store.setPath(['profileBio', 'enabled'], false);
        pendingProfileBioEnable.add(String(chatId));
        waitingInput.set(String(chatId), 'profileBioCity');
        await answerCallback(query.id, 'Сначала укажите город');
        await sendInputPrompt(chatId, `${HINTS.profileBioCityRequired}\n\n${PROFILE_BIO_CITY_HINT}`);
        await editMessageText(chatId, query.message.message_id, 'Панель управления ботом:', {
          reply_markup: buildMenuKeyboard(),
        });
        return;
      }
    }

    await editMessageText(chatId, query.message.message_id, 'Панель управления ботом:', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  await answerCallback(query.id);
}

async function ensureBotAbout(tokenOverride) {
  if (store.getPath(['telegram', 'defaultAboutApplied']) === true) {
    return;
  }

  const [description, shortDescription] = await Promise.all([
    setBotDescription(BOT_ABOUT, tokenOverride),
    setBotShortDescription(BOT_ABOUT, tokenOverride),
  ]);

  if (!description?.ok) {
    console.warn('setMyDescription:', description?.description);
    return;
  }
  if (!shortDescription?.ok) {
    console.warn('setMyShortDescription:', shortDescription?.description);
    return;
  }

  store.setPath(['telegram', 'defaultAboutApplied'], true);
  console.log('Описание Telegram-бота задано');
}

async function registerBotCommands(tokenOverride) {
  const data = await setBotCommands(BOT_COMMANDS, tokenOverride);
  if (!data.ok) {
    console.warn('setMyCommands:', data.description);
  }
  try {
    await ensureBotAbout(tokenOverride);
  } catch (err) {
    console.warn('Описание Telegram-бота:', err.message);
  }
  return data;
}

const DEVELOPER_BROADCAST_CHANNEL = 'notificationsmax_in_tg';
const DEVELOPER_BROADCAST_PREFIX = 'Рассылка от разработчика:\n';
const DEVELOPER_BROADCAST_CHECK_MS = 30_000;
let developerBroadcastTimer = null;
let developerBroadcastCheckBusy = false;

function developerBroadcastRecipients() {
  return listKnownChats()
    .filter((chat) => chat.type === 'private' && hasWrittenToBot(chat.id))
    .map((chat) => String(chat.id));
}

function shiftedEntities(entities, shift) {
  return (Array.isArray(entities) ? entities : []).map((entity) => ({
    ...entity,
    offset: Number(entity.offset || 0) + shift,
  }));
}

async function sendDeveloperBroadcast(sourceText, sourceEntities = [], postId = null) {
  const text = `${DEVELOPER_BROADCAST_PREFIX}${sourceText}`;
  const entities = [
    { type: 'bold', offset: 0, length: 'Рассылка от разработчика:'.length },
    ...shiftedEntities(sourceEntities, DEVELOPER_BROADCAST_PREFIX.length),
  ];
  const recipients = developerBroadcastRecipients();
  let sent = 0;
  let failed = 0;

  for (const chatId of recipients) {
    try {
      const result = await api('sendMessage', {
        chat_id: chatId,
        text,
        entities,
        link_preview_options: { is_disabled: false },
      });
      if (result?.ok) sent += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  if (postId != null) store.setPath(['telegram', 'developerBroadcastLastPostId'], Number(postId));
  console.log(`Рассылка разработчика: отправлено ${sent}, ошибок ${failed}, всего ${recipients.length}`);
}

async function handleDeveloperBroadcast(post) {
  const username = String(post?.chat?.username || '').replace(/^@/, '').toLowerCase();
  if (username !== DEVELOPER_BROADCAST_CHANNEL) return;
  const postId = Number(post.message_id || 0);
  const lastId = Number(store.getPath(['telegram', 'developerBroadcastLastPostId']) || 0);
  if (postId && postId <= lastId) return;

  const sourceText = String(post.text || post.caption || '');
  if (!sourceText.trim()) {
    if (postId) store.setPath(['telegram', 'developerBroadcastLastPostId'], postId);
    return;
  }
  await sendDeveloperBroadcast(sourceText, post.text ? post.entities : post.caption_entities, postId);
}

function decodeTelegramHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    })
    .replace(/&#(\d+);/g, (entity, decimal) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function extractLatestChannelPost(html) {
  const postRe = /<div class="tgme_widget_message[^>]*data-post="notificationsmax_in_tg\/(\d+)"[\s\S]*?<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>\s*<\/div>/gi;
  let match;
  let latest = null;
  while ((match = postRe.exec(html))) {
    const id = Number(match[1]);
    const raw = match[2];
    const text = decodeTelegramHtml(
      raw
        .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
        .replace(/<[^>]+>/g, '')
    ).trim();
    if (text && (!latest || id > latest.id)) latest = { id, text };
  }
  return latest;
}

async function checkDeveloperBroadcastChannel() {
  if (developerBroadcastCheckBusy) return;
  developerBroadcastCheckBusy = true;
  try {
    const response = await fetch(`https://t.me/s/${DEVELOPER_BROADCAST_CHANNEL}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 MAX-TG-Bot/1.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const latest = extractLatestChannelPost(await response.text());
    if (!latest) return;

    const lastId = Number(store.getPath(['telegram', 'developerBroadcastLastPostId']) || 0);
    if (!lastId) {
      store.setPath(['telegram', 'developerBroadcastLastPostId'], latest.id);
      console.log(`Рассылка разработчика: начальная публикация #${latest.id} запомнена`);
      return;
    }
    if (latest.id <= lastId) return;
    await sendDeveloperBroadcast(latest.text, [], latest.id);
  } catch (err) {
    console.warn('Проверка канала рассылки:', err.message);
  } finally {
    developerBroadcastCheckBusy = false;
  }
}

function startDeveloperBroadcastPolling() {
  if (developerBroadcastTimer) return;
  void checkDeveloperBroadcastChannel();
  developerBroadcastTimer = setInterval(() => {
    void checkDeveloperBroadcastChannel();
  }, DEVELOPER_BROADCAST_CHECK_MS);
  developerBroadcastTimer.unref?.();
  console.log('Проверка канала рассылки запущена: каждые 30 секунд');
}

function startTelegramAdmin() {
  const { token } = getTelegram();
  if (!token) {
    console.warn('Telegram token не задан — панель управления отключена');
    return () => {};
  }

  console.log('Панель управления в Telegram запущена (/menu)');
  loadWaitingInput();
  startDeveloperBroadcastPolling();
  deleteWebhook()
    .then(() => registerBotCommands())
    .catch((err) => {
      console.warn('Инициализация Telegram:', err.message);
    });

  return pollUpdates(async (update) => {
    if (update.channel_post) {
      try {
        await handleDeveloperBroadcast(update.channel_post);
      } catch (err) {
        console.error('Ошибка рассылки разработчика:', err.message);
      }
      return;
    }

    const from = update.message?.from || update.callback_query?.from || update.my_chat_member?.from;
    await runWithPremiumEmoji(from, async () => {
      recordChatFromUpdate(update);
      try {
        if (update.my_chat_member) await handleMyChatMember(update.my_chat_member);
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      } catch (err) {
        console.error('Ошибка панели Telegram:', err.message);
      }
    });
  }, {
    id: 'admin-main',
    priority: 0,
    allowedUpdates: ['message', 'callback_query', 'my_chat_member', 'channel_post'],
    onError: (err) => console.error('Ошибка панели Telegram:', err.message),
  });
}

module.exports = {
  startTelegramAdmin,
  registerBotCommands,
  registerAuthInputWaiter,
  clearAuthInputWaiter,
  setReauthHandler,
  setSessionCheckHandler,
  setAuthBusyCheck,
  setReplyHandler,
  setStopHandler,
  setStartHandler,
  setMaxChatPickerHandler,
  setMaxChatResolveHandler,
  setMaxChatKindHandler,
  setMaxChatStatsHandler,
  buildStatusText,
  buildMenuKeyboard,
  BOT_COMMANDS,
};
