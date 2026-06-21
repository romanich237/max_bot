const crypto = require('crypto');
const { isOwnByAuthor } = require('./parser');

const store = new Map();
const tgLinks = new Map();
const forwardIds = new Map();
const MAX_ENTRIES = 500;
const MAX_TG_LINKS = 2000;

function makeId(messageKey) {
  return crypto.createHash('md5').update(messageKey).digest('hex').slice(0, 12);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function authorsMatch(left, right) {
  if (normalizeText(left) === normalizeText(right)) return true;
  if (isOwnByAuthor(left) && isOwnByAuthor(right)) return true;
  return false;
}

function entryHasVoice(entry) {
  return (entry.media || []).some((item) => item.type === 'voice');
}

function matchesReplyTarget(entry, reply) {
  if (!reply || !entry) return false;
  if (!authorsMatch(entry.author, reply.author)) return false;

  if (reply.isVoice) {
    if (entryHasVoice(entry)) return true;
    const replyBody = normalizeText(reply.body);
    return (
      !replyBody ||
      replyBody === 'голосовое сообщение' ||
      normalizeText(entry.body) === replyBody
    );
  }

  const entryBody = normalizeText(entry.body);
  const replyBody = normalizeText(reply.body);
  if (!entryBody && !replyBody) return true;
  if (entryBody === replyBody) return true;
  if (entryBody && replyBody && (entryBody.includes(replyBody) || replyBody.includes(entryBody))) {
    return true;
  }

  return false;
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
    media: message.media || [],
    maxChatUrl: maxChatUrl || null,
  });

  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    forwardIds.delete(oldest);
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

function recordForward(id, chatId, messageId) {
  if (!id || !chatId || !messageId) return;
  linkTelegramMessage(chatId, messageId, id);
  if (!forwardIds.has(id)) forwardIds.set(id, {});
  forwardIds.get(id)[String(chatId)] = messageId;
}

function findTelegramReplyTo(chatId, maxChatUrl, reply) {
  if (!reply) return null;

  let found = null;
  for (const [id, entry] of store) {
    if ((entry.maxChatUrl || null) !== (maxChatUrl || null)) continue;
    if (!matchesReplyTarget(entry, reply)) continue;
    const messageId = forwardIds.get(id)?.[String(chatId)];
    if (messageId) found = messageId;
  }

  return found;
}

function resolveReplyToByChat(maxChatUrl, reply, chatIds) {
  if (!reply) return {};

  const result = {};
  for (const chatId of chatIds || []) {
    const messageId = findTelegramReplyTo(chatId, maxChatUrl, reply);
    if (messageId) result[String(chatId)] = messageId;
  }
  return result;
}

function get(id) {
  return store.get(id) || null;
}

function getByTelegramMessage(chatId, messageId) {
  const id = tgLinks.get(`${String(chatId)}:${messageId}`);
  return id ? get(id) : null;
}

module.exports = {
  put,
  get,
  linkTelegramMessage,
  recordForward,
  findTelegramReplyTo,
  resolveReplyToByChat,
  getByTelegramMessage,
  matchesReplyTarget,
};
