const {
  buildScreenshotCaptionForPage,
  qrSecondsRemaining,
  qrRefreshSeconds,
  DEFAULT_QR_REFRESH_MS,
} = require('./auth-browser');
const { buildEventMessage } = require('./tg-events');
const {
  sendPhotoBuffer,
  editPhotoBuffer,
  editMessageCaption,
  editMessageText,
  sendMessage,
} = require('./tg-api');

let session = null;
let ticker = null;

function isEditOk(result) {
  if (result?.ok) return true;
  return /message is not modified/i.test(result?.description || '');
}

function getRefreshMs(options = {}) {
  return options.refreshMs ?? DEFAULT_QR_REFRESH_MS;
}

function buildScreenshotKeyboard() {
  return {
    inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'auth:refresh' }]],
  };
}

function buildAuthStatusText(secondsRemaining, refreshMs = DEFAULT_QR_REFRESH_MS) {
  const totalSec = qrRefreshSeconds(refreshMs);
  const sec = secondsRemaining ?? totalSec;
  return buildEventMessage({
    title: 'Ожидание входа в MAX',
    status: 'progress',
    lines: [
      'Вход выполняется в Telegram (без фото).',
      'Рекомендуется <b>номер телефона</b>: /reauth → «Номер телефона».',
      'Если появится @Browser — пришлю скриншот для ввода пароля.',
      `Обновление каждые ${sec} сек.`,
    ],
  });
}

function getSecondsRemaining() {
  if (!session) return qrRefreshSeconds(DEFAULT_QR_REFRESH_MS);
  return qrSecondsRemaining(session.lastQrSent, getRefreshMs(session.options));
}

function beginCaptionSession(chatIds, options = {}, page = null) {
  endCaptionSession();
  session = {
    page,
    chatIds,
    options: { refreshMs: DEFAULT_QR_REFRESH_MS, ...options },
    lastQrSent: Date.now(),
    lastCaptionSec: null,
    photoMessageIds: {},
    textMessageIds: {},
  };

  ticker = setInterval(() => {
    if (!session?.page) return;
    tickCaptions(session.page).catch((err) => {
      console.warn('auth-caption:', err.message);
    });
  }, 2000);

  return endCaptionSession;
}

function endCaptionSession() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  session = null;
}

function isCaptionSessionActive() {
  return Boolean(session);
}

function getCaptionSession() {
  return session;
}

function setCaptionPage(page) {
  if (session) session.page = page;
}

function markQrRefreshed() {
  if (!session) return;
  session.lastQrSent = Date.now();
  session.lastCaptionSec = null;
}

async function upsertAuthScreenshot(page, chatIds, options = {}, captureFn) {
  if (!captureFn) throw new Error('upsertAuthScreenshot: captureFn required');

  const opts = { ...session?.options, ...options };
  const refreshMs = getRefreshMs(opts);
  const secondsRemaining = qrSecondsRemaining(session?.lastQrSent ?? Date.now(), refreshMs);
  const buffer = await captureFn(page);
  const caption = await buildScreenshotCaptionForPage(page, {
    ...opts,
    secondsRemaining,
  });
  const replyMarkup = buildScreenshotKeyboard();
  const messageIds = session?.photoMessageIds || {};
  const targets = chatIds || session?.chatIds || [];

  for (const chatId of targets) {
    const key = String(chatId);
    const existingId = messageIds[key];
    let result;

    if (existingId) {
      result = await editPhotoBuffer(key, existingId, buffer, caption, opts.token, {
        reply_markup: replyMarkup,
      });

      if (!isEditOk(result)) {
        console.warn(`Не удалось обновить скриншот в ${key}: ${result.description}`);
        result = await sendPhotoBuffer(key, buffer, caption, opts.token, {
          reply_markup: replyMarkup,
        });
      }
    } else {
      result = await sendPhotoBuffer(key, buffer, caption, opts.token, {
        reply_markup: replyMarkup,
      });
    }

    if (!isEditOk(result) && !result?.ok) {
      console.error(`Не удалось отправить скриншот в ${key}: ${result?.description}`);
      continue;
    }

    if (result?.result?.message_id) {
      messageIds[key] = result.result.message_id;
    }
  }

  if (session) {
    session.photoMessageIds = messageIds;
    session.lastCaptionSec = secondsRemaining;
    session.page = page;
  }
}

async function upsertAuthText(page, chatIds, options = {}) {
  const opts = { ...session?.options, ...options };
  const refreshMs = getRefreshMs(opts);
  const secondsRemaining = getSecondsRemaining();
  const text = buildAuthStatusText(secondsRemaining, refreshMs);
  const replyMarkup = buildScreenshotKeyboard();
  const messageIds = session?.textMessageIds || {};
  const targets = chatIds || session?.chatIds || [];

  for (const chatId of targets) {
    const key = String(chatId);
    const existingId = messageIds[key];
    let result;

    if (existingId) {
      result = await editMessageText(key, existingId, text, { reply_markup: replyMarkup }, opts.token);
      if (!isEditOk(result)) {
        result = await sendMessage(key, text, { reply_markup: replyMarkup }, opts.token);
      }
    } else {
      result = await sendMessage(key, text, { reply_markup: replyMarkup }, opts.token);
    }

    if (!isEditOk(result) && !result?.ok) {
      console.error(`Не удалось отправить статус в ${key}: ${result?.description}`);
      continue;
    }

    if (result?.result?.message_id) {
      messageIds[key] = result.result.message_id;
    }
  }

  if (session) {
    session.textMessageIds = messageIds;
    session.lastCaptionSec = secondsRemaining;
    session.page = page;
  }
}

async function tickCaptions(page) {
  if (!session) return;

  const secondsRemaining = getSecondsRemaining();
  if (session.lastCaptionSec === secondsRemaining) return;

  const opts = session.options;
  const refreshMs = getRefreshMs(opts);
  const replyMarkup = buildScreenshotKeyboard();
  let updated = false;

  if (Object.keys(session.photoMessageIds).length) {
    const caption = await buildScreenshotCaptionForPage(page, {
      ...opts,
      secondsRemaining,
    });

    for (const [key, messageId] of Object.entries(session.photoMessageIds)) {
      const result = await editMessageCaption(
        key,
        messageId,
        caption,
        { reply_markup: replyMarkup },
        opts.token
      );

      if (!isEditOk(result) && !result?.ok) {
        console.warn(`Не удалось обновить подпись в ${key}: ${result?.description}`);
        continue;
      }

      updated = true;
    }
  }

  if (Object.keys(session.textMessageIds).length) {
    const text = buildAuthStatusText(secondsRemaining, refreshMs);

    for (const [key, messageId] of Object.entries(session.textMessageIds)) {
      const result = await editMessageText(
        key,
        messageId,
        text,
        { reply_markup: replyMarkup },
        opts.token
      );

      if (!isEditOk(result) && !result?.ok) {
        console.warn(`Не удалось обновить текст в ${key}: ${result?.description}`);
        continue;
      }

      updated = true;
    }
  }

  if (updated) {
    session.lastCaptionSec = secondsRemaining;
    session.page = page;
  }
}

module.exports = {
  DEFAULT_QR_REFRESH_MS,
  buildScreenshotKeyboard,
  buildAuthStatusText,
  beginCaptionSession,
  endCaptionSession,
  isCaptionSessionActive,
  getCaptionSession,
  setCaptionPage,
  markQrRefreshed,
  upsertAuthScreenshot,
  upsertAuthText,
  tickCaptions,
  isEditOk,
};
