const { store } = require('./config');

const TOGGLES = [
  { label: 'Бесконечный онлайн', path: ['alwaysOnline', 'enabled'] },
  { label: 'Ротация имени', path: ['profileRotate', 'enabled'] },
  { label: 'Время в Telegram', path: ['telegram', 'showTime'] },
  { label: 'Заголовок в Telegram', path: ['telegram', 'showServiceHeader'] },
  { label: 'Автообновление с GitHub', path: ['autoUpdate', 'enabled'] },
];

function buildToggleRows(prefix) {
  const cfg = store.get();
  return TOGGLES.map((item) => {
    const value = item.path.reduce((cur, key) => cur?.[key], cfg);
    return [{
      text: `${item.label}: ${value ? '✅' : '❌'}`,
      callback_data: `${prefix}${item.path.join('.')}`,
    }];
  });
}

function parseNameList(text) {
  return text
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function saveProfileNames(names) {
  store.setPath(['profileRotate', 'mode'], 'list');
  store.setPath(['profileRotate', 'names'], names);
  store.setPath(['max', 'ownAuthorNames'], names);
}

const PROFILE_NAMES_HINT =
  'Отправьте имена для ротации через запятую.\nПример: <code>в, ва, вас, вася</code>';

module.exports = {
  TOGGLES,
  buildToggleRows,
  parseNameList,
  saveProfileNames,
  PROFILE_NAMES_HINT,
};
