const fs = require('fs');
const { CHATS, BUTTONS } = require('./bot-texts');
const path = require('path');
const { store, resolveFromRoot, getNotificationChatIds, isPrivateChatId } = require('./config');

const KNOWN_CHATS_PATH = resolveFromRoot('data/known-chats.json');
const CHATS_PER_PAGE = 8;
const DISCOVER_CHAT_REQUEST_ID = 1;
const NOTIFY_GROUP_REQUEST_ID = 2;

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
  const shared = update.message?.chat_shared;
  if (shared?.chat_id) {
    return recordChat({
      id: shared.chat_id,
      title: shared.title,
      username: shared.username || null,
      type: 'unknown',
    });
  }

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
    `<b>${CHATS.infoHeader}</b>`,
    '',
    `Название: <b>${escapeHtml(title)}</b>`,
    `ID: <code>${chat.id}</code>`,
    `Тип: ${getChatTypeLabel(chat.type)}`,
  ];

  if (chat.username) {
    lines.push(`Username: @${escapeHtml(chat.username)}`);
  }

  lines.push('', CHATS.infoFooter);
  return lines.join('\n');
}

function buildChatInfoKeyboard(chatId) {
  return {
    inline_keyboard: [
      [{ text: BUTTONS.bindNotify, callback_data: `bindchat:${chatId}` }],
      [{ text: BUTTONS.backToChats, callback_data: 'discover:page:0' }],
      [{ text: BUTTONS.backToMenu, callback_data: 'discover:menu' }],
    ],
  };
}

function buildDiscoverEmptyText() {
  return CHATS.discoverEmpty;
}

function buildNotifyChatText() {
  const chatIds = getNotificationChatIds();
  const lines = [`<b>${CHATS.notifyHeader}</b>`, ''];

  if (!chatIds.length) {
    lines.push(CHATS.notifyEmpty);
  } else {
    const hasGroup = chatIds.some((id) => !isPrivateChatId(id));
    lines.push(hasGroup ? CHATS.notifyDualMode : CHATS.notifyDmMode, '');

    for (const id of chatIds) {
      const known = getKnownChat(id);
      const title = known?.title || 'Без названия';
      const kind = isPrivateChatId(id) ? 'ЛС' : 'группа';
      lines.push(`${kind}: <b>${escapeHtml(title)}</b> (<code>${id}</code>)`);
    }
  }

  lines.push('', CHATS.notifyFooter);
  return lines.join('\n');
}

function buildNotifyChatKeyboard() {
  const chatIds = getNotificationChatIds();
  const hasGroup = chatIds.some((id) => !isPrivateChatId(id));
  const rows = [
    [{ text: BUTTONS.bindGroup, callback_data: 'notify:bindGroup' }],
  ];

  if (hasGroup) {
    rows.push([{ text: BUTTONS.notifyDmOnly, callback_data: 'notify:dmOnly' }]);
  }

  rows.push(
    [{ text: BUTTONS.discoverId, callback_data: 'discover:page:0' }],
    [{ text: BUTTONS.backToMenu, callback_data: 'discover:menu' }]
  );

  return { inline_keyboard: rows };
}

function buildBindGroupReplyKeyboard() {
  return {
    keyboard: [
      [
        {
          text: BUTTONS.bindGroup,
          request_chat: {
            request_id: NOTIFY_GROUP_REQUEST_ID,
            chat_is_channel: false,
          },
        },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function setDmOnlyNotifications(adminChatId) {
  const adminId = String(adminChatId);
  const admins = new Set((store.getPath(['telegram', 'adminChatIds']) || []).map(String));
  admins.add(adminId);
  store.setPath(['telegram', 'adminChatIds'], [...admins]);
  store.setPath(['telegram', 'chatIds'], [adminId]);
  return { chatIds: [adminId] };
}

function bindNotificationChat(targetChatId, adminChatId) {
  const targetId = String(targetChatId);
  const adminId = String(adminChatId);
  const { getAdminChatIds } = require('./config');
  const adminIds = new Set(getAdminChatIds().map(String));
  adminIds.add(adminId);

  let privateId = isPrivateChatId(adminId) ? adminId : [...adminIds].find(isPrivateChatId);
  if (!privateId) privateId = adminId;

  let chatIds;
  if (isPrivateChatId(targetId)) {
    chatIds = [targetId];
  } else {
    chatIds = [privateId, targetId];
  }

  chatIds = [...new Set(chatIds)];
  store.setPath(['telegram', 'chatIds'], chatIds);
  store.setPath(['telegram', 'adminChatIds'], [...adminIds]);
  return { targetId, chatIds };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  CHATS_PER_PAGE,
  DISCOVER_CHAT_REQUEST_ID,
  NOTIFY_GROUP_REQUEST_ID,
  recordChat,
  recordChatFromUpdate,
  listKnownChats,
  getKnownChat,
  buildDiscoverKeyboard,
  buildDiscoverEmptyText,
  buildChatInfoText,
  buildChatInfoKeyboard,
  buildNotifyChatText,
  buildNotifyChatKeyboard,
  buildBindGroupReplyKeyboard,
  bindNotificationChat,
  setDmOnlyNotifications,
  getChatTypeLabel,
};
