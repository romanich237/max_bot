const { getSettings, getAdminChatIds } = require('./config');
const { sendMessage, answerCallback, pollUpdates } = require('./tg-api');
const { buildEventMessage, notifyEvent } = require('./tg-events');
const { isLoginPage } = require('./parser');
const { runAuthPhoneOnPage } = require('./auth-phone');
const {
  isBrowserPasswordPrompt,
  buildBrowserPasswordHintHtml,
  captureBrowserScreenshot,
  tryHandleBrowserPasswordPrompt,
  qrRefreshSeconds,
} = require('./auth-browser');
const {
  DEFAULT_QR_REFRESH_MS,
  buildScreenshotKeyboard,
  beginCaptionSession,
  endCaptionSession,
  isCaptionSessionActive,
  getCaptionSession,
  markQrRefreshed,
  upsertAuthScreenshot,
  upsertAuthText,
} = require('./auth-caption');
const { launchMaxContext } = require('./browser-context');
const { BUTTONS, AUTH } = require('./bot-texts');
const { deleteMessageQuiet } = require('./tg-step-chat');

const MAX_LOGIN_URL = 'https://web.max.ru/';
const QR_REFRESH_MS = DEFAULT_QR_REFRESH_MS;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

function buildAuthModeKeyboard(options = {}) {
  const rows = [];
  if (options.allowQr !== false) {
    rows.push([{ text: BUTTONS.authQr, callback_data: 'auth:mode:qr' }]);
  }
  rows.push([{ text: BUTTONS.authPhone, callback_data: 'auth:mode:phone' }]);
  return { inline_keyboard: rows };
}

function buildPhoneAuthWarningMessage() {
  return buildEventMessage({ ...AUTH.phoneWarning, status: 'wait' });
}

const PHONE_AUTH_WARNING_SHORT = AUTH.phoneWarningShort;

function buildActiveSessionMessage() {
  return buildEventMessage({ ...AUTH.sessionActive, status: 'done' });
}

async function probeMaxSession(page, chatUrl) {
  if (!page || page.isClosed()) return false;

  if (!(await isLoginPage(page))) {
    return true;
  }

  const target = chatUrl || MAX_LOGIN_URL;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);

  if (!(await isLoginPage(page))) {
    return true;
  }

  await page.waitForTimeout(2000);
  return !(await isLoginPage(page));
}

function isAuthSessionActive() {
  return isCaptionSessionActive();
}

function clearAuthSession() {
  endCaptionSession();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureAuthScreenshot(page) {
  if (await isBrowserPasswordPrompt(page)) {
    return captureBrowserScreenshot(page);
  }
  return captureLoginScreenshot(page);
}

async function upsertLoginScreenshot(page, chatIds, options = {}) {
  const isPassword = await isBrowserPasswordPrompt(page);

  if (!isPassword && options.sendQrPhotos === false) {
    await upsertAuthText(page, chatIds, options);
    return;
  }

  await upsertAuthScreenshot(page, chatIds, options, captureAuthScreenshot);
}

async function ensureQrLoginView(page) {
  const qrForm = page.locator('form.auth--qr-code');
  if (await qrForm.isVisible({ timeout: 1500 }).catch(() => false)) {
    return;
  }

  const qrTab = page.getByRole('button', { name: /qr|qr-код/i });
  if (await qrTab.isVisible({ timeout: 1500 }).catch(() => false)) {
    await qrTab.click();
    await page.waitForTimeout(1000);
    return;
  }

  await page.goto(MAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);
}

async function refreshQrCodeSession(page) {
  if (await isBrowserPasswordPrompt(page)) {
    return { ok: false, reason: 'browser-password' };
  }

  await ensureQrLoginView(page);

  const refreshBtn = page
    .getByRole('button', { name: /refresh qr code/i })
    .or(page.locator('button[aria-label="Refresh QR code"]'))
    .or(page.locator('form.auth--qr-code .qr button.button--primary[type="button"]'))
    .or(page.locator('form.auth--qr-code button.button--primary[type="button"]'));

  const btn = refreshBtn.first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(2000);
    return { ok: true, method: 'button' };
  }

  await page.goto(MAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);
  return { ok: true, method: 'reload' };
}

async function refreshAuthScreenshot() {
  const session = getCaptionSession();
  if (!session) {
    throw new Error('Сейчас авторизация не идёт. Отправьте /reauth');
  }

  const { page, chatIds, options } = session;
  await refreshQrCodeSession(page);
  await upsertLoginScreenshot(page, chatIds, options);
  markQrRefreshed();
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
  if (options.skipAuthCallbackPoll) return () => {};

  const adminIds = new Set((options.chatIds || getAdminChatIds()).map(String));

  return pollUpdates(async (update) => {
    const query = update.callback_query;
    if (!query || query.data !== 'auth:refresh') return false;

    const chatId = String(query.message?.chat?.id || '');
    if (!adminIds.has(chatId)) {
      await answerCallback(query.id, 'Нет доступа', options.token);
      return true;
    }

    await answerCallback(query.id, 'Обновляю…', options.token);

    try {
      await refreshAuthScreenshot();
    } catch (err) {
      await sendMessage(chatId, err.message, {}, options.token);
    }
    return true;
  }, {
    priority: 10,
    token: options.token,
    onError: (err) => console.error('auth-qr poll:', err.message),
  });
}

