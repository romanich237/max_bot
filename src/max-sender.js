const { findWrapperIndex } = require('./media');

async function openReplyOnMessage(page, wrapper) {
  await wrapper.scrollIntoViewIfNeeded();
  await wrapper.hover();
  await page.waitForTimeout(200);

  const replyInBubble = wrapper.locator(
    'button[aria-label*="reply" i], button[aria-label*="ответ" i], [class*="reply" i] button'
  ).first();

  if (await replyInBubble.isVisible({ timeout: 1500 }).catch(() => false)) {
    await replyInBubble.click();
    return true;
  }

  await wrapper.click({ button: 'right' });
  await page.waitForTimeout(300);

  const menuReply = page
    .getByRole('menuitem', { name: /ответить/i })
    .or(page.getByText(/^ответить$/i))
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
    page.locator('[contenteditable="true"]').last(),
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
  await input.fill('');
  await page.waitForTimeout(100);

  const tag = await input.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'textarea' || (await input.getAttribute('role')) === 'textbox') {
    await input.fill(text);
  } else {
    await input.evaluate((el, value) => {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, text);
  }
}

async function submitComposer(page) {
  const sendBtn = page
    .getByRole('button', { name: /^(send|отправить)$/i })
    .or(page.locator('button[type="submit"]'))
    .last();

  if (await sendBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await sendBtn.click();
    return;
  }

  await page.keyboard.press('Enter');
}

async function sendReplyInMax(page, message, text, wrapperSelector) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new Error('Пустой ответ');
  }

  const index = await findWrapperIndex(page, message, wrapperSelector);
  const wrapper = page.locator(wrapperSelector).nth(index);

  if (!(await wrapper.count())) {
    throw new Error('Сообщение не найдено в чате MAX');
  }

  await openReplyOnMessage(page, wrapper);
  const input = await findComposer(page);
  await typeInComposer(page, input, trimmed);
  await page.waitForTimeout(150);
  await submitComposer(page);
  await page.waitForTimeout(500);
}

module.exports = { sendReplyInMax };
