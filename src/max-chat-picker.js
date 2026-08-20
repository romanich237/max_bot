const { isLoginPage, openChatWhenReady } = require('./parser');
const { isMaxChatUrl, normalizeMaxChatUrl, chatLabelFromUrl, mergeChatTitles, setChatTitle, getChatTitle } = require('./max-chats');

const MAX_HOME_URL = 'https://web.max.ru/';
const CHAT_ID_RE = /-\d{5,}/;
const ANY_CHAT_ID_RE = /-?\d{5,}/;

function chatIdFromBlob(blob) {
  const text = String(blob || '');
  const negative = text.match(CHAT_ID_RE);
  if (negative) return negative[0];

  const positive = text.match(/(?:web\.max\.ru\/|href=["']\/)(\d{5,})/);
  return positive ? positive[1] : '';
}

function chatUrlFromChatId(chatId) {
  const id = String(chatId || '').match(ANY_CHAT_ID_RE);
  return id ? `https://web.max.ru/${id[0]}` : '';
}

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

  const match = raw.match(/(?:web\.max\.ru\/|^\/?)(-?\d{5,})/);
  if (!match) return '';

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw.split('?')[0]);
      if (/web\.max\.ru$/i.test(url.hostname)) {
        return `https://web.max.ru/${match[1]}`;
      }
    } catch {
      /* ignore */
    }
  }

  return `https://web.max.ru/${match[1]}`;
}

function chatUrlFromId(chatId) {
  return chatUrlFromChatId(chatId);
}

function isChatListRowEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.querySelector?.('h3.title')) return true;
  if (el.matches?.('h3.title, button.cell')) return true;
  if (el.closest?.('button.cell')) return true;
  return Boolean(el.closest?.('.scrollListContent') && el.closest?.('div.item'));
}

async function openChatsTab(page) {
  const navTab = page.getByRole('tab', { name: /^(чаты|chats)$/i }).first();
  if (await navTab.isVisible({ timeout: 800 }).catch(() => false)) {
    const isChatRow = await navTab.evaluate(isChatListRowEl);
    if (!isChatRow) {
      await navTab.click();
      await page.waitForTimeout(600);
      return true;
    }
  }

  const navButton = page
    .locator(
      'nav button, [role="tablist"] button, [class*="tabbar" i] button, [class*="navbar" i] button, [class*="dock" i] button, aside button'
    )
    .filter({ hasNot: page.locator('h3.title') })
    .filter({ hasText: /^(чаты|chats)$/i })
    .first();
  if (await navButton.isVisible({ timeout: 800 }).catch(() => false)) {
    await navButton.click();
    await page.waitForTimeout(600);
    return true;
  }

  const buttons = page.getByRole('button', { name: /^(чаты|chats)$/i });
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const isChatRow = await btn.evaluate(isChatListRowEl);
    if (isChatRow) continue;
    await btn.click();
    await page.waitForTimeout(600);
    return true;
  }

  return false;
}

