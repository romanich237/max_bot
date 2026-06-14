const fs = require('fs');
const { getSettings } = require('./config');
const db = require('./db');

function loadStateFromFile() {
  try {
    const { stateFile } = getSettings();
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch {
    /* ignore corrupt state */
  }
  return { seenKeys: [], lastSnapshot: [], chatSnapshots: {} };
}

function saveStateToFile(state) {
  const keys = [...state.seenKeys].slice(-500);
  const payload = {
    seenKeys: keys,
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

    const [seenKeys, lastSnapshot] = await Promise.all([
      db.loadSeenKeys(),
      db.loadSnapshot(),
    ]);

    return { seenKeys, lastSnapshot, chatSnapshots: {} };
  } catch (err) {
    console.error('MySQL недоступен, fallback на state.json:', err.message);
    return loadStateFromFile();
  }
}

async function saveState(state) {
  const keys = [...state.seenKeys].slice(-500);
  const payload = {
    seenKeys: keys,
    lastSnapshot: state.lastSnapshot,
    chatSnapshots: state.chatSnapshots || {},
  };

  if (db.isEnabled()) {
    try {
      await db.saveSeenKeys(keys);
      await db.saveSnapshot(state.lastSnapshot);
    } catch (err) {
      console.error('Ошибка сохранения в MySQL:', err.message);
    }
  }

  saveStateToFile(payload);
}

module.exports = { loadState, saveState };
