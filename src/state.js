const fs = require('fs');
const { getSettings } = require('./config');
const db = require('./db');

const SEEN_KEYS_LIMIT = 4000;
const SEEN_RECORDS_LIMIT = 4000;

function emptyState() {
  return { seenKeys: [], seenRecords: [], lastSnapshot: [], chatSnapshots: {} };
}

function loadStateFromFile() {
  try {
    const { stateFile } = getSettings();
    if (fs.existsSync(stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return {
        seenKeys: parsed.seenKeys || [],
        seenRecords: parsed.seenRecords || [],
        lastSnapshot: parsed.lastSnapshot || [],
        chatSnapshots: parsed.chatSnapshots || {},
      };
    }
  } catch {
    /* ignore corrupt state */
  }
  return emptyState();
}

function saveStateToFile(state) {
  const keys = [...state.seenKeys].slice(-SEEN_KEYS_LIMIT);
  const payload = {
    seenKeys: keys,
    seenRecords: [...(state.seenRecords || [])].slice(-SEEN_RECORDS_LIMIT),
    lastSnapshot: state.lastSnapshot,
    chatSnapshots: state.chatSnapshots || {},
  };
  fs.writeFileSync(getSettings().stateFile, JSON.stringify(payload, null, 2));
}

async function loadState() {
  if (!db.isEnabled()) {
    return loadStateFromFile();
  }

  try {
    await db.initSchema();
    await db.testConnection();

    const [seenKeys, lastSnapshot, seenRecords] = await Promise.all([
      db.loadSeenKeys(),
      db.loadSnapshot(),
      typeof db.loadForwardedIdentities === 'function' ? db.loadForwardedIdentities() : [],
    ]);

    const fromFile = loadStateFromFile();
    const mergedRecords = [...(seenRecords || []), ...(fromFile.seenRecords || [])];
    const unique = [];
    const used = new Set();
    for (const item of mergedRecords) {
      const id = item.timedFingerprint || item.fingerprint || item.key;
      if (!id || used.has(id)) continue;
      used.add(id);
      unique.push(item);
    }

    return {
      seenKeys: seenKeys.length ? seenKeys : fromFile.seenKeys,
      seenRecords: unique.slice(-SEEN_RECORDS_LIMIT),
      lastSnapshot: lastSnapshot.length ? lastSnapshot : fromFile.lastSnapshot,
      chatSnapshots: fromFile.chatSnapshots || {},
    };
  } catch (err) {
    console.error('БД недоступна, fallback на state.json:', err.message);
    return loadStateFromFile();
  }
}

async function saveState(state) {
  const keys = [...state.seenKeys].slice(-SEEN_KEYS_LIMIT);
  const payload = {
    seenKeys: keys,
    seenRecords: [...(state.seenRecords || [])].slice(-SEEN_RECORDS_LIMIT),
    lastSnapshot: state.lastSnapshot,
    chatSnapshots: state.chatSnapshots || {},
  };

  if (db.isEnabled()) {
    try {
      await db.saveSeenKeys(keys);
      await db.saveSnapshot(state.lastSnapshot);
    } catch (err) {
      console.error('Ошибка сохранения в БД:', err.message);
    }
  }

  saveStateToFile(payload);
}

module.exports = { loadState, saveState };
