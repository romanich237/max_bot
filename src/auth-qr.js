const { chromium } = require('playwright');
const { getSettings, getAdminChatIds } = require('./config');
const { sendMessage, sendPhotoBuffer, answerCallback, pollUpdates } = require('./tg-api');
const { isLoginPage } = require('./parser');

const MAX_LOGIN_URL = 'https://web.max.ru/';
const QR_REFRESH_MS = 45000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

let activeAuthSession = null;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildScreenshotCaption() {
  return [
    'Скриншот входа MAX.',
    'Отсканируйте QR в приложении MAX.',
    'Обновляется каждые 45 сек. Или нажмите «Обновить».',
  ].join('\n');
}

async function sendAuthScreenshot(page, chatIds, options = {}) {
  const buffer = await captureLoginScreenshot(page);
  const caption = buildScreenshotCaption();
  const replyMarkup = buildScreenshotKeyboard();

  for (const chatId of chatIds) {
    const result = await sendPhotoBuffer(chatId, buffer, caption, options.token, {
      reply_markup: replyMarkup,
    });
    if (!result.ok) {
      console.error(`Не удалось отправить скриншот в ${chatId}:`, result.description);
    }
  }
}

async function refreshAuthScreenshot() {
  if (!activeAuthSession) {
    throw new Error('Сейчас авторизация не идёт. Отправьте /reauth');
  }

  const { page, chatIds, options } = activeAuthSession;
  await sendAuthScreenshot(page, chatIds, options);
  activeAuthSession.lastQrSent = Date.now();
}

async function captureLoginScreenshot(page) {
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

  activeAuthSession = { page, chatIds, options, lastQrSent: 0 };
  if (options.useAuthCallbackPoll) {
    stopAuthPoll = startAuthCallbackPoll({ ...options, chatIds });
  }

  try {
  while (Date.now() - started < timeoutMs) {
    if (!(await isLoginPage(page))) {
      return true;
    }

    if (Date.now() - lastQrSent >= refreshMs) {
      await sendAuthScreenshot(page, chatIds, options);
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
      await sendMessage(chatId, intro, {}, options.token);
    }
  }

  const ok = await waitForLogin(page, chatIds, options);
  if (!ok) {
    throw new Error(
      'Время ожидания входа истекло (10 мин). Запустите снова: bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)'
    );
  }

  for (const chatId of chatIds) {
    await sendMessage(chatId, 'Вход в MAX выполнен.', {}, options.token);
  }

  return true;
}

async function runAuthQrTelegram(options = {}) {
  const settings = getSettings();
  const chatIds = (options.chatIds || getAdminChatIds()).map(String);
  if (!chatIds.length) {
    throw new Error('Не задан telegram.chatIds для отправки скриншота');
  }

  const context = await chromium.launchPersistentContext(settings.userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    locale: 'ru-RU',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    return await runAuthQrOnPage(page, chatIds, options);
  } finally {
    await context.close();
  }
}

module.exports = {
  runAuthQrTelegram,
  runAuthQrOnPage,
  captureLoginScreenshot,
  captureQrImage: captureLoginScreenshot,
  waitForLogin,
  refreshAuthScreenshot,
  isAuthSessionActive,
  buildScreenshotKeyboard,
};