async function waitForLogin(page, chatIds, options = {}) {
  const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
  const refreshMs = options.refreshMs ?? QR_REFRESH_MS;
  options.refreshMs = refreshMs;
  const started = Date.now();
  let lastQrSent = 0;
  let stopAuthPoll = null;

  beginCaptionSession(chatIds, options, page);
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
      await refreshQrCodeSession(page);
      await upsertLoginScreenshot(page, chatIds, options);
      lastQrSent = Date.now();
      markQrRefreshed();
      options.onQrSent?.();
    }

    await sleep(2000);
  }

  return false;
  } finally {
    stopAuthPoll?.();
    endCaptionSession();
  }
}

async function runAuthQrOnPage(page, chatIds, options = {}) {
  await page.goto(MAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);

  if (!(await isLoginPage(page))) {
    await notifyEvent(chatIds, {
      title: 'Сессия MAX активна',
      status: 'done',
      lines: [
        'Повторный вход не нужен — сессия уже авторизована.',
        'Чтобы войти заново, удалите это устройство в MAX: настройки → Безопасность → Устройства.',
      ],
    }, options);
    return true;
  }

  if (options.introMessage !== false) {
    const intro =
      options.introMessage ||
      buildEventMessage({
        ...AUTH.qrIntro(qrRefreshSeconds(QR_REFRESH_MS)),
        status: 'wait',
        step: 1,
        total: 3,
        lines: [
          ...AUTH.qrIntro(qrRefreshSeconds(QR_REFRESH_MS)).lines,
          '',
          buildBrowserPasswordHintHtml(),
        ],
      });

    const introMessageIds = new Map();
    for (const chatId of chatIds) {
      const result = await sendMessage(chatId, intro, {}, options.token);
      if (result?.result?.message_id) {
        introMessageIds.set(String(chatId), result.result.message_id);
      }
    }

    const cleanupIntro = async () => {
      for (const [chatId, messageId] of introMessageIds) {
        await deleteMessageQuiet(chatId, messageId, options.token);
      }
      introMessageIds.clear();
    };

    options.onQrSent = (() => {
      const prev = options.onQrSent;
      return async () => {
        await cleanupIntro();
        await prev?.();
      };
    })();
  }

  const ok = await waitForLogin(page, chatIds, options);
  if (!ok) {
    throw new Error(AUTH.timeout);
  }

  if (options.afterLoginChatUrl) {
    await page.goto(options.afterLoginChatUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForTimeout(3000);
  }

  await notifyEvent(
    chatIds,
    {
      title: AUTH.loginDone.title,
      status: 'done',
      step: 5,
      total: 5,
      lines: AUTH.loginDone.lines,
    },
    options
  );

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
  const keyboard = buildAuthModeKeyboard({
    allowQr: options.allowQr !== false,
  });

  for (const chatId of chatIds) {
    await sendMessage(
      chatId,
      buildEventMessage({ ...AUTH.chooseMode, status: 'wait', step: 1, total: 5 }),
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
      if (!query?.data?.startsWith('auth:mode:')) return false;

      const chatId = String(query.message?.chat?.id || '');
      if (!admins.has(chatId)) {
        await answerCallback(query.id, 'Нет доступа', options.token);
        return true;
      }

      const mode = query.data === 'auth:mode:phone' ? 'phone' : 'qr';
      await answerCallback(
        query.id,
        mode === 'phone' ? 'Вход по номеру' : 'Вход по QR',
        options.token
      );
      if (query.message?.message_id) {
        await deleteMessageQuiet(chatId, query.message.message_id, options.token);
      }
      if (mode === 'phone') {
        await sendMessage(chatId, buildPhoneAuthWarningMessage(), {}, options.token);
      }
      finish(mode);
      return true;
    }, {
      priority: 10,
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
    return await runAuthOnPage(page, chatIds, {
      sendQrPhotos: options.sendQrPhotos !== false,
      sendCaptchaPhotos: options.sendCaptchaPhotos === true,
      sendPasswordPhotos: options.sendPasswordPhotos !== false,
      ...options,
      mode,
    });
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
  buildPhoneAuthWarningMessage,
  PHONE_AUTH_WARNING_SHORT,
  buildActiveSessionMessage,
  probeMaxSession,
  runAuthQrTelegram,
  runAuthQrOnPage,
  captureLoginScreenshot,
  captureQrImage: captureLoginScreenshot,
  waitForLogin,
  refreshAuthScreenshot,
  refreshQrCodeSession,
  isAuthSessionActive,
  buildScreenshotKeyboard,
};
