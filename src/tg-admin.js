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
} = require('./config');
const {
  setDefaultChatUrl,
  addMonitorChatUrl,
  removeMonitorChatUrl,
  setChatTitle,
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
  getStoredChatKind,
  setChatKind,
  isChatForwardEnabled,
  setChatForwardEnabled,
  setNotifyTarget,
  cycleNotifyTarget,
  setNotifyChatIds,
  toggleNotifyChatId,
  getDefaultNotifyChatIds,
  formatNotifyDestLabel,
  listNotifyDestTitles,
  isMonitorAllChatsEnabled,
  setMonitorAllChatsEnabled,
  isMonitorPersonalChatsEnabled,
  setMonitorPersonalChatsEnabled,
} = require('./max-chats');
const { resolveMaxChatInput } = require('./max-chat-picker');
const {
  deleteWebhook,
  setBotCommands,
  setBotDescription,
  setBotShortDescription,
  sendMessage,
  pinChatMessage,
  answerCallback,
  editMessageText,
  getChat,
  pollUpdates,
  sendPhotoBuffer,
  editMessageCaption,
} = require('./tg-api');
const {
  TOGGLES,
  FORWARDING_TOGGLE,
  buildToggleButton,
  saveProfileBioCity,
  saveProfileBioTemplate,
  PROFILE_BIO_CITY_HINT,
  PROFILE_BIO_TEMPLATE_HINT,
  MAX_BIO_LENGTH,
} = require('./tg-settings');
const { previewBioTemplate } = require('./profile-bio');
const replyStore = require('./reply-store');
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
  buildBindGroupReplyKeyboard,
  bindNotificationChat,
  unbindNotificationChat,
  setDmOnlyNotifications,
  refreshTelegramChat,
  refreshNotificationChatStatuses,
  getBotAdminStatus,
  isBotAdminStatus,
  buildMissingAdminKeyboard,
  NOTIFY_GROUP_REQUEST_ID,
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
];

let reauthHandler = null;
let sessionCheckHandler = null;
let replyHandler = null;
let stopHandler = null;
let startHandler = null;
let maxChatPickerHandler = null;
let maxChatResolveHandler = null;
let maxChatKindHandler = null;
let isAuthBusyCheck = () => false;
const waitingInput = new Map();
const maxChatAddCache = new Map();
const pendingProfileBioEnable = new Set();

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

async function dispatchMaxReply(chatId, target, text) {
  if (!target) {
    await sendMessage(chatId, REPLY.stale);
    return;
  }

  if (!replyHandler) {
    await sendMessage(chatId, REPLY.unavailable);
    return;
  }

  try {
    await replyHandler(target, text);
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
  }
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

function buildStatusText() {
  const profileBio = getProfileBio();
  const online = getAlwaysOnline();
  const maxName = getMaxDisplayName();
  const monitorUrls = getMonitorChatUrls();
  const notifyIds = getNotificationChatIds();

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
    lines.push(`Шаблон: <code>${escapeHtml(profileBio.template)}</code>`);
  }

  lines.push(maxName ? `Сейчас имя: <code>${escapeHtml(maxName)}</code>` : STATUS.nameAuto);
  lines.push('', `<b>${STATUS.chatsHeader}</b>`);

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
      const forward = isChatForwardEnabled(url) ? 'слать' : 'не слать';
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

  await pinChatMessage(chatId, sent.result.message_id).catch((err) => {
    console.warn('pin about:', err.message);
  });
  markPinnedAbout(chatId);
  return true;
}

