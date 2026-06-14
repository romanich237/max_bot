const {
  getMax,
  getMaxDisplayName,
  getSettings,
  getProfileRotate,
  getProfileBio,
  getAlwaysOnline,
  getAdminChatIds,
  isSetupComplete,
  getDefaultChatUrl,
  getMonitorChatUrls,
  store,
} = require('./config');
const {
  scopedMessageKey,
  chatIdFromUrl,
  chatLabelFromUrl,
} = require('./max-chats');
const { rotateDisplayName, rotateProfileBio } = require('./profile');
const { syncOwnNames, syncOwnNamesFromMessages } = require('./max-profile-sync');
const { injectOnlineGuards, startAlwaysOnline } = require('./online');
const { startTelegramAdmin, setReauthHandler, setSessionCheckHandler, setAuthBusyCheck, setReplyHandler, setStopHandler, setStartHandler } = require('./tg-admin');
const { runAuthOnPage, probeMaxSession } = require('./auth-qr');
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

async function forwardMessage(page, message, isCatchUp, maxChatUrl) {
  const mediaFiles = await downloadMessageMedia(
    page,
    message,
    MESSAGE_WRAPPER_SELECTOR
  );

  await sendToTelegram(message, { isCatchUp, mediaFiles, maxChatUrl });
  await persistMessage(message, { forwarded: true, mediaFiles });
}

function scopeMessages(chatUrl, messages) {
  return messages.map((message) => ({
    ...message,
    key: scopedMessageKey(chatUrl, message.key),
  }));
}

function createChatStates(state) {
  const defaultUrl = getDefaultChatUrl();
  const urls = getMonitorChatUrls();
  const chatSnapshots = state.chatSnapshots || {};
  const rawSeen = state.seenKeys || [];

  const globalSeen = new Set(
    rawSeen.map((key) =>
      String(key).includes('::') ? key : scopedMessageKey(defaultUrl, key)
    )
  );

  const chatStates = new Map();
  for (const url of urls) {
    const prefix = chatIdFromUrl(url);
    const seenKeys = new Set([...globalSeen].filter((key) => key.startsWith(`${prefix}::`)));
    chatStates.set(url, {
      url,
      seenKeys,
      lastSnapshot:
        chatSnapshots[url] || (url === defaultUrl ? state.lastSnapshot || [] : []),
      baselineDone: true,
    });
  }

  return chatStates;
}

function persistChatStates(chatStates) {
  const defaultUrl = getDefaultChatUrl();
  const seenKeys = new Set();
  const chatSnapshots = {};
  let lastSnapshot = [];

  for (const [url, chatState] of chatStates) {
    chatSnapshots[url] = chatState.lastSnapshot;
    for (const key of chatState.seenKeys) {
      seenKeys.add(key);
    }
    if (url === defaultUrl) {
      lastSnapshot = chatState.lastSnapshot;
    }
  }

  return {
    seenKeys: [...seenKeys],
    lastSnapshot,
    chatSnapshots,
  };
}

