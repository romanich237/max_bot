const {
  store,
  getTelegram,
  getAdminChatIds,
  getMax,
  getMaxDisplayName,
  getProfileRotate,
  getProfileBio,
  getAlwaysOnline,
  getDefaultChatUrl,
  getMonitorChatUrls,
  getNotificationChatIds,
} = require('./config');
const {
  setDefaultChatUrl,
  addMonitorChatUrl,
  removeMonitorChatUrl,
  buildMaxChatsText,
  buildMaxChatsKeyboard,
  buildMaxChatViewKeyboard,
  chatLabelFromUrl,
} = require('./max-chats');
const {
  deleteWebhook,
  setBotCommands,
  sendMessage,
  answerCallback,
  editMessageText,
  getChat,
  pollUpdates,
} = require('./tg-api');
const {
  TOGGLES,
  buildToggleButton,
  parseNameList,
  saveProfileNames,
  saveProfileBioCity,
  saveProfileBioTemplate,
  PROFILE_NAMES_HINT,
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
  bindNotificationChat,
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
} = require('./bot-texts');
const {
  buildBrowserPasswordAcceptedMessage,
  buildBrowserPasswordSavedMessage,
  buildBrowserPasswordPromptMessage,
  acceptBrowserPassword,
  parseBrowserPasswordCommand,
  getBrowserPassword,
} = require('./auth-browser');

