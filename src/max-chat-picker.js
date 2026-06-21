const { isLoginPage } = require('./parser');
const { isMaxChatUrl, normalizeMaxChatUrl, chatLabelFromUrl, mergeChatTitles, setChatTitle, getChatTitle } = require('./max-chats');

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

function chatUrlFromId(chatId) {
  const id = String(chatId || '').match(CHAT_ID_RE);
  return id ? `https://web.max.ru/${id[0]}` : '';
}

async function ensureChatListVisible(page) {
  const currentUrl = page.url();
  if (!/web\.max\.ru/i.test(currentUrl)) {
    await page.goto(MAX_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  } else if (!/\/-\d{5,}/.test(currentUrl)) {
    await page.goto(MAX_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  const inChat = await page
    .locator('.messageWrapper, .openedChat')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);

  if (inChat && /\/-\d{5,}/.test(page.url())) {
    const back = page.getByRole('button', { name: /^(go back|назад)$/i });
    if (await back.isVisible({ timeout: 1500 }).catch(() => false)) {
      await back.click();
      await page.waitForTimeout(800);
    } else {
      await page.goto(MAX_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(2000);
    }
  }

  const chatsBtn = page.getByRole('button', { name: /^(chats|чаты)$/i });
  if (await chatsBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await chatsBtn.click();
    await page.waitForTimeout(800);
  }
}

async function waitForChatListDom(page) {
  await page
    .waitForFunction(
      () => {
        const CHAT_ID = /-\d{5,}/;
        const hasChatId = (value) => CHAT_ID.test(String(value || ''));

        for (const el of document.querySelectorAll('[href], a, button, [role="listitem"], [class*="cell" i]')) {
          const href = el.getAttribute('href') || '';
          if (hasChatId(href)) return true;

          for (const attr of el.attributes || []) {
            if (hasChatId(attr.value)) return true;
          }

          const text = el.innerText || '';
          if (hasChatId(text)) return true;
        }

        for (const h3 of document.querySelectorAll('h3')) {
          const title = (h3.innerText || '').trim();
          if (title && !/^(chats|чаты)$/i.test(title)) return true;
        }

        return hasChatId(document.body?.innerHTML || '');
      },
      { timeout: 25000 }
    )
    .catch(() => {});
}

async function extractMaxChatsFromPage(page) {
  return page.evaluate(() => {
    const CHAT_ID = /-\d{5,}/;

    function chatUrlFromMatch(match) {
      return `https://web.max.ru/${match[0]}`;
    }

    function pickTitle(container) {
      if (!container) return '';

      const fromAria = container.getAttribute('aria-label') || '';
      if (fromAria.trim()) {
        return fromAria.trim().split(',')[0].trim();
      }

      const titleNode = container.querySelector?.(
        '[class*="title" i], [class*="name" i], [class*="header" i], [class*="peer" i] span, h3, h4'
      );
      const fromNode = titleNode?.innerText || '';
      if (fromNode.trim()) {
        return fromNode.trim().split('\n')[0].trim();
      }

      const lines = (container.innerText || '')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      for (const line of lines) {
        if (/^\d{1,2}:\d{2}$/.test(line)) continue;
        if (CHAT_ID.test(line)) continue;
        if (/^(вчера|сегодня|yesterday|today)$/i.test(line)) continue;
        return line;
      }

      return lines[0] || '';
    }

    function findContainerForId(chatId) {
      const escaped = chatId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const selectors = [
        `a[href*="${chatId}"]`,
        `[href*="${chatId}"]`,
        `button`,
        '[role="listitem"]',
        '[class*="cell" i]',
        '[class*="chat" i]',
        '[class*="dialog" i]',
        '[class*="peer" i]',
        '[class*="conversation" i]',
      ];

      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const blob = [
            el.getAttribute('href') || '',
            el.outerHTML || '',
            el.innerText || '',
          ].join(' ');
          if (new RegExp(escaped).test(blob)) {
            return el.closest('li, [role="listitem"], button, [class*="cell" i], [class*="chat" i], [class*="dialog" i], [class*="peer" i]') || el;
          }
        }
      }

      return null;
    }

    const chats = [];
    const seen = new Set();
    const seenTitles = new Set();

    function addChat(title, url, container) {
      let cleanTitle = (title || pickTitle(container) || '').replace(/\s+/g, ' ').trim();
      if (!cleanTitle) return;

      if (!url) {
        const key = cleanTitle.toLowerCase();
        if (seenTitles.has(key)) return;
        seenTitles.add(key);
        chats.push({ title: cleanTitle, url: null });
        return;
      }

      if (seen.has(url)) return;

      if (CHAT_ID.test(cleanTitle)) {
        const id = url.match(CHAT_ID);
        cleanTitle = id ? `Чат ${id[0]}` : url;
      }

      seen.add(url);
      seenTitles.add(cleanTitle.toLowerCase());
      chats.push({ title: cleanTitle, url });
    }

    const SKIP_HEADINGS = /^(chats|чаты)$/i;
    for (const h3 of document.querySelectorAll('h3')) {
      const title = (h3.innerText || '').trim().split('\n')[0].trim();
      if (!title || SKIP_HEADINGS.test(title)) continue;

      const row =
        h3.closest('button.cell, button[class*="cell"]') ||
        h3.parentElement?.closest?.('button.cell, button[class*="cell"]');
      const blob = [row?.outerHTML || '', h3.outerHTML || ''].join(' ');
      const neg = blob.match(CHAT_ID);
      addChat(title, neg ? chatUrlFromMatch(neg) : null, row);
    }

    for (const link of document.querySelectorAll('a[href], [href]')) {
      const href = link.getAttribute('href') || '';
      const match = href.match(CHAT_ID);
      if (!match) continue;

      const container =
        link.closest(
          'li, [role="listitem"], button, [class*="cell" i], [class*="chat" i], [class*="dialog" i], [class*="peer" i], [class*="conversation" i]'
        ) || link.parentElement;

      addChat(pickTitle(container) || pickTitle(link), chatUrlFromMatch(match), container);
    }

    for (const el of document.querySelectorAll(
      'button, [role="button"], [role="listitem"], [class*="cell" i], [class*="chat" i], [class*="dialog" i], [class*="peer" i]'
    )) {
      let chatId = '';

      for (const attr of el.attributes || []) {
        const match = String(attr.value || '').match(CHAT_ID);
        if (match) {
          chatId = match[0];
          break;
        }
      }

      if (!chatId) {
        const innerLink = el.querySelector('a[href], [href]');
        const href = innerLink?.getAttribute('href') || '';
        const match = href.match(CHAT_ID);
        if (match) chatId = match[0];
      }

      if (!chatId) continue;

      addChat(pickTitle(el), chatUrlFromMatch(chatId.match(CHAT_ID)), el);
    }

    const html = document.body?.innerHTML || '';
    for (const match of html.matchAll(/(?:https:\/\/web\.max\.ru)?\/(-\d{5,})/g)) {
      const chatId = `-${match[1]}`;
      const url = chatUrlFromMatch(chatId.match(CHAT_ID));
      const container = findContainerForId(chatId);
      addChat(pickTitle(container), url, container);
    }

    return chats;
  });
}

async function findChatListClip(page) {
  return page.evaluate(() => {
    const CHAT_ID = /-\d{5,}/;
    const counts = new Map();

    function bump(el) {
      let node = el;
      for (let depth = 0; depth < 12 && node; depth++) {
        node = node.parentElement;
        if (!node || node === document.body) break;
        counts.set(node, (counts.get(node) || 0) + 1);
      }
    }

    for (const el of document.querySelectorAll('a[href], [href], button, [role="listitem"], [class*="cell" i]')) {
      const blob = [
        el.getAttribute('href') || '',
        el.outerHTML || '',
      ].join(' ');

      if (!CHAT_ID.test(blob)) continue;
      bump(el);
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
  return page.screenshot({ type: 'png', fullPage: false   });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePageChatUrl(url) {
  const raw = String(url || '').trim();
  if (!/web\.max\.ru/i.test(raw)) return '';

  try {
    const parsed = new URL(raw.split('?')[0]);
    const segment = parsed.pathname.replace(/^\//, '').trim();
    if (!segment) return '';
    return `https://web.max.ru/${segment}`;
  } catch {
    return '';
  }
}

async function readOpenChatTitle(page) {
  const mainName = await page
    .locator('main[name*="Chat window" i], main[name*="чат" i]')
    .first()
    .getAttribute('name')
    .catch(() => null);

  if (mainName) {
    const cleaned = mainName
      .replace(/^Chat window with\s+/i, '')
      .replace(/^Чат с\s+/i, '')
      .replace(/\u00a0/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }

  const heading = page.locator('h2').first();
  if (await heading.isVisible({ timeout: 1000 }).catch(() => false)) {
    const text = (await heading.innerText()).trim();
    const match = text.match(/(?:Chat window with|Чат)\s+(.+)/i);
    if (match?.[1]) return match[1].trim();
    return text.split('\n')[0].trim();
  }

  return '';
}

async function resolveChatUrlByTitle(page, title) {
  const query = normalizeChatTitle(title);
  if (!query) return null;

  await ensureChatListVisible(page);

  const button = page
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(query)}`, 'i') })
    .first();

  if (await button.isVisible({ timeout: 2500 }).catch(() => false)) {
    await button.click();
  } else {
    const heading = page
      .locator('h3')
      .filter({ hasText: new RegExp(`^${escapeRegExp(query)}$`, 'i') })
      .first();

    if (!(await heading.isVisible({ timeout: 2000 }).catch(() => false))) {
      return null;
    }

    await heading.click();
  }

  await page.waitForTimeout(1500);
  const url = normalizePageChatUrl(page.url());
  if (!url || url === MAX_HOME_URL.replace(/\/$/, '')) return null;
  return url;
}

async function syncMonitoredChatTitles(page, urls = [], options = {}) {
  const { force = false } = options;
  const updated = {};

  for (const chatUrl of urls.filter(Boolean)) {
    if (!force && getChatTitle(chatUrl)) continue;

    try {
      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(2000);

      if (await isLoginPage(page)) {
        console.warn(`Не удалось прочитать название чата ${chatUrl}: сессия MAX истекла`);
        continue;
      }

      const title = await readOpenChatTitle(page);
      if (title) {
        setChatTitle(chatUrl, title);
        updated[chatUrl] = title;
      }
    } catch (err) {
      console.warn(`Не удалось прочитать название чата ${chatUrl}:`, err.message);
    }
  }

  return updated;
}

async function debugChatListState(page) {
  return page.evaluate(() => {
    const CHAT_ID = /-\d{5,}/;
    const links = [...document.querySelectorAll('a[href], [href]')].filter((el) =>
      CHAT_ID.test(el.getAttribute('href') || '')
    );
    const buttons = document.querySelectorAll('button, [role="listitem"], [class*="cell" i]').length;
    const htmlMatches = (document.body?.innerHTML || '').match(/\/-\d{5,}/g) || [];
    return {
      url: location.href,
      chatLinks: links.length,
      buttons,
      htmlChatIds: [...new Set(htmlMatches)].slice(0, 5),
    };
  });
}

async function listMaxChats(page) {
  if (!page || page.isClosed()) {
    throw new Error('Браузер MAX недоступен. Перезапустите бота.');
  }

  await ensureChatListVisible(page);

  if (await isLoginPage(page)) {
    throw new Error('Сессия MAX истекла. Отправьте /reauth');
  }

  let chats = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForChatListDom(page);
    await page.waitForTimeout(attempt === 0 ? 1500 : 2500);

    chats = await extractMaxChatsFromPage(page);
    if (chats.length) break;

    await ensureChatListVisible(page);
  }

  if (!chats.length) {
    const debug = await debugChatListState(page).catch(() => ({}));
    console.warn('listMaxChats: пустой список', JSON.stringify(debug));

    const knownUrls = [...new Set((debug.htmlChatIds || []).map((id) => chatUrlFromId(id)).filter(Boolean))];
    if (knownUrls.length) {
      chats = knownUrls.map((url) => ({
        url,
        title: chatLabelFromUrl(url),
      }));
    }
  }

  if (!chats.length) {
    throw new Error('Не удалось прочитать список чатов MAX. Отправьте ссылку вручную.');
  }

  const screenshot = await captureMaxChatListScreenshot(page);
  mergeChatTitles(chats.filter((chat) => chat.url && chat.title));
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

  if (!match.url) {
    return { title: match.title, needsUrl: true };
  }

  return { url: match.url, title: match.title };
}

module.exports = {
  MAX_HOME_URL,
  listMaxChats,
  ensureChatListVisible,
  extractMaxChatsFromPage,
  captureMaxChatListScreenshot,
  readOpenChatTitle,
  resolveChatUrlByTitle,
  syncMonitoredChatTitles,
  resolveMaxChatByName,
  resolveMaxChatInput,
  normalizeChatName,
  chatUrlFromHref,
};
