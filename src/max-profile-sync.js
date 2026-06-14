const { store, getAdminChatIds, getProfileRotate } = require('./config');
const { sendMessage } = require('./tg-api');
const { readProfileFirstNameOnly } = require('./profile');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeName(name) {
  return (name || '').trim();
}

function collectNamesFromMessages(messages = []) {
  const names = new Set();
  for (const msg of messages) {
    if (!msg.isOwn) continue;
    const author = normalizeName(msg.author);
    if (author && author !== 'Неизвестно') {
      names.add(author);
    }
  }
  return [...names];
}

function mergeOwnAuthorNames(newNames = []) {
  const current = store.getPath(['max', 'ownAuthorNames']) || [];
  const merged = [...current];
  let changed = false;

  for (const raw of newNames) {
    const name = normalizeName(raw);
    if (!name) continue;
    const exists = merged.some((item) => item.toLowerCase() === name.toLowerCase());
    if (!exists) {
      merged.push(name);
      changed = true;
    }
  }

  if (changed) {
    store.setPath(['max', 'ownAuthorNames'], merged);
  }

  return { merged, changed };
}

function replaceOwnAuthorNames(names = []) {
  const normalized = [];
  const seen = new Set();

  for (const raw of names) {
    const name = normalizeName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(name);
  }

  const prev = store.getPath(['max', 'ownAuthorNames']) || [];
  const changed =
    prev.length !== normalized.length ||
    prev.some((item, index) => item.toLowerCase() !== normalized[index]?.toLowerCase());

  if (changed) {
    store.setPath(['max', 'ownAuthorNames'], normalized);
  }

  return { merged: normalized, changed };
}

async function notifyOwnNamesUpdate(currentName, allNames, reason) {
  const privateChatIds = getAdminChatIds().filter((id) => Number(id) > 0);
  if (!privateChatIds.length) return;

  const lines = [
    '<b>Имя в MAX</b>',
    reason ? escapeHtml(reason) : null,
    currentName ? `Сейчас: <code>${escapeHtml(currentName)}</code>` : null,
    allNames.length
      ? `Свои имена (не пересылаются):\n${allNames.map((n) => `• <code>${escapeHtml(n)}</code>`).join('\n')}`
      : null,
  ].filter(Boolean);

  for (const chatId of privateChatIds) {
    try {
      await sendMessage(chatId, lines.join('\n'));
    } catch (err) {
      console.error(`Не удалось отправить имя в ${chatId}:`, err.message);
    }
  }
}

async function syncOwnNames(page, options = {}) {
  const rotation = getProfileRotate();
  const configuredNames = (rotation.names || []).map(normalizeName).filter(Boolean);
  let profileFirstName = '';

  if (options.readProfile && page) {
    try {
      profileFirstName = normalizeName(await readProfileFirstNameOnly(page, options.chatUrl));
    } catch (err) {
      console.warn('Не удалось прочитать имя из профиля MAX:', err.message);
    }
  }

  let merged;
  let changed;

  if (configuredNames.length > 0) {
    ({ merged, changed } = replaceOwnAuthorNames(configuredNames));
  } else {
    const names = new Set(options.extraNames || []);

    for (const name of collectNamesFromMessages(options.messages || [])) {
      names.add(name);
    }

    if (profileFirstName) names.add(profileFirstName);

    ({ merged, changed } = mergeOwnAuthorNames([...names]));
  }

  const rotatedName = normalizeName(options.extraNames?.[0]);
  const currentName =
    rotatedName ||
    profileFirstName ||
    store.getPath(['max', 'currentDisplayName']) ||
    (merged.length ? merged[merged.length - 1] : '');
  const prevName = store.getPath(['max', 'currentDisplayName']) || '';
  const nameChanged = Boolean(currentName && currentName !== prevName);

  if (currentName) {
    store.setPath(['max', 'currentDisplayName'], currentName);
  }

  if (options.notify && (changed || nameChanged)) {
    await notifyOwnNamesUpdate(
      currentName,
      merged,
      options.reason || 'Имя взято из настроек профиля MAX (имя и фамилия).'
    );
  }

  if (changed || nameChanged) {
    console.log(`Имена MAX (свои): ${merged.join(' → ')}`);
  }

  return { currentName, ownAuthorNames: merged, changed: changed || nameChanged };
}

function syncOwnNamesFromMessages(messages, options = {}) {
  const configuredNames = (getProfileRotate().names || []).map(normalizeName).filter(Boolean);
  if (configuredNames.length > 0) {
    return {
      changed: false,
      ownAuthorNames: store.getPath(['max', 'ownAuthorNames']) || configuredNames,
    };
  }

  const names = collectNamesFromMessages(messages);
  if (!names.length) {
    return { changed: false, ownAuthorNames: store.getPath(['max', 'ownAuthorNames']) || [] };
  }

  const { merged, changed } = mergeOwnAuthorNames(names);
  const currentName = store.getPath(['max', 'currentDisplayName']) || '';

  if (options.notify && changed) {
    notifyOwnNamesUpdate(
      currentName,
      merged,
      'Добавлено имя из чата в список «своих» (для фильтрации).'
    ).catch((err) => console.error('notifyOwnNamesUpdate:', err.message));
  }

  return { currentName, ownAuthorNames: merged, changed };
}

module.exports = {
  collectNamesFromMessages,
  mergeOwnAuthorNames,
  replaceOwnAuthorNames,
  syncOwnNames,
  syncOwnNamesFromMessages,
};
