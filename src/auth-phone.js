const { sendMessage } = require('./tg-api');
const { isLoginPage } = require('./parser');
const { promptTelegramText, sleep } = require('./auth-prompt');
const { notifyEvent, maskPhone, buildEventMessage } = require('./tg-events');
const {
  isBrowserPasswordPrompt,
  buildBrowserPasswordHintHtml,
  tryHandleBrowserPasswordPrompt,
} = require('./auth-browser');
const { isCaptchaPage, waitForCaptchaResolved, hasVisibleSmsInputs } = require('./auth-captcha');
const { beginCaptionSession, endCaptionSession } = require('./auth-caption');

const AUTH_STEPS = 5;
const MAX_LOGIN_URL = 'https://web.max.ru/';
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

async function notifyAuthDone(chatIds, options, payload) {
  await notifyEvent(chatIds, payload, options);
}

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return digits.slice(1);
  }
  if (digits.length === 10) return digits;
  return null;
}

function normalizeSmsCode(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length >= 4 && digits.length <= 8) return digits;
  return null;
}

async function openPhoneLoginForm(page) {
  const phoneBtn = page.getByRole('button', {
    name: /войти по номеру телефона|sign in with phone|phone number/i,
  });

  if (await phoneBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await phoneBtn.click();
    await page.waitForTimeout(1500);
    return;
  }

  const qrBtn = page.getByRole('button', { name: /войти по qr|sign in via qr|qr code/i });
  if (await qrBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    return;
  }

  throw new Error('Не найдена кнопка «Войти по номеру телефона» на странице MAX');
}

async function fillPhoneNumber(page, phone10) {
  const countryBtn = page.getByRole('button', { name: /🇷🇺|\+7|Russia/i }).first();
  if (await countryBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await countryBtn.click().catch(() => {});
    const russia = page.getByRole('button', { name: /🇷🇺.*\+7|Russia.*\+7/i }).first();
    if (await russia.isVisible({ timeout: 1500 }).catch(() => false)) {
      await russia.click();
      await page.waitForTimeout(400);
    }
  }

  const input = page.getByRole('textbox').first();
  await input.click();
  await input.fill('');
  await input.pressSequentially(phone10, { delay: 60 });
  await page.waitForTimeout(600);
}

async function clickSignIn(page) {
  const btn = page.getByRole('button', { name: /^(Sign in|Войти)$/i });
  await btn.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
}

async function isAuthComplete(page) {
  if (await isLoginPage(page)) return false;
  if (await hasVisibleSmsInputs(page)) return false;
  if (await isBrowserPasswordPrompt(page)) return false;
  if (await isCaptchaPage(page)) return false;

  const url = page.url();
  if (/web\.max\.ru\/-\d+/.test(url)) {
    return page
      .locator('.messageWrapper, .openedChat')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
  }

  return false;
}

async function isSmsCodePage(page) {
  if (await hasVisibleSmsInputs(page)) return true;

  const text = await page.locator('body').innerText().catch(() => '');
  return (
    /код|sms|code/i.test(text) &&
    (/введите|enter|confirm|подтверд/i.test(text) || /digit|цифр/i.test(text))
  );
}

async function waitForSmsPage(page, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isSmsCodePage(page)) return true;
    if (await isAuthComplete(page)) return false;
    await sleep(800);
  }
  return false;
}

async function fillSmsCode(page, code) {
  const otpInputs = page.locator(
    'input[maxlength="1"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
  );
  const count = await otpInputs.count();

  if (count >= 4 && count <= 8) {
    for (let i = 0; i < code.length && i < count; i++) {
      await otpInputs.nth(i).fill(code[i]);
      await sleep(120);
    }
    return;
  }

  const single = page
    .locator('input[type="tel"], input[inputmode="numeric"], input[type="text"], input[type="number"]')
    .first();
  await single.fill(code);
}

async function waitForSmsOrCaptcha(page, chatIds, options, timeoutMs = 120000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await isSmsCodePage(page)) return 'sms';
    if (await isBrowserPasswordPrompt(page)) return 'password';
    if (await isAuthComplete(page)) return 'done';
    await sleep(1500);
  }

  throw new Error('Не дождались экрана ввода SMS-кода. Повторите /reauth');
}

async function ensureCaptchaPassed(page, chatIds, options) {
  if (!(await isCaptchaPage(page))) return;

  const ok = await waitForCaptchaResolved(page, {
    chatIds,
    token: options.token,
  });

  if (!ok) {
    throw new Error(
      'Капча «не робот» не пройдена за 3 мин. Повторите /reauth и выберите QR-код.'
    );
  }

  await page.waitForTimeout(1500);
}

async function waitForLoginComplete(page, timeoutMs = AUTH_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await isLoginPage(page))) return true;
    await sleep(2000);
  }
  return false;
}

