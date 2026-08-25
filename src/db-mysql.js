const mysql = require('mysql2/promise');
const { getDatabase, getMax } = require('./config');
const { isDuplicateIdentity } = require('./parser');

let pool = null;
let schemaReady = false;

async function getPool() {
  if (!pool) {
    const database = getDatabase();
    pool = mysql.createPool({
      host: database.host,
      port: database.port,
      user: database.user,
      password: database.password,
      database: database.database,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    });
  }
  return pool;
}

async function ensureColumn(p, table, column, definition) {
  const [rows] = await p.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );

  if (rows[0].cnt === 0) {
    await p.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initSchema() {
  if (schemaReady) return;

  const p = await getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS seen_messages (
      message_key VARCHAR(768) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_snapshot (
      id TINYINT PRIMARY KEY DEFAULT 1,
      snapshot JSON NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_key VARCHAR(768) NOT NULL UNIQUE,
      author VARCHAR(255) NOT NULL DEFAULT '',
      body TEXT,
      time_str VARCHAR(64) DEFAULT '',
      is_own TINYINT(1) NOT NULL DEFAULT 0,
      chat_url VARCHAR(512) NOT NULL DEFAULT '',
      media_json JSON,
      forwarded TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_author (author)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumn(p, 'messages', 'reply_author', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumn(p, 'messages', 'reply_body', 'TEXT DEFAULT NULL');
  await ensureColumn(p, 'messages', 'reply_is_voice', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn(p, 'messages', 'fingerprint', 'VARCHAR(40) DEFAULT NULL');
  await ensureColumn(p, 'messages', 'timed_fingerprint', 'VARCHAR(40) DEFAULT NULL');
  await ensureColumn(p, 'messages', 'date_str', 'VARCHAR(16) DEFAULT NULL');
  await ensureColumn(p, 'messages', 'clock_str', 'VARCHAR(8) DEFAULT NULL');
  await ensureColumn(p, 'messages', 'chat_title', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumn(p, 'messages', 'chat_kind', 'VARCHAR(32) DEFAULT NULL');

  await p.query(`
    CREATE TABLE IF NOT EXISTS media_files (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_key VARCHAR(768) NOT NULL,
      media_type VARCHAR(32) NOT NULL,
      source_url TEXT,
      local_path TEXT,
      sticker_id VARCHAR(64) DEFAULT NULL,
      duration VARCHAR(16) DEFAULT NULL,
      file_size INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_message_key (message_key),
      INDEX idx_media_type (media_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await p.query('CREATE INDEX idx_messages_fingerprint ON messages (fingerprint)').catch(() => {});
  await p.query('CREATE INDEX idx_messages_timed_fp ON messages (timed_fingerprint)').catch(() => {});

  schemaReady = true;
  const database = getDatabase();
  console.log(`MySQL подключен: ${database.host}/${database.database}`);
}

async function testConnection() {
  const p = await getPool();
  await p.query('SELECT 1');
}

async function loadSeenKeys() {
  const p = await getPool();
  const [rows] = await p.query(
    'SELECT message_key FROM seen_messages ORDER BY created_at DESC LIMIT 4000'
  );
  return rows.map((r) => r.message_key).reverse();
}

async function loadForwardedIdentities() {
  const p = await getPool();
  const [rows] = await p.query(
    `SELECT message_key AS \`key\`, fingerprint, timed_fingerprint AS timedFingerprint,
            date_str AS date, clock_str AS clock, time_str AS time,
            author, body, chat_url AS maxChatUrl, created_at AS seenAt
     FROM messages
     WHERE forwarded = 1
     ORDER BY id DESC
     LIMIT 4000`
  );
  return rows;
}

async function loadSnapshot() {
  const p = await getPool();
  const [rows] = await p.query('SELECT snapshot FROM bot_snapshot WHERE id = 1');
  if (!rows.length) return [];
  const raw = rows[0].snapshot;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveSeenKeys(keys) {
  if (!keys.length) return;

  const p = await getPool();
  const slice = keys.slice(-4000);
  const placeholders = slice.map(() => '(?)').join(',');
  await p.query(`INSERT IGNORE INTO seen_messages (message_key) VALUES ${placeholders}`, slice);
  await p.query(
    `DELETE FROM seen_messages
     WHERE created_at < (
       SELECT created_at FROM (
         SELECT created_at FROM seen_messages ORDER BY created_at DESC LIMIT 1 OFFSET 3999
       ) AS keep_from
     )`
  ).catch(() => {});
}

async function saveSnapshot(snapshot) {
  const p = await getPool();
  const json = JSON.stringify(snapshot || []);
  await p.query(
    `INSERT INTO bot_snapshot (id, snapshot) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE snapshot = VALUES(snapshot)`,
    [json]
  );
}

async function saveMessage(message, options = {}) {
  const { forwarded = false, mediaFiles = [] } = options;
  const p = await getPool();
  const reply = message.reply || {};
  const chatUrl = message.maxChatUrl || message.chatUrl || getMax().chatUrl || '';
  const chatTitle = message.chatTitle || null;
  const chatKind = message.chatKind || null;

  await p.query(
    `INSERT INTO messages
      (message_key, author, body, time_str, is_own, chat_url, media_json, forwarded,
       reply_author, reply_body, reply_is_voice, fingerprint, timed_fingerprint, date_str, clock_str,
       chat_title, chat_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      body = VALUES(body),
      media_json = VALUES(media_json),
      reply_author = VALUES(reply_author),
      reply_body = VALUES(reply_body),
      reply_is_voice = VALUES(reply_is_voice),
      fingerprint = VALUES(fingerprint),
      timed_fingerprint = VALUES(timed_fingerprint),
      date_str = VALUES(date_str),
      clock_str = VALUES(clock_str),
      chat_url = VALUES(chat_url),
      chat_title = COALESCE(VALUES(chat_title), chat_title),
      chat_kind = COALESCE(VALUES(chat_kind), chat_kind),
      forwarded = GREATEST(forwarded, VALUES(forwarded))`,
    [
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
      chatTitle,
      chatKind,
    ]
  );

  for (const media of mediaFiles) {
    if (!media.localPath) continue;

    let fileSize = null;
    try {
      const fs = require('fs');
      fileSize = fs.statSync(media.localPath).size;
    } catch {
      /* ignore */
    }

    await p.query(
      `INSERT INTO media_files
        (message_key, media_type, source_url, local_path, sticker_id, duration, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.key,
        media.type,
        media.url || null,
        media.localPath,
        media.stickerId || null,
        media.duration || null,
        fileSize,
      ]
    );
  }
}

async function saveMessages(messages, options = {}) {
  if (!messages?.length) return;
  for (const message of messages) {
    await saveMessage(message, options);
  }
}

async function wasForwarded(message) {
  const p = await getPool();
  const key = String(message.key || '');
  const fingerprint = String(message.fingerprint || '');
  const timedFingerprint = String(message.timedFingerprint || '');
  if (!key && !fingerprint) return false;

  if (key) {
    const [exact] = await p.query(
      'SELECT 1 AS ok FROM messages WHERE forwarded = 1 AND message_key = ? LIMIT 1',
      [key]
    );
    if (exact.length) return true;
  }

  const [rows] = await p.query(
    `SELECT message_key, body, author, time_str, date_str, clock_str, fingerprint,
            timed_fingerprint, chat_url, created_at
     FROM messages
     WHERE forwarded = 1 AND (
       message_key = ?
       OR (fingerprint IS NOT NULL AND fingerprint != '' AND fingerprint = ?)
       OR (timed_fingerprint IS NOT NULL AND timed_fingerprint != '' AND timed_fingerprint = ?)
       OR (author = ? AND IFNULL(body, '') = ?)
     )
     ORDER BY id DESC
     LIMIT 80`,
    [key, fingerprint, timedFingerprint, message.author || '', message.body || '']
  );

  return rows.some((row) => isDuplicateIdentity(message, row));
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
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
