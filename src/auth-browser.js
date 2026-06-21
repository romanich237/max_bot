const { getMax, store } = require('./config');
const { sendMessage } = require('./tg-api');
const { promptTelegramText } = require('./auth-prompt');
const { buildEventMessage, notifyEvent } = require('./tg-events');
const { AUTH } = require('./bot-texts');

function buildBrowserPasswordAcceptedMessage() {
  return buildEventMessage({ ...AUTH.passwordAccepted, status: 'done' });
}

function buildBrowserPasswordSavedMessage({ delivered = false } = {}) {
  if (delivered) {
    return buildEventMessage({ ...AUTH.passwordAccepted, status: 'done' });
  }
  return buildEventMessage({ ...AUTH.passwordSaved, status: 'done' });
}

function buildBrowserPasswordPromptMessage() {
  return buildEventMessage({ ...AUTH.passwordPrompt, status: 'wait' });
}

async function notifyPasswordAccepted(chatIds, options = {}) {
  const text = buildBrowserPasswordAcceptedMessage();
  for (const chatId of chatIds || []) {
    await sendMessage(chatId, text, {}, options.token);
  }
}

let passwordDelivery = null;

function deliverBrowserPassword(password) {
  if (!passwordDelivery) return false;
  const { resolve, clearWaiter } = passwordDelivery;
  passwordDelivery = null;
  clearWaiter?.();
  resolve(password);
  return true;
}