async function processChatMessages(page, chatUrl, chatState, options = {}) {
  const { onLoginRequired, forwardOnStart = 0, isStartup = false } = options;

  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);

  if (await isLoginPage(page)) {
    const defaultUrl = getDefaultChatUrl();
    if (defaultUrl && (await probeMaxSession(page, defaultUrl))) {
      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(2500);
    }

    if (await isLoginPage(page)) {
      if (onLoginRequired) {
        await onLoginRequired();
      }
      return null;
    }
  }

  let messages = await readMessages(page);
  const needsBaseline = isStartup || chatState.baselineDone === false;
  if (needsBaseline && !isStartup) {
    console.log(`[${chatLabelFromUrl(chatUrl)}] Первичная синхронизация (без пересылки истории).`);
  } else if (isStartup) {
    console.log(
      `[${chatLabelFromUrl(chatUrl)}] В DOM найдено ${messages.length} сообщений.`
    );
  }

  syncOwnNamesFromMessages(messages);

  const scoped = scopeMessages(chatUrl, messages);

  if (isStartup && forwardOnStart > 0) {
    const recent = scoped.filter(shouldForward).slice(-forwardOnStart);
    for (const message of recent) {
      logMessage(message, `Старт → TG (${chatLabelFromUrl(chatUrl)})`);
      await forwardMessage(page, message, true, chatUrl);
    }
  }

  markSeen(scoped, chatState.seenKeys);

  if (needsBaseline) {
    for (const message of scoped) {
      if (!shouldForward(message)) {
        await persistMessage(message, { forwarded: false });
      }
    }
    chatState.lastSnapshot = snapshotFrom(scoped);
    chatState.baselineDone = true;
    return scoped;
  }

  const byKeys = findNewMessages(scoped, chatState.seenKeys);
  let toSend = byKeys;

  if (toSend.length === 0 && chatState.lastSnapshot.length > 0) {
    const byTail = diffByTail(chatState.lastSnapshot, scoped).filter(
      (message) => !chatState.seenKeys.has(message.key)
    );
    markSeen(byTail, chatState.seenKeys);
    toSend = byTail;
  }

  for (const message of toSend) {
    if (!shouldForward(message)) {
      logMessage(message, `Пропуск (моё) · ${chatLabelFromUrl(chatUrl)}`);
      await persistMessage(message, { forwarded: false });
      continue;
    }
    logMessage(message, `Новое · ${chatLabelFromUrl(chatUrl)}`);
    await forwardMessage(page, message, false, chatUrl);
  }

  if (toSend.length > 0) {
    chatState.lastSnapshot = snapshotFrom(scoped);
  }

  return scoped;
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
  const state = await loadState();
  const chatStates = createChatStates(state);
  let profileBusy = false;
  let authBusy = false;
  let profileIndex = 0;
  let profileTimer = null;
  let bioTimer = null;
  let monitorTimer = null;
  const reauthPromptIds = {};
  const defaultChatUrl = getDefaultChatUrl();

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

  function clearBioTimer() {
    if (bioTimer) {
      clearTimeout(bioTimer);
      bioTimer = null;
    }
  }

  function pauseMonitoring() {
    store.setPath(['max', 'monitoringEnabled'], false);
    clearMonitorTimer();
    clearProfileTimer();
    clearBioTimer();
    console.log('Мониторинг MAX остановлен');
  }

  function resumeMonitoring() {
    store.setPath(['max', 'monitoringEnabled'], true);
    scheduleProfileRotate();
    scheduleProfileBio();
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
      const chatUrl = getDefaultChatUrl();
      if (await probeMaxSession(page, chatUrl)) {
        clearReauthPromptIds();
        return { alreadyActive: true };
      }

      await runAuthOnPage(page, getAdminChatIds(), {
        sendQrPhotos: true,
        sendCaptchaPhotos: false,
        sendPasswordPhotos: true,
        useAuthCallbackPoll: true,
        ...options,
        useAdminPoll: true,
        afterLoginChatUrl: chatUrl,
      });
      const loaded = (await openChatWhenReady(page, chatUrl)) || [];
      if (!loaded.length && (await isLoginPage(page))) {
        throw new Error('Вход выполнен, но чат MAX недоступен. Проверьте chatUrl.');
      }
      const defaultState = chatStates.get(chatUrl);
      if (defaultState) {
        const scoped = scopeMessages(chatUrl, loaded);
        defaultState.lastSnapshot = snapshotFrom(scoped);
        markSeen(scoped, defaultState.seenKeys);
      }
      clearReauthPromptIds();
      await syncOwnNames(page, {
        messages: loaded,
        readProfile: true,
        chatUrl,
        notify: false,
      });
      return { alreadyActive: false };
    } finally {
      authBusy = false;
      profileBusy = false;
    }
  }

  setReauthHandler(async (authOptions = {}) => {
    return performReauth({ introMessage: false, ...authOptions });
  });

  setSessionCheckHandler(async () => {
    if (authBusy) return false;
    return probeMaxSession(page, getDefaultChatUrl());
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

      const targetChatUrl = targetMessage.maxChatUrl || getDefaultChatUrl();
      if (targetChatUrl) {
        const loaded = await openChatWhenReady(page, targetChatUrl);
        if (loaded === null) {
          throw new Error('Сессия MAX истекла. Отправьте /reauth');
        }
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
      scheduleProfileBio();
    } else {
      clearProfileTimer();
      clearBioTimer();
    }
  });

  const monitorUrls = getMonitorChatUrls();
  console.log(`Чаты MAX для мониторинга (${monitorUrls.length}):`);
  for (const url of monitorUrls) {
    const mark = url === defaultChatUrl ? '⭐' : '•';
    console.log(`  ${mark} ${url}`);
  }
  console.log(`Медиа сохраняются в: ${settings.dataDir}`);
  if (db.isEnabled()) {
    console.log('Состояние и сообщения сохраняются в MySQL');
  }

  let sessionExpired = false;
  const forwardOnStart = getSettings().forwardOnStart;

  for (const chatUrl of monitorUrls) {
    const chatState = chatStates.get(chatUrl);
    if (!chatState) continue;

    const result = await processChatMessages(page, chatUrl, chatState, {
      forwardOnStart,
      isStartup: true,
      onLoginRequired: async () => {
        if (!sessionExpired) {
          sessionExpired = true;
          console.log('Сессия истекла. Ожидание входа через Telegram…');
          await notifyReauthNeeded();
        }
      },
    });

    if (result === null && sessionExpired) {
      break;
    }
  }

  if (!sessionExpired) {
    const defaultState = chatStates.get(defaultChatUrl);
    await syncOwnNames(page, {
      messages: defaultState?.lastSnapshot || [],
      readProfile: true,
      chatUrl: defaultChatUrl,
      notify: false,
      reason: 'Имя взято из настроек профиля MAX.',
    });
    await saveState(persistChatStates(chatStates));
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
        const chatUrl = getDefaultChatUrl();
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
          notify: false,
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

  function scheduleProfileBio() {
    clearBioTimer();

    if (!isMonitoringEnabled()) return;

    const profileBio = getProfileBio();
    if (!profileBio.enabled) return;

    console.log(`Авто описание: каждые ${profileBio.intervalMs / 1000} с`);

    const tick = async () => {
      const current = getProfileBio();
      if (!current.enabled || !isMonitoringEnabled()) return;

      if (authBusy) {
        bioTimer = setTimeout(tick, 30000);
        return;
      }

      if (!String(current.city || '').trim()) {
        console.warn('Авто описание: город не задан');
        bioTimer = setTimeout(tick, current.intervalMs);
        return;
      }

      profileBusy = true;
      try {
        const chatUrl = getDefaultChatUrl();
        const bioText = await rotateProfileBio(page, chatUrl, current);
        console.log(`Описание обновлено (${bioText.length} симв.)`);
      } catch (err) {
        console.error('Ошибка обновления описания:', err.message);
      } finally {
        profileBusy = false;
      }

      bioTimer = setTimeout(tick, getProfileBio().intervalMs);
    };

    bioTimer = setTimeout(tick, 5000);
  }

  if (isMonitoringEnabled()) {
    scheduleProfileRotate();
    scheduleProfileBio();
  }

  async function monitorTick() {
    if (!isMonitoringEnabled() || profileBusy || authBusy) return;

    try {
      const monitorUrls = getMonitorChatUrls();
      let urlsChanged = false;

      for (const url of monitorUrls) {
        if (!chatStates.has(url)) {
          chatStates.set(url, {
            url,
            seenKeys: new Set(),
            lastSnapshot: [],
            baselineDone: false,
          });
          urlsChanged = true;
        }
      }

      for (const url of [...chatStates.keys()]) {
        if (!monitorUrls.includes(url)) {
          chatStates.delete(url);
          urlsChanged = true;
        }
      }

      if (urlsChanged) {
        console.log(`Список чатов MAX обновлён (${monitorUrls.length})`);
      }

      let sessionExpired = false;

      for (const chatUrl of monitorUrls) {
        const chatState = chatStates.get(chatUrl);
        if (!chatState) continue;

        await processChatMessages(page, chatUrl, chatState, {
          onLoginRequired: async () => {
            if (!sessionExpired) {
              sessionExpired = true;
              console.log('Сессия истекла. Ожидание входа через Telegram…');
              await notifyReauthNeeded();
            }
          },
        });

        if (sessionExpired) break;
      }

      if (sessionExpired) return;

      await saveState(persistChatStates(chatStates));
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
