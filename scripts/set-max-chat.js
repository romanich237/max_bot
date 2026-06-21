#!/usr/bin/env node
const {
  isMaxChatUrl,
  normalizeMaxChatUrl,
  addMonitorChatUrl,
  setDefaultChatUrl,
  setChatTitle,
  getDefaultChatUrl,
  getMonitorChatUrls,
} = require('../src/max-chats');
const store = require('../src/settings-store');
const { getAdminChatIds, isPrivateChatId } = require('../src/config');
const { setDmOnlyNotifications } = require('../src/tg-chats');

function usage() {
  console.log('Использование: node scripts/set-max-chat.js <url> [название] [--dm-only]');
  console.log('Пример: node scripts/set-max-chat.js https://web.max.ru/35859265 "Коды подтверждения" --dm-only');
  process.exit(1);
}

const args = process.argv.slice(2);
const dmOnly = args.includes('--dm-only');
const positional = args.filter((arg) => arg !== '--dm-only');
const rawUrl = positional[0];
const title = positional.slice(1).join(' ').trim();

if (!rawUrl) usage();

const url = normalizeMaxChatUrl(rawUrl);
if (!isMaxChatUrl(url)) {
  console.error('Некорректная ссылка MAX:', rawUrl);
  process.exit(1);
}

const hasDefault = Boolean(getDefaultChatUrl());
const result = hasDefault ? addMonitorChatUrl(url, { title }) : setDefaultChatUrl(url, { title });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (title) {
  setChatTitle(url, title);
}

if (dmOnly) {
  const admins = getAdminChatIds();
  const dmId = admins.find(isPrivateChatId) || admins[0];
  if (!dmId) {
    console.warn('Личный chat ID не найден. Задайте telegram.chatIds в config.json');
  } else {
    setDmOnlyNotifications(dmId);
    console.log('Уведомления: только ЛС', dmId);
  }
}

console.log('Чат MAX добавлен:');
console.log('  URL:', url);
if (title) console.log('  Название:', title);
console.log('  Основной:', url === getDefaultChatUrl() ? 'да' : 'нет');
console.log('  Всего в мониторинге:', getMonitorChatUrls().length);
console.log('');
console.log('Перезапуск: pm2 restart max-tg');
