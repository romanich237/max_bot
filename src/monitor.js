const { chromium } = require('playwright');
const {
  getMax,
  getSettings,
  getProfileRotate,
  getAlwaysOnline,
  getAdminChatIds,
  isSetupComplete,
  store,
} = require('./config');
const { rotateDisplayName } = require('./profile');
const { injectOnlineGuards, startAlwaysOnline } = require('./online');
const { startTelegramAdmin, setReauthHandler } = require('./tg-admin');
const { runAuthQrOnPage } = require('./auth-qr');
const { sendToTelegram } = require('./telegram');
const { loadState, saveState } = require('./state');
const { downloadMessageMedia } = require('./media');
const db = require('./db');
const {
  MESSAGE_WRAPPER_SELECTOR,
  isLoginPage,
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
  let currentChatUrl = max.chatUrl;

  const context = await chromium.launchPersistentContext(settings.userDataDir, {
    headless: settings.headless,
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = context.pages()[0] || (await context.newPage());
  await injectOnlineGuards(page);

  const onlineKeeper = startAlwaysOnline(page, getAlwaysOnline);

  async function performReauth(options = {}) {
    authBusy = true;
    profileBusy = true;
    try {
      await runAuthQrOnPage(page, getAdminChatIds(), options);
      currentChatUrl = getMax().chatUrl;
      await page.goto(currentChatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);
      messages = await waitForChat(page);
      lastSnapshot = snapshotFrom(messages);
    } finally {
      authBusy = false;
      profileBusy = false;
    }
  }

  setReauthHandler(async () => {
    await performReauth({ introMessage: false });
  });

  startTelegramAdmin();

  store.on('change', () => {
    onlineKeeper.reschedule();
    scheduleProfileRotate();
  });

  console.log(`Подключение к чату MAX: ${currentChatUrl}`);
  console.log(`Медиа сохраняются в: ${settings.dataDir}`);
  if (db.isEnabled()) {
    console.log('Состояние и сообщения сохраняются в MySQL');
  }

  await page.goto(currentChatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4000);

  if (await isLoginPage(page)) {
    console.log('Сессия истекла. Отправляю скриншот входа в Telegram…');
    await performReauth({
      introMessage:
        '<b>Сессия MAX истекла</b>\nСейчас пришлю скриншот страницы входа — отсканируйте QR в приложении MAX.',
    });
  } else {
    messages = await waitForChat(page);
  }
  console.log(`В DOM найдено ${messages.length} сообщений (после прокрутки вниз).`);

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
    if (profileTimer) {
      clearTimeout(profileTimer);
      profileTimer = null;
    }

    const profileRotate = getProfileRotate();
    if (!profileRotate.enabled) return;

    console.log(
      `Ротация имени: каждые ${profileRotate.intervalMs / 1000} с (режим: ${profileRotate.mode})`
    );

    const tick = async () => {
      const current = getProfileRotate();
      profileTimer = setTimeout(tick, current.intervalMs);

      if (!current.enabled || profileBusy || authBusy) return;

      profileBusy = true;
      try {
        const chatUrl = getMax().chatUrl;
        const name = await rotateDisplayName(page, chatUrl, {
          ...current,
          _index: profileIndex,
        });
        profileIndex += 1;
        console.log(`Имя обновлено: «${name}»`);
      } catch (err) {
        console.error('Ошибка смены имени:', err.message);
      } finally {
        profileBusy = false;
      }
    };

    profileTimer = setTimeout(tick, profileRotate.intervalMs);
  }

  scheduleProfileRotate();

  async function monitorTick() {
    if (profileBusy || authBusy) return;

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
        console.log('Сессия истекла. Отправляю скриншот входа в Telegram…');
        await performReauth({
          introMessage:
            '<b>Сессия MAX истекла</b>\nСейчас пришлю скриншот страницы входа — отсканируйте QR в приложении MAX.',
        });
        return;
      }

      messages = await readMessages(page);
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
    const delay = getSettings().checkIntervalMs;
    setTimeout(async () => {
      await monitorTick();
      scheduleMonitor();
    }, delay);
  };

  scheduleMonitor();
}

module.exports = { startMonitor };
