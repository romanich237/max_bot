const { getSettings, getAdminChatIds } = require('./config');
const { sendMessage, sendPhotoBuffer, editPhotoBuffer, answerCallback, pollUpdates } = require('./tg-api');
const { isLoginPage } = require('./parser');
const { runAuthPhoneOnPage } = require('./auth-phone');
const {
  isBrowserPasswordPrompt,
  buildBrowserPasswordHintHtml,
  buildScreenshotCaptionForPage,
  captureBrowserScreenshot,
  tryHandleBrowserPasswordPrompt,
} = require('./auth-browser');
const { launchMaxContext } = require('./browser-context');

const MAX_LOGIN_URL = 'https://web.max.ru/';
const QR_REFRESH_MS = 45000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

let activeAuthSession = null;

function buildAuthModeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📷 QR-код', callback_data: 'auth:mode:qr' }],
      [{ text: '📱 Номер телефона', callback_data: 'auth:mode:phone' }],
    ],
  };
}

function buildScreenshotKeyboard() {
  return {
    inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'auth:refresh' }]],
  };
}

function isAuthSessionActive() {
  return Boolean(activeAuthSession);
}

function clearAuthSession() {
  activeAuthSession = null;
}

function isEditOk(result) {
  if (result.ok) return true;
  const desc = result.description || '';
  return /message is not modified/i.test(desc);
}

