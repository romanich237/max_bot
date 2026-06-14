const {
  getMax,
  getMaxDisplayName,
  getSettings,
  getProfileRotate,
  getAlwaysOnline,
  getAdminChatIds,
  isSetupComplete,
  store,
} = require('./config');
const { rotateDisplayName } = require('./profile');
const { syncOwnNames, syncOwnNamesFromMessages } = require('./max-profile-sync');
const { injectOnlineGuards, startAlwaysOnline } = require('./online');
const { startTelegramAdmin, setReauthHandler, setAuthBusyCheck, setReplyHandler, setStopHandler, setStartHandler } = require('./tg-admin');
const { runAuthOnPage, buildAuthModeKeyboard } = require('./auth-qr');
const { launchMaxContext } = require('./browser-context');
const { sendMessage: sendTgMessage, editMessageText } = require('./tg-api');
const { sendReplyInMax } = require('./max-sender');
const { sendToTelegram } = require('./telegram');
const { loadState, saveState } = require('./state');
const { downloadMessageMedia } = require('./media');
const db = require('./db');
const {
  MESSAGE_WRAPPER_SELECTOR,
  isLoginPage,
  openChatWhenReady,
  readMessages,
  findNewMessages,
  diffByTail,
  waitForChat,
  shouldForward,
} = require('./parser');

function markSeen(messages, seenKeys) {
  for (const message of messages) {
    seenKeys.add(message.key);
  }
}

function logMessage(message, prefix) {
  const preview = `${message.body.slice(0, 50)}${message.body.length > 50 ? '...' : ''}`;
  const replyInfo = message.reply?.author ? ` ↩ ${message.reply.author}` : '';
  const mediaInfo = message.media?.length
    ? ` +${message.media.map((m) => m.type).join(',')}`
    : '';
  console.log(`${prefix}: ${message.author}${replyInfo}: "${preview}"${mediaInfo}`);
}

async function persistMessage(message, options = {}) {
  if (!db.isEnabled()) return;

  try {
    await db.saveMessage(message, options);
  } catch (err) {
    console.error('Ошибка записи сообщения в БД:', err.message);
  }
}

async function forwardMessage(page, message, isCatchUp) {
  const mediaFiles = await downloadMessageMedia(
    page,
    message,
    MESSAGE_WRAPPER_SELECTOR
  );

  await sendToTelegram(message, { isCatchUp, mediaFiles });
  await persistMessage(message, { forwarded: true, mediaFiles });
}

function snapshotFrom(messages) {
  return messages.map(({ key, author, body, time, isOwn, media, reply }) => ({
    key,
    author,
    body,
    time,
    isOwn,
    media,
    reply,
  }));
}

