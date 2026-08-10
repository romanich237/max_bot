const { File } = require('node:buffer');
const { getTelegram } = require('./config');

let proxyDispatcher = null;

function getProxyAgent() {
  if (proxyDispatcher) return proxyDispatcher;
  const { ProxyAgent } = require('undici');
  proxyDispatcher = new ProxyAgent(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  return proxyDispatcher;
}

function resolveToken(tokenOverride) {
  const token = tokenOverride || getTelegram().token;
  if (!token) throw new Error('Telegram token не задан');
  return token;
}

function getFetchInit(baseInit = {}) {
  const init = { ...baseInit };
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy && !init.dispatcher) {
    init.dispatcher = getProxyAgent();
  }
  return init;
}

const TELEGRAM_API = 'https://api.telegram.org';
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRIES = 4;

function wrapFetchError(err, context) {
  const cause = err.cause?.message || err.message || String(err);
  return new Error(
    `${context}: нет связи с api.telegram.org (${cause}). ` +
      'Проверьте интернет, выполните curl -I https://api.telegram.org. ' +
      'При блокировке задайте HTTPS_PROXY или HTTP_PROXY.'
  );
}

async function fetchTelegram(url, init = {}) {
  let lastErr;
  const options = getFetchInit(init);

  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) {
        const delay = 1500 * attempt;
        console.warn(`Telegram API: повтор ${attempt}/${FETCH_RETRIES - 1} через ${delay}мс...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw wrapFetchError(lastErr, 'Telegram API');
}

async function checkTelegramConnectivity(tokenOverride) {
  const token = resolveToken(tokenOverride);
  const url = `${TELEGRAM_API}/bot${token}/getMe`;
  const response = await fetchTelegram(url, { method: 'POST' });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API: ${data.description || 'getMe failed'}`);
  }
  return data;
}

async function api(method, body = {}, tokenOverride) {
  const token = resolveToken(tokenOverride);
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const response = await fetchTelegram(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function deleteWebhook(tokenOverride) {
  return api('deleteWebhook', { drop_pending_updates: true }, tokenOverride);
}

async function deleteMessage(chatId, messageId, tokenOverride) {
  return api(
    'deleteMessage',
    {
      chat_id: chatId,
      message_id: messageId,
    },
    tokenOverride
  );
}

async function setBotCommands(commands, tokenOverride) {
  return api('setMyCommands', { commands }, tokenOverride);
}

async function sendMessage(chatId, text, extra = {}, tokenOverride) {
  return api(
    'sendMessage',
    {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...extra,
    },
    tokenOverride
  );
}

async function sendPhotoBuffer(chatId, buffer, caption = '', tokenOverride, extra = {}) {
  const token = resolveToken(tokenOverride);
  const url = `${TELEGRAM_API}/bot${token}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', extra.parse_mode || 'HTML');
  }
  if (extra.reply_markup) {
    form.append('reply_markup', JSON.stringify(extra.reply_markup));
  }
  form.append('photo', new File([buffer], 'max-login.png', { type: 'image/png' }));

  const response = await fetchTelegram(url, { method: 'POST', body: form });
  return response.json();
}

async function editPhotoBuffer(chatId, messageId, buffer, caption = '', tokenOverride, extra = {}) {
  const token = resolveToken(tokenOverride);
  const url = `${TELEGRAM_API}/bot${token}/editMessageMedia`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('message_id', String(messageId));
  const media = {
    type: 'photo',
    media: 'attach://photo',
  };
  if (caption) {
    media.caption = caption;
    media.parse_mode = extra.parse_mode || 'HTML';
  }
  form.append('media', JSON.stringify(media));
  if (extra.reply_markup) {
    form.append('reply_markup', JSON.stringify(extra.reply_markup));
  }
  form.append('photo', new File([buffer], 'max-login.png', { type: 'image/png' }));

  const response = await fetchTelegram(url, { method: 'POST', body: form });
  return response.json();
}

async function answerCallback(callbackQueryId, text, tokenOverride) {
  return api(
    'answerCallbackQuery',
    {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    },
    tokenOverride
  );
}

async function editMessageText(chatId, messageId, text, extra = {}, tokenOverride) {
  return api(
    'editMessageText',
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...extra,
    },
    tokenOverride
  );
}

async function editMessageCaption(chatId, messageId, caption, extra = {}, tokenOverride) {
  return api(
    'editMessageCaption',
    {
      chat_id: chatId,
      message_id: messageId,
      caption,
      parse_mode: 'HTML',
      ...extra,
    },
    tokenOverride
  );
}

async function getChat(chatId, tokenOverride) {
  return api('getChat', { chat_id: chatId }, tokenOverride);
}

function pollUpdates(handler, options = {}) {
  const bus = require('./tg-update-bus');
  return bus.subscribe(handler, options);
}

module.exports = {
  api,
  checkTelegramConnectivity,
  deleteWebhook,
  deleteMessage,
  setBotCommands,
  sendMessage,
  sendPhotoBuffer,
  editPhotoBuffer,
  answerCallback,
  editMessageText,
  editMessageCaption,
  getChat,
  pollUpdates,
};
