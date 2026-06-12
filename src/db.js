const mysql = require('mysql2/promise');
const { getDatabase, getMax } = require('./config');

let pool = null;
let schemaReady = false;

function isEnabled() {
  return getDatabase().enabled === true;
}

async function getPool() {
  if (!isEnabled()) return null;
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
  if (!isEnabled() || schemaReady) return;

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
    'SELECT message_key FROM seen_messages ORDER BY created_at ASC LIMIT 1000'
  );
  return rows.map((r) => r.message_key);
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
  const slice = keys.slice(-500);

  await p.query('DELETE FROM seen_messages');
  if (slice.length) {
    const placeholders = slice.map(() => '(?)').join(',');
    await p.query(`INSERT IGNORE INTO seen_messages (message_key) VALUES ${placeholders}`, slice);
  }
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

  await p.query(
    `INSERT INTO messages
      (message_key, author, body, time_str, is_own, chat_url, media_json, forwarded,
       reply_author, reply_body, reply_is_voice)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      body = VALUES(body),
      media_json = VALUES(media_json),
      reply_author = VALUES(reply_author),
      reply_body = VALUES(reply_body),
      reply_is_voice = VALUES(reply_is_voice),
      forwarded = GREATEST(forwarded, VALUES(forwarded))`,
    [
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
      reply.isVoice ? 1 : 0,
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

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    schemaReady = false;
  }
}

module.exports = {
  isEnabled,
  initSchema,
  testConnection,
  loadSeenKeys,
  loadSnapshot,
  saveSeenKeys,
  saveSnapshot,
  saveMessage,
  close,
};
