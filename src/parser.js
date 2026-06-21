const { getMax, getProfileRotate, getMaxDisplayName } = require('./config');
const { buildMediaKey, bodyWithMedia } = require('./media');

const MESSAGE_WRAPPER_SELECTOR = '.messageWrapper';

function ownNamesLower() {
  const max = getMax();
  const rotate = getProfileRotate();
  const names = new Set();

  for (const raw of [...(max.ownAuthorNames || []), ...(rotate.names || [])]) {
    const value = String(raw || '').toLowerCase().trim();
    if (value) names.add(value);
  }

  const display = String(getMaxDisplayName() || max.currentDisplayName || '')
    .toLowerCase()
    .trim();
  if (display) names.add(display);

  return [...names];
}

async function isLoginPage(page) {
  const authFormVisible = await page
    .locator('form.auth--qr-code, form.auth--password, form.auth--code, form.auth')
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (authFormVisible) return true;

  const url = page.url();
  if (/web\.max\.ru\/-\d+/.test(url)) {
    const inChat = await page
      .locator('.messageWrapper, .openedChat')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (inChat) return false;
  }

  const captchaIframe = await page
    .locator('iframe[src*="not_robot_captcha"], iframe[src*="id.vk.ru"]')
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (captchaIframe) return true;

  const qrVisible = await page
    .locator('canvas')
    .first()
    .or(page.locator('img[src*="qr"], img[alt*="QR" i], img[alt*="qr" i]').first())
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (qrVisible) return true;

  const bodyText = await page.locator('body').innerText();
  if (/войдите в max|sign in to max/i.test(bodyText)) return true;
  if (/qr-код|qr code|scan the qr/i.test(bodyText)) return true;
  if (/войти по номеру телефона|phone number do you want/i.test(bodyText)) return true;
  if (/код из sms|sms.*code|enter.*code|введите.*код/i.test(bodyText)) return true;
  if (/@browser/i.test(bodyText)) return true;
  if (/не робот|not a robot|captcha/i.test(bodyText)) return true;

  const hasPassword = await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (hasPassword) {
    const lower = bodyText.toLowerCase();
    if (
      /browser/.test(lower) ||
      /пароль/.test(lower) ||
      /password/.test(lower) ||
      /облачн/.test(lower) ||
      /устройств/.test(lower)
    ) {
      return true;
    }
  }

  return /войдите в max/i.test(bodyText) && /qr-код/i.test(bodyText);
}

async function openChatWhenReady(page, chatUrl, maxAttempts = 3) {
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await page.waitForTimeout(3000);

    if (await isLoginPage(page)) {
      if (attempt < maxAttempts - 1) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        continue;
      }
      return null;
    }

    const messages = await readMessages(page);
    if (messages.length > 0) {
      return messages;
    }

    if (attempt < maxAttempts - 1) {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  }

  if (await isLoginPage(page)) {
    return null;
  }

  return readMessages(page);
}

async function scrollChatToBottom(page) {
  await page.evaluate(() => {
    const scrollables = new Set();

    const openedChat = document.querySelector('.openedChat');
    if (openedChat) scrollables.add(openedChat);

    const wrapper = document.querySelector('.messageWrapper');
    if (wrapper) {
      let el = wrapper.parentElement;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if (
          el.scrollHeight > el.clientHeight + 5 &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto')
        ) {
          scrollables.add(el);
        }
        el = el.parentElement;
      }
    }

    document.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el);
      if (
        el.scrollHeight > el.clientHeight + 50 &&
        (style.overflowY === 'auto' || style.overflowY === 'scroll')
      ) {
        scrollables.add(el);
      }
    });

    for (const el of scrollables) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

function isOwnByAuthor(author) {
  const names = ownNamesLower();
  if (!names.length) return false;
  const normalized = author.toLowerCase().trim();
  return names.some(
    (name) => normalized === name || normalized.startsWith(name) || name.startsWith(normalized)
  );
}

function shouldForward(message) {
  return !message.isOwn;
}

function keyAuthor(author) {
  if (!author || author === 'Неизвестно') return author || '';
  if (isOwnByAuthor(author)) return '__own__';
  return author;
}

function buildMessageKey(msg) {
  const reply = msg.reply || {};
  const replyPart = `${keyAuthor(reply.author)}::${reply.body || ''}::${reply.isVoice ? 1 : 0}`;
  return `${keyAuthor(msg.author)}::${msg.body}::${msg.time}::${replyPart}::${buildMediaKey(msg.media)}`;
}