function clearPasswordDelivery() {
  passwordDelivery = null;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function maskBrowserPassword(password) {
  const value = String(password || '');
  if (!value) return '';
  if (value.length <= 2) return '••••';
  return `${value[0]}${'•'.repeat(Math.min(value.length - 2, 8))}${value[value.length - 1]}`;
}

function parseBrowserPasswordCommand(text) {
  const withValue = String(text || '').match(/^\/set\s+browserpassword\s+([\s\S]+)$/i);
  if (withValue) {
    const password = withValue[1].trim();
    return password ? { password } : { error: AUTH.passwordEmpty };
  }
  if (/^\/set\s+browserpassword$/i.test(String(text || '').trim())) {
    return { prompt: true };
  }
  return null;
}

function acceptBrowserPassword(password) {
  const pwd = String(password || '').trim();
  if (!pwd) return { ok: false, error: AUTH.passwordEmpty };
  store.setPath(['max', 'browserPassword'], pwd);
  return { ok: true, password: pwd, delivered: deliverBrowserPassword(pwd) };
}

function getBrowserPassword() {
  const value = getMax().browserPassword;
  return value ? String(value) : '';
}

async function readBodyText(page) {
  return page.locator('body').innerText();
}

async function isBrowserPasswordPrompt(page) {
  const passwordInput = page.locator('input[type="password"]').first();
  const hasPassword = await passwordInput
    .isVisible({ timeout: 300 })
    .catch(() => false);
  if (!hasPassword) return false;

  const bodyText = await readBodyText(page);
  if (/@browser/i.test(bodyText)) return true;

  const lower = bodyText.toLowerCase();
  return (
    /browser/.test(lower) ||
    /пароль/.test(lower) ||
    /password/.test(lower) ||
    /облачн/.test(lower) ||
    /устройств/.test(lower) ||
    /подтверд/.test(lower)
  );
}

function buildBrowserPasswordHintHtml() {
  const password = getBrowserPassword();
  return AUTH.passwordHint(Boolean(password), escapeHtml(maskBrowserPassword(password)));
}

const DEFAULT_QR_REFRESH_MS = 45000;

function qrRefreshSeconds(refreshMs = DEFAULT_QR_REFRESH_MS) {
  return Math.max(1, Math.round(refreshMs / 1000));
}

function qrSecondsRemaining(lastQrSent, refreshMs = DEFAULT_QR_REFRESH_MS) {
  const totalSec = qrRefreshSeconds(refreshMs);
  if (!lastQrSent) return totalSec;
  const elapsed = Date.now() - lastQrSent;
  const remainingMs = refreshMs - (elapsed % refreshMs);
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function buildQrScreenshotCaption(options = {}) {
  const refreshMs = options.refreshMs ?? DEFAULT_QR_REFRESH_MS;
  const sec = options.secondsRemaining ?? qrRefreshSeconds(refreshMs);
  return AUTH.qrCaption(sec);
}

function buildBrowserScreenshotCaption(options = {}) {
  const refreshMs = options.refreshMs ?? DEFAULT_QR_REFRESH_MS;
  const sec = options.secondsRemaining ?? qrRefreshSeconds(refreshMs);
  return AUTH.passwordCaption(sec);
}

async function buildScreenshotCaptionForPage(page, options = {}) {
  const refreshMs = options.refreshMs ?? DEFAULT_QR_REFRESH_MS;
  const captionOptions = {
    refreshMs,
    secondsRemaining: options.secondsRemaining,
  };
  if (await isBrowserPasswordPrompt(page)) {
    return buildBrowserScreenshotCaption(captionOptions);
  }
  return buildQrScreenshotCaption(captionOptions);
}

async function captureBrowserScreenshot(page) {
  await page.waitForTimeout(500);

  const passwordInput = page.locator('input[type="password"]').first();
  if (await passwordInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    const box = await passwordInput.boundingBox();
    if (box?.width && box?.height) {
      const viewport = page.viewportSize() || { width: 1280, height: 900 };
      const paddingX = 80;
      const paddingTop = 160;
      const paddingBottom = 120;
      return page.screenshot({
        type: 'png',
        clip: {
          x: Math.max(0, box.x - paddingX),
          y: Math.max(0, box.y - paddingTop),
          width: Math.min(viewport.width - Math.max(0, box.x - paddingX), box.width + paddingX * 2),
          height: Math.min(
            viewport.height - Math.max(0, box.y - paddingTop),
            box.height + paddingTop + paddingBottom
          ),
        },
      });
    }
  }

  return page.screenshot({ type: 'png', fullPage: false });
}

async function fillBrowserPassword(page, password) {
  const input = page
    .locator('input[type="password"]')
    .first()
    .or(page.getByRole('textbox', { name: /password|пароль/i }));

  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(password);

  const continueBtn = page
    .getByRole('button', {
      name: /продолжить|continue|войти|sign in|далее|next|готово|done|подтвердить|confirm/i,
    })
    .first();

  if (await continueBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await continueBtn.click({ timeout: 5000 });
    return;
  }

  await input.press('Enter');
}

async function waitForBrowserPasswordResult(page) {
  const passwordInput = page.locator('input[type="password"]').first();
  try {
    await passwordInput.waitFor({ state: 'hidden', timeout: 8000 });
    return;
  } catch {
    if (await isBrowserPasswordPrompt(page)) {
      throw new Error('Пароль не принят. Проверьте пароль и отправьте /reauth');
    }
  }
}

async function resolveBrowserPassword(chatIds, options = {}) {
  const configured = getBrowserPassword();
  if (configured) return configured;

  const promptMessage = options.skipPromptMessage
    ? null
    : buildEventMessage({ ...AUTH.passwordWait, status: 'wait' });

  let deliveryResolve;
  const deliveryPromise = new Promise((resolve) => {
    deliveryResolve = resolve;
  });

  const { clearAuthInputWaiter } = require('./tg-admin');
  passwordDelivery = {
    resolve: deliveryResolve,
    clearWaiter: clearAuthInputWaiter,
  };

  try {
    const password = await Promise.race([
      promptTelegramText(chatIds, promptMessage, {
        token: options.token,
        useAdminPoll: options.useAdminPoll,
        useWebPoll: options.useWebPoll,
        field: 'password',
        label: 'Пароль для входа',
        hint: 'Пароль из личного кабинета MAX',
        validate: (text) => (text.trim() ? text.trim() : null),
        invalidMessage: AUTH.passwordEmpty,
        onAccepted: () => notifyPasswordAccepted(chatIds, options),
      }),
      deliveryPromise,
    ]);

    return password;
  } finally {
    clearPasswordDelivery();
    clearAuthInputWaiter();
  }
}

async function handleBrowserPasswordPrompt(page, chatIds, options = {}) {
  const configured = getBrowserPassword();
  const password =
    configured ||
    (await resolveBrowserPassword(chatIds, {
      ...options,
      skipPromptMessage: Boolean(options.browserScreenshotSent),
    }));

  if (!configured && password) {
    acceptBrowserPassword(password);
  }

  if (configured) {
    await notifyEvent(
      chatIds,
      {
        title: 'Вхожу в MAX',
        status: 'progress',
        lines: ['Ввожу пароль…'],
      },
      options
    );
  }

  await fillBrowserPassword(page, password);
  await waitForBrowserPasswordResult(page);

  return true;
}

async function tryHandleBrowserPasswordPrompt(page, chatIds, options = {}) {
  if (!(await isBrowserPasswordPrompt(page))) return false;
  if (options.browserPasswordResolving) return true;

  if (options.sendPasswordPhotos !== false && !options.browserScreenshotSent && chatIds?.length) {
    const {
      isCaptionSessionActive,
      beginCaptionSession,
      upsertAuthScreenshot,
      markQrRefreshed,
    } = require('./auth-caption');

    if (!isCaptionSessionActive()) {
      beginCaptionSession(chatIds, options, page);
    }

    await upsertAuthScreenshot(page, chatIds, options, captureBrowserScreenshot);
    markQrRefreshed();
    options.browserScreenshotSent = true;
  }

  options.browserPasswordResolving = true;
  try {
    await handleBrowserPasswordPrompt(page, chatIds, options);
  } catch (err) {
    for (const chatId of chatIds) {
      await sendMessage(
        chatId,
        buildEventMessage({ ...AUTH.passwordFail(err.message), status: 'fail' }),
        {},
        options.token
      );
    }
    return false;
  } finally {
    options.browserPasswordResolving = false;
  }

  await notifyEvent(
    chatIds,
    {
      title: 'Пароль принят',
      status: 'done',
      lines: ['Продолжаю вход в MAX.'],
    },
    options
  );

  return true;
}

module.exports = {
  getBrowserPassword,
  maskBrowserPassword,
  parseBrowserPasswordCommand,
  acceptBrowserPassword,
  isBrowserPasswordPrompt,
  buildBrowserPasswordHintHtml,
  buildBrowserPasswordAcceptedMessage,
  buildBrowserPasswordSavedMessage,
  buildBrowserPasswordPromptMessage,
  deliverBrowserPassword,
  buildQrScreenshotCaption,
  buildBrowserScreenshotCaption,
  buildScreenshotCaptionForPage,
  qrRefreshSeconds,
  qrSecondsRemaining,
  DEFAULT_QR_REFRESH_MS,
  captureBrowserScreenshot,
  fillBrowserPassword,
  resolveBrowserPassword,
  handleBrowserPasswordPrompt,
  tryHandleBrowserPasswordPrompt,
};
