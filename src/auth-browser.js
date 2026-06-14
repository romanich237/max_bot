const { getMax, store } = require('./config');
const { sendMessage } = require('./tg-api');
const { promptTelegramText } = require('./auth-prompt');
const { buildEventMessage, notifyEvent } = require('./tg-events');

function buildBrowserPasswordAcceptedMessage() {
  return buildEventMessage({
    title: 'Пароль принят',
    status: 'done',
    lines: ['Ввожу пароль @Browser в MAX…'],
  });
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

function getBrowserPassword() {
  const value = getMax().browserPassword;
  return value ? String(value) : '';
}

async function readBodyText(page) {
  return page.locator('body').innerText();
}

async function isBrowserPasswordPrompt(page) {
  const bodyText = await readBodyText(page);
  if (/@browser/i.test(bodyText)) return true;

  const hasPassword = await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (!hasPassword) return false;

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
  const lines = [
    'Если в MAX появится <code>@Browser</code> — введите пароль от аккаунта (из личного кабинета MAX → Безопасность).',
  ];

  if (password) {
    lines.push(`Пароль: <code>${escapeHtml(password)}</code>`);
    lines.push('Бот введёт его автоматически на странице входа.');
  } else {
    lines.push('Задайте пароль: <code>/set browserpassword ваш_пароль</code>');
  }

  return lines.join('\n');
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
  return [
    '🔐 Вход в MAX',
    'Отсканируйте QR-код в приложении MAX.',
    `QR-код обновляется каждые ${sec} секунд — это создаёт новую сессию.`,
    '👉 Не успели? Нажмите «Обновить» вручную.',
  ].join('\n');
}

function buildBrowserScreenshotCaption(options = {}) {
  const refreshMs = options.refreshMs ?? DEFAULT_QR_REFRESH_MS;
  const sec = options.secondsRemaining ?? qrRefreshSeconds(refreshMs);
  return [
    'Вход в MAX',
    'Пароль: из личного кабинета.',
    'Установка: /set browserpassword [пароль]',
    `Обновление: ${sec} с · кнопка «Обновить»`,
    'Статус: в процессе',
  ].join('\n');
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
  await page.waitForTimeout(1200);

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
  await input.click();
  await input.fill('');
  await input.pressSequentially(password, { delay: 40 });

  const continueBtn = page
    .getByRole('button', { name: /продолжить|continue|войти|sign in|далее|next|готово|done|подтвердить|confirm/i })
    .first();

  if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await continueBtn.click({ timeout: 5000 });
    return;
  }

  const submit = page.getByRole('button', {
    name: /войти|sign in|продолжить|continue|подтвердить|confirm|далее|next|готово|done/i,
  });

  for (let i = 0; i < await submit.count(); i++) {
    const btn = submit.nth(i);
    if (await btn.isVisible().catch(() => false) && (await btn.isEnabled().catch(() => false))) {
      await btn.click();
      return;
    }
  }

  await input.press('Enter');
}

async function resolveBrowserPassword(chatIds, options = {}) {
  const configured = getBrowserPassword();
  if (configured) return configured;

  const promptMessage = options.skipPromptMessage
    ? null
    : buildEventMessage({
        title: 'Пароль @Browser',
        status: 'wait',
        lines: [
          'Отправьте пароль от аккаунта (личный кабинет MAX → Безопасность).',
          'Или задайте заранее: <code>/set browserpassword ваш_пароль</code>',
        ],
      });

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
        label: 'Пароль @Browser',
        hint: 'Пароль из личного кабинета MAX',
        validate: (text) => (text.trim() ? text.trim() : null),
        invalidMessage: 'Пароль не может быть пустым. Отправьте пароль или /cancel.',
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
    store.setPath(['max', 'browserPassword'], password);
  }

  if (configured) {
    await notifyEvent(
      chatIds,
      {
        title: 'Вхожу в MAX',
        status: 'progress',
        lines: ['Ввожу пароль @Browser…'],
      },
      options
    );
  }

  await fillBrowserPassword(page, password);
  await page.waitForTimeout(2500);

  if (await isBrowserPasswordPrompt(page)) {
    throw new Error('Пароль @Browser не принят. Проверьте пароль и отправьте /reauth');
  }

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
        buildEventMessage({
          title: 'Пароль @Browser не принят',
          status: 'fail',
          lines: [
            err.message,
            'Отправьте пароль <b>текстом</b> (без команды) или:',
            '<code>/set browserpassword ваш_пароль</code>',
          ],
        }),
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
      title: 'Пароль @Browser принят',
      status: 'done',
      lines: ['Продолжаю вход в MAX.'],
    },
    options
  );

  return true;
}

module.exports = {
  getBrowserPassword,
  isBrowserPasswordPrompt,
  buildBrowserPasswordHintHtml,
  buildBrowserPasswordAcceptedMessage,
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