async function ensureChatListVisible(page) {
  const currentUrl = page.url();
  if (!/web\.max\.ru/i.test(currentUrl)) {
    await page.goto(MAX_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  } else if (!/\/-?\d{5,}/.test(currentUrl)) {
    await page.goto(MAX_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  const inChat = await page
    .locator('.messageWrapper, .openedChat')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);

  if (inChat && /\/-?\d{5,}/.test(page.url())) {
    const back = page.getByRole('button', { name: /^(go back|назад)$/i });
    if (await back.isVisible({ timeout: 1500 }).catch(() => false)) {
      await back.click();
      await page.waitForTimeout(800);
    } else {
      await page.goto(MAX_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(2000);
    }
  }

  await openChatsTab(page);
}

async function waitForChatListDom(page) {
  await page
    .waitForFunction(
      () => {
        if (document.querySelector('.scrollListContent h3.title, button.cell > h3.title, button.cell h3.title')) {
          return true;
        }

        const CHAT_ID = /-\d{5,}/;
        const hasChatId = (value) => CHAT_ID.test(String(value || ''));

        for (const el of document.querySelectorAll('[href], a, button.cell, [role="listitem"]')) {
          const href = el.getAttribute('href') || '';
          if (hasChatId(href)) return true;

          for (const attr of el.attributes || []) {
            if (hasChatId(attr.value)) return true;
          }
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

    function chatIdFromBlob(blob) {
      const text = String(blob || '');
      const negative = text.match(/-\d{5,}/);
      if (negative) return negative[0];
      const fromHref = text.match(/(?:web\.max\.ru\/|href=["']\/)(-?\d{5,})/);
      if (fromHref) return fromHref[1];
      return '';
    }

    function chatUrlFromId(chatId) {
      return chatId ? `https://web.max.ru/${chatId}` : '';
    }

    function chatUrlFromMatch(match) {
      return chatUrlFromId(match?.[0]);
    }

    function nodeBlob(el) {
      if (!el) return '';
      const attrs = [...(el.attributes || [])].map((attr) => attr.value).join(' ');
      return [el.getAttribute?.('href') || '', attrs, el.outerHTML || ''].join(' ');
    }

    function pickTitle(container) {
      if (!container) return '';

      const titleNode =
        (container.matches?.('h3.title') ? container : null) ||
        container.querySelector?.('h3.title');
      const fromTitle = (titleNode?.innerText || '').trim().split('\n')[0].trim();
      if (fromTitle) return fromTitle;

      const fromAria = container.getAttribute('aria-label') || '';
      if (fromAria.trim()) {
        return fromAria.trim().split(',')[0].trim();
      }

      const fallbackNode = container.querySelector?.(
        '[class*="title" i], [class*="name" i], [class*="header" i], [class*="peer" i] span, h3, h4'
      );
      const fromNode = fallbackNode?.innerText || '';
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
            return el.closest('button.cell, div.item, li, [role="listitem"]') || el;
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

      const key = cleanTitle.toLowerCase();

      if (!url) {
        const fromList = Boolean(
          container &&
            (container.matches?.('h3.title, button.cell, div.item') ||
              container.querySelector?.('h3.title') ||
              container.closest?.('.scrollListContent, .scrollListScrollable, button.cell, div.item'))
        );
        if (/^(chats|чаты)$/i.test(cleanTitle) && !fromList) return;
        if (seenTitles.has(key)) return;
        seenTitles.add(key);
        chats.push({ title: cleanTitle, url: null });
        return;
      }

      if (seen.has(url)) {
        const existing = chats.find((chat) => chat.url === url);
        if (existing && (!existing.title || CHAT_ID.test(existing.title))) {
          existing.title = cleanTitle;
        }
        return;
      }

      const titleOnly = chats.findIndex((chat) => !chat.url && chat.title.toLowerCase() === key);
      if (titleOnly >= 0) {
        chats[titleOnly].url = url;
        seen.add(url);
        return;
      }

      seen.add(url);
      seenTitles.add(key);
      chats.push({ title: cleanTitle, url });
    }

    function addFromRow(row) {
      if (!row) return;
      const heading = row.querySelector?.('h3.title') || (row.matches?.('h3.title') ? row : null);
      const title = (heading?.innerText || pickTitle(row) || '').trim().split('\n')[0].trim();
      const blob = [nodeBlob(row), nodeBlob(row.parentElement), nodeBlob(heading)].join(' ');
      addChat(title, chatUrlFromId(chatIdFromBlob(blob)) || null, row);
    }

    for (const item of document.querySelectorAll(
      '.scrollListContent div.item, .scrollListScrollable div.item, aside div.item'
    )) {
      const cell = item.querySelector('button.cell') || item;
      addFromRow(cell);
    }

    for (const h3 of document.querySelectorAll('button.cell > h3.title, button.cell h3.title, h3.title')) {
      const title = (h3.innerText || '').trim().split('\n')[0].trim();
      if (!title) continue;

      const row =
        h3.closest('button.cell, div.item') ||
        h3.parentElement?.closest?.('button.cell, div.item');
      addFromRow(row || h3);
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

    for (const match of html.matchAll(/(?:https:\/\/web\.max\.ru)?\/(\d{5,})(?=["'/?#\s]|$)/g)) {
      const chatId = match[1];
      const url = chatUrlFromMatch([chatId]);
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
  const profileBtn = page
    .getByRole('button', { name: /^(Open|Открыть)\s+.+(profile|профил)/i })
    .first();
  if (await profileBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    const label =
      (await profileBtn.getAttribute('aria-label')) || (await profileBtn.innerText()) || '';
    const fromLabel =
      label.match(/^Open\s+(.+?)(?:'s|’s)\s+profile$/i)?.[1] ||
      label.match(/^Открыть профиль\s+(.+)$/i)?.[1] ||
      label.match(/^(?:Open|Открыть)\s+(.+?)(?:'s|’s)?\s*(?:profile|профил)/i)?.[1];
    if (fromLabel?.trim()) return fromLabel.trim();
  }

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

async function ensureChatTitleFromPage(page, chatUrl) {
  const normalized = normalizeMaxChatUrl(chatUrl);
  if (!normalized || getChatTitle(normalized)) return getChatTitle(normalized);

  const title = await readOpenChatTitle(page);
  if (title) {
    setChatTitle(normalized, title);
    return title;
  }

  return '';
}

async function resolveChatUrlByTitle(page, title) {
  const query = normalizeChatTitle(title);
  if (!query) return null;

  await ensureChatListVisible(page);

  const cell = page
    .locator('button.cell')
    .filter({
      has: page.locator('h3.title').filter({ hasText: new RegExp(`^${escapeRegExp(query)}$`, 'i') }),
    })
    .first();
  const titleLocator = page
    .locator('button.cell > h3.title, button.cell h3.title')
    .filter({ hasText: new RegExp(`^${escapeRegExp(query)}$`, 'i') })
    .first();

  if (await cell.isVisible({ timeout: 2500 }).catch(() => false)) {
    await cell.click();
  } else if (await titleLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
    const parentButton = titleLocator.locator('xpath=ancestor::button[1]');
    if (await parentButton.isVisible({ timeout: 400 }).catch(() => false)) {
      await parentButton.click();
    } else {
      await titleLocator.click();
    }
  } else {
    const button = page
      .getByRole('button', { name: new RegExp(`^${escapeRegExp(query)}`, 'i') })
      .first();

    if (!(await button.isVisible({ timeout: 2000 }).catch(() => false))) {
      return null;
    }
    await button.click();
  }

  await page.waitForURL(/web\.max\.ru\/-?\d{5,}/, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);

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
    const buttons = document.querySelectorAll('button.cell, [role="listitem"]').length;
    const titles = [...document.querySelectorAll('button.cell h3.title, h3.title')].map((el) =>
      (el.innerText || '').trim().split('\n')[0].trim()
    );
    const htmlMatches = (document.body?.innerHTML || '').match(/\/-\d{5,}/g) || [];
    return {
      url: location.href,
      chatLinks: links.length,
      buttons,
      titles: titles.slice(0, 20),
      titleCount: titles.length,
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

async function discoverMaxChatsForMonitor(page) {
  if (!page || page.isClosed()) {
    throw new Error('Браузер MAX недоступен. Перезапустите бота.');
  }

  const returnUrl = page.url();
  await ensureChatListVisible(page);

  if (await isLoginPage(page)) {
    throw new Error('Сессия MAX истекла. Отправьте /reauth');
  }

  await waitForChatListDom(page);
  await page.waitForTimeout(1200);

  let chats = await extractMaxChatsFromPage(page);
  if (!chats.length) {
    await page.waitForTimeout(1500);
    chats = await extractMaxChatsFromPage(page);
  }

  mergeChatTitles(chats.filter((chat) => chat.url && chat.title));

  const urls = [...new Set(chats.map((chat) => normalizeMaxChatUrl(chat.url)).filter(Boolean))];

  const shouldRestore = /web\.max\.ru\/-?\d{5,}/.test(returnUrl);
  if (shouldRestore && returnUrl !== page.url()) {
    await openChatWhenReady(page, returnUrl).catch(() => {});
  }

  return { chats, urls };
}

async function readUnreadCounts(page) {
  if (!page || page.isClosed()) {
    return { chats: 0, messages: 0 };
  }

  try {
    await ensureChatListVisible(page);
    await page.waitForTimeout(600);

    return await page.evaluate(() => {
      function parseCount(text) {
        const raw = String(text || '')
          .trim()
          .replace(/\s+/g, '');
        if (!raw || /^\d{1,2}:\d{2}/.test(raw)) return 0;
        const plus = raw.match(/^(\d{1,4})\+$/);
        if (plus) return Number(plus[1]);
        if (/^\d{1,5}$/.test(raw)) return Number(raw);
        return 0;
      }

      function chatIdFromEl(el) {
        if (!el) return '';
        const blob = [el.getAttribute?.('href') || '', el.outerHTML || ''].join(' ');
        const match = blob.match(/web\.max\.ru\/(-?\d{5,})/) || blob.match(/["'\/](-?\d{5,})["'/?#\s]/);
        return match ? match[1] : '';
      }

      function unreadFromRow(row) {
        if (!row) return 0;

        const badges = row.querySelectorAll(
          '[class*="counter" i], [class*="badge" i], [class*="unread" i], [class*="count" i], [class*="notif" i], [class*="indicator" i]'
        );
        let best = 0;
        for (const badge of badges) {
          const n = parseCount(badge.innerText || badge.textContent || '');
          if (n > best) best = n;
        }
        if (best > 0) return best;

        const attr =
          row.getAttribute('data-unread') ||
          row.getAttribute('data-count') ||
          row.getAttribute('aria-label') ||
          '';
        const fromAria = String(attr).match(/(\d{1,5})\s*(непрочит|unread|сообщ|message)/i);
        if (fromAria) return Number(fromAria[1]);
        const fromAttr = parseCount(attr);
        if (fromAttr > 0 && fromAttr < 10000) return fromAttr;

        if (
          row.querySelector(
            '[class*="unread" i], [class*="dot" i], [class*="indicator" i], [class*="mention" i]'
          )
        ) {
          return 1;
        }

        return 0;
      }

      const seen = new Set();
      let chats = 0;
      let messages = 0;

      const cells = document.querySelectorAll('button.cell');
      for (const cell of cells) {
        const heading = cell.querySelector('h3.title');
        if (!heading) continue;

        const item = cell.closest('div.item') || cell;
        const title = (heading.innerText || '').trim().split('\n')[0].trim();
        const id = chatIdFromEl(item) || chatIdFromEl(cell) || (title ? `title:${title.toLowerCase()}` : '');
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const count = unreadFromRow(item);
        if (count > 0) {
          chats += 1;
          messages += count;
        }
      }

      let tabCount = 0;
      for (const btn of document.querySelectorAll(
        'nav button, [role="tab"], [class*="tabbar" i] button, [class*="navbar" i] button, aside button'
      )) {
        if (btn.querySelector('h3.title') || btn.closest('.scrollListContent, .scrollListScrollable')) continue;
        const label = (btn.innerText || '').trim().split('\n')[0].trim();
        if (!/^(чаты|chats)$/i.test(label)) continue;
        tabCount = unreadFromRow(btn);
        break;
      }

      if (tabCount > 0 && chats === 0 && messages === 0) {
        chats = tabCount;
        messages = tabCount;
      } else if (tabCount > 0 && messages > 0 && Math.abs(tabCount - messages) <= 1) {
        messages = Math.max(messages, tabCount);
      }

      return { chats, messages };
    });
  } catch (err) {
    console.warn('непрочитанные MAX:', err.message);
    return { chats: 0, messages: 0 };
  }
}

module.exports = {
  MAX_HOME_URL,
  listMaxChats,
  ensureChatListVisible,
  openChatsTab,
  extractMaxChatsFromPage,
  captureMaxChatListScreenshot,
  readUnreadCounts,
  readOpenChatTitle,
  ensureChatTitleFromPage,
  resolveChatUrlByTitle,
  syncMonitoredChatTitles,
  resolveMaxChatByName,
  resolveMaxChatInput,
  normalizeChatName,
  chatUrlFromHref,
  discoverMaxChatsForMonitor,
};
