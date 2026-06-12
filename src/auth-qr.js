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

async function captureQrImage(page) {
  const canvas = page.locator('canvas').first();
  if (await canvas.isVisible({ timeout: 3000 }).catch(() => false)) {
    return canvas.screenshot({ type: 'png' });
  }

  const loginImg = page
    .locator('img[src*="qr"], img[alt*="QR" i], img[alt*="qr" i]')
    .first();
  if (await loginImg.isVisible({ timeout: 2000 }).catch(() => false)) {
    return loginImg.screenshot({ type: 'png' });
  }

  const loginPanel = page
    .locator('main, [class*="login"], [class*="auth"], [class*="qr"]')
    .first();
  if (await loginPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
    return loginPanel.screenshot({ type: 'png' });
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
      const buffer = await captureQrImage(page);
      const caption =
        'Отсканируйте QR-код в приложении MAX.\nКод обновляется каждые 45 секунд.';

      for (const chatId of chatIds) {
        const result = await sendPhotoBuffer(chatId, buffer, caption, options.token);
        if (!result.ok) {
          console.error(`Не удалось отправить QR в ${chatId}:`, result.description);
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

  await sendMessage(
    chatIds[0],
    'Открыта страница входа MAX. Сейчас пришлю QR-код…',
    {},
    options.token
  );

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
    throw new Error('Не задан telegram.chatIds для отправки QR');
  }

  const context = await chromium.launchPersistentContext(settings.userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
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
  captureQrImage,
  waitForLogin,
};
