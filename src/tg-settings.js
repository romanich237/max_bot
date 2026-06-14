const { store } = require('./config');
const { DEFAULT_BIO_TEMPLATE, MAX_BIO_LENGTH } = require('./profile-bio');

const TOGGLES = [
  { label: 'Бесконечный онлайн', path: ['alwaysOnline', 'enabled'] },
  { label: 'Авто имя', path: ['profileRotate', 'enabled'] },
  { label: 'Авто описание', path: ['profileBio', 'enabled'] },
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
  'Отправьте имена авто через запятую.\nПример: <code>в, ва, вас, вася</code>';

const PROFILE_BIO_CITY_HINT =
  'Отправьте ваш город для погоды и часового пояса.\nПример: <code>Москва</code>';

const PROFILE_BIO_TEMPLATE_HINT = [
  'Отправьте шаблон описания профиля MAX (до 400 символов после подстановки).',
  'Переменные: <code>{час}</code> <code>{минута}</code> <code>{день}</code> <code>{месяц}</code> <code>{погода}</code>',
  `По умолчанию: <code>${DEFAULT_BIO_TEMPLATE}</code>`,
].join('\n');

function saveProfileBioCity(city) {
  store.setPath(['profileBio', 'city'], String(city || '').trim());
}

function saveProfileBioTemplate(template) {
  store.setPath(['profileBio', 'template'], String(template || '').trim() || DEFAULT_BIO_TEMPLATE);
}

module.exports = {
  TOGGLES,
  buildToggleRows,
  parseNameList,
  saveProfileNames,
  saveProfileBioCity,
  saveProfileBioTemplate,
  PROFILE_NAMES_HINT,
  PROFILE_BIO_CITY_HINT,
  PROFILE_BIO_TEMPLATE_HINT,
  MAX_BIO_LENGTH,
};
