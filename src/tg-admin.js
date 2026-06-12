const {
  store,
  getTelegram,
  getAdminChatIds,
  getMax,
  getProfileRotate,
  getAlwaysOnline,
} = require('./config');
const {
  deleteWebhook,
  sendMessage,
  answerCallback,
  editMessageText,
  pollUpdates,
} = require('./tg-api');
const {
  buildToggleRows,
  parseNameList,
  saveProfileNames,
  PROFILE_NAMES_HINT,
} = require('./tg-settings');

const SETTABLE = {
  profileinterval: { path: ['profileRotate', 'intervalMs'], type: 'int', min: 10000, max: 3600000 },
  onlineinterval: { path: ['alwaysOnline', 'intervalMs'], type: 'int', min: 5000, max: 300000 },
  chaturl: { path: ['max', 'chatUrl'], type: 'string' },
  browserpassword: { path: ['max', 'browserPassword'], type: 'string' },
  profilenames: { path: ['profileRotate', 'names'], type: 'names' },
};

let reauthHandler = null;
const waitingInput = new Map();

function setReauthHandler(fn) {
  reauthHandler = fn;
}

function onFlag(value) {
  return value ? '✅ вкл' : '❌ выкл';
}

function buildStatusText() {
  const max = getMax();
  const profile = getProfileRotate();
  const online = getAlwaysOnline();
  const tg = getTelegram();

  const lines = [
    '<b>Настройки MAX → Telegram</b>',
    '',
    `Бесконечный онлайн: ${onFlag(online.enabled)} (${online.intervalMs / 1000} с)`,
    `Ротация имени: ${onFlag(profile.enabled)} (${profile.intervalMs / 1000} с)`,
    profile.names?.length ? `Имена: ${profile.names.join(' → ')}` : 'Имена: не заданы',
    `Пропуск своих: ${onFlag(max.skipOwnMessages)}`,
    `Время в TG: ${onFlag(tg.showTime)}`,
    `Заголовок в TG: ${onFlag(tg.showServiceHeader)}`,
    max.chatUrl ? `Чат MAX: <code>${max.chatUrl}</code>` : 'Чат MAX: не задан',
  ];

  return lines.filter(Boolean).join('\n');
}

function buildMenuKeyboard() {
  const rows = buildToggleRows('toggle:');
  rows.push([{ text: '✏️ Имена ротации', callback_data: 'action:profileNames' }]);
  rows.push([{ text: '📊 Обновить статус', callback_data: 'status' }]);
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
  const rule = SETTABLE[key];
  if (!rule) return { error: `Неизвестный ключ. Доступно: ${Object.keys(SETTABLE).join(', ')}` };

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
    `Имена сохранены: ${names.join(' → ')}\n\n${buildStatusText()}`,
    { reply_markup: buildMenuKeyboard() }
  );
  return true;
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, 'Нет доступа. Добавьте свой chat ID в <code>telegram.chatIds</code>.');
    return;
  }

  const text = (message.text || '').trim();
  const waitKey = waitingInput.get(String(chatId));

  if (waitKey === 'profileNames' && text && !text.startsWith('/')) {
    await handleProfileNamesInput(chatId, text);
    return;
  }

  if (/^\/(start|menu)$/i.test(text)) {
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

  if (/^\/reauth$/i.test(text)) {
    if (!reauthHandler) {
      await sendMessage(
        chatId,
        'Перезапустите установку:\n<code>bash &lt;(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)</code>'
      );
      return;
    }

    await sendMessage(chatId, 'Отправляю скриншот страницы входа MAX…');
    try {
      await reauthHandler(chatId);
      await sendMessage(chatId, 'Сессия MAX обновлена. Мониторинг продолжается.');
    } catch (err) {
      await sendMessage(chatId, `Ошибка входа: ${err.message}`);
    }
    return;
  }

  if (/^\/help$/i.test(text)) {
    await sendMessage(
      chatId,
      [
        '<b>Команды</b>',
        '/menu — кнопки вкл/выкл',
        '/status — текущие настройки',
        '/reauth — скриншот входа MAX',
        '/set ключ значение — изменить параметр',
        '',
        '<b>Ключи для /set</b>',
        'chatUrl, browserPassword, profileInterval, onlineInterval, profileNames',
      ].join('\n')
    );
    return;
  }

  if (/^\/set\b/i.test(text)) {
    const result = parseSetCommand(text);
    if (result?.error) {
      await sendMessage(chatId, result.error);
      return;
    }
    await sendMessage(
      chatId,
      `Сохранено: <code>${result.key}</code> = <code>${result.value}</code>\n\n${buildStatusText()}`,
      { reply_markup: buildMenuKeyboard() }
    );
  }
}

async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  if (!chatId || !isAdmin(chatId)) {
    await answerCallback(query.id, 'Нет доступа');
    return;
  }

  const data = query.data || '';

  if (data === 'action:profileNames') {
    waitingInput.set(String(chatId), 'profileNames');
    await answerCallback(query.id, 'Жду имена');
    await sendMessage(chatId, PROFILE_NAMES_HINT);
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
    const next = store.togglePath(path);
    await answerCallback(query.id, next ? 'Включено' : 'Выключено');

    if (path.join('.') === 'profileRotate.enabled' && next) {
      const names = store.getPath(['profileRotate', 'names']) || [];
      if (!names.length) {
        waitingInput.set(String(chatId), 'profileNames');
        await sendMessage(chatId, 'Ротация включена. ' + PROFILE_NAMES_HINT);
      }
    }

    await editMessageText(chatId, query.message.message_id, 'Панель управления ботом:', {
      reply_markup: buildMenuKeyboard(),
    });
  }
}

function startTelegramAdmin() {
  const { token } = getTelegram();
  if (!token) {
    console.warn('Telegram token не задан — панель управления отключена');
    return () => {};
  }

  console.log('Панель управления в Telegram запущена (/menu)');
  deleteWebhook().catch((err) => {
    console.warn('deleteWebhook:', err.message);
  });

  return pollUpdates(async (update) => {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  }, {
    onError: (err) => console.error('Ошибка панели Telegram:', err.message),
  });
}

module.exports = {
  startTelegramAdmin,
  setReauthHandler,
  buildStatusText,
  buildMenuKeyboard,
};