async function runAuthPhoneOnPage(page, chatIds, options = {}) {
  beginCaptionSession(chatIds, options, page);

  try {
  await page.goto(MAX_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);

  if (!(await isLoginPage(page))) {
    await notifyAuthDone(chatIds, options, {
      title: 'Сессия MAX уже активна',
      status: 'done',
      lines: ['Повторный вход не требуется.'],
    });
    return true;
  }

  if (options.introMessage !== false) {
    const intro =
      options.introMessage ||
      buildEventMessage({
        title: 'Вход в MAX по номеру телефона',
        status: 'wait',
        step: 1,
        total: AUTH_STEPS,
        lines: [
          'Отправьте номер: <code>+79XXXXXXXXX</code> или <code>9XXXXXXXXX</code>.',
          '',
          buildBrowserPasswordHintHtml(),
        ],
      });

    for (const chatId of chatIds) {
      await sendMessage(chatId, intro, {}, options.token);
    }
  }

  await openPhoneLoginForm(page);

  const phone = await promptTelegramText(
    chatIds,
    buildEventMessage({
      title: 'Номер телефона',
      status: 'wait',
      step: 2,
      total: AUTH_STEPS,
      lines: ['Отправьте номер для входа в MAX.'],
    }),
    {
      token: options.token,
      useAdminPoll: options.useAdminPoll,
      useWebPoll: options.useWebPoll,
      field: 'tel',
      label: 'Номер телефона',
      hint: 'Пример: +79001234567 или 9001234567',
      validate: (text) => normalizePhone(text) || false,
      invalidMessage:
        'Неверный номер. Пример: <code>+79001234567</code> или <code>9001234567</code>. Или /cancel.',
    }
  );

  await notifyAuthDone(chatIds, options, {
    title: 'Вхожу в MAX',
    status: 'progress',
    step: 2,
    total: AUTH_STEPS,
    lines: [`Номер: <code>${maskPhone(phone)}</code>`],
  });

  await fillPhoneNumber(page, phone);
  await clickSignIn(page);

  await notifyAuthDone(chatIds, options, {
    title: 'Номер телефона принят',
    status: 'done',
    step: 2,
    total: AUTH_STEPS,
    lines: [`Номер: <code>${maskPhone(phone)}</code>`],
  });

  const smsPromptOptions = {
    token: options.token,
    useAdminPoll: options.useAdminPoll,
    useWebPoll: options.useWebPoll,
    field: 'sms',
    label: 'Код из SMS',
    hint: '4–8 цифр из SMS. Можно отправить сразу, не дожидаясь капчи.',
    validate: (text) => normalizeSmsCode(text) || false,
    invalidMessage: 'Код должен содержать 4–8 цифр. Или /cancel.',
  };

  const codePromise = promptTelegramText(
    chatIds,
    buildEventMessage({
      title: 'Код из SMS',
      status: 'wait',
      step: 4,
      total: AUTH_STEPS,
      lines: [
        'Отправьте 4–8 цифр из SMS, как только получите.',
        'Можно вводить параллельно с капчей «не робот».',
      ],
    }),
    smsPromptOptions
  );

  const captchaAndNext = (async () => {
    await ensureCaptchaPassed(page, chatIds, options);
    await notifyAuthDone(chatIds, options, {
      title: 'Капча пройдена',
      status: 'done',
      step: 3,
      total: AUTH_STEPS,
    });
    return waitForSmsOrCaptcha(page, chatIds, options);
  })();

  const [nextStep, code] = await Promise.all([captchaAndNext, codePromise]);

  if (nextStep === 'done') {
    await notifyAuthDone(chatIds, options, {
      title: 'Вход в MAX завершён',
      status: 'done',
      step: AUTH_STEPS,
      total: AUTH_STEPS,
    });
    return true;
  }

  if (nextStep === 'password') {
    await tryHandleBrowserPasswordPrompt(page, chatIds, options);
  } else {
    const smsReady = await waitForSmsPage(page, 90000);
    if (!smsReady) {
      throw new Error('Экран ввода SMS-кода не появился. Повторите /reauth');
    }

    await fillSmsCode(page, code);
    await page.waitForTimeout(3000);

    await notifyAuthDone(chatIds, options, {
      title: 'SMS-код принят',
      status: 'done',
      step: 4,
      total: AUTH_STEPS,
    });
  }

  while (await isBrowserPasswordPrompt(page)) {
    await tryHandleBrowserPasswordPrompt(page, chatIds, options);
  }

  if (await isCaptchaPage(page)) {
    await ensureCaptchaPassed(page, chatIds, options);
  }

  const ok = await waitForLoginComplete(page, options.timeoutMs ?? AUTH_TIMEOUT_MS);
  if (!ok) {
    throw new Error('Время ожидания входа истекло (10 мин). Повторите: /reauth');
  }

  if (options.afterLoginChatUrl) {
    await page.goto(options.afterLoginChatUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForTimeout(3000);
  }

  await notifyAuthDone(chatIds, options, {
    title: 'Вход в MAX завершён',
    status: 'done',
    step: AUTH_STEPS,
    total: AUTH_STEPS,
    footer: 'Можно продолжить настройку в Telegram.',
  });

  return true;
  } finally {
    endCaptionSession();
  }
}

module.exports = {
  runAuthPhoneOnPage,
  normalizePhone,
};
