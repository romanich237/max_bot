const { isLoginPage, openChatWhenReady } = require('./parser');
const {
  isMaxChatUrl,
  normalizeMaxChatUrl,
  chatLabelFromUrl,
  mergeChatTitles,
  setChatTitle,
  getChatTitle,
  getChatTitles,
  isRequiredChatUrl,
  GROUP_SUBTITLE_SELECTOR,
  GROUP_SUBTITLE_PATTERN,
  kindFromSubtitleText,
  PERSONAL_ONLINE_SELECTOR,
  getStoredChatKind,
  setChatKind,
} = require('./max-chats');

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
  return page.evaluate((groupSubtitlePattern) => {
    const ANY_CHAT_ID = /(?:web\.max\.ru\/|["'/])(-?\d{5,})(?:["'/?#\s]|$)/g;
    const GROUP_SUBTITLE_RE = new RegExp(groupSubtitlePattern, 'i');
    const JUNK_TITLE_RE =
      /^(группа|group|groups|канал|channel|чаты|chats|чат|личные|personal|online|в сети)$/i;

    function looksLikeChatId(value) {
      const text = String(value || '');
      if (!/^-?\d{5,16}$/.test(text)) return false;
      const abs = Math.abs(Number(text));
      if (!Number.isFinite(abs) || abs < 10000) return false;
      if (abs >= 1e12 && abs < 2e13) return false;
      return true;
    }

    function idFromValue(value) {
      if (value == null) return '';
      if (typeof value === 'number' && looksLikeChatId(String(Math.trunc(value)))) {
        return String(Math.trunc(value));
      }
      const text = String(value);
      const href = text.match(/(?:web\.max\.ru\/|href=["']\/|["'/])(-?\d{5,16})(?:["'/?#\s]|$)/);
      if (href && looksLikeChatId(href[1])) return href[1];
      if (looksLikeChatId(text)) return text;
      return '';
    }

    function chatIdFromBlob(blob) {
      return idFromValue(blob);
    }

    function visitForId(value, depth, seen) {
      if (value == null || depth > 6) return '';
      const direct = idFromValue(value);
      if (direct) return direct;
      if (typeof value !== 'object') return '';
      if (seen.has(value)) return '';
      seen.add(value);
      try {
        const entries = Object.entries(value);
        for (const [key, val] of entries) {
          if (!/id|peer|dialog|chat|cid/i.test(key)) continue;
          const found = idFromValue(val) || visitForId(val, depth + 1, seen);
          if (found) return found;
        }
        if (depth < 3) {
          for (const val of Object.values(value)) {
            const found = visitForId(val, depth + 1, seen);
            if (found) return found;
          }
        }
      } catch {
        /* ignore */
      }
      return '';
    }

    function chatIdFromSvelte(el) {
      let node = el;
      for (let i = 0; i < 10 && node; i++) {
        let names = [];
        try {
          names = Object.getOwnPropertyNames(node);
        } catch {
          names = [];
        }
        for (const key of names) {
          if (!key.startsWith('__') && !key.startsWith('$') && key !== '$$') continue;
          try {
            const found = visitForId(node[key], 0, new Set());
            if (found) return found;
          } catch {
            /* ignore */
          }
        }
        if (node.dataset) {
          for (const val of Object.values(node.dataset)) {
            const found = idFromValue(val);
            if (found) return found;
          }
        }
        node = node.parentElement;
      }
      return '';
    }

    function chatUrlFromId(chatId) {
      return chatId ? `https://web.max.ru/${chatId}` : '';
    }

    function nodeBlob(el) {
      if (!el) return '';
      const attrs = [...(el.attributes || [])].map((attr) => attr.value).join(' ');
      return [el.getAttribute?.('href') || '', attrs, el.outerHTML || ''].join(' ');
    }

    function isJunkTitle(value) {
      return JUNK_TITLE_RE.test(String(value || '').replace(/\s+/g, ' ').trim());
    }

    function rowTitle(container) {
      if (!container) return '';
      const heading =
        (container.matches?.('h3.title') ? container : null) ||
        container.querySelector?.('h3.title');
      const fromTitle = (heading?.innerText || '').trim().split('\n')[0].trim();
      if (fromTitle && !isJunkTitle(fromTitle)) return fromTitle;
      return '';
    }

    function kindFromContainer(container) {
      if (!container) return '';
      if (container.querySelector?.('.subtitleWrapper .online, span.online')) {
        return 'personal';
      }
      const node =
        (container.matches?.('.subtitleWrapper') ? container : null) ||
        container.querySelector?.('.subtitleWrapper');
      const text = (node?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return GROUP_SUBTITLE_RE.test(text) ? 'group' : '';
    }

    function listRoot() {
      return (
        document.querySelector('aside .scrollListContent') ||
        document.querySelector('aside .scrollListScrollable') ||
        document.querySelector('aside') ||
        document.querySelector('.scrollListContent')
      );
    }

    const chats = [];
    const seen = new Set();
    const seenTitles = new Set();

    function addChat(title, url, container) {
      const kind = kindFromContainer(container);
      let cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
      if (isJunkTitle(cleanTitle)) cleanTitle = '';
      if (!cleanTitle) cleanTitle = url || '';
      if (!cleanTitle) return;

      const key = cleanTitle.toLowerCase();

      if (!url) {
        if (seenTitles.has(key)) return;
        seenTitles.add(key);
        chats.push({ title: cleanTitle, url: null, kind: kind || undefined });
        return;
      }

      if (seen.has(url)) {
        const existing = chats.find((chat) => chat.url === url);
        if (existing && (!existing.title || existing.title === url || isJunkTitle(existing.title))) {
          if (cleanTitle && cleanTitle !== url) existing.title = cleanTitle;
        }
        if (existing && kind && !existing.kind) existing.kind = kind;
        return;
      }

      const titleOnly = chats.findIndex((chat) => !chat.url && chat.title.toLowerCase() === key);
      if (titleOnly >= 0) {
        chats[titleOnly].url = url;
        if (kind) chats[titleOnly].kind = kind;
        seen.add(url);
        return;
      }

      seen.add(url);
      seenTitles.add(key);
      chats.push({ title: cleanTitle, url, kind: kind || undefined });
    }

    function addFromRow(row) {
      if (!row || row.closest?.('.openedChat')) return;
      const item = row.closest?.('div.item') || row;
      const cell = item.querySelector?.('button.cell') || (item.matches?.('button.cell') ? item : row);
      const blob = [nodeBlob(item), nodeBlob(cell)].join(' ');
      const chatId =
        chatIdFromBlob(blob) || chatIdFromSvelte(cell) || chatIdFromSvelte(item) || '';
      const url = chatUrlFromId(chatId) || null;
      addChat(rowTitle(cell) || rowTitle(item), url, cell);
    }

    const root = listRoot();
    const scope = root || document;
    for (const item of scope.querySelectorAll('div.item, button.cell')) {
      if (item.closest?.('.openedChat')) continue;
      if (root && !root.contains(item)) continue;
      addFromRow(item);
    }

    if (root) {
      const html = root.innerHTML || '';
      for (const match of html.matchAll(ANY_CHAT_ID)) {
        const chatId = match[1];
        if (!chatId) continue;
        const url = chatUrlFromId(chatId);
        if (!url || seen.has(url)) continue;
        addChat(url, url, root);
      }
    }

    return chats;
  }, GROUP_SUBTITLE_PATTERN);
}

async function findChatListClip(page) {
  return page.evaluate(() => {
    const list =
      document.querySelector('aside .scrollListScrollable') ||
      document.querySelector('aside .cropped') ||
      document.querySelector('aside .scrollListContent') ||
      document.querySelector('aside');

    if (!list) return null;

    const rect = list.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;

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

async function readOpenChatSubtitle(page) {
  const loc = page.locator(GROUP_SUBTITLE_SELECTOR).first();
  const visible = await loc.isVisible({ timeout: 2500 }).catch(() => false);
  if (!visible) return '';
  const text = await loc.innerText().catch(() => '');
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function hasOpenChatOnlineStatus(page) {
  const loc = page.locator(PERSONAL_ONLINE_SELECTOR).first();
  return loc.isVisible({ timeout: 800 }).catch(() => false);
}

async function ensureChatKindFromPage(page, chatUrl) {
  const normalized = normalizeMaxChatUrl(chatUrl);
  if (!normalized || isRequiredChatUrl(normalized)) {
    return getStoredChatKind(normalized) || '';
  }

  const subtitle = await readOpenChatSubtitle(page);
  let kind = kindFromSubtitleText(subtitle);
  if (kind !== 'group' && (await hasOpenChatOnlineStatus(page))) {
    kind = 'personal';
  }
  if (kind) setChatKind(normalized, kind);
  return kind || getStoredChatKind(normalized);
}

async function readOpenChatTitle(page) {
  const opened = page.locator('.openedChat').first();
  const hasOpened = await opened.isVisible({ timeout: 800 }).catch(() => false);
  const scope = hasOpened ? opened : page;

  const profileBtn = scope
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
    .locator('main[name*="Chat window" i]')
    .first()
    .getAttribute('name')
    .catch(() => null);

  if (mainName) {
    const cleaned = mainName
      .replace(/^Chat window with\s+/i, '')
      .replace(/^Чат с\s+/i, '')
      .replace(/\u00a0/g, ' ')
      .trim();
    if (cleaned && !/^(chat window|чат)$/i.test(cleaned)) return cleaned;
  }

  const heading = scope.locator('h2').first();
  if (await heading.isVisible({ timeout: 1000 }).catch(() => false)) {
    const text = (await heading.innerText()).trim();
    const match = text.match(/(?:Chat window with|Чат с)\s+(.+)/i);
    if (match?.[1]) return match[1].trim();
    const firstLine = text.split('\n')[0].trim();
    if (firstLine && !/^(чаты|chats)$/i.test(firstLine)) return firstLine;
  }

  return '';
}

function titleOwnedByOtherChat(title, url) {
  const clean = normalizeChatTitle(title).toLowerCase();
  if (!clean) return false;
  const current = normalizeMaxChatUrl(url);
  for (const [otherUrl, stored] of Object.entries(getChatTitles())) {
    if (otherUrl === current) continue;
    if (normalizeChatTitle(stored).toLowerCase() === clean) return true;
  }
  return false;
}

async function ensureChatTitleFromPage(page, chatUrl) {
  const normalized = normalizeMaxChatUrl(chatUrl);
  await ensureChatKindFromPage(page, normalized);

  if (!normalized || getChatTitle(normalized) || isRequiredChatUrl(normalized)) {
    return getChatTitle(normalized) || chatLabelFromUrl(normalized);
  }

  const title = await readOpenChatTitle(page);
  if (title && !titleOwnedByOtherChat(title, normalized)) {
    setChatTitle(normalized, title);
    return title;
  }

  return getChatTitle(normalized);
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
      await ensureChatKindFromPage(page, chatUrl);
      if (title && !titleOwnedByOtherChat(title, chatUrl)) {
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

async function collectAllMaxChats(page) {
  const byKey = new Map();

  function merge(chats) {
    for (const chat of chats || []) {
      const titleKey = normalizeChatName(chat.title);
      if (!titleKey && !chat.url) continue;
      const existing = [...byKey.values()].find(
        (item) =>
          (chat.url && item.url === chat.url) ||
          (titleKey && normalizeChatName(item.title) === titleKey)
      );
      if (existing) {
        if (!existing.url && chat.url) existing.url = chat.url;
        if (!existing.kind && chat.kind) existing.kind = chat.kind;
        if (chat.title && (!existing.title || existing.title.length < chat.title.length)) {
          existing.title = chat.title;
        }
        continue;
      }
      byKey.set(chat.url || `title:${titleKey}`, { ...chat });
    }
  }

  merge(await extractMaxChatsFromPage(page));

  let stagnant = 0;
  for (let step = 0; step < 30; step++) {
    const before = byKey.size;
    const moved = await page.evaluate(() => {
      const nodes = [
        document.querySelector('.scrollListScrollable'),
        document.querySelector('.scrollListContent'),
      ].filter(Boolean);

      let scroller = null;
      for (const el of nodes) {
        let cur = el;
        for (let i = 0; i < 8 && cur; i++) {
          if (cur.scrollHeight > cur.clientHeight + 24) {
            scroller = cur;
            break;
          }
          cur = cur.parentElement;
        }
        if (scroller) break;
      }
      if (!scroller) return false;

      const prev = scroller.scrollTop;
      scroller.scrollBy(0, Math.max(scroller.clientHeight - 48, 180));
      if (scroller.scrollTop <= prev + 2) {
        scroller.scrollTop = scroller.scrollHeight;
      }
      return scroller.scrollTop > prev + 2;
    });

    await page.waitForTimeout(400);
    merge(await extractMaxChatsFromPage(page));

    if (byKey.size <= before && !moved) stagnant += 1;
    else stagnant = 0;
    if (stagnant >= 2) break;
  }

  await page.evaluate(() => {
    const nodes = [
      document.querySelector('.scrollListScrollable'),
      document.querySelector('.scrollListContent'),
    ].filter(Boolean);
    for (const el of nodes) {
      let cur = el;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur.scrollHeight > cur.clientHeight + 24) {
          cur.scrollTop = 0;
          return;
        }
        cur = cur.parentElement;
      }
    }
  });
  await page.waitForTimeout(250);

  return [...byKey.values()];
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

    chats = await collectAllMaxChats(page);
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
  await page.waitForTimeout(800);

  let chats = await collectAllMaxChats(page);
  if (!chats.length) {
    await page.waitForTimeout(1500);
    chats = await collectAllMaxChats(page);
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

    return await page.evaluate((groupSubtitlePattern) => {
      const GROUP_SUBTITLE_RE = new RegExp(groupSubtitlePattern, 'i');

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

      function looksLikeChatId(value) {
        const text = String(value || '');
        if (!/^-?\d{5,16}$/.test(text)) return false;
        const abs = Math.abs(Number(text));
        if (!Number.isFinite(abs) || abs < 10000) return false;
        if (abs >= 1e12 && abs < 2e13) return false;
        return true;
      }

      function chatIdFromBlob(blob) {
        const text = String(blob || '');
        const href = text.match(/(?:web\.max\.ru\/|href=["']\/|["'/])(-?\d{5,16})(?:["'/?#\s]|$)/);
        if (href && looksLikeChatId(href[1])) return href[1];
        return '';
      }

      function listRoot() {
        return (
          document.querySelector('aside .scrollListContent') ||
          document.querySelector('aside .scrollListScrollable') ||
          document.querySelector('aside') ||
          document.querySelector('.scrollListContent')
        );
      }

      function unreadFromRow(row, cell) {
        if (!row) return 0;

        const subtitle = row.querySelector('.subtitleWrapper');
        const subtitleText = (subtitle?.innerText || '').replace(/\s+/g, ' ').trim();
        if (GROUP_SUBTITLE_RE.test(subtitleText)) {
          /* в подписи группы часто число подписчиков — не путать с непрочитанными */
        }

        const badgeSelectors = [
          '[class*="unread" i]',
          '[class*="counter" i]',
          '[class*="badge" i]',
          '[class*="notif" i]',
        ].join(', ');

        let best = 0;
        for (const badge of row.querySelectorAll(badgeSelectors)) {
          if (subtitle && subtitle.contains(badge)) continue;
          if (badge.closest('.subtitleWrapper')) continue;
          const n = parseCount(badge.innerText || badge.textContent || '');
          if (n > 0 && n < 10000) best = Math.max(best, n);
        }
        if (best > 0) return best;

        const attr =
          row.getAttribute('data-unread') ||
          row.getAttribute('data-count') ||
          row.getAttribute('aria-label') ||
          '';
        const fromAria = String(attr).match(/(\d{1,5})\s*(непрочит|unread|сообщ|message)/i);
        if (fromAria) return Number(fromAria[1]);

        const unreadDot = row.querySelector(
          '[class*="unread" i]:not(.subtitleWrapper *), [class*="mention" i]:not(.subtitleWrapper *)'
        );
        if (unreadDot && !subtitle?.contains(unreadDot)) {
          return 1;
        }

        return 0;
      }

      function readTabUnreadMessages() {
        for (const btn of document.querySelectorAll(
          'nav button, [role="tab"], [class*="tabbar" i] button, [class*="navbar" i] button, aside button'
        )) {
          if (btn.querySelector('h3.title') || btn.closest('.scrollListContent, .scrollListScrollable')) {
            continue;
          }
          const label = (btn.innerText || '').trim().split('\n')[0].trim();
          if (!/^(чаты|chats)$/i.test(label)) continue;
          const n = parseCount(btn.innerText || btn.textContent || '');
          if (n > 0) return n;
          for (const badge of btn.querySelectorAll('[class*="unread" i], [class*="counter" i], [class*="badge" i]')) {
            const count = parseCount(badge.innerText || badge.textContent || '');
            if (count > 0) return count;
          }
        }
        return 0;
      }

      const root = listRoot();
      const scope = root || document;
      const seen = new Set();
      let chats = 0;
      let messages = 0;

      for (const item of scope.querySelectorAll('div.item')) {
        if (item.closest?.('.openedChat')) continue;
        if (root && !root.contains(item)) continue;

        const cell = item.querySelector('button.cell');
        if (!cell?.querySelector('h3.title')) continue;

        const blob = [item.getAttribute?.('href') || '', cell.getAttribute?.('href') || '', item.outerHTML || ''].join(
          ' '
        );
        const chatId = chatIdFromBlob(blob);
        if (!chatId || seen.has(chatId)) continue;
        seen.add(chatId);

        const count = unreadFromRow(item, cell);
        if (count > 0) {
          chats += 1;
          messages += count;
        }
      }

      const tabMessages = readTabUnreadMessages();
      if (tabMessages > messages) {
        messages = tabMessages;
      }

      return { chats, messages };
    }, GROUP_SUBTITLE_PATTERN);
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
  readOpenChatSubtitle,
  ensureChatKindFromPage,
  ensureChatTitleFromPage,
  resolveChatUrlByTitle,
  syncMonitoredChatTitles,
  resolveMaxChatByName,
  resolveMaxChatInput,
  normalizeChatName,
  chatUrlFromHref,
  discoverMaxChatsForMonitor,
};
