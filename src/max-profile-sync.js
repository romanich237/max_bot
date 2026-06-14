const { store, getAdminChatIds, getProfileRotate } = require('./config');
const { sendMessage } = require('./tg-api');
const { readProfileFirstName } = require('./profile');

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
  const names = new Set(options.extraNames || []);

  const rotation = getProfileRotate();
  for (const name of rotation.names || []) {
    const normalized = normalizeName(name);
    if (normalized) names.add(normalized);
  }

  for (const name of collectNamesFromMessages(options.messages || [])) {
    names.add(name);
  }

  if (options.readProfile && page) {
    try {
      const profileName = await readProfileFirstName(page, options.chatUrl);
      if (profileName) names.add(profileName);
    } catch (err) {
      console.warn('Не удалось прочитать имя из профиля MAX:', err.message);
    }
  }

  const nameList = [...names];
  const { merged, changed } = mergeOwnAuthorNames(nameList);
  const currentName = nameList[nameList.length - 1] || merged[merged.length - 1] || '';
  const prevName = store.getPath(['max', 'currentDisplayName']) || '';
  const nameChanged = Boolean(currentName && currentName !== prevName);

  if (currentName) {
    store.setPath(['max', 'currentDisplayName'], currentName);
  }

  if (options.notify && (changed || nameChanged)) {
    await notifyOwnNamesUpdate(
      currentName,
      merged,
      options.reason || 'Обновлён список имён — ваши сообщения не пересылаются в Telegram.'
    );
  }

  if (changed || nameChanged) {
    console.log(`Имена MAX (свои): ${merged.join(' → ')}`);
  }

  return { currentName, ownAuthorNames: merged, changed: changed || nameChanged };
}

function syncOwnNamesFromMessages(messages, options = {}) {
  const names = collectNamesFromMessages(messages);
  if (!names.length) {
    return { changed: false, ownAuthorNames: store.getPath(['max', 'ownAuthorNames']) || [] };
  }

  const { merged, changed } = mergeOwnAuthorNames(names);
  const currentName = names[names.length - 1];
  const prevName = store.getPath(['max', 'currentDisplayName']) || '';
  const nameChanged = currentName && currentName !== prevName;

  if (nameChanged) {
    store.setPath(['max', 'currentDisplayName'], currentName);
  }

  if (options.notify && (changed || nameChanged)) {
    notifyOwnNamesUpdate(
      currentName,
      merged,
      'Новое имя из чата MAX — добавлено в список «своих».'
    ).catch((err) => console.error('notifyOwnNamesUpdate:', err.message));
  }

  return { currentName, ownAuthorNames: merged, changed: changed || nameChanged };
}

module.exports = {
  collectNamesFromMessages,
  mergeOwnAuthorNames,
  syncOwnNames,
  syncOwnNamesFromMessages,
};
