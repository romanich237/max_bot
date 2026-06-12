const { File } = require('node:buffer');
const { getTelegram } = require('./config');

function resolveToken(tokenOverride) {
  const token = tokenOverride || getTelegram().token;
  if (!token) throw new Error('Telegram token не задан');
  return token;
}

async function api(method, body = {}, tokenOverride) {
  const token = resolveToken(tokenOverride);
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function deleteWebhook(tokenOverride) {
  return api('deleteWebhook', { drop_pending_updates: true }, tokenOverride);
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

async function sendPhotoBuffer(chatId, buffer, caption = '', tokenOverride) {
  const token = resolveToken(tokenOverride);
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('photo', new File([buffer], 'qr.png', { type: 'image/png' }));

  const response = await fetch(url, { method: 'POST', body: form });
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

function pollUpdates(handler, options = {}) {
  const {
    token: tokenOverride,
    allowedUpdates = ['message', 'callback_query'],
    onError,
  } = options;

  let offset = 0;
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;

    try {
      const data = await api(
        'getUpdates',
        {
          offset,
          timeout: 25,
          allowed_updates: allowedUpdates,
        },
        tokenOverride
      );

      if (!data.ok) {
        onError?.(new Error(data.description || 'getUpdates failed'));
      } else {
        for (const update of data.result || []) {
          offset = update.update_id + 1;
          await handler(update);
        }
      }
    } catch (err) {
      onError?.(err);
    }

    if (!stopped) {
      timer = setTimeout(tick, 500);
    }
  };

  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = {
  api,
  deleteWebhook,
  sendMessage,
  sendPhotoBuffer,
  answerCallback,
  editMessageText,
  pollUpdates,
};