function buildMenuKeyboard() {
  const prefix = 'toggle:';
  const rows = [
    [buildToggleButton(prefix, TOGGLES[0]), buildToggleButton(prefix, TOGGLES[1])],
    [
      { text: BUTTONS.bioTemplate, callback_data: 'action:profileBioTemplate' },
      { text: BUTTONS.bioCity, callback_data: 'action:profileBioCity' },
    ],
    [
      { text: BUTTONS.maxChats, callback_data: 'maxchat:list' },
      { text: BUTTONS.notifyChat, callback_data: 'action:notifyChat' },
    ],
  ];

  const statusRow = [
    buildToggleButton(prefix, FORWARDING_TOGGLE),
    { text: BUTTONS.refreshStatus, callback_data: 'status' },
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

function isAdmin(chatId, userId) {
  const ids = getAdminChatIds();
  if (userId != null && ids.includes(String(userId))) return true;
  if (chatId != null && isPrivateChatId(chatId) && ids.includes(String(chatId))) return true;
  return false;
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
  await clearInputPrompt(chatId, userMessageId);

  const saved = SAVED.city(escapeHtml(city));
  const lines = [...saved.lines];
  if (shouldEnableBio) {
    lines.unshift(HINTS.profileBioEnabled.trim());
  }

  await sendMessage(
    chatId,
    buildEventMessage({ ...saved, status: 'done', lines: [...lines, '', buildStatusText()] }),
    { reply_markup: buildMenuKeyboard() }
  );
  return true;
}

async function handleProfileBioTemplateInput(chatId, text, userMessageId) {
  const template = String(text || '').trim();
  if (!template) {
    await deleteMessageQuiet(chatId, userMessageId);
    await sendInputPrompt(chatId, ERRORS.templateNotRecognized + PROFILE_BIO_TEMPLATE_HINT);
    return false;
  }

  const preview = previewBioTemplate(template, getProfileBio().city);
  if (preview.length > MAX_BIO_LENGTH) {
    await deleteMessageQuiet(chatId, userMessageId);
    await sendInputPrompt(
      chatId,
      `Слишком длинный результат (${preview.length} симв.). Сократите шаблон до ${MAX_BIO_LENGTH} символов.`
    );
    return false;
  }

  saveProfileBioTemplate(template);
  waitingInput.delete(String(chatId));
  await clearInputPrompt(chatId, userMessageId);
  await sendMessage(
    chatId,
    buildEventMessage({
      title: SAVED.template(escapeHtml(preview.text)).title,
      status: 'done',
      lines: [
        `Шаблон: <code>${escapeHtml(template)}</code>`,
        `Пример: <code>${escapeHtml(preview.text)}</code> (${preview.length} симв.)`,
        '',
        buildStatusText(),
      ],
    }),
    { reply_markup: buildMenuKeyboard() }
  );
  return true;
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
        ? 'Группа или канал MAX — выберите ЛС и нужные группы ниже.'
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
  lines.push('', CHATS.notifyDestHint);

  await editMessageText(chatId, messageId, lines.join('\n'), {
    reply_markup: buildMaxChatViewKeyboard(index, destPage),
  });
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

  const selectedNames = destIds.map((id) => {
    const known = getKnownChat(id);
    if (isPrivateChatId(id)) return 'ЛС';
    return known?.title || `Группа ${id}`;
  });
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

  if (url) {
    if (title && !/^https:\/\/web\.max\.ru\//i.test(title)) setChatTitle(url, title);
    if (kind) setChatKind(url, kind);
    waitingInput.set(String(chatId), 'maxchat:add');
    await proceedMaxChatAdd(chatId, { url, title, kind });
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

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!isAdmin(chatId, userId)) {
    await rejectUnauthorized(message.chat, userId);
    return;
  }

  const text = (message.text || '').trim();

  if (message.chat_shared) {
    await handleChatShared(chatId, message.chat_shared);
    return;
  }

  if (await handleAuthInput(chatId, text, message.message_id)) return;

  const waitKey = waitingInput.get(String(chatId));
  const userMessageId = message.message_id;

  if (waitKey?.startsWith('reply:') && text && !text.startsWith('/')) {
    const target = replyStore.get(waitKey.slice('reply:'.length));
    waitingInput.delete(String(chatId));
    await clearInputPrompt(chatId, userMessageId);
    await dispatchMaxReply(chatId, target, text);
    return;
  }

  if (text && !text.startsWith('/') && !waitKey && message.reply_to_message?.message_id) {
    const target = replyStore.getByTelegramMessage(chatId, message.reply_to_message.message_id);
    if (target) {
      await dispatchMaxReply(chatId, target, text);
      return;
    }
  }

  if (waitKey === 'profileBioCity' && text && !text.startsWith('/')) {
    await handleProfileBioCityInput(chatId, text, userMessageId);
    return;
  }

  if (waitKey === 'profileBioTemplate' && text && !text.startsWith('/')) {
    await handleProfileBioTemplateInput(chatId, text, userMessageId);
    return;
  }

  if (waitKey === 'browserPassword' && text && !text.startsWith('/')) {
    await handleBrowserPasswordInput(chatId, text, userMessageId);
    return;
  }

  if (waitKey === 'maxchat:add' && text && !text.startsWith('/')) {
    await handleMaxChatUrlInput(chatId, text, userMessageId);
    return;
  }

  if (/^\/cancel$/i.test(text)) {
    const key = String(chatId);
    pendingProfileBioEnable.delete(key);
    waitingInput.delete(key);
    await clearMaxChatAddPrompt(chatId, userMessageId);
    await sendMessage(chatId, ERRORS.cancelled);
    return;
  }

  if (/^\/start$/i.test(text)) {
    waitingInput.delete(String(chatId));
    const firstVisit = await sendPinnedAboutOnce(message.chat);
    if (!firstVisit) {
      await sendMessage(chatId, START.welcome, {
        reply_markup: { remove_keyboard: true },
      });
    }
    await sendMessage(chatId, START.panel, {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (/^\/menu$/i.test(text)) {
    waitingInput.delete(String(chatId));
    await sendMessage(chatId, START.panel, {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (/^\/status$/i.test(text)) {
    await sendMessage(chatId, buildStatusText());
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
      const doneText =
        result.status === 'updated'
          ? buildEventMessage({
              ...UPDATES.done(result.fromVersion, result.toVersion),
              status: 'done',
            })
          : result.status === 'error'
            ? buildEventMessage({ ...UPDATES.fail(result.message), status: 'fail' })
            : null;
      if (!doneText) return;

      const messageId = sent?.ok ? sent.result?.message_id : null;
      if (messageId) {
        try {
          await editMessageText(chatId, messageId, doneText);
          rememberUpdateNotices([{ chatId, messageId }], 'done');
          return;
        } catch (err) {
          console.warn('update message edit:', err.message);
        }
      }
      const fallback = await sendMessage(chatId, doneText);
      track(fallback, result.status === 'updated' ? 'done' : 'fail');
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
  if (!chatId || !isAdmin(chatId, userId)) {
    await rejectUnauthorized(query.message?.chat, userId, { callbackId: query.id });
    return;
  }

  const data = query.data || '';

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
    const target = replyStore.get(data.slice('reply:'.length));
    if (!target) {
      await answerCallback(query.id, 'Сообщение устарело');
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
        'Напишите текст сообщения.',
        'Отмена: /cancel',
      ].join('\n')
    );
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
    await editMessageText(chatId, query.message.message_id, START.about, {
      reply_markup: buildAboutKeyboard(),
    });
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
    await sendInputPrompt(chatId, PROFILE_BIO_TEMPLATE_HINT);
    return;
  }

  if (data === 'action:notifyChat') {
    await answerCallback(query.id, 'Чат уведомлений');
    await showNotifyChats(chatId, query.message.message_id);
    return;
  }

  if (data.startsWith('notify:chat:')) {
    const targetId = data.slice('notify:chat:'.length);
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

  if (data.startsWith('notify:remove:')) {
    const targetId = data.slice('notify:remove:'.length);
    const result = unbindNotificationChat(targetId);
    if (result.error) {
      await answerCallback(query.id, result.error);
      return;
    }
    await answerCallback(query.id, 'Группа удалена из рассылки');
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
    const chat = {
      url,
      title: fromCache?.title || '',
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
    await editMessageText(chatId, query.message.message_id, 'Панель управления ботом:', {
      reply_markup: buildMenuKeyboard(),
    });
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

function startTelegramAdmin() {
  const { token } = getTelegram();
  if (!token) {
    console.warn('Telegram token не задан — панель управления отключена');
    return () => {};
  }

  console.log('Панель управления в Telegram запущена (/menu)');
  deleteWebhook()
    .then(() => registerBotCommands())
    .catch((err) => {
      console.warn('Инициализация Telegram:', err.message);
    });

  return pollUpdates(async (update) => {
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
    allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
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
  buildStatusText,
  buildMenuKeyboard,
  BOT_COMMANDS,
};
