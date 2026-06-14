const crypto = require('crypto');

const store = new Map();
const tgLinks = new Map();
const MAX_ENTRIES = 500;
const MAX_TG_LINKS = 2000;

function makeId(messageKey) {
  return crypto.createHash('md5').update(messageKey).digest('hex').slice(0, 12);
}

function put(message, maxChatUrl) {
  const id = makeId(`${maxChatUrl || ''}::${message.key}`);
  store.set(id, {
    author: message.author,
    key: message.key,
    body: message.body,
    time: message.time,
    index: message.index,
    reply: message.reply || null,
    maxChatUrl: maxChatUrl || null,
  });

  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }

  return id;
}

function linkTelegramMessage(chatId, messageId, id) {
  if (!chatId || !messageId || !id) return;
  tgLinks.set(`${String(chatId)}:${messageId}`, id);

  if (tgLinks.size > MAX_TG_LINKS) {
    const oldest = tgLinks.keys().next().value;
    tgLinks.delete(oldest);
  }
}

function get(id) {
  return store.get(id) || null;
}

function getByTelegramMessage(chatId, messageId) {
  const id = tgLinks.get(`${String(chatId)}:${messageId}`);
  return id ? get(id) : null;
}

module.exports = { put, get, linkTelegramMessage, getByTelegramMessage };
