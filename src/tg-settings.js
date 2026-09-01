const { store } = require('./config');
const { DEFAULT_BIO_TEMPLATE, MAX_BIO_LENGTH } = require('./profile-bio');
const { TOGGLES, HINTS, withOnOffEmoji } = require('./bot-texts');

const FORWARDING_TOGGLE = {
  label: TOGGLES.forwarding,
  path: ['max', 'forwardingEnabled'],
  defaultOn: true,
};

const TOGGLE_ITEMS = [
  { label: TOGGLES.alwaysOnline, path: ['alwaysOnline', 'enabled'] },
  { label: TOGGLES.profileRotate, path: ['profileRotate', 'enabled'] },
  { label: TOGGLES.profileBio, path: ['profileBio', 'enabled'] },
];

function isToggleOn(item) {
  const cfg = store.get();
  const value = item.path.reduce((cur, key) => cur?.[key], cfg);
  if (item.defaultOn) return value !== false;
  return Boolean(value);
}

function buildToggleButton(prefix, item) {
  const on = isToggleOn(item);
  return withOnOffEmoji(
    {
      text: item.label,
      callback_data: `${prefix}${item.path.join('.')}`,
      style: on ? 'success' : 'danger',
    },
    on
  );
}

function buildToggleRows(prefix) {
  return TOGGLE_ITEMS.map((item) => [buildToggleButton(prefix, item)]);
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

const PROFILE_NAMES_HINT = HINTS.profileNames;
const PROFILE_BIO_CITY_HINT = HINTS.profileBioCity;
const PROFILE_BIO_TEMPLATE_HINT = HINTS.profileBioTemplate;

function saveProfileBioCity(city) {
  store.setPath(['profileBio', 'city'], String(city || '').trim());
}

function saveProfileBioTemplate(template) {
  store.setPath(['profileBio', 'template'], String(template || '').trim() || DEFAULT_BIO_TEMPLATE);
}

module.exports = {
  TOGGLES: TOGGLE_ITEMS,
  FORWARDING_TOGGLE,
  buildToggleButton,
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
