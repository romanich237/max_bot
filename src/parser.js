const crypto = require('crypto');
const { getMax, getProfileRotate, getMaxDisplayName } = require('./config');
const { chatIdFromUrl } = require('./max-chats');
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
  if (!page || page.isClosed()) return true;

  const authFormVisible = await page
    .locator(
      'form.auth--qr-code, form.auth--password, form.auth--code, form.auth--captcha, .auth--qr-code, .auth--password, .auth--code'
    )
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);

  const inApp = await page
    .locator(
      [
        '.openedChat',
        '.messageWrapper',
        '.scrollListContent h3.title',
        'button.cell h3.title',
        '.app.app--mainActive',
        'main.main--active',
      ].join(', ')
    )
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);

  if (inApp && !authFormVisible) return false;
  if (authFormVisible) return true;

  const url = String(page.url() || '');
  const onChatUrl = /web\.max\.ru\/-?\d{5,}/i.test(url);
  if (onChatUrl) return false;

  const captchaIframe = await page
    .locator('iframe[src*="not_robot_captcha"], iframe[src*="id.vk.ru"]')
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (captchaIframe) return true;

  const qrVisible = await page
    .locator(
      'form.auth--qr-code canvas, form.auth--qr-code img[src*="qr"], .auth--qr-code canvas, .auth--qr-code img[src*="qr"]'
    )
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (qrVisible) return true;

  let bodyText = '';
  try {
    bodyText = await page.locator('body').innerText({ timeout: 1500 });
  } catch {
    bodyText = '';
  }

  if (/войдите в max|sign in to max/i.test(bodyText)) return true;
  if (/войти по номеру телефона|phone number do you want/i.test(bodyText)) return true;
  if (/код из sms|enter the code from|введите код из/i.test(bodyText)) return true;
  if (/не робот|not a robot/i.test(bodyText)) return true;
  if (/qr-код|scan the qr/i.test(bodyText)) return true;

  const hasPassword = await page
    .locator('form.auth--password input[type="password"]')
    .first()
    .isVisible({ timeout: 300 })
    .catch(() => false);

  return Boolean(hasPassword);
}

async function readOpenedHeaderTitle(page) {
  return page
    .evaluate(() => {
      const opened = document.querySelector('.openedChat');
      if (!opened) return '';
      const node =
        opened.querySelector('button.main .content') ||
        opened.querySelector('.header') ||
        opened.querySelector('h2');
      return String(node?.innerText || '')
        .split('\n')[0]
        .replace(/\s+/g, ' ')
        .trim();
    })
    .catch(() => '');
}

async function waitForOpenChat(page, chatUrl, timeout = 15000, options = {}) {
  const expectedId = chatIdFromUrl(chatUrl);
  const previousTitle = String(options.previousTitle || '').trim();
  if (!expectedId) {
    await page.waitForTimeout(800);
    return;
  }

  const escaped = expectedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .waitForURL(new RegExp(`web\\.max\\.ru/${escaped}(?:[/?#]|$)`, 'i'), { timeout })
    .catch(() => {});

  await page
    .waitForFunction(
      (chatId) => {
        const path = String(location.pathname || '').replace(/\/+$/, '');
        if (path !== `/${chatId}` && !path.endsWith(`/${chatId}`)) return false;

        const opened = document.querySelector('.openedChat');
        if (!opened) return false;
        const style = window.getComputedStyle(opened);
        if (style.display === 'none' || style.visibility === 'hidden') return false;

        return Boolean(
          opened.querySelector('.messageWrapper') ||
            opened.querySelector('button.main') ||
            opened.querySelector('.header')
        );
      },
      expectedId,
      { timeout }
    )
    .catch(() => {});

  if (previousTitle) {
    await page
      .waitForFunction(
        (prevTitle) => {
          const opened = document.querySelector('.openedChat');
          const titleNode =
            opened?.querySelector('button.main .content') ||
            opened?.querySelector('.header') ||
            opened?.querySelector('h2');
          const title = String(titleNode?.innerText || '')
            .split('\n')[0]
            .replace(/\s+/g, ' ')
            .trim();
          return Boolean(title && title !== prevTitle);
        },
        previousTitle,
        { timeout: 3500 }
      )
      .catch(() => {});
  }

  await page.waitForTimeout(400);
}

