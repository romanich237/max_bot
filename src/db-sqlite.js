const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getDatabase, getMax } = require('./config');
const { isDuplicateIdentity } = require('./parser');

let db = null;
let schemaReady = false;

function getDb() {
  if (!db) {
    const cfg = getDatabase();
    const file = cfg.file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function ensureColumn(database, table, column, definition) {
  const cols = database.pragma(`table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initSchema() {
  if (schemaReady) return;

  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS seen_messages (
      message_key TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_seen_created_at ON seen_messages (created_at);

    CREATE TABLE IF NOT EXISTS bot_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_key TEXT NOT NULL UNIQUE,
      author TEXT NOT NULL DEFAULT '',
      body TEXT,
      time_str TEXT DEFAULT '',
      is_own INTEGER NOT NULL DEFAULT 0,
      chat_url TEXT NOT NULL DEFAULT '',
      media_json TEXT,
      forwarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_author ON messages (author);

    CREATE TABLE IF NOT EXISTS media_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_key TEXT NOT NULL,
      media_type TEXT NOT NULL,
      source_url TEXT,
      local_path TEXT,
      sticker_id TEXT,
      duration TEXT,
      file_size INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_media_message_key ON media_files (message_key);
    CREATE INDEX IF NOT EXISTS idx_media_type ON media_files (media_type);
  `);

  ensureColumn(database, 'messages', 'reply_author', 'TEXT');
  ensureColumn(database, 'messages', 'reply_body', 'TEXT');
  ensureColumn(database, 'messages', 'reply_is_voice', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'messages', 'fingerprint', 'TEXT');
  ensureColumn(database, 'messages', 'timed_fingerprint', 'TEXT');
  ensureColumn(database, 'messages', 'date_str', 'TEXT');
  ensureColumn(database, 'messages', 'clock_str', 'TEXT');
  ensureColumn(database, 'messages', 'chat_title', 'TEXT');
  ensureColumn(database, 'messages', 'chat_kind', 'TEXT');

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_fingerprint ON messages (fingerprint);
    CREATE INDEX IF NOT EXISTS idx_messages_timed_fp ON messages (timed_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_messages_date_str ON messages (date_str);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_url ON messages (chat_url);
  `);

  schemaReady = true;
  console.log(`SQLite подключен: ${getDatabase().file}`);
}

async function testConnection() {
  getDb().prepare('SELECT 1').get();
}

async function loadSeenKeys() {
  const database = getDb();
  const rows = database
    .prepare('SELECT message_key FROM seen_messages ORDER BY created_at DESC LIMIT 4000')
    .all();
  return rows.map((r) => r.message_key).reverse();
}

async function loadForwardedIdentities() {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT message_key AS key, fingerprint, timed_fingerprint AS timedFingerprint,
              date_str AS date, clock_str AS clock, time_str AS time,
              author, body, chat_url AS maxChatUrl, created_at AS seenAt
       FROM messages
       WHERE forwarded = 1
       ORDER BY id DESC
       LIMIT 4000`
    )
    .all();
  return rows;
}

async function loadSnapshot() {
  const database = getDb();
  const row = database.prepare('SELECT snapshot FROM bot_snapshot WHERE id = 1').get();
  if (!row) return [];
  return JSON.parse(row.snapshot);
}

async function saveSeenKeys(keys) {
  if (!keys.length) return;

  const database = getDb();
  const slice = keys.slice(-4000);
  const insert = database.prepare('INSERT OR IGNORE INTO seen_messages (message_key) VALUES (?)');

  const tx = database.transaction((items) => {
    for (const key of items) {
      insert.run(key);
    }
    const extra =
      database.prepare('SELECT COUNT(*) AS n FROM seen_messages').get().n - 4000;
    if (extra > 0) {
      database
        .prepare(
          `DELETE FROM seen_messages WHERE rowid IN (
             SELECT rowid FROM (
               SELECT rowid FROM seen_messages ORDER BY created_at ASC LIMIT ?
             )
           )`
        )
        .run(extra);
    }
  });

  tx(slice);
}

async function saveSnapshot(snapshot) {
  const database = getDb();
  const json = JSON.stringify(snapshot || []);
  database
    .prepare(
      `INSERT INTO bot_snapshot (id, snapshot) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot`
    )
    .run(json);
}

async function saveMessage(message, options = {}) {
  const database = getDb();
  saveMessageRow(database, message, options);
}

function saveMessageRow(database, message, options = {}) {
  const { forwarded = false, mediaFiles = [] } = options;
  const reply = message.reply || {};
  const chatUrl = message.maxChatUrl || message.chatUrl || getMax().chatUrl || '';
  const chatTitle = message.chatTitle || '';
  const chatKind = message.chatKind || '';

  database
    .prepare(
      `INSERT INTO messages
        (message_key, author, body, time_str, is_own, chat_url, media_json, forwarded,
         reply_author, reply_body, reply_is_voice, fingerprint, timed_fingerprint, date_str, clock_str,
         chat_title, chat_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_key) DO UPDATE SET
        body = excluded.body,
        media_json = excluded.media_json,
        reply_author = excluded.reply_author,
        reply_body = excluded.reply_body,
        reply_is_voice = excluded.reply_is_voice,
        fingerprint = excluded.fingerprint,
        timed_fingerprint = excluded.timed_fingerprint,
        date_str = excluded.date_str,
        clock_str = excluded.clock_str,
        chat_url = excluded.chat_url,
        chat_title = COALESCE(excluded.chat_title, chat_title),
        chat_kind = COALESCE(excluded.chat_kind, chat_kind),
        forwarded = MAX(forwarded, excluded.forwarded)`
    )
    .run(
      message.key,
      message.author || '',
      message.body || '',
      message.time || '',
      message.isOwn ? 1 : 0,
      chatUrl,
      JSON.stringify(message.media || []),
      forwarded ? 1 : 0,
      reply.author || null,
      reply.body || null,
      reply.isVoice ? 1 : 0,
      message.fingerprint || null,
      message.timedFingerprint || null,
      message.date || null,
      message.clock || null,
      chatTitle || null,
      chatKind || null
    );

  const insertMedia = database.prepare(
    `INSERT INTO media_files
      (message_key, media_type, source_url, local_path, sticker_id, duration, file_size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const media of mediaFiles) {
    if (!media.localPath) continue;

    let fileSize = null;
    try {
      fileSize = fs.statSync(media.localPath).size;
    } catch {
      /* ignore */
    }

    insertMedia.run(
      message.key,
      media.type,
      media.url || null,
      media.localPath,
      media.stickerId || null,
      media.duration || null,
      fileSize
    );
  }
}

async function saveMessages(messages, options = {}) {
  if (!messages?.length) return;
  const database = getDb();
  const tx = database.transaction((items) => {
    for (const message of items) {
      saveMessageRow(database, message, options);
    }
  });
  tx(messages);
}

async function wasForwarded(message) {
  const database = getDb();
  const key = String(message.key || '');
  const fingerprint = String(message.fingerprint || '');
  const timedFingerprint = String(message.timedFingerprint || '');
  if (!key && !fingerprint) return false;

  if (key) {
    const exact = database
      .prepare('SELECT 1 AS ok FROM messages WHERE forwarded = 1 AND message_key = ? LIMIT 1')
      .get(key);
    if (exact) return true;
  }

  const rows = database
    .prepare(
      `SELECT message_key, body, author, time_str, date_str, clock_str, fingerprint,
              timed_fingerprint, chat_url, created_at
       FROM messages
       WHERE forwarded = 1 AND (
         message_key = ?
         OR (? != '' AND fingerprint = ?)
         OR (? != '' AND timed_fingerprint = ?)
         OR (author = ? AND IFNULL(body, '') = ?)
       )
       ORDER BY id DESC
       LIMIT 80`
    )
    .all(
      key,
      fingerprint,
      fingerprint,
      timedFingerprint,
      timedFingerprint,
      message.author || '',
      message.body || ''
    );

  return rows.some((row) => isDuplicateIdentity(message, row));
}

async function close() {
  if (db) {
    db.close();
    db = null;
    schemaReady = false;
  }
}

module.exports = {
  initSchema,
  testConnection,
  loadSeenKeys,
  loadForwardedIdentities,
  loadSnapshot,
  saveSeenKeys,
  saveSnapshot,
  saveMessage,
  saveMessages,
  wasForwarded,
  close,
};
