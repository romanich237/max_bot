const {
  store,
  getTelegram,
  getAdminChatIds,
  getMax,
  getMaxDisplayName,
  getProfileRotate,
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
  buildToggleRows,
  parseNameList,
  saveProfileNames,
  PROFILE_NAMES_HINT,
} = require('./tg-settings');
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
const { buildBrowserPasswordAcceptedMessage, deliverBrowserPassword } = require('./auth-browser');

const SETTABLE = {
  profileinterval: { path: ['profileRotate', 'intervalMs'], type: 'int', min: 10000, max: 3600000 },
  onlineinterval: { path: ['alwaysOnline', 'intervalMs'], type: 'int', min: 5000, max: 300000 },
  profilenames: { path: ['profileRotate', 'names'], type: 'names' },
  browserpassword: { path: ['max', 'browserPassword'], type: 'string' },
};

const BOT_COMMANDS = [
  { command: 'start', description: 'Старт и меню' },
  { command: 'menu', description: 'Настройки бота' },
  { command: 'reauth', description: 'Вход в MAX' },
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

function onFlag(value) {
  return value ? '✅ вкл' : '❌ выкл';
}

function buildStatusText() {
  const profile = getProfileRotate();
  const online = getAlwaysOnline();

  const maxName = getMaxDisplayName();

  const defaultUrl = getDefaultChatUrl();
  const monitorUrls = getMonitorChatUrls();
  const notifyIds = getNotificationChatIds();

  const lines = [
    '<b>Настройки MAX → Telegram</b>',
    '',
    `Мониторинг MAX: ${onFlag(isMonitoringEnabled())}`,
    `Бесконечный онлайн: ${onFlag(online.enabled)} (${online.intervalMs / 1000} с)`,
    `Авто имя: ${onFlag(profile.enabled)} (${profile.intervalMs / 1000} с)`,
    profile.names?.length ? `Имена: ${profile.names.join(' → ')}` : 'Имена: не заданы',
    maxName
      ? `Имя в MAX: <code>${escapeHtml(maxName)}</code>`
      : 'Имя в MAX: определяется автоматически',
    '',
    '<b>Чаты MAX:</b>',
    monitorUrls.length
      ? monitorUrls
          .map((url) => {
            const star = url === defaultUrl ? '⭐ ' : '• ';
            return `${star}<code>${escapeHtml(url)}</code>`;
          })
          .join('\n')
      : 'не заданы',
    notifyIds.length
      ? `Уведомления в TG: ${notifyIds.map((id) => `<code>${id}</code>`).join(', ')}`
      : 'Уведомления в TG: не задан',
  ];

  return lines.filter(Boolean).join('\n');
}

const DISCOVER_ID_BUTTON = '🔍 Узнать ID';
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
  const rows = buildToggleRows('toggle:');
  rows.push([{ text: '✏️ Имена авто', callback_data: 'action:profileNames' }]);
  rows.push([{ text: '💬 Чаты MAX', callback_data: 'maxchat:list' }]);
  rows.push([{ text: '📬 Чат уведомлений', callback_data: 'action:notifyChat' }]);
  rows.push([{ text: '📊 Обновить статус', callback_data: 'status' }]);
  if (isMonitoringEnabled()) {
    rows.push([{ text: '⏹ Остановить MAX', callback_data: 'action:stopMax' }]);
  } else {
    rows.push([{ text: '▶️ Запустить MAX', callback_data: 'action:startMax' }]);
  }
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
    if (!rawValue) return { error: 'Укажите ссылку на чат MAX' };
    const result = setDefaultChatUrl(rawValue);
    if (result.error) return { error: result.error };
    return { ok: true, key, value: result.url };
  }

  const rule = SETTABLE[key];
  if (!rule) return { error: `Неизвестный ключ. Доступно: chaturl, ${Object.keys(SETTABLE).join(', ')}` };

  if (rule.type === 'names') {
    const names = parseNameList(rawValue);
    if (!names.length) return { error: 'Укажите имена через запятую' };
    saveProfileNames(names);
    return { ok: true, key, value: names.join(', ') };
  }

  let value = rawValue;
  if (rule.type === 'int') {
    value = Number.parseInt(rawValue, 10);
    if (Number.isNaN(value)) return { error: 'Нужно целое число' };
    if (rule.min != null && value < rule.min) return { error: `Минимум: ${rule.min}` };
    if (rule.max != null && value > rule.max) return { error: `Максимум: ${rule.max}` };
  } else if (!rawValue) {
    return { error: 'Укажите значение после ключа' };
  }

  store.setPath(rule.path, value);
  return { ok: true, key, value };
}

