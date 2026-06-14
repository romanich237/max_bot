const fs = require('fs');
const path = require('path');
const { store, resolveFromRoot } = require('./config');

const KNOWN_CHATS_PATH = resolveFromRoot('data/known-chats.json');
const CHATS_PER_PAGE = 8;

function loadKnownChats() {
  try {
    if (fs.existsSync(KNOWN_CHATS_PATH)) {
      const data = JSON.parse(fs.readFileSync(KNOWN_CHATS_PATH, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    }
  } catch {
    /* ignore corrupt file */
  }
  return {};
}

function saveKnownChats(chats) {
  fs.mkdirSync(path.dirname(KNOWN_CHATS_PATH), { recursive: true });
  fs.writeFileSync(KNOWN_CHATS_PATH, `${JSON.stringify(chats, null, 2)}\n`, 'utf8');
}

function getChatTitle(chat) {
  if (chat.title) return chat.title;
  if (chat.username) return `@${chat.username}`;
  const parts = [chat.first_name, chat.last_name].filter(Boolean);
  return parts.join(' ') || 'Без названия';
}

function getChatTypeLabel(type) {
  const map = {
    private: 'личный чат',
    group: 'группа',
    supergroup: 'супергруппа',
    channel: 'канал',
  };
  return map[type] || type || 'чат';
}

function recordChat(chat) {
  if (!chat?.id) return null;

  const id = String(chat.id);
  const chats = loadKnownChats();
  const entry = {
    id,
    title: getChatTitle(chat),
    type: chat.type || 'unknown',
    username: chat.username || null,
    updatedAt: Date.now(),
  };

  chats[id] = entry;
  saveKnownChats(chats);
  return entry;
}

function recordChatFromUpdate(update) {
  const chat =
    update.message?.chat ||
    update.callback_query?.message?.chat ||
    update.my_chat_member?.chat ||
    update.chat_member?.chat;

  return recordChat(chat);
}

function listKnownChats() {
  return Object.values(loadKnownChats()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getKnownChat(chatId) {
  return loadKnownChats()[String(chatId)] || null;
}

function truncateButtonLabel(text, max = 42) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function buildDiscoverKeyboard(page = 0) {
  const chats = listKnownChats();
  const totalPages = Math.max(1, Math.ceil(chats.length / CHATS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = chats.slice(safePage * CHATS_PER_PAGE, safePage * CHATS_PER_PAGE + CHATS_PER_PAGE);

  const rows = slice.map((chat) => [
    {
      text: truncateButtonLabel(chat.title),
      callback_data: `chatinfo:${chat.id}`,
    },
  ]);

  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) {
      nav.push({ text: '◀️', callback_data: `discover:page:${safePage - 1}` });
    }
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'discover:noop' });
    if (safePage < totalPages - 1) {
      nav.push({ text: '▶️', callback_data: `discover:page:${safePage + 1}` });
    }
    rows.push(nav);
  }

  rows.push([{ text: '« В меню', callback_data: 'discover:menu' }]);
  return { inline_keyboard: rows };
}

function buildChatInfoText(chat, freshTitle) {
  const title = freshTitle || chat.title || 'Без названия';
  const lines = [
    '<b>Информация о чате</b>',
    '',
    `Название: <b>${escapeHtml(title)}</b>`,
    `ID: <code>${chat.id}</code>`,
    `Тип: ${getChatTypeLabel(chat.type)}`,
  ];

  if (chat.username) {
    lines.push(`Username: @${escapeHtml(chat.username)}`);
  }

  lines.push('', 'Скопируйте ID или нажмите «Привязать», чтобы сюда приходили уведомления из MAX.');
  return lines.join('\n');
}

function buildChatInfoKeyboard(chatId) {
  return {
    inline_keyboard: [
      [{ text: '✅ Привязать для уведомлений', callback_data: `bindchat:${chatId}` }],
      [{ text: '« К списку чатов', callback_data: 'discover:page:0' }],
      [{ text: '« В меню', callback_data: 'discover:menu' }],
    ],
  };
}

function buildDiscoverEmptyText() {
  return [
    '<b>Узнать ID чата</b>',
    '',
    'Бот пока не видел чатов, кроме текущего.',
    '',
    'Чтобы появилась группа:',
    '1. Добавьте бота в группу',
    '2. Напишите в группе <code>/start</code> или любое сообщение',
    '3. Снова нажмите «Узнать ID»',
    '',
    'Личный чат: напишите боту <code>/start</code> в личке.',
  ].join('\n');
}

function buildNotifyChatText() {
  const chatIds = store.getPath(['telegram', 'chatIds']) || [];
  const lines = ['<b>Чат для уведомлений из MAX</b>', ''];

  if (!chatIds.length) {
    lines.push('Сейчас чат не задан.');
  } else {
    for (const id of chatIds) {
      const known = getKnownChat(id);
      const label = known?.title ? `${known.title} ` : '';
      lines.push(`${label}(<code>${id}</code>)`);
    }
  }

  lines.push('', 'Нажмите «🔍 Узнать ID» внизу экрана, чтобы выбрать чат из списка.');
  return lines.join('\n');
}

function bindNotificationChat(targetChatId, adminChatId) {
  const targetId = String(targetChatId);
  const { getAdminChatIds } = require('./config');
  const adminIds = new Set(getAdminChatIds().map(String));
  adminIds.add(String(adminChatId));
  adminIds.delete(targetId);

  store.setPath(['telegram', 'chatIds'], [targetId]);
  store.setPath(['telegram', 'adminChatIds'], [...adminIds]);
  return targetId;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  CHATS_PER_PAGE,
  recordChat,
  recordChatFromUpdate,
  listKnownChats,
  getKnownChat,
  buildDiscoverKeyboard,
  buildDiscoverEmptyText,
  buildChatInfoText,
  buildChatInfoKeyboard,
  buildNotifyChatText,
  bindNotificationChat,
  getChatTypeLabel,
};