async function startMonitor() {
  if (!isSetupComplete()) {
    console.error(
      'Установка не завершена. Выполните: bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)'
    );
    process.exit(1);
  }

  const settings = getSettings();
  const max = getMax();
  const state = await loadState();
  const seenKeys = new Set(state.seenKeys);
  let lastSnapshot = state.lastSnapshot || [];
  let messages = [];
  let profileBusy = false;
  let authBusy = false;
  let profileIndex = 0;
  let profileTimer = null;
  let monitorTimer = null;
  let currentChatUrl = max.chatUrl;
  const reauthPromptIds = {};
  let lastProfileNameSync = 0;
  const PROFILE_NAME_RETRY_MS = 5 * 60 * 1000;

  function isEditOk(result) {
    if (result?.ok) return true;
    return /message is not modified/i.test(result?.description || '');
  }

  function clearReauthPromptIds() {
    for (const key of Object.keys(reauthPromptIds)) {
      delete reauthPromptIds[key];
    }
  }

  function isMonitoringEnabled() {
    return getMax().monitoringEnabled !== false;
  }

  function clearMonitorTimer() {
    if (monitorTimer) {
      clearTimeout(monitorTimer);
      monitorTimer = null;
    }
  }

  function clearProfileTimer() {
    if (profileTimer) {
      clearTimeout(profileTimer);
      profileTimer = null;
    }
  }

  function pauseMonitoring() {
    store.setPath(['max', 'monitoringEnabled'], false);
    clearMonitorTimer();
    clearProfileTimer();
    console.log('Мониторинг MAX остановлен');
  }

  function resumeMonitoring() {
    store.setPath(['max', 'monitoringEnabled'], true);
    scheduleProfileRotate();
    scheduleMonitor();
    console.log('Мониторинг MAX запущен');
  }

  const context = await launchMaxContext(settings.userDataDir, {
    headless: settings.headless,
  });

  const page = context.pages()[0] || (await context.newPage());
  await injectOnlineGuards(page);

  const onlineKeeper = startAlwaysOnline(page, getAlwaysOnline);

  async function notifyReauthNeeded(introMessage) {
    const text =
      introMessage ||
      '<b>Сессия MAX истекла</b>\nВыберите способ входа в MAX:';
    const replyMarkup = buildAuthModeKeyboard();

    for (const chatId of getAdminChatIds()) {
      const key = String(chatId);
      const existingId = reauthPromptIds[key];
      let result;

      if (existingId) {
        result = await editMessageText(key, existingId, text, { reply_markup: replyMarkup });
        if (!isEditOk(result)) {
          result = await sendTgMessage(key, text, { reply_markup: replyMarkup });
        }
      } else {
        result = await sendTgMessage(key, text, { reply_markup: replyMarkup });
      }

      if (!isEditOk(result) && !result?.ok) {
        console.error(`Не удалось обновить запрос входа в ${key}:`, result?.description);
        continue;
      }

      if (result?.result?.message_id) {
        reauthPromptIds[key] = result.result.message_id;
      }
    }
  }

  async function performReauth(options = {}) {
    authBusy = true;
    profileBusy = true;
    try {
      const chatUrl = getMax().chatUrl;
      await runAuthOnPage(page, getAdminChatIds(), {
        sendQrPhotos: true,
        sendCaptchaPhotos: false,
        sendPasswordPhotos: true,
        useAuthCallbackPoll: true,
        ...options,
        useAdminPoll: true,
        afterLoginChatUrl: chatUrl,
      });
      currentChatUrl = chatUrl;
      messages = (await openChatWhenReady(page, chatUrl)) || [];
      if (!messages.length && (await isLoginPage(page))) {
        throw new Error('Вход выполнен, но чат MAX недоступен. Проверьте chatUrl.');
      }
      lastSnapshot = snapshotFrom(messages);
      clearReauthPromptIds();
      await syncOwnNames(page, {
        messages,
        readProfile: true,
        chatUrl,
        notify: false,
      });
    } finally {
      authBusy = false;
      profileBusy = false;
    }
  }

  setReauthHandler(async (authOptions = {}) => {
    await performReauth({ introMessage: false, ...authOptions });
  });

  setAuthBusyCheck(() => authBusy);

  setStopHandler(() => {
    pauseMonitoring();
  });

  setStartHandler(() => {
    resumeMonitoring();
  });

  setReplyHandler(async (targetMessage, text) => {
    if (authBusy) {
      throw new Error('Идёт авторизация MAX, повторите позже');
    }

    profileBusy = true;
    try {
      if (await isLoginPage(page)) {
        throw new Error('Сессия MAX истекла. Отправьте /reauth');
      }

      await sendReplyInMax(page, targetMessage, text, MESSAGE_WRAPPER_SELECTOR);
      console.log(`Ответ в MAX для ${targetMessage.author}: "${text.slice(0, 50)}"`);
    } finally {
      profileBusy = false;
    }
  });

  startTelegramAdmin();

  const { startSitePortal } = require('./site-portal');
  const { openPortalPort } = require('./open-firewall-port');
  openPortalPort();
  startSitePortal().catch((err) => {
    console.warn('Site portal не запущен:', err.message);
  });

  store.on('change', () => {
    onlineKeeper.reschedule();
    if (isMonitoringEnabled()) {
      scheduleProfileRotate();
    } else {
      clearProfileTimer();
    }
  });

  console.log(`Подключение к чату MAX: ${currentChatUrl}`);
  console.log(`Медиа сохраняются в: ${settings.dataDir}`);
  if (db.isEnabled()) {
    console.log('Состояние и сообщения сохраняются в MySQL');
  }

  const loaded = await openChatWhenReady(page, currentChatUrl);
  if (loaded === null) {
    console.log('Сессия истекла. Ожидание входа через Telegram…');
    await notifyReauthNeeded();
  } else {
    messages = loaded;
  }
  console.log(`В DOM найдено ${messages.length} сообщений (после прокрутки вниз).`);

  await syncOwnNames(page, {
    messages,
    readProfile: true,
    chatUrl: currentChatUrl,
    notify: true,
    reason: 'Имя взято из настроек профиля MAX.',
  });

  const forwardOnStart = getSettings().forwardOnStart;
  if (forwardOnStart > 0) {
    const recent = messages.filter(shouldForward).slice(-forwardOnStart);
    for (const message of recent) {
      logMessage(message, 'Старт → TG');
      await forwardMessage(page, message, true);
    }
  }

  markSeen(messages, seenKeys);

  for (const message of messages) {
    if (!shouldForward(message)) {
      await persistMessage(message, { forwarded: false });
    }
  }

  lastSnapshot = snapshotFrom(messages);
  await saveState({ seenKeys: [...seenKeys], lastSnapshot });

  if (messages.length > 0) {
    logMessage(messages[messages.length - 1], 'Последнее в чате');
  }

  console.log('Мониторинг запущен. Жду новые сообщения...');
  console.log('Управление: отправьте /menu боту в Telegram');

  function scheduleProfileRotate() {
    clearProfileTimer();

    if (!isMonitoringEnabled()) return;

    const profileRotate = getProfileRotate();
    if (!profileRotate.enabled) return;

    console.log(
      `Авто имя: каждые ${profileRotate.intervalMs / 1000} с (режим: ${profileRotate.mode})`
    );

    const tick = async () => {
      const current = getProfileRotate();
      profileTimer = setTimeout(tick, current.intervalMs);

      if (!current.enabled || profileBusy || authBusy || !isMonitoringEnabled()) return;

      profileBusy = true;
      try {
        const chatUrl = getMax().chatUrl;
        const name = await rotateDisplayName(page, chatUrl, {
          ...current,
          _index: profileIndex,
        });
        profileIndex += 1;
        console.log(`Имя обновлено: «${name}»`);
        await syncOwnNames(page, {
          extraNames: [name],
          readProfile: true,
          chatUrl,
          notify: true,
          reason: 'Имя обновлено в профиле MAX.',
        });
      } catch (err) {
        console.error('Ошибка смены имени:', err.message);
      } finally {
        profileBusy = false;
      }
    };

    profileTimer = setTimeout(tick, profileRotate.intervalMs);
  }

  if (isMonitoringEnabled()) {
    scheduleProfileRotate();
  }

  async function monitorTick() {
    if (!isMonitoringEnabled() || profileBusy || authBusy) return;

    try {
      const maxCfg = getMax();
      if (maxCfg.chatUrl && maxCfg.chatUrl !== currentChatUrl) {
        currentChatUrl = maxCfg.chatUrl;
        console.log(`Новый чат MAX: ${currentChatUrl}`);
        await page.goto(currentChatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(3000);
        messages = await waitForChat(page);
        lastSnapshot = snapshotFrom(messages);
      }

      if (await isLoginPage(page)) {
        const chatUrl = maxCfg.chatUrl || currentChatUrl;
        const reopened = chatUrl ? await openChatWhenReady(page, chatUrl, 2) : null;
        if (reopened !== null) {
          messages = reopened;
          lastSnapshot = snapshotFrom(messages);
          clearReauthPromptIds();
          return;
        }

        console.log('Сессия истекла. Ожидание входа через Telegram…');
        await notifyReauthNeeded();
        return;
      }

      messages = await readMessages(page);
      syncOwnNamesFromMessages(messages);

      if (Date.now() - lastProfileNameSync > PROFILE_NAME_RETRY_MS) {
        lastProfileNameSync = Date.now();
        profileBusy = true;
        try {
          await syncOwnNames(page, {
            readProfile: true,
            chatUrl: currentChatUrl,
            notify: false,
          });
        } catch (err) {
          console.warn('Синхронизация имени MAX:', err.message);
        } finally {
          profileBusy = false;
        }
      }

      const byKeys = findNewMessages(messages, seenKeys);
      const byTail = diffByTail(lastSnapshot, messages);
      const toSend = byKeys.length >= byTail.length ? byKeys : byTail;

      markSeen(toSend, seenKeys);

      for (const message of toSend) {
        if (!shouldForward(message)) {
          logMessage(message, 'Пропуск (моё)');
          await persistMessage(message, { forwarded: false });
          continue;
        }
        logMessage(message, 'Новое');
        await forwardMessage(page, message, false);
      }

      if (toSend.length > 0) {
        lastSnapshot = snapshotFrom(messages);
        await saveState({ seenKeys: [...seenKeys], lastSnapshot });
      }
    } catch (err) {
      console.error('Ошибка парсинга:', err.message);
    }
  }

  const scheduleMonitor = () => {
    clearMonitorTimer();
    if (!isMonitoringEnabled()) return;

    const delay = getSettings().checkIntervalMs;
    monitorTimer = setTimeout(async () => {
      await monitorTick();
      scheduleMonitor();
    }, delay);
  };

  if (isMonitoringEnabled()) {
    scheduleMonitor();
  } else {
    console.log('Мониторинг MAX выключен. Запустите через /menu в Telegram.');
  }
}

module.exports = { startMonitor };