async function openChatPage(page, chatUrl, timeout = 15000) {
  const previousTitle = await readOpenedHeaderTitle(page);
  const sameChat = chatIdFromUrl(page.url()) === chatIdFromUrl(chatUrl);
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitForOpenChat(page, chatUrl, timeout, {
    previousTitle: sameChat ? '' : previousTitle,
  });
}

async function openChatWhenReady(page, chatUrl, maxAttempts = 3) {
  await openChatPage(page, chatUrl);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await isLoginPage(page)) {
      if (attempt < maxAttempts - 1) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForOpenChat(page, chatUrl);
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
      await waitForOpenChat(page, chatUrl);
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

function normalizeClock(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return `${String(match[1]).padStart(2, '0')}:${match[2]}`;
}

function hashIdentity(parts) {
  return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 20);
}

function contentFingerprint(msg) {
  const reply = msg.reply || {};
  return hashIdentity([
    keyAuthor(msg.author),
    String(msg.body || ''),
    keyAuthor(reply.author || ''),
    String(reply.body || ''),
    reply.isVoice ? '1' : '0',
    buildMediaKey(msg.media),
  ]);
}

function timedFingerprint(msg) {
  return hashIdentity([
    contentFingerprint(msg),
    msg.date || '',
    msg.clock || normalizeClock(msg.time) || '',
  ]);
}

function buildMessageKey(msg) {
  const reply = msg.reply || {};
  const replyPart = `${keyAuthor(reply.author)}::${reply.body || ''}::${reply.isVoice ? 1 : 0}`;
  const when = [msg.date || '', msg.clock || normalizeClock(msg.time) || msg.time || '']
    .filter(Boolean)
    .join(' ');
  return `${keyAuthor(msg.author)}::${msg.body}::${when}::${replyPart}::${buildMediaKey(msg.media)}`;
}

function attachIdentity(msg) {
  const clock = normalizeClock(msg.time);
  const date = msg.date || '';
  const withMeta = { ...msg, clock, date };
  return {
    ...withMeta,
    key: buildMessageKey(withMeta),
    fingerprint: contentFingerprint(withMeta),
    timedFingerprint: timedFingerprint(withMeta),
  };
}

function chatsMatch(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return true;
  if (left === right) return true;
  const idA = left.match(/-?\d{5,}/);
  const idB = right.match(/-?\d{5,}/);
  return Boolean(idA && idB && idA[0] === idB[0]);
}

function identityView(item = {}) {
  return {
    key: item.key || item.message_key || '',
    fingerprint: item.fingerprint || '',
    timedFingerprint: item.timedFingerprint || item.timed_fingerprint || '',
    date: item.date || item.date_str || '',
    clock: item.clock || normalizeClock(item.time || item.time_str || ''),
    chatUrl: item.maxChatUrl || item.chatUrl || item.chat_url || '',
    seenAt: item.seenAt || item.created_at || item.createdAt || '',
    author: item.author || '',
    body: item.body || '',
  };
}

function isDuplicateIdentity(message, stored) {
  const a = identityView(message);
  const b = identityView(stored);
  if (!a.key && !a.fingerprint && !a.body) return false;
  if (!chatsMatch(a.chatUrl, b.chatUrl)) return false;

  if (
    a.key &&
    b.key &&
    (a.key === b.key || a.key.endsWith(`::${b.key}`) || b.key.endsWith(`::${a.key}`))
  ) {
    return true;
  }

  if (a.timedFingerprint && b.timedFingerprint && a.timedFingerprint === b.timedFingerprint) {
    return true;
  }

  const sameContent =
    Boolean(a.fingerprint && b.fingerprint && a.fingerprint === b.fingerprint) ||
    Boolean(a.author && a.author === b.author && (a.body || '') === (b.body || ''));

  if (!sameContent) return false;
  if (a.date && b.date && a.date !== b.date) return false;
  if (a.clock && b.clock && a.clock !== b.clock) return false;

  if (!a.date || !b.date) {
    const seenAt = Date.parse(b.seenAt || '');
    if (Number.isFinite(seenAt) && Date.now() - seenAt > 18 * 60 * 60 * 1000) {
      if (a.clock && b.clock && a.clock === b.clock) return false;
    }
  }

  return true;
}

