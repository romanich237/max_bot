const { sendPhotoBuffer } = require('./tg-api');

const CAPTCHA_IFRAME_RE = /not_robot_captcha|id\.vk\.ru/i;
const CAPTCHA_TIMEOUT_MS = 3 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isCaptchaPage(page) {
  const hasIframe = await page
    .locator('iframe[src*="not_robot_captcha"], iframe[src*="id.vk.ru"]')
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (hasIframe) return true;

  const hasCaptchaContainer = await page
    .locator('#c1_captcha, .auth--captcha')
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (hasCaptchaContainer) return true;

  const text = await page.locator('body').innerText();
  return /не робот|not a robot|captcha/i.test(text);
}

function getCaptchaFrame(page) {
  return page.frames().find((frame) => CAPTCHA_IFRAME_RE.test(frame.url()));
}

async function tryClickCaptcha(page) {
  const iframe = page.locator('iframe[src*="not_robot_captcha"], iframe[src*="id.vk.ru"]').first();
  if (!(await iframe.isVisible({ timeout: 1500 }).catch(() => false))) {
    return false;
  }

  const frame = getCaptchaFrame(page);
  if (frame) {
    const frameSelectors = [
      '[role="checkbox"]',
      'input[type="checkbox"]',
      '#checkbox',
      '.checkbox',
      'label',
      'div[tabindex]',
    ];

    for (const selector of frameSelectors) {
      const target = frame.locator(selector).first();
      if (await target.isVisible({ timeout: 400 }).catch(() => false)) {
        await target.click({ force: true, timeout: 5000 }).catch(() => {});
        return true;
      }
    }

    const textTarget = frame.getByText(/not a robot|не робот/i).first();
    if (await textTarget.isVisible({ timeout: 400 }).catch(() => false)) {
      await textTarget.click({ force: true, timeout: 5000 }).catch(() => {});
      return true;
    }
  }

  const frameLocator = page.frameLocator('iframe[src*="not_robot_captcha"], iframe[src*="id.vk.ru"]');
  const outerSelectors = ['[role="checkbox"]', 'label', 'div[tabindex="0"]'];

  for (const selector of outerSelectors) {
    const target = frameLocator.locator(selector).first();
    if (await target.isVisible({ timeout: 400 }).catch(() => false)) {
      await target.click({ force: true, timeout: 5000 }).catch(() => {});
      return true;
    }
  }

  const textTarget = frameLocator.getByText(/not a robot|не робот/i).first();
  if (await textTarget.isVisible({ timeout: 400 }).catch(() => false)) {
    await textTarget.click({ force: true, timeout: 5000 }).catch(() => {});
    return true;
  }

  const box = await iframe.boundingBox();
  if (box?.width && box?.height) {
    await page.mouse.click(
      box.x + Math.min(40, box.width * 0.08),
      box.y + box.height * 0.5
    );
    return true;
  }

  return false;
}

async function captureCaptchaScreenshot(page) {
  await page.waitForTimeout(800);

  const iframe = page.locator('iframe[src*="not_robot_captcha"], iframe[src*="id.vk.ru"]').first();
  if (await iframe.isVisible({ timeout: 1500 }).catch(() => false)) {
    const box = await iframe.boundingBox();
    if (box?.width && box?.height) {
      const viewport = page.viewportSize() || { width: 1280, height: 900 };
      const padding = 24;
      return page.screenshot({
        type: 'png',
        clip: {
          x: Math.max(0, box.x - padding),
          y: Math.max(0, box.y - padding * 2),
          width: Math.min(viewport.width - Math.max(0, box.x - padding), box.width + padding * 2),
          height: Math.min(
            viewport.height - Math.max(0, box.y - padding * 2),
            box.height + padding * 4
          ),
        },
      });
    }
  }

  return page.screenshot({ type: 'png', fullPage: false });
}

async function notifyCaptcha(chatIds, page, options = {}) {
  const buffer = await captureCaptchaScreenshot(page);
  const caption = [
    'Проверка «не робот» на MAX.',
    'Бот нажимает галочку автоматически.',
    'Если не проходит за 3 мин — /reauth и выберите QR-код.',
  ].join('\n');

  for (const chatId of chatIds || []) {
    await sendPhotoBuffer(chatId, buffer, caption, options.token);
  }
}

async function waitForCaptchaResolved(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? CAPTCHA_TIMEOUT_MS;
  const started = Date.now();
  let lastClick = 0;
  let notified = false;

  while (Date.now() - started < timeoutMs) {
    if (!(await isCaptchaPage(page))) {
      return true;
    }

    if (!notified && options.chatIds?.length) {
      notified = true;
      await notifyCaptcha(options.chatIds, page, options);
    }

    if (Date.now() - lastClick >= 2500) {
      await tryClickCaptcha(page);
      lastClick = Date.now();
    }

    await sleep(1200);
  }

  return false;
}

module.exports = {
  CAPTCHA_TIMEOUT_MS,
  isCaptchaPage,
  tryClickCaptcha,
  captureCaptchaScreenshot,
  waitForCaptchaResolved,
};