async function handleProfileNamesInput(chatId, text) {
  const names = parseNameList(text);
  if (!names.length) {
    await sendMessage(chatId, 'Не распознано. ' + PROFILE_NAMES_HINT);
    return false;
  }

  saveProfileNames(names);
  waitingInput.delete(String(chatId));
  await sendMessage(
    chatId,
    buildEventMessage({
      title: 'Имена авто сохранены',
      status: 'done',
      lines: [`Список: ${names.join(' → ')}`, '', buildStatusText()],
    }),
    { reply_markup: buildMenuKeyboard() }
  );
  return true;
}

function buildAuthInputAcceptedMessage(waiter) {
  const label = String(waiter?.label || '').toLowerCase();

  if (/код из sms|sms/.test(label)) {
    return buildEventMessage({
      title: 'Код принят',
      status: 'done',
      lines: ['Ввожу код в MAX…'],
    });
  }

  if (/номер телефона|телефон/.test(label)) {
    return buildEventMessage({
      title: 'Вхожу в MAX',
      status: 'progress',
      lines: ['Номер принят, продолжаю вход…'],
    });
  }

  if (waiter?.field === 'password') {
    return buildBrowserPasswordAcceptedMessage();
  }

  return buildEventMessage({
    title: 'Принято',
    status: 'done',
    lines: ['Продолжаю…'],
  });
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

  if (/^\/set\s+browserpassword\s+/i.test(text)) {
    const setResult = parseSetCommand(text);
    if (setResult?.ok) {
      const waiter = authInputWaiter;
      clearAuthInputWaiter();
      waiter.onValid(setResult.value);
      await sendMessage(chatId, buildAuthInputAcceptedMessage(waiter));
      return true;
    }
    return false;
  }

  if (text.startsWith('/') && !/^\/cancel$/i.test(text)) {
    return false;
  }

  if (authInputWaiter.validate) {
        const validated = authInputWaiter.validate(text);
        if (validated === false || validated == null) {
          await sendMessage(
            chatId,
            authInputWaiter.invalidMessage || 'Неверный формат. Попробуйте ещё раз или /cancel.'
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
    url === defaultUrl ? '⭐ Основной чат' : 'Дополнительный чат',
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
      ? 'Этот чат уже в списке.'
      : `Чат добавлен: <code>${escapeHtml(result.url)}</code>`,
    '',
    buildMaxChatsText(),
  ];

  await sendMessage(
    chatId,
    buildEventMessage({
      title: result.duplicate ? 'Чат уже в списке' : 'Чат MAX добавлен',
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
    'Выберите чат — бот пришлёт ID и название.',
    'Можно привязать чат для уведомлений из MAX.',
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
    await sendMessage(chatId, 'Нет доступа. Добавьте свой chat ID в <code>telegram.chatIds</code>.');
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

    if (!target) {
      await sendMessage(chatId, 'Сообщение устарело. Нажмите «Ответить» на новом сообщении из MAX.');
      return;
    }

    if (!replyHandler) {
      await sendMessage(chatId, 'Ответы недоступны — перезапустите бота: <code>pm2 restart max-tg</code>');
      return;
    }

    try {
      await replyHandler(target, text);
      await sendMessage(
        chatId,
        buildEventMessage({
          title: 'Ответ отправлен в MAX',
          status: 'done',
          lines: [`Получатель: <b>${escapeHtml(target.author || 'пользователь')}</b>`],
        })
      );
    } catch (err) {
      await sendMessage(
        chatId,
        buildEventMessage({
          title: 'Не удалось отправить ответ',
          status: 'fail',
          lines: [escapeHtml(err.message)],
        })
      );
    }
    return;
  }

  if (waitKey === 'profileNames' && text && !text.startsWith('/')) {
    await handleProfileNamesInput(chatId, text);
    return;
  }

  if (waitKey === 'maxchat:add' && text && !text.startsWith('/')) {
    await handleMaxChatUrlInput(chatId, text);
    return;
  }

  if (/^\/cancel$/i.test(text)) {
    waitingInput.delete(String(chatId));
    await sendMessage(chatId, 'Отменено.');
    return;
  }

  if (isDiscoverIdRequest(text)) {
    await sendMessage(
      chatId,
      'Нажмите «🔍 Узнать ID» внизу и выберите чат из списка Telegram.',
      { reply_markup: buildDiscoverReplyKeyboard() }
    );
    return;
  }

  if (/^\/start$/i.test(text)) {
    waitingInput.delete(String(chatId));
    await sendMessage(
      chatId,
      [
        '<b>MAX → Telegram</b>',
        '',
        'Бот пересылает сообщения из MAX в Telegram.',
        'Управление — кнопками ниже.',
        `ID чата — «${DISCOVER_ID_BUTTON}» внизу, затем выберите чат из списка.`,
      ].join('\n'),
      { reply_markup: buildDiscoverReplyKeyboard() }
    );
    await sendMessage(chatId, 'Панель управления ботом:', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (/^\/menu$/i.test(text)) {
    waitingInput.delete(String(chatId));
    await sendMessage(chatId, 'Панель управления ботом:', {
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
      await sendMessage(chatId, 'Остановка недоступна. Перезапустите: <code>pm2 restart max-tg</code>');
      return;
    }
    stopHandler();
    await sendMessage(
      chatId,
      buildEventMessage({
        title: 'Мониторинг MAX остановлен',
        status: 'done',
        lines: ['Сообщения из MAX больше не пересылаются.'],
      }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (/^\/(resume|run)$/i.test(text)) {
    if (!startHandler) {
      await sendMessage(chatId, 'Запуск недоступен. Выполните: <code>pm2 restart max-tg</code>');
      return;
    }
    startHandler();
    await sendMessage(
      chatId,
      buildEventMessage({
        title: 'Мониторинг MAX запущен',
        status: 'done',
        lines: ['Сообщения из MAX снова пересылаются в Telegram.'],
      }),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (/^\/reauth$/i.test(text)) {
    if (!reauthHandler) {
      await sendMessage(
        chatId,
        'Перезапустите установку:\n<code>bash &lt;(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)</code>'
      );
      return;
    }

    if (!(await ensureCanStartReauth(chatId))) {
      return;
    }

    await sendMessage(
      chatId,
      buildEventMessage({
        title: 'Способ входа в MAX',
        status: 'wait',
        lines: ['Выберите: QR-код или номер телефона.'],
      }),
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
    await sendMessage(chatId, 'Всё управление — в /menu (кнопки ниже).', {
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
    if (result?.ok && result.key === 'browserpassword') {
      if (authInputWaiter) {
        const waiter = authInputWaiter;
        clearAuthInputWaiter();
        waiter.onValid(result.value);
        await sendMessage(chatId, buildAuthInputAcceptedMessage(waiter));
        return;
      }

      const delivered = deliverBrowserPassword(result.value);
      const { isCaptionSessionActive } = require('./auth-caption');
      if (delivered || isCaptionSessionActive()) {
        await sendMessage(chatId, buildBrowserPasswordAcceptedMessage());
        return;
      }
    }
    if (result?.ok) {
      await sendMessage(
        chatId,
        buildEventMessage({
          title: 'Сохранено',
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
        'Перезапустите установку:\n<code>bash &lt;(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)</code>'
      );
      return;
    }

    if (isAuthBusyCheck() || isAuthSessionActive()) {
      await answerCallback(query.id, 'Уже идёт вход');
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
          buildEventMessage({
            title: 'Сессия MAX обновлена',
            status: 'done',
            lines: ['Мониторинг продолжается.'],
          })
        );
      })
      .catch(async (err) => {
        await sendMessage(
          chatId,
          buildEventMessage({
            title: 'Ошибка входа в MAX',
            status: 'fail',
            lines: [err.message],
          })
        );
      });
    return;
  }

  if (data === 'auth:refresh') {
    await answerCallback(query.id, 'Обновляю…');
    if (!isAuthSessionActive()) {
      await sendMessage(chatId, 'Сейчас авторизация не идёт. Отправьте /reauth');
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
        'Напишите текст ответа (или /cancel).',
      ].join('\n')
    );
    return;
  }

  if (data === 'action:stopMax') {
    await answerCallback(query.id, 'Остановлено');
    if (!stopHandler) {
      await sendMessage(chatId, 'Остановка недоступна. Перезапустите: <code>pm2 restart max-tg</code>');
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
      await sendMessage(chatId, 'Запуск недоступен. Выполните: <code>pm2 restart max-tg</code>');
      return;
    }
    startHandler();
    await sendMessage(
      chatId,
      buildEventMessage({
        title: 'Мониторинг MAX запущен',
        status: 'done',
        lines: ['Пересылка сообщений включена.'],
      }),
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
        title: 'Чат привязан для уведомлений',
        status: 'done',
        lines: [
          known?.title ? `Название: <b>${escapeHtml(known.title)}</b>` : null,
          `ID: <code>${targetChatId}</code>`,
          boundChatIds.length > 1
            ? 'Сообщения из MAX будут приходить в ЛС и в этот чат.'
            : 'Сообщения из MAX будут приходить в ЛС.',
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
        await sendMessage(chatId, 'Авто имя включено. ' + PROFILE_NAMES_HINT);
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