async function upsertAuthScreenshot(page, chatIds, options = {}) {
  const buffer = await captureLoginScreenshot(page);
  const caption = await buildScreenshotCaptionForPage(page);
  const replyMarkup = buildScreenshotKeyboard();
  const messageIds = activeAuthSession?.photoMessageIds || {};

  for (const chatId of chatIds) {
    const key = String(chatId);
    const existingId = messageIds[key];
    let result;

    if (existingId) {
      result = await editPhotoBuffer(key, existingId, buffer, caption, options.token, {
        reply_markup: replyMarkup,
      });

      if (!isEditOk(result)) {
        console.warn(`Не удалось обновить скриншот в ${key}: ${result.description}`);
        result = await sendPhotoBuffer(key, buffer, caption, options.token, {
          reply_markup: replyMarkup,
        });
      }
    } else {
      result = await sendPhotoBuffer(key, buffer, caption, options.token, {
        reply_markup: replyMarkup,
      });
    }

    if (!result.ok && !isEditOk(result)) {
      console.error(`Не удалось отправить скриншот в ${key}:`, result.description);
      continue;
    }

    if (result.result?.message_id) {
      messageIds[key] = result.result.message_id;
    }
  }

  if (activeAuthSession) {
    activeAuthSession.photoMessageIds = messageIds;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildScreenshotCaption() {
  const { buildQrScreenshotCaption } = require('./auth-browser');
  return buildQrScreenshotCaption();
}

async function refreshAuthScreenshot() {
  if (!activeAuthSession) {
    throw new Error('Сейчас авторизация не идёт. Отправьте /reauth');
  }

  const { page, chatIds, options } = activeAuthSession;
  await upsertAuthScreenshot(page, chatIds, options);
  activeAuthSession.lastQrSent = Date.now();
}

async function captureLoginScreenshot(page) {
  if (await isBrowserPasswordPrompt(page)) {
    return captureBrowserScreenshot(page);
  }

  await page.waitForTimeout(1500);

  const qrLocator = page
    .locator('canvas')
    .first()
    .or(page.locator('img[src*="qr"], img[alt*="QR" i], img[alt*="qr" i]').first())
    .or(page.locator('[class*="qr" i]').first());

  if (await qrLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
    const box = await qrLocator.boundingBox();
    if (box?.width && box?.height) {
      const padding = 48;
      const viewport = page.viewportSize() || { width: 1280, height: 900 };
      return page.screenshot({
        type: 'png',
        clip: {
          x: Math.max(0, box.x - padding),
          y: Math.max(0, box.y - padding),
          width: Math.min(viewport.width - Math.max(0, box.x - padding), box.width + padding * 2),
          height: Math.min(viewport.height - Math.max(0, box.y - padding), box.height + padding * 2),
        },
      });
    }
  }

  return page.screenshot({ type: 'png', fullPage: false });
}

function startAuthCallbackPoll(options = {}) {
  const adminIds = new Set((options.chatIds || getAdminChatIds()).map(String));

  return pollUpdates(async (update) => {
    const query = update.callback_query;
    if (!query || query.data !== 'auth:refresh') return;

    const chatId = String(query.message?.chat?.id || '');
    if (!adminIds.has(chatId)) {
      await answerCallback(query.id, 'Нет доступа', options.token);
      return;
    }

    await answerCallback(query.id, 'Обновляю…', options.token);

    try {
      await refreshAuthScreenshot();
    } catch (err) {
      await sendMessage(chatId, err.message, {}, options.token);
    }
  }, {
    token: options.token,
    onError: (err) => console.error('auth-qr poll:', err.message),
  });
}

async function waitForLogin(page, chatIds, options = {}) {
  const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
  const refreshMs = options.refreshMs ?? QR_REFRESH_MS;
  const started = Date.now();
  let lastQrSent = 0;
  let stopAuthPoll = null;

  activeAuthSession = { page, chatIds, options, lastQrSent: 0, photoMessageIds: {} };
  if (options.useAuthCallbackPoll) {
    stopAuthPoll = startAuthCallbackPoll({ ...options, chatIds });
  }

  try {
  while (Date.now() - started < timeoutMs) {
    if (!(await isLoginPage(page))) {
      return true;
    }

    await tryHandleBrowserPasswordPrompt(page, chatIds, options);

    if (Date.now() - lastQrSent >= refreshMs) {
      await upsertAuthScreenshot(page, chatIds, options);
      lastQrSent = Date.now();
      if (activeAuthSession) activeAuthSession.lastQrSent = lastQrSent;
      options.onQrSent?.();
    }

    await sleep(2000);
  }

  return false;
  } finally {
    stopAuthPoll?.();
    clearAuthSession();
  }
}

async function runAuthQrOnPage(page, chatIds, options = {}) {
  await page.goto(MAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);

  if (!(await isLoginPage(page))) {
    await sendMessage(
      chatIds[0],
      'Сессия MAX уже активна.',
      {},
      options.token
    );
    return true;
  }

  if (options.introMessage !== false) {
    const intro =
      options.introMessage ||
      '<b>Авторизация MAX</b>\nСейчас пришлю скриншот страницы входа — отсканируйте QR в приложении MAX.';

    for (const chatId of chatIds) {
      await sendMessage(
        chatId,
        `${intro}\n\n${buildBrowserPasswordHintHtml()}`,
        {},
        options.token
      );
    }
  }

  const ok = await waitForLogin(page, chatIds, options);
  if (!ok) {
    throw new Error(
      'Время ожидания входа истекло (10 мин). Запустите снова: bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)'
    );
  }

  if (options.afterLoginChatUrl) {
    await page.goto(options.afterLoginChatUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForTimeout(3000);
  }

  for (const chatId of chatIds) {
    await sendMessage(chatId, 'Вход в MAX выполнен.', {}, options.token);
  }

  return true;
}

async function chooseAuthModeTelegram(chatIds, options = {}) {
  if (options.mode === 'qr' || options.mode === 'phone') {
    return options.mode;
  }

  if (options.useWebPoll) {
    const { chooseAuthModeWeb } = require('./setup-portal/runner');
    const { getActivePortalState } = require('./setup-portal/runner');
    if (getActivePortalState()) {
      return chooseAuthModeWeb(getActivePortalState());
    }
  }

  const admins = new Set(chatIds.map(String));
  const keyboard = buildAuthModeKeyboard();

  for (const chatId of chatIds) {
    await sendMessage(
      chatId,
      'Выберите способ входа в MAX:',
      { reply_markup: keyboard },
      options.token
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopPoll = null;
    const timeoutMs = options.modeTimeoutMs ?? 5 * 60 * 1000;

    const finish = (mode) => {
      if (settled) return;
      settled = true;
      stopPoll?.();
      clearTimeout(timer);
      resolve(mode);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      stopPoll?.();
      clearTimeout(timer);
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error('Время выбора способа входа истекло (5 мин)'));
    }, timeoutMs);

    stopPoll = pollUpdates(async (update) => {
      const query = update.callback_query;
      if (!query?.data?.startsWith('auth:mode:')) return;

      const chatId = String(query.message?.chat?.id || '');
      if (!admins.has(chatId)) {
        await answerCallback(query.id, 'Нет доступа', options.token);
        return;
      }

      const mode = query.data === 'auth:mode:phone' ? 'phone' : 'qr';
      await answerCallback(
        query.id,
        mode === 'phone' ? 'Вход по номеру' : 'Вход по QR',
        options.token
      );
      finish(mode);
    }, {
      token: options.token,
      onError: (err) => fail(err),
    });
  });
}

async function runAuthOnPage(page, chatIds, options = {}) {
  const mode = options.mode === 'phone' ? 'phone' : 'qr';
  if (mode === 'phone') {
    return runAuthPhoneOnPage(page, chatIds, options);
  }
  return runAuthQrOnPage(page, chatIds, options);
}

async function runAuthTelegram(options = {}) {
  const settings = getSettings();
  const chatIds = (options.chatIds || getAdminChatIds()).map(String);
  if (!chatIds.length) {
    throw new Error('Не задан telegram.chatIds для авторизации');
  }

  const mode = await chooseAuthModeTelegram(chatIds, options);

  const context = await launchMaxContext(settings.userDataDir, {
    headless: true,
    deviceScaleFactor: 2,
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    return await runAuthOnPage(page, chatIds, { ...options, mode });
  } finally {
    await context.close();
  }
}

async function runAuthQrTelegram(options = {}) {
  const settings = getSettings();
  const chatIds = (options.chatIds || getAdminChatIds()).map(String);
  if (!chatIds.length) {
    throw new Error('Не задан telegram.chatIds для отправки скриншота');
  }

  const context = await launchMaxContext(settings.userDataDir, {
    headless: true,
    deviceScaleFactor: 2,
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    return await runAuthQrOnPage(page, chatIds, options);
  } finally {
    await context.close();
  }
}

module.exports = {
  MAX_LOGIN_URL,
  AUTH_TIMEOUT_MS,
  QR_REFRESH_MS,
  runAuthTelegram,
  runAuthOnPage,
  chooseAuthModeTelegram,
  buildAuthModeKeyboard,
  runAuthQrTelegram,
  runAuthQrOnPage,
  captureLoginScreenshot,
  captureQrImage: captureLoginScreenshot,
  waitForLogin,
  refreshAuthScreenshot,
  isAuthSessionActive,
  buildScreenshotKeyboard,
};