function localDateISO(daysAgo = 0) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function parseMessages(page) {
  const months = [
    'январ',
    'феврал',
    'март',
    'апрел',
    'мая',
    'июн',
    'июл',
    'август',
    'сентябр',
    'октябр',
    'ноябр',
    'декабр',
  ];

  return page
    .evaluate(({ wrapperSelector, todayISO, yesterdayISO, year, months }) => {
      function isTimeText(text) {
        return /^\d{1,2}:\d{2}(\s*(AM|PM))?$/i.test(text);
      }

      function parseHeaderDate(text) {
        const raw = String(text || '').replace(/\s+/g, ' ').trim();
        if (!raw || raw.length > 48) return '';
        if (/^сегодня$/i.test(raw)) return todayISO;
        if (/^вчера$/i.test(raw)) return yesterdayISO;

        const stripped = raw.replace(
          /^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье),?\s*/i,
          ''
        );

        const dotted = stripped.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
        if (dotted) {
          const day = dotted[1].padStart(2, '0');
          const month = dotted[2].padStart(2, '0');
          let parsedYear = year;
          if (dotted[3]) {
            parsedYear = dotted[3].length === 2 ? 2000 + Number(dotted[3]) : Number(dotted[3]);
          }
          return `${parsedYear}-${month}-${day}`;
        }

        const named = stripped.match(/^(\d{1,2})\s+([а-яё]+)/i);
        if (named) {
          const label = named[2].toLowerCase();
          const monthIdx = months.findIndex((prefix) => label.startsWith(prefix));
          if (monthIdx >= 0) {
            const day = named[1].padStart(2, '0');
            const month = String(monthIdx + 1).padStart(2, '0');
            const yearMatch = stripped.match(/\b(20\d{2})\b/);
            const parsedYear = yearMatch ? Number(yearMatch[1]) : year;
            return `${parsedYear}-${month}-${day}`;
          }
        }

        return '';
      }

      function collectWrapperDates(wrappers) {
        const dates = wrappers.map(() => '');
        if (!wrappers.length) return dates;

        const root =
          wrappers[0].closest(
            '.openedChat, [class*="chatContent"], [class*="messagesList"], [class*="MessageList"], main'
          ) || wrappers[0].parentElement;
        if (!root) return dates;

        const wrapperSet = new Set(wrappers);
        let currentDate = '';

        const walk = (node) => {
          if (!node || node.nodeType !== 1) return;
          if (wrapperSet.has(node)) {
            const idx = wrappers.indexOf(node);
            if (idx >= 0) dates[idx] = currentDate;
            return;
          }

          if (!node.querySelector?.(wrapperSelector)) {
            const parsed = parseHeaderDate(node.innerText);
            if (parsed) {
              currentDate = parsed;
              return;
            }
          }

          for (const child of node.children || []) {
            walk(child);
          }
        };

        walk(root);
        return dates;
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

      function normalizeBodyText(text) {
        return String(text || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r\n/g, '\n')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      function extractBody(wrapper) {
        const roots = [...wrapper.querySelectorAll('.bubbleContent')];
        if (!roots.length) roots.push(wrapper);

        const parts = [];
        for (const root of roots) {
          const clone = root.cloneNode(true);
          clone
            .querySelectorAll(
              [
                '.mark',
                '.header',
                '.meta',
                '.meta--text',
                '.attachAudio',
                '.media',
                '.grid',
                '.tile',
                '.sticker',
                '.avatarImage',
                '[class*="keyboard"]',
                '[class*="reaction"]',
              ].join(', ')
            )
            .forEach((el) => el.remove());

          const texts = [...clone.querySelectorAll('.text')].filter((el) => {
            const t = String(el.innerText || '').trim();
            if (!t || isTimeText(t) || t === 'Голосовое сообщение') return false;
            return true;
          });
          const top = texts.filter(
            (el) => !texts.some((other) => other !== el && other.contains(el))
          );

          let chunk = top.length
            ? top.map((el) => String(el.innerText || '').trim()).join('\n')
            : String(clone.innerText || '');

          chunk = normalizeBodyText(chunk).replace(
            /\n\d{1,2}:\d{2}(\s*(AM|PM))?$/i,
            ''
          );
          if (chunk) parts.push(chunk);
        }

        return [...new Set(parts)].join('\n\n').trim();
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

      function queryWrappers(selector) {
        const opened = document.querySelector('.openedChat');
        if (opened) {
          const style = window.getComputedStyle(opened);
          if (style.display === 'none' || style.visibility === 'hidden') return [];
          return Array.from(opened.querySelectorAll('.messageWrapper'));
        }

        const main = document.querySelector('main[name*="Chat window" i], main[name*="чат" i]');
        if (main) {
          return Array.from(main.querySelectorAll('.messageWrapper'));
        }

        return Array.from(document.querySelectorAll(selector));
      }

      const wrappers = queryWrappers(wrapperSelector);
      const wrapperDates = collectWrapperDates(wrappers);
      let lastAuthor = '';
      return wrappers.map((wrapper, index) => {
        let author = extractAuthor(wrapper);
        if (author === 'Неизвестно' && lastAuthor) {
          author = lastAuthor;
        } else if (author && author !== 'Неизвестно') {
          lastAuthor = author;
        }

        const reply = extractReply(wrapper);
        let body = extractBody(wrapper);
        if (author && body === author) body = '';
        if (author && body.startsWith(`${author}\n`)) {
          body = body.slice(author.length).trim();
        }
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
          date: wrapperDates[index] || '',
          media,
          isOwn,
        };
      });
    }, {
      wrapperSelector: MESSAGE_WRAPPER_SELECTOR,
      todayISO: localDateISO(0),
      yesterdayISO: localDateISO(1),
      year: new Date().getFullYear(),
      months,
    })
    .then((messages) =>
      messages
        .map((msg) => {
          const body = bodyWithMedia(msg.body, msg.media);
          const normalized = {
            ...msg,
            body,
            reply: msg.reply || null,
            isOwn: msg.isOwn || isOwnByAuthor(msg.author),
          };
          return attachIdentity(normalized);
        })
        .filter((msg) => Boolean(msg.body) || (msg.media && msg.media.length > 0))
    );
}

async function readMessages(page) {
  await scrollChatToBottom(page);
  await page.waitForTimeout(500);
  await scrollChatToBottom(page);
  return parseMessages(page);
}

function findNewMessages(messages, seenKeys) {
  return messages.filter((message) => !seenKeys.has(message.key));
}

function messagesMatch(a, b) {
  if (a.author !== b.author || a.body !== b.body) return false;
  if (a.key && b.key && a.key === b.key) return true;
  const dateA = a.date || '';
  const dateB = b.date || '';
  if (dateA && dateB && dateA !== dateB) return false;
  const clockA = a.clock || normalizeClock(a.time);
  const clockB = b.clock || normalizeClock(b.time);
  if (clockA && clockB) return clockA === clockB;
  return a.time === b.time;
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
  openChatPage,
  waitForOpenChat,
  readMessages,
  findNewMessages,
  diffByTail,
  waitForChat,
  shouldForward,
  isOwnByAuthor,
  normalizeClock,
  attachIdentity,
  isDuplicateIdentity,
  identityView,
};