const SETTABLE = {
  profileinterval: { path: ['profileRotate', 'intervalMs'], type: 'int', min: 10000, max: 3600000 },
  biointerval: { path: ['profileBio', 'intervalMs'], type: 'int', min: 10000, max: 3600000 },
  biocity: { path: ['profileBio', 'city'], type: 'string' },
  biotemplate: { path: ['profileBio', 'template'], type: 'string' },
  onlineinterval: { path: ['alwaysOnline', 'intervalMs'], type: 'int', min: 5000, max: 300000 },
  profilenames: { path: ['profileRotate', 'names'], type: 'names' },
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
let isAuthBusyCheck = () => false;
const waitingInput = new Map();

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

function buildStatusText() {
  const profile = getProfileRotate();
  const profileBio = getProfileBio();
  const online = getAlwaysOnline();

  const maxName = getMaxDisplayName();

  const defaultUrl = getDefaultChatUrl();
  const monitorUrls = getMonitorChatUrls();
  const notifyIds = getNotificationChatIds();

  const lines = [
    STATUS.header,
    '',
    `${STATUS.monitoring}: ${onFlag(isMonitoringEnabled())}`,
    `${STATUS.alwaysOnline}: ${onFlag(online.enabled)} · ${online.intervalMs / 1000} с`,
    `${STATUS.profileRotate}: ${onFlag(profile.enabled)} · ${profile.intervalMs / 1000} с`,
    profile.names?.length ? `Имена: ${profile.names.join(' → ')}` : STATUS.namesUnset,
    `${STATUS.profileBio}: ${onFlag(profileBio.enabled)} · ${profileBio.intervalMs / 1000} с`,
    profileBio.city ? `Город: <code>${escapeHtml(profileBio.city)}</code>` : STATUS.cityUnset,
    `Шаблон: <code>${escapeHtml(profileBio.template)}</code>`,
    maxName
      ? `Имя в MAX: <code>${escapeHtml(maxName)}</code>`
      : STATUS.nameAuto,
    '',
    `<b>${STATUS.chatsHeader}</b>`,
    monitorUrls.length
      ? monitorUrls
          .map((url) => {
            const star = url === defaultUrl ? '⭐ ' : '• ';
            return `${star}<code>${escapeHtml(url)}</code>`;
          })
          .join('\n')
      : STATUS.chatsUnset,
    notifyIds.length
      ? `Уведомления: ${notifyIds.map((id) => `<code>${id}</code>`).join(', ')}`
      : STATUS.notifyUnset,
  ];

  return lines.filter(Boolean).join('\n');
}

const DISCOVER_ID_BUTTON = BUTTONS.discoverId;
const DISCOVER_CHAT_REQUEST_ID = 1;

function buildDiscoverReplyKeyboard() {
  return {
    keyboard: [
      [
        {
          text: DISCOVER_ID_BUTTON,
          request_chat: {
            request_id: DISCOVER_CHAT_REQUEST_ID,
            chat_is_channel: false,
          },
        },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function isDiscoverIdRequest(text) {
  const normalized = String(text || '').trim();
  return normalized === DISCOVER_ID_BUTTON || /^узнать\s*id$/i.test(normalized);
}

function buildMenuKeyboard() {
  const prefix = 'toggle:';
  const rows = [
    [buildToggleButton(prefix, TOGGLES[0])],
    [buildToggleButton(prefix, TOGGLES[1]), buildToggleButton(prefix, TOGGLES[2])],
    [{ text: BUTTONS.profileNames, callback_data: 'action:profileNames' }],
    [
      { text: BUTTONS.bioTemplate, callback_data: 'action:profileBioTemplate' },
      { text: BUTTONS.bioCity, callback_data: 'action:profileBioCity' },
    ],
    [
      { text: BUTTONS.maxChats, callback_data: 'maxchat:list' },
      { text: BUTTONS.notifyChat, callback_data: 'action:notifyChat' },
    ],
  ];

  const statusRow = [{ text: BUTTONS.refreshStatus, callback_data: 'status' }];
  if (isMonitoringEnabled()) {
    statusRow.push({ text: BUTTONS.stopMax, callback_data: 'action:stopMax' });
  } else {
    statusRow.push({ text: BUTTONS.startMax, callback_data: 'action:startMax' });
  }
  rows.push(statusRow);

  return { inline_keyboard: rows };
}

function isAdmin(chatId) {
  return getAdminChatIds().includes(String(chatId));
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

  if (rule.type === 'names') {
    const names = parseNameList(rawValue);
    if (!names.length) return { error: ERRORS.namesRequired };
    saveProfileNames(names);
    return { ok: true, key, value: names.join(', ') };
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

async function handleBrowserPasswordInput(chatId, text) {
  const password = String(text || '').trim();
  if (!password) {
    await sendMessage(chatId, AUTH.passwordEmpty);
    return true;
  }

  const result = acceptBrowserPassword(password);
  waitingInput.delete(String(chatId));
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

async function handleProfileBioCityInput(chatId, text) {
  const city = String(text || '').trim();
  if (!city) {
    await sendMessage(chatId, ERRORS.cityNotRecognized + PROFILE_BIO_CITY_HINT);
    return false;
  }

  saveProfileBioCity(city);
  waitingInput.delete(String(chatId));
  await sendMessage(
    chatId,
      buildEventMessage({ ...SAVED.city(escapeHtml(city)), status: 'done', lines: [...SAVED.city(escapeHtml(city)).lines, '', buildStatusText()] }),
    { reply_markup: buildMenuKeyboard() }
  );
  return true;
}

async function handleProfileBioTemplateInput(chatId, text) {
  const template = String(text || '').trim();
  if (!template) {
    await sendMessage(chatId, ERRORS.templateNotRecognized + PROFILE_BIO_TEMPLATE_HINT);
    return false;
  }

  const preview = previewBioTemplate(template, getProfileBio().city);
  if (preview.length > MAX_BIO_LENGTH) {
    await sendMessage(
      chatId,
      `Слишком длинный результат (${preview.length} симв.). Сократите шаблон до ${MAX_BIO_LENGTH} символов.`
    );
    return false;
  }

  saveProfileBioTemplate(template);
  waitingInput.delete(String(chatId));
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

async function handleProfileNamesInput(chatId, text) {
  const names = parseNameList(text);
  if (!names.length) {
    await sendMessage(chatId, ERRORS.notRecognized + PROFILE_NAMES_HINT);
    return false;
  }

  saveProfileNames(names);
  waitingInput.delete(String(chatId));
  await sendMessage(
    chatId,
      buildEventMessage({
      title: SETUP.namesSaved(names.join(' → ')).title,
      status: 'done',
      lines: [`Порядок смены: ${names.join(' → ')}`, '', buildStatusText()],
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

async function handleAuthInput(chatId, text) {
  if (!authInputWaiter) return false;

  const chatIdStr = String(chatId);
  const allowed = new Set((authInputWaiter.chatIds || []).map(String));
  if (!allowed.has(chatIdStr)) return false;

  if (/^\/cancel$/i.test(text)) {
    const waiter = authInputWaiter;
    clearAuthInputWaiter();
    waiter.onCancel?.();
    return true;
  }

  const browserCmd = parseBrowserPasswordCommand(text);
  if (browserCmd?.error) {
    await sendMessage(chatId, browserCmd.error);
    return true;
  }
  if (browserCmd?.password) {
    const result = acceptBrowserPassword(browserCmd.password);
    const waiter = authInputWaiter;
    clearAuthInputWaiter();
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
          await sendMessage(
            chatId,
            authInputWaiter.invalidMessage || ERRORS.invalidFormat
          );
          return true;
        }
        const waiter = authInputWaiter;
        clearAuthInputWaiter();
        waiter.onValid(typeof validated === 'string' ? validated : text);
        await sendMessage(chatId, buildAuthInputAcceptedMessage(waiter));
        return true;
  }

  const waiter = authInputWaiter;
  clearAuthInputWaiter();
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

async function showMaxChats(chatId, messageId) {
  await editMessageText(chatId, messageId, buildMaxChatsText(), {
    reply_markup: buildMaxChatsKeyboard(),
  });
}

async function showMaxChatView(chatId, messageId, index) {
  const urls = getMonitorChatUrls();
  const url = urls[index];
  if (!url) {
    await showMaxChats(chatId, messageId);
    return;
  }

  const defaultUrl = getDefaultChatUrl();
  const lines = [
    `<b>${escapeHtml(chatLabelFromUrl(url))}</b>`,
    '',
    `<code>${escapeHtml(url)}</code>`,
    url === defaultUrl ? CHATS.primary : CHATS.secondary,
  ];

  await editMessageText(chatId, messageId, lines.join('\n'), {
    reply_markup: buildMaxChatViewKeyboard(index),
  });
}

async function handleMaxChatUrlInput(chatId, text) {
  const result = addMonitorChatUrl(text);
  waitingInput.delete(String(chatId));

  if (result.error) {
    await sendMessage(chatId, result.error);
    return false;
  }

  const lines = [
    result.duplicate
      ? CHATS.duplicate.lines[0]
      : `Чат добавлен: <code>${escapeHtml(result.url)}</code>`,
    '',
    buildMaxChatsText(),
  ];

  await sendMessage(
    chatId,
    buildEventMessage({
      title: result.duplicate ? CHATS.duplicate.title : CHATS.added.title,
      status: 'done',
      lines,
    }),
    { reply_markup: buildMaxChatsKeyboard() }
  );
  return true;
}

async function handleChatShared(adminChatId, shared) {
  await replyChatInfo(adminChatId, String(shared.chat_id), shared.title);
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
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, ERRORS.noAccess);
    return;
  }

  const text = (message.text || '').trim();

  if (message.chat_shared) {
    await handleChatShared(chatId, message.chat_shared);
    return;
  }

  if (await handleAuthInput(chatId, text)) return;

  const waitKey = waitingInput.get(String(chatId));

  if (waitKey?.startsWith('reply:') && text && !text.startsWith('/')) {
    const target = replyStore.get(waitKey.slice('reply:'.length));
    waitingInput.delete(String(chatId));
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

  if (waitKey === 'profileNames' && text && !text.startsWith('/')) {
    await handleProfileNamesInput(chatId, text);
    return;
  }

  if (waitKey === 'profileBioCity' && text && !text.startsWith('/')) {
    await handleProfileBioCityInput(chatId, text);
    return;
  }

  if (waitKey === 'profileBioTemplate' && text && !text.startsWith('/')) {
    await handleProfileBioTemplateInput(chatId, text);
    return;
  }

  if (waitKey === 'browserPassword' && text && !text.startsWith('/')) {
    await handleBrowserPasswordInput(chatId, text);
    return;
  }

  if (waitKey === 'maxchat:add' && text && !text.startsWith('/')) {
    await handleMaxChatUrlInput(chatId, text);
    return;
  }

  if (/^\/cancel$/i.test(text)) {
    waitingInput.delete(String(chatId));
    await sendMessage(chatId, ERRORS.cancelled);
    return;
  }

  if (isDiscoverIdRequest(text)) {
    await sendMessage(
      chatId,
      START.discoverPrompt,
      { reply_markup: buildDiscoverReplyKeyboard() }
    );
    return;
  }

  if (/^\/start$/i.test(text)) {
    waitingInput.delete(String(chatId));
    await sendMessage(
      chatId,
      START.welcome,
      { reply_markup: buildDiscoverReplyKeyboard() }
    );
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
        '<b>MAX в браузере</b> (без QR-кода)',
        '',
        primary.startsWith('https://')
          ? 'Временный HTTPS: браузер может предупредить о сертификате — продолжите вручную.'
          : null,
        'Откройте ссылку, войдите по <b>номеру телефона</b>, пройдите капчу вручную.',
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
      await sendMessage(chatId, buildBrowserPasswordPromptMessage());
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

async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  if (!chatId || !isAdmin(chatId)) {
    await answerCallback(query.id, 'Нет доступа');
    return;
  }

  const data = query.data || '';

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
    await sendMessage(
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
    await answerCallback(query.id, 'Остановлено');
    if (!stopHandler) {
      await sendMessage(chatId, MONITORING.stopUnavailable);
      return;
    }
    stopHandler();
    await sendMessage(
      chatId,
      buildEventMessage({
        title: 'Мониторинг MAX остановлен',
        status: 'done',
        lines: ['Сообщения не пересылаются.'],
      }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (data === 'action:startMax') {
    await answerCallback(query.id, 'Запущено');
    if (!startHandler) {
      await sendMessage(chatId, MONITORING.startUnavailable);
      return;
    }
    startHandler();
    await sendMessage(
      chatId,
        buildEventMessage({ ...MONITORING.started, status: 'done', lines: ['Пересылка сообщений включена.'] }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (data === 'action:profileNames') {
    waitingInput.set(String(chatId), 'profileNames');
    await answerCallback(query.id, 'Жду имена');
    await sendMessage(chatId, PROFILE_NAMES_HINT);
    return;
  }

  if (data === 'action:profileBioCity') {
    waitingInput.set(String(chatId), 'profileBioCity');
    await answerCallback(query.id, 'Жду город');
    await sendMessage(chatId, PROFILE_BIO_CITY_HINT);
    return;
  }

  if (data === 'action:profileBioTemplate') {
    waitingInput.set(String(chatId), 'profileBioTemplate');
    await answerCallback(query.id, 'Жду шаблон');
    await sendMessage(chatId, PROFILE_BIO_TEMPLATE_HINT);
    return;
  }

  if (data === 'action:notifyChat') {
    await answerCallback(query.id, 'Чат уведомлений');
    await editMessageText(chatId, query.message.message_id, buildNotifyChatText(), {
      reply_markup: {
        inline_keyboard: [[{ text: '« В меню', callback_data: 'discover:menu' }]],
      },
    });
    return;
  }

  if (data === 'maxchat:list') {
    await answerCallback(query.id, 'Чаты MAX');
    await showMaxChats(chatId, query.message.message_id);
    return;
  }

  if (data === 'maxchat:add') {
    waitingInput.set(String(chatId), 'maxchat:add');
    await answerCallback(query.id, 'Жду ссылку');
    await sendMessage(
      chatId,
      [
        '<b>Добавить чат MAX</b>',
        '',
        'Отправьте ссылку на чат, например:',
        '<code>https://web.max.ru/-68396892343002</code>',
        '',
        'Или /cancel для отмены.',
      ].join('\n')
    );
    return;
  }

  if (data.startsWith('maxchat:view:')) {
    const index = Number.parseInt(data.slice('maxchat:view:'.length), 10) || 0;
    await answerCallback(query.id, 'Чат MAX');
    await showMaxChatView(chatId, query.message.message_id, index);
    return;
  }

  if (data.startsWith('maxchat:default:')) {
    const index = Number.parseInt(data.slice('maxchat:default:'.length), 10) || 0;
    const urls = getMonitorChatUrls();
    const url = urls[index];
    if (!url) {
      await answerCallback(query.id, 'Чат не найден');
      return;
    }

    const result = setDefaultChatUrl(url);
    if (result.error) {
      await answerCallback(query.id, 'Ошибка');
      await sendMessage(chatId, result.error);
      return;
    }

    await answerCallback(query.id, 'Основной чат');
    await showMaxChatView(chatId, query.message.message_id, index);
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
    const known = getKnownChat(targetChatId);
    const { chatIds: boundChatIds } = bindNotificationChat(targetChatId, chatId);
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
        ].filter(Boolean),
      }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (data === 'status') {
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
    const next = store.togglePath(path);
    await answerCallback(query.id, next ? 'Включено' : 'Выключено');

    if (path.join('.') === 'profileRotate.enabled' && next) {
      const names = store.getPath(['profileRotate', 'names']) || [];
      if (!names.length) {
        waitingInput.set(String(chatId), 'profileNames');
        await sendMessage(chatId, HINTS.profileNamesEnabled + PROFILE_NAMES_HINT);
      }
    }

    if (path.join('.') === 'profileBio.enabled' && next) {
      const city = store.getPath(['profileBio', 'city']) || '';
      if (!city) {
        waitingInput.set(String(chatId), 'profileBioCity');
        await sendMessage(chatId, HINTS.profileBioEnabled + PROFILE_BIO_CITY_HINT);
      }
    }

    await editMessageText(chatId, query.message.message_id, 'Панель управления ботом:', {
      reply_markup: buildMenuKeyboard(),
    });
  }
}

async function registerBotCommands(tokenOverride) {
  const data = await setBotCommands(BOT_COMMANDS, tokenOverride);
  if (!data.ok) {
    console.warn('setMyCommands:', data.description);
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
    recordChatFromUpdate(update);
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
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
  buildStatusText,
  buildMenuKeyboard,
  BOT_COMMANDS,
};
