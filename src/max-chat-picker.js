const { isLoginPage } = require('./parser');
const { isMaxChatUrl, normalizeMaxChatUrl } = require('./max-chats');

const MAX_HOME_URL = 'https://web.max.ru/';
const CHAT_ID_RE = /-\d{5,}/;

function normalizeChatTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChatName(value) {
  return normalizeChatTitle(value).toLowerCase();
}

function chatUrlFromHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';

  const match = raw.match(CHAT_ID_RE);
  if (!match) return '';

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw.split('?')[0]);
      if (/web\.max\.ru$/i.test(url.hostname)) {
        return `https://web.max.ru/${match[0]}`;
      }
    } catch {
      /* ignore */
    }
  }

  return `https://web.max.ru/${match[0]}`;
}

async function extractMaxChatsFromPage(page) {
  return page.evaluate(() => {
    const CHAT_ID = /-\d{5,}/;
    const chats = [];
    const seen = new Set();

    function pickTitle(link, container) {
      const fromAria = link.getAttribute('aria-label') || '';
      if (fromAria.trim()) return fromAria.trim();

      const titleNode = container?.querySelector?.(
        '[class*="title" i], [class*="name" i], [class*="header" i], [class*="peer" i] span, h3, h4'
      );
      const fromNode = titleNode?.innerText || '';
      if (fromNode.trim()) return fromNode.trim().split('\n')[0].trim();

      const fromLink = (link.innerText || '').trim();
      if (fromLink) return fromLink.split('\n')[0].trim();

      return '';
    }

    function addChat(title, href, container) {
      const match = String(href || '').match(CHAT_ID);
      if (!match) return;

      const url = (() => {
        const raw = String(href || '').trim();
        if (/^https?:\/\//i.test(raw)) {
          try {
            const parsed = new URL(raw.split('?')[0]);
            if (/web\.max\.ru$/i.test(parsed.hostname)) {
              return `https://web.max.ru/${match[0]}`;
            }
          } catch {
            /* ignore */
          }
        }
        return `https://web.max.ru/${match[0]}`;
      })();

      if (seen.has(url)) return;

      const cleanTitle = (title || '').replace(/\s+/g, ' ').trim();
      if (!cleanTitle || cleanTitle.length < 1) return;

      seen.add(url);
      chats.push({ title: cleanTitle, url });
    }

    const links = [...document.querySelectorAll('a[href]')];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!CHAT_ID.test(href)) continue;
      const container = link.closest('li, [role="listitem"], [class*="chat" i], [class*="dialog" i], [class*="peer" i], [class*="conversation" i]') || link.parentElement;
      addChat(pickTitle(link, container), href, container);
    }

    return chats;
  });
}

async function findChatListClip(page) {
  return page.evaluate(() => {
    const CHAT_ID = /-\d{5,}/;
    const counts = new Map();

    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (!CHAT_ID.test(href)) continue;

      let el = link;
      for (let depth = 0; depth < 12 && el; depth++) {
        el = el.parentElement;
        if (!el || el === document.body) break;
        counts.set(el, (counts.get(el) || 0) + 1);
      }
    }

    let best = null;
    let bestCount = 0;
    for (const [el, count] of counts) {
      if (count > bestCount) {
        best = el;
        bestCount = count;
      }
    }

    if (!best || bestCount < 1) return null;

    const rect = best.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const padding = 8;

    return {
      x: Math.max(0, rect.x - padding),
      y: Math.max(0, rect.y - padding),
      width: Math.min(viewport.width - Math.max(0, rect.x - padding), rect.width + padding * 2),
      height: Math.min(viewport.height - Math.max(0, rect.y - padding), rect.height + padding * 2),
    };
  });
}

async function captureMaxChatListScreenshot(page) {
  const clip = await findChatListClip(page);
  if (clip?.width > 40 && clip?.height > 40) {
    return page.screenshot({ type: 'png', clip });
  }
  return page.screenshot({ type: 'png', fullPage: false });
}

async function listMaxChats(page) {
  await page.goto(MAX_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);

  if (await isLoginPage(page)) {
    throw new Error('Сессия MAX истекла. Отправьте /reauth');
  }

  await page
    .waitForFunction(
      () => {
        const CHAT_ID = /-\d{5,}/;
        return [...document.querySelectorAll('a[href]')].some((link) =>
          CHAT_ID.test(link.getAttribute('href') || '')
        );
      },
      { timeout: 20000 }
    )
    .catch(() => {});

  let chats = await extractMaxChatsFromPage(page);

  if (!chats.length) {
    throw new Error('Не удалось прочитать список чатов MAX. Отправьте ссылку вручную.');
  }

  const screenshot = await captureMaxChatListScreenshot(page);
  return { chats, screenshot };
}

function resolveMaxChatByName(chats, query) {
  const normalizedQuery = normalizeChatName(query);
  if (!normalizedQuery) return null;

  const exact = chats.filter((chat) => normalizeChatName(chat.title) === normalizedQuery);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { ambiguous: exact };

  const startsWith = chats.filter((chat) => normalizeChatName(chat.title).startsWith(normalizedQuery));
  if (startsWith.length === 1) return startsWith[0];
  if (startsWith.length > 1) return { ambiguous: startsWith };

  const includes = chats.filter((chat) => normalizeChatName(chat.title).includes(normalizedQuery));
  if (includes.length === 1) return includes[0];
  if (includes.length > 1) return { ambiguous: includes };

  return null;
}

function resolveMaxChatInput(text, chats = []) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return { error: 'empty' };
  }

  if (isMaxChatUrl(trimmed)) {
    return { url: normalizeMaxChatUrl(trimmed) };
  }

  const match = resolveMaxChatByName(chats, trimmed);
  if (!match) {
    return { error: 'not_found' };
  }
  if (match.ambiguous) {
    return { error: 'ambiguous', matches: match.ambiguous };
  }

  return { url: match.url, title: match.title };
}

module.exports = {
  MAX_HOME_URL,
  listMaxChats,
  extractMaxChatsFromPage,
  captureMaxChatListScreenshot,
  resolveMaxChatByName,
  resolveMaxChatInput,
  normalizeChatName,
  chatUrlFromHref,
};
