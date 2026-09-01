const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isOwnByAuthor } = require('./parser');
const { resolveFromRoot } = require('./config');

const store = new Map();
const tgLinks = new Map();
const forwardIds = new Map();
const MAX_ENTRIES = 3000;
const MAX_TG_LINKS = 8000;
const STORE_PATH = resolveFromRoot('data/reply-store.json');

let saveTimer = null;
let loaded = false;

function makeId(messageKey) {
  return crypto.createHash('md5').update(messageKey).digest('hex').slice(0, 12);
}

function normalizeChatUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[.…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function authorsMatch(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a === b) return true;
  if (isOwnByAuthor(left) && isOwnByAuthor(right)) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const aFirst = a.split(/\s+/)[0] || '';
  const bFirst = b.split(/\s+/)[0] || '';
  if (aFirst.length >= 3 && bFirst.length >= 3 && (a.startsWith(bFirst) || b.startsWith(aFirst))) {
    return true;
  }

  return false;
}

function entryHasVoice(entry) {
  return (entry.media || []).some((item) => item.type === 'voice');
}

function bodiesMatch(entryBody, replyBody) {
  const left = normalizeText(entryBody);
  const right = normalizeText(replyBody);
  if (!left && !right) return true;
  if (!right) return false;
  if (left === right) return true;
  if (left && (left.includes(right) || right.includes(left))) return true;
  return false;
}

function matchesReplyTarget(entry, reply, { requireAuthor = true } = {}) {
  if (!reply || !entry) return false;
  if (requireAuthor && !authorsMatch(entry.author, reply.author)) return false;

  if (reply.isVoice) {
    if (entryHasVoice(entry)) return true;
    const replyBody = normalizeText(reply.body);
    return (
      !replyBody ||
      replyBody === 'голосовое сообщение' ||
      bodiesMatch(entry.body, reply.body)
    );
  }

  return bodiesMatch(entry.body, reply.body);
}

function pruneStore() {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    forwardIds.delete(oldest);
  }
  while (tgLinks.size > MAX_TG_LINKS) {
    const oldest = tgLinks.keys().next().value;
    tgLinks.delete(oldest);
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const entries = [];
    for (const [id, entry] of store) {
      entries.push({
        id,
        author: entry.author,
        key: entry.key,
        body: entry.body,
        time: entry.time,
        index: entry.index,
        maxChatUrl: entry.maxChatUrl,
        media: (entry.media || []).map((item) => ({ type: item.type })),
        forwards: forwardIds.get(id) || {},
      });
    }
    fs.writeFileSync(STORE_PATH, `${JSON.stringify({ entries }, null, 0)}\n`, 'utf8');
  } catch (err) {
    console.warn('reply-store: не удалось сохранить', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 250);
}

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const item of entries) {
      if (!item?.id) continue;
      store.set(item.id, {
        author: item.author || '',
        key: item.key || '',
        body: item.body || '',
        time: item.time || '',
        index: item.index,
        reply: null,
        media: item.media || [],
        maxChatUrl: item.maxChatUrl || null,
      });
      const forwards = item.forwards && typeof item.forwards === 'object' ? item.forwards : {};
      if (Object.keys(forwards).length) {
        forwardIds.set(item.id, forwards);
        for (const [chatId, messageId] of Object.entries(forwards)) {
          if (chatId && messageId) tgLinks.set(`${String(chatId)}:${messageId}`, item.id);
        }
      }
    }
    pruneStore();
  } catch (err) {
    console.warn('reply-store: не удалось прочитать', err.message);
  }
}

loadFromDisk();

function put(message, maxChatUrl) {
  const normalizedUrl = normalizeChatUrl(maxChatUrl);
  const id = makeId(`${normalizedUrl}::${message.key}`);
  store.set(id, {
    author: message.author,
    key: message.key,
    body: message.body,
    time: message.time,
    index: message.index,
    reply: message.reply || null,
    media: message.media || [],
    maxChatUrl: normalizedUrl || null,
  });

  pruneStore();
  scheduleSave();
  return id;
}

function linkTelegramMessage(chatId, messageId, id) {
  if (!chatId || !messageId || !id) return;
  tgLinks.set(`${String(chatId)}:${messageId}`, id);
  pruneStore();
}

function recordForward(id, chatId, messageId) {
  if (!id || !chatId || !messageId) return;
  linkTelegramMessage(chatId, messageId, id);
  if (!forwardIds.has(id)) forwardIds.set(id, {});
  forwardIds.get(id)[String(chatId)] = messageId;
  scheduleSave();
}

function findTelegramReplyTo(chatId, maxChatUrl, reply) {
  if (!reply) return null;
  const url = normalizeChatUrl(maxChatUrl);

  let found = null;
  let foundLoose = null;
  for (const [id, entry] of store) {
    if (normalizeChatUrl(entry.maxChatUrl) !== url) continue;
    const messageId = forwardIds.get(id)?.[String(chatId)];
    if (!messageId) continue;
    if (matchesReplyTarget(entry, reply, { requireAuthor: true })) {
      found = messageId;
    } else if (matchesReplyTarget(entry, reply, { requireAuthor: false })) {
      foundLoose = messageId;
    }
  }

  return found || foundLoose;
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
