const { getMax } = require('./config');
const { sendMessage } = require('./tg-api');
const { promptTelegramText } = require('./auth-prompt');

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

function buildQrScreenshotCaption() {
  const password = getBrowserPassword();
  const lines = [
    'Скриншот входа MAX.',
    'Отсканируйте QR в приложении MAX.',
    'Если появится @Browser — введите пароль от аккаунта (из личного кабинета).',
  ];

  if (password) {
    lines.push(`Пароль: ${password}`);
  }

  lines.push('Обновляется каждые 45 сек. Или нажмите «Обновить».');
  return lines.join('\n');
}

function buildBrowserScreenshotCaption() {
  const password = getBrowserPassword();
  const lines = [
    'Вход @Browser в MAX.',
    'Введите пароль от аккаунта (из личного кабинета).',
  ];

  if (password) {
    lines.push(`Пароль: ${password}`);
    lines.push('Бот вводит пароль автоматически.');
  } else {
    lines.push('Задайте: /set browserpassword ваш_пароль');
  }

  lines.push('Обновляется каждые 45 сек. Или нажмите «Обновить».');
  return lines.join('\n');
}

async function buildScreenshotCaptionForPage(page) {
  if (await isBrowserPasswordPrompt(page)) {
    return buildBrowserScreenshotCaption();
  }
  return buildQrScreenshotCaption();
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
  await input.fill(password);

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

  return promptTelegramText(
    chatIds,
    [
      'В MAX появился вход <b>@Browser</b>.',
      'Отправьте пароль от аккаунта (личный кабинет MAX → Безопасность).',
      'Или задайте заранее: <code>/set browserpassword ваш_пароль</code>',
    ].join('\n'),
    {
      token: options.token,
      useAdminPoll: options.useAdminPoll,
      useWebPoll: options.useWebPoll,
      field: 'password',
      label: 'Пароль @Browser',
      hint: 'Пароль из личного кабинета MAX',
      validate: (text) => (text.trim() ? text.trim() : null),
      invalidMessage: 'Пароль не может быть пустым. Отправьте пароль или /cancel.',
    }
  );
}

async function handleBrowserPasswordPrompt(page, chatIds, options = {}) {
  const configured = getBrowserPassword();
  const password = configured || (await resolveBrowserPassword(chatIds, options));
  await fillBrowserPassword(page, password);
  await page.waitForTimeout(2500);
  return true;
}

async function tryHandleBrowserPasswordPrompt(page, chatIds, options = {}) {
  if (!(await isBrowserPasswordPrompt(page))) return false;

  if (!options.browserHintSent && chatIds?.length) {
    for (const chatId of chatIds) {
      await sendMessage(chatId, buildBrowserPasswordHintHtml(), {}, options.token);
    }
    options.browserHintSent = true;
  }

  await handleBrowserPasswordPrompt(page, chatIds, options);
  return true;
}

module.exports = {
  getBrowserPassword,
  isBrowserPasswordPrompt,
  buildBrowserPasswordHintHtml,
  buildQrScreenshotCaption,
  buildBrowserScreenshotCaption,
  buildScreenshotCaptionForPage,
  captureBrowserScreenshot,
  fillBrowserPassword,
  resolveBrowserPassword,
  handleBrowserPasswordPrompt,
  tryHandleBrowserPasswordPrompt,
};
