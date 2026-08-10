const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getDatabase, getMax } = require('./config');

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

  schemaReady = true;
  console.log(`SQLite подключен: ${getDatabase().file}`);
}

async function testConnection() {
  getDb().prepare('SELECT 1').get();
}

async function loadSeenKeys() {
  const database = getDb();
  const rows = database
    .prepare('SELECT message_key FROM seen_messages ORDER BY created_at ASC LIMIT 1000')
    .all();
  return rows.map((r) => r.message_key);
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
  const slice = keys.slice(-500);
  const insert = database.prepare('INSERT OR IGNORE INTO seen_messages (message_key) VALUES (?)');

  const tx = database.transaction((items) => {
    database.prepare('DELETE FROM seen_messages').run();
    for (const key of items) {
      insert.run(key);
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
  const { forwarded = false, mediaFiles = [] } = options;
  const database = getDb();
  const reply = message.reply || {};

  database
    .prepare(
      `INSERT INTO messages
        (message_key, author, body, time_str, is_own, chat_url, media_json, forwarded,
         reply_author, reply_body, reply_is_voice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_key) DO UPDATE SET
        body = excluded.body,
        media_json = excluded.media_json,
        reply_author = excluded.reply_author,
        reply_body = excluded.reply_body,
        reply_is_voice = excluded.reply_is_voice,
        forwarded = MAX(forwarded, excluded.forwarded)`
    )
    .run(
      message.key,
      message.author || '',
      message.body || '',
      message.time || '',
      message.isOwn ? 1 : 0,
      getMax().chatUrl || '',
      JSON.stringify(message.media || []),
      forwarded ? 1 : 0,
      reply.author || null,
      reply.body || null,
      reply.isVoice ? 1 : 0
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
  loadSnapshot,
  saveSeenKeys,
  saveSnapshot,
  saveMessage,
  close,
};
