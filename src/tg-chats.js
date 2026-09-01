const fs = require('fs');
const { CHATS, BUTTONS, withTgEmoji, tgEmojiHtml } = require('./bot-texts');
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
  const prev = chats[id];
  const nextTitle = getChatTitle(chat);
  const keepTitle =
    prev?.title &&
    prev.title !== 'Без названия' &&
    (!nextTitle || nextTitle === 'Без названия');

  const entry = {
    id,
    title: keepTitle ? prev.title : nextTitle,
    type: chat.type || prev?.type || 'unknown',
    username: chat.username || prev?.username || null,
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
      [{ ...withTgEmoji({ text: BUTTONS.bindNotify, callback_data: `bindchat:${chatId}` }, 'check') }],
      [{ text: BUTTONS.backToChats, callback_data: 'discover:page:0' }],
      [{ text: BUTTONS.backToMenu, callback_data: 'discover:menu' }],
    ],
  };
}

function buildDiscoverEmptyText() {
  return CHATS.discoverEmpty;
}

function adminMark(isAdmin) {
  return isAdmin ? '✅' : '❌';
}

const DOCS_URL = 'https://github.com/romanich237/max_bot';
const BOT_ADMIN_RIGHTS = ['post_messages', 'edit_messages', 'delete_messages'];

function telegramGroupAdminRights(options = {}) {
  return {
    is_anonymous: false,
    can_manage_chat: false,
    can_delete_messages: true,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: Boolean(options.promote),
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
  };
}

function listBoundGroupIds() {
  return getNotificationChatIds().filter((id) => !isPrivateChatId(id));
}

function listKnownGroupChats() {
  return listBoundGroupIds().map((id) => {
    const known = getKnownChat(id) || { title: 'Без названия' };
    return { ...known, id: String(id), bound: true };
  });
}

async function buildBotAdminInviteUrl() {
  const { getBotUsername } = require('./tg-api');
  const username = await getBotUsername();
  if (!username) return '';
  return `https://t.me/${encodeURIComponent(username)}?startgroup=true&admin=${BOT_ADMIN_RIGHTS.join('+')}`;
}

function buildMissingAdminText(groupTitle) {
  return [
    `<b>${CHATS.notAdmin.title}</b>`,
    '',
    ...CHATS.notAdmin.lines(groupTitle ? escapeHtml(groupTitle) : ''),
  ].join('\n');
}

async function buildMissingAdminKeyboard() {
  const inviteUrl = await buildBotAdminInviteUrl();
  const rows = [];
  if (inviteUrl) {
    rows.push([withTgEmoji({ text: BUTTONS.addAdmin, url: inviteUrl }, 'plus')]);
  }
  rows.push([{ text: BUTTONS.docs, url: DOCS_URL }]);
  return { inline_keyboard: rows };
}

async function refreshTelegramChat(chatId) {
  const { getChat } = require('./tg-api');
  try {
    const data = await getChat(chatId);
    if (data.ok && data.result) {
      return recordChat(data.result);
    }
  } catch {
    /* бот ещё не в чате */
  }
  return getKnownChat(chatId);
}

async function getBotAdminStatus(chatId) {
  if (isPrivateChatId(chatId)) {
    return { admin: true, member: true, status: 'private' };
  }

  const { getBotUserId, getChatMember } = require('./tg-api');
  try {
    const botId = await getBotUserId();
    if (!botId) return { admin: false, member: false, status: 'unknown' };
    const data = await getChatMember(chatId, botId);
    const status = data.ok ? data.result?.status : '';
    return {
      admin: status === 'administrator' || status === 'creator',
      member: ['creator', 'administrator', 'member', 'restricted'].includes(status),
      status: status || 'left',
    };
  } catch {
    return { admin: false, member: false, status: 'left' };
  }
}

async function refreshNotificationChatStatuses() {
  const statuses = {};
  for (const id of getNotificationChatIds()) {
    if (isPrivateChatId(id)) {
      statuses[id] = { admin: true, member: true, status: 'private' };
      continue;
    }
    await refreshTelegramChat(id);
    statuses[id] = await getBotAdminStatus(id);
  }
  return statuses;
}

function isBotAdminStatus(member) {
  const status = member?.status;
  return status === 'administrator' || status === 'creator';
}

function buildNotifyChatText(adminByChat = {}) {
  const chatIds = getNotificationChatIds();
  const lines = [`<b>${CHATS.notifyHeader}</b>`, ''];
  const groups = listKnownGroupChats();
  const dmIds = chatIds.filter(isPrivateChatId);

  if (!chatIds.length && !groups.length) {
    lines.push(CHATS.notifyEmpty);
  } else {
    const hasGroup = groups.some((chat) => chat.bound);
    lines.push(hasGroup ? CHATS.notifyDualMode : CHATS.notifyDmMode, '');

    for (const id of dmIds) {
      const known = getKnownChat(id);
      const title = known?.title || 'Без названия';
      lines.push(`ЛС: <b>${escapeHtml(title)}</b> (<code>${id}</code>)`);
    }

    if (groups.length) {
      lines.push('', `${tgEmojiHtml('group')} <b>Группы (${groups.length})</b>`);
      for (const chat of groups) {
        const title = chat.title || 'Без названия';
        const mark = adminMark(Boolean(adminByChat[chat.id]?.admin));
        lines.push(`${tgEmojiHtml('group')} <b>${escapeHtml(title)}</b> (<code>${chat.id}</code>) ${mark}`);
      }
    }
  }

  lines.push('', CHATS.notifyFooter);
  return lines.join('\n');
}

