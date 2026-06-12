const crypto = require('crypto');

const store = new Map();
const MAX_ENTRIES = 500;

function makeId(messageKey) {
  return crypto.createHash('md5').update(messageKey).digest('hex').slice(0, 12);
}

function put(message) {
  const id = makeId(message.key);
  store.set(id, {
    author: message.author,
    key: message.key,
    body: message.body,
    time: message.time,
    index: message.index,
    reply: message.reply || null,
  });

  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }

  return id;
}

function get(id) {
  return store.get(id) || null;
}

module.exports = { put, get };
