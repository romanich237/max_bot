const { chromium } = require('playwright');
const { getSettings, getAdminChatIds } = require('./config');
const { sendMessage, sendPhotoBuffer } = require('./tg-api');
const { isLoginPage } = require('./parser');

const MAX_LOGIN_URL = 'https://web.max.ru/';
const QR_REFRESH_MS = 45000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForLogin(page, chatIds, options = {}) {
  const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
  const refreshMs = options.refreshMs ?? QR_REFRESH_MS;
  const started = Date.now();
  let lastQrSent = 0;

  while (Date.now() - started < timeoutMs) {
    if (!(await isLoginPage(page))) {
      return true;
    }

    if (Date.now() - lastQrSent >= refreshMs) {
      const buffer = await captureLoginScreenshot(page);
      const caption =
        'Скриншот входа MAX.\nОтсканируйте QR в приложении MAX.\nОбновляется каждые 45 сек.';

      for (const chatId of chatIds) {
        const result = await sendPhotoBuffer(chatId, buffer, caption, options.token);
        if (!result.ok) {
          console.error(`Не удалось отправить скриншот в ${chatId}:`, result.description);
        }
      }

      lastQrSent = Date.now();
      options.onQrSent?.();
    }

    await sleep(2000);
  }

  return false;
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
};