async function parseMessages(page) {
  return page
    .evaluate(({ wrapperSelector }) => {
      function isTimeText(text) {
        return /^\d{1,2}:\d{2}(\s*(AM|PM))?$/i.test(text);
      }

      function extractTime(wrapper) {
        const meta = wrapper.querySelector('.meta--text');
        if (meta?.innerText?.trim()) return meta.innerText.trim();

        for (const el of wrapper.querySelectorAll('.text')) {
          const t = el.innerText.trim();
          if (isTimeText(t)) return t;
        }
        return '';
      }

      function extractAuthor(wrapper) {
        const headerName = wrapper.querySelector('.header .name .text');
        if (headerName?.innerText?.trim()) return headerName.innerText.trim();

        const bubbleHeader = wrapper.querySelector('.bubbleContent .header .text');
        if (bubbleHeader?.innerText?.trim()) return bubbleHeader.innerText.trim();

        return 'Неизвестно';
      }

      function extractReply(wrapper) {
        const mark = wrapper.querySelector('.mark');
        if (!mark) return null;

        const replyAuthor =
          mark.querySelector('.author .text')?.innerText?.trim() ||
          mark.querySelector('.name .text')?.innerText?.trim() ||
          '';

        const replyBody =
          mark.querySelector('.text.svelte-m3np2o')?.innerText?.trim() || '';

        const isVoice = !!mark.querySelector('.attach, [class*="attach"]');

        if (!replyAuthor && !replyBody && !isVoice) return null;

        return {
          author: replyAuthor,
          body: isVoice && !replyBody ? 'голосовое сообщение' : replyBody,
          isVoice,
        };
      }

      function extractBody(wrapper) {
        const parts = [];

        wrapper.querySelectorAll('.bubbleContent').forEach((bubble) => {
          bubble.querySelectorAll('.text.svelte-1htnb3l, .text').forEach((el) => {
            if (el.closest('.mark')) return;
            if (el.closest('.header')) return;
            if (el.closest('.meta')) return;

            const t = el.innerText.trim();
            if (!t || isTimeText(t)) return;
            if (t === 'Голосовое сообщение') return;

            parts.push(t);
          });
        });

        const unique = [...new Set(parts)];
        return unique.join('\n').trim();
      }

      function isValidPhoto(img) {
        const src = img.src || '';
        if (!src || img.classList.contains('avatarImage')) return false;
        if (src.includes('st.max.ru/emojis')) return false;
        if (/fn=sqr_\d/i.test(src)) return false;

        if (img.closest('.media, .grid, .tile, .attaches')) return true;

        const style = img.getAttribute('style') || '';
        const widthMatch = style.match(/width:\s*([\d.]+)(px|em)/);
        const width = widthMatch ? parseFloat(widthMatch[1]) : img.naturalWidth || img.width;
        const unit = widthMatch?.[2] || 'px';
        if (unit === 'em') return false;
        if (width > 0 && width <= 40) return false;

        return src.includes('oneme.ru') || width > 80;
      }

      function extractMedia(wrapper) {
        const items = [];

        const audio = wrapper.querySelector('.attachAudio');
        if (audio) {
          const duration = audio.querySelector('.duration')?.innerText?.trim() || '';
          items.push({ type: 'voice', duration });
        }

        wrapper.querySelectorAll('.sticker[data-testid^="sticker-"]').forEach((el) => {
          const stickerId = el.getAttribute('data-testid')?.replace('sticker-', '') || '';
          if (stickerId) items.push({ type: 'sticker', stickerId });
        });

        wrapper.querySelectorAll('video').forEach((video) => {
          const url = video.src || video.currentSrc;
          if (url && !url.startsWith('blob:')) {
            items.push({ type: 'video', url });
          }
        });

        wrapper.querySelectorAll('.media img, .grid img, .tile img, .attaches img, img').forEach((img) => {
          if (!isValidPhoto(img)) return;
          items.push({ type: 'photo', url: img.src });
        });

        wrapper.querySelectorAll('[class*="attachFile"], [class*="attachDoc"]').forEach((el) => {
          const link = el.querySelector('a[href]') || (el.tagName === 'A' ? el : null);
          const url = link?.href;
          const fileName = (el.innerText || link?.innerText || 'file').trim().split('\n')[0];
          if (url) items.push({ type: 'file', url, fileName });
        });

        wrapper.querySelectorAll('.attaches a[href], .bubbleContent a[href]').forEach((link) => {
          const url = link.href;
          if (!url || url.startsWith('javascript:')) return;
          if (/\.(pdf|doc|docx|zip|rar|7z|txt|xlsx|xls|ppt|pptx|apk|mp3|wav|ogg)(\?|$)/i.test(url)) {
            items.push({
              type: 'file',
              url,
              fileName: (link.innerText || 'file').trim().split('\n')[0],
            });
          }
        });

        const seen = new Set();
        return items.filter((item) => {
          const id = item.url || item.stickerId || `${item.type}:${item.duration}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      }

      const wrappers = document.querySelectorAll(wrapperSelector);
      let lastAuthor = '';
      return Array.from(wrappers).map((wrapper, index) => {
        let author = extractAuthor(wrapper);
        if (author === 'Неизвестно' && lastAuthor) {
          author = lastAuthor;
        } else if (author && author !== 'Неизвестно') {
          lastAuthor = author;
        }

        const reply = extractReply(wrapper);
        let body = extractBody(wrapper);
        const time = extractTime(wrapper);
        const media = extractMedia(wrapper);

        const bubble = wrapper.querySelector('[data-bubbles-variant]');
        const variant = bubble?.getAttribute('data-bubbles-variant') || '';
        const wrapperClass = wrapper.className || '';
        const bubbleClass = bubble?.className || '';
        const isOwn =
          variant === 'outgoing' ||
          /outgoing|isOwn|myMessage|messageWrapper--out/i.test(wrapperClass) ||
          /outgoing|isOwn/i.test(bubbleClass);

        if (!body && media.length === 1) {
          const labels = {
            voice: 'голосовое',
            photo: 'фото',
            video: 'видео',
            file: 'файл',
            sticker: 'стикер',
          };
          const m = media[0];
          const label = labels[m.type] || 'медиа';
          body = `[${m.duration ? `${label} ${m.duration}` : label}]`;
        } else if (!body && media.length > 1) {
          body = `[${media.length} вложения]`;
        }

        return {
          index,
          author,
          body,
          reply,
          time,
          media,
          isOwn,
        };
      });
    }, { wrapperSelector: MESSAGE_WRAPPER_SELECTOR })
    .then((messages) =>
      messages.map((msg) => {
        const body = bodyWithMedia(msg.body, msg.media);
        const normalized = {
          ...msg,
          body,
          reply: msg.reply || null,
          isOwn: msg.isOwn || isOwnByAuthor(msg.author),
        };
        return { ...normalized, key: buildMessageKey(normalized) };
      })
    );
}

async function readMessages(page) {
  await scrollChatToBottom(page);
  await page.waitForTimeout(500);
  await scrollChatToBottom(page);
  return parseMessages(page);
}

function findNewMessages(messages, seenKeys) {
  const fresh = [];
  for (const message of messages) {
    if (!seenKeys.has(message.key)) {
      fresh.push(message);
      seenKeys.add(message.key);
    }
  }
  return fresh;
}

function messagesMatch(a, b) {
  return a.body === b.body && a.time === b.time && a.author === b.author;
}

function diffByTail(prev, current) {
  if (!prev.length || !current.length) return [];

  const maxOverlap = Math.min(prev.length, current.length, 20);
  for (let overlap = maxOverlap; overlap >= 1; overlap--) {
    const prevTail = prev.slice(-overlap);
    const currHead = current.slice(0, overlap);
    const keysMatch = prevTail.every((p, i) => p.key === currHead[i].key);
    const contentMatch = prevTail.every((p, i) => messagesMatch(p, currHead[i]));
    if (keysMatch || contentMatch) {
      return current.slice(overlap);
    }
  }

  return current.filter((m) => !prev.some((p) => messagesMatch(p, m)));
}

async function waitForChat(page) {
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    if (await isLoginPage(page)) {
      throw new Error(
        'Требуется авторизация. Локально: npm run auth. На сервер: загрузите max_session.zip'
      );
    }

    const messages = await readMessages(page);
    if (messages.length > 0) {
      return messages;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(
    'Не удалось найти сообщения. Проверьте chatUrl и сессию в config.json'
  );
}

module.exports = {
  MESSAGE_WRAPPER_SELECTOR,
  isLoginPage,
  openChatWhenReady,
  readMessages,
  findNewMessages,
  diffByTail,
  waitForChat,
  shouldForward,
  isOwnByAuthor,
};
