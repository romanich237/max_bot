const { findWrapperIndex } = require('./media');

function normalizeMatchText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function resolveReplyWrapper(page, message, wrapperSelector) {
  const { readMessages } = require('./parser');
  const messages = await readMessages(page);
  const author = normalizeMatchText(message.author);
  const body = normalizeMatchText(message.body);
  const replyBody = normalizeMatchText(message.reply?.body);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (author && normalizeMatchText(msg.author) !== author) continue;
    if (body && normalizeMatchText(msg.body) !== body) continue;

    if (replyBody) {
      const msgReplyBody = normalizeMatchText(msg.reply?.body);
      if (msgReplyBody && msgReplyBody !== replyBody) continue;
    }

    const wrapper = page.locator(wrapperSelector).nth(msg.index);
    if (await wrapper.count()) {
      return wrapper;
    }
  }

  return null;
}

async function openReplyOnMessage(page, wrapper) {
  const messageEl = wrapper.locator('.message').first();
  const target = (await messageEl.count()) ? messageEl : wrapper;

  await target.scrollIntoViewIfNeeded();
  await target.hover();
  await page.waitForTimeout(200);

  const replyInBubble = wrapper.locator(
    'button[aria-label*="reply" i], button[aria-label*="ответ" i], [class*="reply" i] button'
  ).first();

  if (await replyInBubble.isVisible({ timeout: 1500 }).catch(() => false)) {
    await replyInBubble.click();
    return true;
  }

  await target.click({ button: 'right' });
  await page.waitForTimeout(300);

  const menuReply = page
    .getByRole('menuitem', { name: /^(reply|ответить)$/i })
    .or(page.getByRole('menuitem', { name: /reply|ответить/i }))
    .first();

  if (await menuReply.isVisible({ timeout: 2000 }).catch(() => false)) {
    await menuReply.click();
    return true;
  }

  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

async function findComposer(page) {
  const candidates = [
    page.getByRole('textbox', { name: /^(message|сообщение)$/i }),
    page.locator('[contenteditable="true"], [contenteditable=""]').last(),
    page.locator('textarea').last(),
    page.getByRole('textbox').last(),
  ];

  for (const input of candidates) {
    if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
      return input;
    }
  }

  throw new Error('Не найдено поле ввода в чате MAX');
}

async function typeInComposer(page, input, text) {
  await input.click();
  await page.waitForTimeout(100);

  const isContentEditable = await input.evaluate((el) => el.isContentEditable);
  if (isContentEditable) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(50);
    await page.keyboard.insertText(text);
    return;
  }

  const tag = await input.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'textarea') {
    await input.fill(text);
    return;
  }

  try {
    await input.fill(text);
  } catch {
    await page.keyboard.insertText(text);
  }
}

function sendButton(page) {
  return page
    .getByRole('button', { name: /send message|^send$|отправить/i })
    .or(page.locator('button[aria-label*="Send" i], button[aria-label*="отправить" i]'))
    .last();
}

async function submitComposer(page) {
  const sendBtn = sendButton(page);

  if (await sendBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (await sendBtn.isEnabled().catch(() => true)) {
      await sendBtn.click();
      return;
    }
  }

  await page.keyboard.press('Enter');
}

function normalizeReplyPayload(payload) {
  if (typeof payload === 'string' || payload == null) {
    return { text: String(payload || ''), photos: [] };
  }
  return {
    text: String(payload.text || ''),
    photos: Array.isArray(payload.photos) ? payload.photos.filter(Boolean) : [],
  };
}

async function attachFilesToComposer(page, filePaths) {
  if (!filePaths.length) return;

  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count();
  for (let i = count - 1; i >= 0; i--) {
    try {
      await fileInputs.nth(i).setInputFiles(filePaths);
      await page.waitForTimeout(400);
      return;
    } catch {
      /* следующий input */
    }
  }

  const attachBtns = [
    page.getByRole('button', { name: /attach|прикрепить|файл|фото|clip|скрепк/i }),
    page.locator(
      'button[aria-label*="attach" i], button[aria-label*="файл" i], button[aria-label*="прикреп" i], button[aria-label*="clip" i]'
    ),
  ];

  for (const loc of attachBtns) {
    const btn = loc.first();
    if (!(await btn.isVisible({ timeout: 800 }).catch(() => false))) continue;
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 4000 }),
        btn.click(),
      ]);
      await chooser.setFiles(filePaths);
      await page.waitForTimeout(400);
      return;
    } catch {
      /* следующая кнопка */
    }
  }

  throw new Error('Не удалось прикрепить фото в MAX');
}

async function waitForSendReady(page, timeoutMs = 10000) {
  const sendBtn = sendButton(page);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (
      (await sendBtn.isVisible().catch(() => false)) &&
      (await sendBtn.isEnabled().catch(() => false))
    ) {
      return;
    }
    await page.waitForTimeout(200);
  }
}

async function sendReplyInMax(page, message, payload, wrapperSelector) {
  const { text, photos } = normalizeReplyPayload(payload);
  const trimmed = text.trim();
  if (!trimmed && !photos.length) {
    throw new Error('Пустой ответ');
  }

  let wrapper = await resolveReplyWrapper(page, message, wrapperSelector);

  if (!wrapper) {
    const index = await findWrapperIndex(page, message, wrapperSelector);
    const total = await page.locator(wrapperSelector).count();
    if (index >= 0 && index < total) {
      wrapper = page.locator(wrapperSelector).nth(index);
      if (!(await wrapper.count())) {
        wrapper = null;
      }
    }
  }

  if (!wrapper) {
    throw new Error('Сообщение не найдено в чате MAX');
  }

  const opened = await openReplyOnMessage(page, wrapper);
  if (!opened) {
    throw new Error('Не удалось открыть ответ на сообщение в MAX');
  }

  if (photos.length) {
    await attachFilesToComposer(page, photos);
    await waitForSendReady(page);
  }

  if (trimmed) {
    const input = await findComposer(page);
    await typeInComposer(page, input, trimmed);
    await page.waitForTimeout(150);
  } else {
    await findComposer(page).catch(() => null);
    await page.waitForTimeout(150);
  }

  await submitComposer(page);
  await page.waitForTimeout(500);
}

module.exports = { sendReplyInMax };
