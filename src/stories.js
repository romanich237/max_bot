const { ensureChatListVisible } = require('./max-chat-picker');
const { isLoginPage } = require('./parser');

const STORY_THUMB_SELECTOR =
  'button.storiesStackItemThumbnailAvatarButton, aside .stories button[class*="Thumbnail"], aside .storiesStackItemContent button';
const STORY_SCROLLER_SELECTOR = '.storiesStack, .storiesStackWrapper, .storiesStackRow, aside .stories';
const STORY_LIKE_BUTTON_SELECTOR = [
  'div.storiesStackItem--active div.storiesPlayer div.composer div.input div.btn button.button--ghost',
  'div.storiesPlayer div.composerWrapper div.composer div.input div.btn button.button--ghost',
  'div.storiesPlayer div.composer div.btn button.button--xsmall.button--ghost',
].join(', ');

async function collectStoryButtons(page) {
  return page.evaluate(() => {
    const selector =
      'button.storiesStackItemThumbnailAvatarButton, aside .stories button[class*="Thumbnail"], aside .storiesStackItemContent button';
    const seen = new Set();
    const items = [];

    for (const btn of document.querySelectorAll(selector)) {
      if (!btn.closest('aside')) continue;
      if (btn.closest('.scrollListContent, .scrollListScrollable, div.item')) continue;
      if (!btn.offsetParent && btn.getAttribute('aria-hidden') === 'true') continue;

      const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
      const rect = btn.getBoundingClientRect();
      const key = `${label}::${Math.round(rect.left)}::${Math.round(rect.top)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        label,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    }

    return items;
  });
}

async function scrollStoriesRow(page) {
  return page.evaluate((scrollerSelector) => {
    for (const selector of scrollerSelector.split(', ')) {
      const node = document.querySelector(selector.trim());
      if (!node) continue;
      const prev = node.scrollLeft;
      node.scrollBy({ left: Math.max(node.clientWidth * 0.7, 120), behavior: 'instant' });
      if (node.scrollLeft > prev + 2) return true;
    }
    return false;
  }, STORY_SCROLLER_SELECTOR);
}

async function isStoryViewerOpen(page) {
  return page.evaluate(() => {
    if (document.querySelector('div.storiesPortal, div.storiesPlayer, div.storiesStackItem--active')) {
      return true;
    }

    const player = document.querySelector('div.storiesStackWrapper--expanded, div.storiesStack--expanded');
    if (player) return true;

    return Boolean(document.querySelector('div.storiesPlayer div.composer div.btn button.button--ghost'));
  });
}

async function clickStoryByLabel(page, label) {
  const target = String(label || '').trim();
  if (!target) return false;

  const buttons = page.locator(STORY_THUMB_SELECTOR);
  const count = await buttons.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const aria = String((await btn.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (!aria) continue;
    if (aria !== target && !aria.includes(target) && !target.includes(aria)) continue;
    if (!(await btn.isVisible({ timeout: 1200 }).catch(() => false))) continue;

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);
    await btn.click({ timeout: 8000 });
    await page.waitForTimeout(800);
    return true;
  }

  return false;
}

async function likeCurrentStory(page) {
  const likeButton = page.locator(STORY_LIKE_BUTTON_SELECTOR).first();
  if (await likeButton.isVisible({ timeout: 2500 }).catch(() => false)) {
    const state = await likeButton.evaluate((btn) => {
      function isStoryLikeActive(button) {
        if (!button) return false;
        if (button.getAttribute('aria-pressed') === 'true') return true;
        if (button.getAttribute('aria-checked') === 'true') return true;
        if (button.getAttribute('data-liked') === 'true') return true;

        const cls = String(button.className || '');
        if (/(?:^|\s)(?:active|liked|selected|isLiked|filled|is-active)(?:\s|$)/i.test(cls)) {
          return true;
        }

        const html = (button.innerHTML || '').toLowerCase();
        if (/fill="#f|fill="#e|fill="rgb\(2[0-9]{2}|fill:red|fill:\s*#f/i.test(html)) {
          return true;
        }

        for (const node of button.querySelectorAll('svg, path, [class*="heart" i], [class*="like" i]')) {
          const nodeCls = String(node.className || '');
          if (/(?:liked|active|filled|selected)/i.test(nodeCls)) return true;
          const fill = node.getAttribute?.('fill') || '';
          if (fill && !/^(none|transparent|currentColor)$/i.test(fill)) return true;
        }

        return false;
      }

      return {
        active: isStoryLikeActive(btn),
        disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true',
      };
    });

    if (state.active) {
      return { ok: true, liked: false, reason: 'already', target: 'composer-heart' };
    }
    if (state.disabled) {
      return { ok: false, liked: false, reason: 'disabled', target: 'composer-heart' };
    }

    await likeButton.click({ timeout: 5000 });
    await page.waitForTimeout(250);
    return { ok: true, liked: true, reason: 'clicked', target: 'composer-heart' };
  }

  return page.evaluate(() => {
    function findStoryLikeButton() {
      const selectors = [
        'div.storiesStackItem--active div.storiesPlayer div.composer div.input div.btn button.button--ghost',
        'div.storiesPlayer div.composerWrapper div.composer div.input div.btn button.button--ghost',
        'div.storiesPlayer div.composer div.btn button.button--xsmall.button--ghost',
      ];
      for (const selector of selectors) {
        const btn = document.querySelector(selector);
        if (btn) return btn;
      }
      return null;
    }

    function isStoryLikeActive(button) {
      if (!button) return false;
      if (button.getAttribute('aria-pressed') === 'true') return true;
      const cls = String(button.className || '');
      return /(?:^|\s)(?:active|liked|selected|isLiked|filled)(?:\s|$)/i.test(cls);
    }

    const btn = findStoryLikeButton();
    if (!btn) return { ok: false, liked: false, reason: 'not_found' };
    if (isStoryLikeActive(btn)) return { ok: true, liked: false, reason: 'already', target: 'composer-heart' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      return { ok: false, liked: false, reason: 'disabled', target: 'composer-heart' };
    }

    btn.click();
    return { ok: true, liked: true, reason: 'clicked', target: 'composer-heart' };
  });
}

async function advanceStorySlide(page) {
  const advanced = await page.evaluate(() => {
    const player =
      document.querySelector('div.storiesStackItem--active div.storiesPlayer') ||
      document.querySelector('div.storiesPlayer');
    if (player) {
      const rect = player.getBoundingClientRect();
      const x = rect.left + rect.width * 0.82;
      const y = rect.top + rect.height * 0.45;
      const el = document.elementFromPoint(x, y);
      if (el) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
        return 'player-tap';
      }
    }

    for (const btn of document.querySelectorAll('button, [role="button"]')) {
      const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
      if (!/next|далее|следующ|вперёд|forward/i.test(label)) continue;
      if (!btn.offsetParent) continue;
      btn.click();
      return 'button';
    }

    return '';
  });

  if (advanced) {
    await page.waitForTimeout(450);
    return true;
  }

  await page.keyboard.press('ArrowRight').catch(() => {});
  await page.waitForTimeout(350);
  return false;
}

async function closeStoryViewer(page) {
  const closed = await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button, [role="button"]')) {
      const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
      if (!/close|закры|назад|back|exit|выйти/i.test(label)) continue;
      if (!btn.offsetParent) continue;
      btn.click();
      return true;
    }
    return false;
  });

  if (closed) {
    await page.waitForTimeout(400);
    return true;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  if (await isStoryViewerOpen(page)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  return !(await isStoryViewerOpen(page));
}

async function watchStoryPack(page, options) {
  const durationMs = Math.max(options.storyDurationMs || 5500, 1500);
  const autoLike = options.autoLike !== false;
  const maxSlides = Math.max(options.maxSlidesPerPack || 25, 1);

  let slides = 0;
  let liked = 0;

  for (let i = 0; i < maxSlides; i++) {
    if (!(await isStoryViewerOpen(page))) break;

    if (autoLike) {
      const likeResult = await likeCurrentStory(page);
      if (likeResult.liked) liked += 1;
    }

    await page.waitForTimeout(durationMs);
    slides += 1;

    const before = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');
    await advanceStorySlide(page);
    const after = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');

    if (!(await isStoryViewerOpen(page))) break;
    if (before === after && i > 0) break;
  }

  await closeStoryViewer(page);
  return { slides, liked };
}

async function gatherAllStoryButtons(page, maxPacks) {
  const merged = [];
  const seen = new Set();
  let stagnant = 0;

  for (let step = 0; step < 40 && merged.length < maxPacks; step++) {
    const batch = await collectStoryButtons(page);
    let added = 0;
    for (const item of batch) {
      const key = item.label || `${item.x}:${item.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      added += 1;
      if (merged.length >= maxPacks) break;
    }

    if (merged.length >= maxPacks) break;
    if (!added) stagnant += 1;
    else stagnant = 0;
    if (stagnant >= 2) break;

    const moved = await scrollStoriesRow(page);
    if (!moved) break;
    await page.waitForTimeout(350);
  }

  return merged.slice(0, maxPacks);
}

async function runStoriesAutomation(page, options = {}) {
  if (!page || page.isClosed()) {
    throw new Error('Браузер MAX недоступен');
  }

  const maxPacks = Math.max(options.maxPacksPerRun || 30, 1);
  const returnUrl = page.url();

  await ensureChatListVisible(page);
  await page.waitForTimeout(600);

  if (await isLoginPage(page)) {
    throw new Error('Сессия MAX истекла. Отправьте /reauth');
  }

  const storyItems = await gatherAllStoryButtons(page, maxPacks);
  if (!storyItems.length) {
    return { packs: 0, slides: 0, liked: 0, skipped: true, reason: 'no_stories' };
  }

  let packs = 0;
  let slides = 0;
  let liked = 0;

  for (const item of storyItems) {
    await ensureChatListVisible(page).catch(() => {});
    await page.waitForTimeout(300);

    const opened = await clickStoryByLabel(page, item.label);
    if (!opened) continue;

    let viewerOpen = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await isStoryViewerOpen(page)) {
        viewerOpen = true;
        break;
      }
      await page.waitForTimeout(350);
    }
    if (!viewerOpen) continue;

    const packStats = await watchStoryPack(page, options);
    packs += 1;
    slides += packStats.slides;
    liked += packStats.liked;

    await page.waitForTimeout(300);
  }

  if (/web\.max\.ru\/-?\d{5,}/.test(returnUrl) && returnUrl !== page.url()) {
    await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  }

  return { packs, slides, liked, skipped: false };
}

module.exports = {
  runStoriesAutomation,
  collectStoryButtons,
  isStoryViewerOpen,
};
