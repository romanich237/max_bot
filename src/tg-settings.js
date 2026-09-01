const { store, getProfileBio } = require('./config');
const {
  DEFAULT_BIO_TEMPLATE,
  MAX_BIO_LENGTH,
  formatEventDateRu,
  normalizeEventDate,
  daysUntilEvent,
  previewBioTemplate,
} = require('./profile-bio');
const { TOGGLES, HINTS, BUTTONS, withOnOffEmoji } = require('./bot-texts');

const FORWARDING_TOGGLE = {
  label: TOGGLES.forwarding,
  path: ['max', 'forwardingEnabled'],
  defaultOn: true,
};

const TOGGLE_ITEMS = [
  { label: TOGGLES.alwaysOnline, path: ['alwaysOnline', 'enabled'] },
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

function saveProfileBioEventDate(value) {
  store.setPath(['profileBio', 'eventDate'], normalizeEventDate(value));
}

const MONTHS_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function shiftYearMonth(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function parseYearMonth(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildBioTemplatePromptText(templateOverride) {
  const bio = getProfileBio();
  const template = String(templateOverride || bio.template || DEFAULT_BIO_TEMPLATE).trim();
  let previewText = template;
  try {
    previewText = previewBioTemplate(template, bio.city, 'Europe/Moscow', bio.eventDate).text;
  } catch {
    /* keep raw template if preview is unavailable */
  }
  const eventIso = normalizeEventDate(bio.eventDate);
  const eventLine = eventIso
    ? `Событие: <b>${formatEventDateRu(eventIso)}</b> · осталось дней: <code>${daysUntilEvent(eventIso)}</code>`
    : 'Событие не задано — нажмите кнопку и выберите дату.';
  return [
    HINTS.profileBioTemplate,
    '',
    eventLine,
    '',
    'Шаблон:',
    `<code>${escapeHtml(template)}</code>`,
    '',
    'Как выглядит:',
    `<code>${escapeHtml(previewText)}</code>`,
    '',
    'Отправьте новый шаблон или /cancel.',
  ].join('\n');
}

function buildBioTemplateKeyboard() {
  const bio = getProfileBio();
  const eventIso = normalizeEventDate(bio.eventDate);
  const label = eventIso ? `${BUTTONS.bioEvent}: ${formatEventDateRu(eventIso)}` : BUTTONS.bioEvent;
  return {
    inline_keyboard: [[{ text: label.slice(0, 64), callback_data: 'bioevent:open' }]],
  };
}

function buildEventCalendarKeyboard(year, month, selectedIso = '') {
  const selected = normalizeEventDate(selectedIso);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const startWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const prev = shiftYearMonth(year, month, -1);
  const next = shiftYearMonth(year, month, 1);
  const rows = [
    [
      { text: '◀️', callback_data: `bioevent:nav:${prev.year}-${pad2(prev.month)}` },
      { text: `${MONTHS_RU[month - 1]} ${year}`.slice(0, 32), callback_data: 'bioevent:noop' },
      { text: '▶️', callback_data: `bioevent:nav:${next.year}-${pad2(next.month)}` },
    ],
  ];

  let row = [];
  for (let i = 0; i < startWeekday; i += 1) {
    row.push({ text: '·', callback_data: 'bioevent:noop' });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${year}-${pad2(month)}-${pad2(day)}`;
    const button = { text: String(day), callback_data: `bioevent:set:${iso}` };
    if (iso === selected) button.style = 'success';
    row.push(button);
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) {
    while (row.length < 7) row.push({ text: '·', callback_data: 'bioevent:noop' });
    rows.push(row);
  }

  rows.push([
    { text: 'Сбросить', callback_data: 'bioevent:clear' },
    { text: '« К шаблону', callback_data: 'bioevent:back' },
  ]);
  return { inline_keyboard: rows };
}

function eventCalendarTitle(year, month) {
  return [
    '<b>Дата события</b>',
    '',
    'Выберите день — в шаблоне подставится <code>{дни_до}</code>.',
    '',
    `${MONTHS_RU[month - 1]} ${year}`,
  ].join('\n');
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
  saveProfileBioEventDate,
  buildBioTemplatePromptText,
  buildBioTemplateKeyboard,
  buildEventCalendarKeyboard,
  eventCalendarTitle,
  parseYearMonth,
  PROFILE_NAMES_HINT,
  PROFILE_BIO_CITY_HINT,
  PROFILE_BIO_TEMPLATE_HINT,
  MAX_BIO_LENGTH,
};