async function buildNotifyChatKeyboard(adminByChat = {}) {
  const groups = listKnownGroupChats();
  const hasGroup = groups.length > 0;
  const rows = [];

  for (const chat of groups) {
    const title = chat.title || 'Без названия';
    const isAdmin = Boolean(adminByChat[chat.id]?.admin);
    rows.push([
      withTgEmoji(
        {
          text: truncateButtonLabel(title, 28),
          callback_data: `notify:chat:${chat.id}`,
          style: isAdmin ? 'success' : 'danger',
        },
        'group'
      ),
      withTgEmoji({ text: BUTTONS.removeNotifyGroup, callback_data: `notify:remove:${chat.id}` }, 'trash'),
    ]);
  }

  rows.push([withTgEmoji({ text: BUTTONS.bindGroup, callback_data: 'notify:bindGroup' }, 'plus')]);

  if (hasGroup) {
    rows.push([withTgEmoji({ text: BUTTONS.notifyDmOnly, callback_data: 'notify:dmOnly' }, 'kiss')]);
  }

  const missingAdmin = groups.some((chat) => !adminByChat[chat.id]?.admin);
  if (missingAdmin) {
    const inviteUrl = await buildBotAdminInviteUrl();
    if (inviteUrl) {
      rows.push([withTgEmoji({ text: BUTTONS.addAdmin, url: inviteUrl }, 'plus')]);
    }
    rows.push([{ text: BUTTONS.docs, url: DOCS_URL }]);
  }

  rows.push(
    [{ text: BUTTONS.backToMenu, callback_data: 'discover:menu' }]
  );

  return { inline_keyboard: rows };
}

function buildNotifyGroupViewText(chatId, status = {}) {
  const known = getKnownChat(chatId);
  const title = known?.title || 'Без названия';
  return [
    `${tgEmojiHtml('group')} <b>Группа уведомлений</b>`,
    '',
    `Название: <b>${escapeHtml(title)}</b>`,
    `ID: <code>${escapeHtml(String(chatId))}</code>`,
    `Бот админ: ${status.admin ? '✅ да' : '❌ нет'}`,
    '',
    '«Удалить» убирает группу из рассылки. Из самой группы в Telegram бот не выйдет.',
  ].join('\n');
}

async function buildNotifyGroupViewKeyboard(chatId, status = {}) {
  const rows = [[withTgEmoji({ text: BUTTONS.removeNotifyGroup, callback_data: `notify:remove:${chatId}` }, 'trash')]];
  if (!status.admin) {
    const inviteUrl = await buildBotAdminInviteUrl();
    if (inviteUrl) {
      rows.push([withTgEmoji({ text: BUTTONS.addAdmin, url: inviteUrl }, 'plus')]);
    }
  }
  rows.push([{ text: '« К списку', callback_data: 'action:notifyChat' }]);
  return { inline_keyboard: rows };
}

function buildBindGroupReplyKeyboard() {
  return {
    keyboard: [
      [
        {
          ...withTgEmoji({ text: BUTTONS.bindGroup }, 'plus'),
          request_chat: {
            request_id: NOTIFY_GROUP_REQUEST_ID,
            chat_is_channel: false,
            request_title: true,
            bot_administrator_rights: telegramGroupAdminRights(),
            user_administrator_rights: telegramGroupAdminRights({ promote: true }),
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
  const removed = (store.getPath(['telegram', 'chatIds']) || [])
    .map(String)
    .filter((id) => !isPrivateChatId(id));
  store.setPath(['telegram', 'adminChatIds'], [...admins]);
  store.setPath(['telegram', 'chatIds'], [adminId]);
  try {
    const { pruneNotifyChatId } = require('./max-chats');
    for (const id of removed) pruneNotifyChatId(id);
  } catch {
    /* ignore */
  }
  return { chatIds: [adminId] };
}

function bindNotificationChat(targetChatId, adminChatId) {
  const targetId = String(targetChatId);
  const adminId = String(adminChatId);
  const { getAdminChatIds } = require('./config');
  const adminIds = new Set(getAdminChatIds().map(String));
  adminIds.add(adminId);

  const existing = (store.getPath(['telegram', 'chatIds']) || []).map(String);
  const chatIds = [...existing];

  if (!isPrivateChatId(targetId)) {
    const privateId = isPrivateChatId(adminId) ? adminId : [...adminIds].find(isPrivateChatId);
    if (privateId && !chatIds.some(isPrivateChatId)) {
      chatIds.unshift(privateId);
    }
  }

  if (!chatIds.includes(targetId)) {
    chatIds.push(targetId);
  }

  const unique = [...new Set(chatIds)];
  store.setPath(['telegram', 'chatIds'], unique);
  store.setPath(['telegram', 'adminChatIds'], [...adminIds]);
  return { targetId, chatIds: unique, added: !existing.includes(targetId) };
}

function unbindNotificationChat(targetChatId) {
  const targetId = String(targetChatId);
  if (isPrivateChatId(targetId)) {
    return { error: 'Личные сообщения из списка убрать нельзя.' };
  }

  const chatIds = (store.getPath(['telegram', 'chatIds']) || [])
    .map(String)
    .filter((id) => id !== targetId);
  store.setPath(['telegram', 'chatIds'], chatIds);
  try {
    const { pruneNotifyChatId } = require('./max-chats');
    pruneNotifyChatId(targetId);
  } catch {
    /* ignore */
  }
  return { ok: true, chatIds };
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
  buildNotifyGroupViewText,
  buildNotifyGroupViewKeyboard,
  buildMissingAdminText,
  buildMissingAdminKeyboard,
  buildBotAdminInviteUrl,
  buildBindGroupReplyKeyboard,
  bindNotificationChat,
  unbindNotificationChat,
  listKnownGroupChats,
  setDmOnlyNotifications,
  refreshTelegramChat,
  refreshNotificationChatStatuses,
  getBotAdminStatus,
  isBotAdminStatus,
  getChatTypeLabel,
};
