const { getProfileBio } = require('./config');
const { fetchWeatherParts } = require('./weather');

const MAX_BIO_LENGTH = 400;
const DEFAULT_BIO_TEMPLATE = '{час}:{минута} · {день}.{месяц} · {температура}, {погода}';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeEventDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return '';
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function zonedTodayIso(timezone = 'Europe/Moscow') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function formatEventDateRu(value) {
  const iso = normalizeEventDate(value);
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function daysUntilEvent(eventDate, timezone = 'Europe/Moscow') {
  const iso = normalizeEventDate(eventDate);
  if (!iso) return '';
  const todayIso = zonedTodayIso(timezone);
  const diff = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000
  );
  return String(Math.max(0, diff));
}

function getDateParts(now, timezone) {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';

  return {
    hour: pick('hour'),
    minute: pick('minute'),
    day: pick('day'),
    month: pick('month'),
  };
}

function applyTemplate(template, values) {
  const daysUntil = values.daysUntil ?? '';
  return String(template || '')
    .replace(/\{дни_до_события\}/gi, daysUntil)
    .replace(/\{дней_до\}/gi, daysUntil)
    .replace(/\{дни_до\}/gi, daysUntil)
    .replace(/\{час\}/gi, values.hour)
    .replace(/\{минута\}/gi, values.minute)
    .replace(/\{день\}/gi, values.day)
    .replace(/\{месяц\}/gi, values.month)
    .replace(/\{температура\}/gi, values.temperature ?? '')
    .replace(/\{погода\}/gi, values.weather ?? '')
    .replace(/\{непрочитанные_чаты\}/gi, values.unreadChats)
    .replace(/\{непрочитанные_сообщения\}/gi, values.unreadMessages)
    .replace(/\{чаты\}/gi, values.unreadChats)
    .replace(/\{сообщения\}/gi, values.unreadMessages);
}

function templateNeedsUnread(template) {
  return /\{непрочитанные_чаты\}|\{непрочитанные_сообщения\}|\{чаты\}|\{сообщения\}/i.test(
    String(template || '')
  );
}

function unreadValues(options = {}) {
  const chats = options.unreadChats ?? options.chats;
  const messages = options.unreadMessages ?? options.messages;
  return {
    unreadChats: chats == null || chats === '' ? '0' : String(chats),
    unreadMessages: messages == null || messages === '' ? '0' : String(messages),
  };
}

async function renderBioDescription(options = {}) {
  const settings = { ...getProfileBio(), ...options };
  const template = settings.template || DEFAULT_BIO_TEMPLATE;
  const city = String(settings.city || '').trim();

  if (!city) {
    throw new Error('Укажите город для авто-описания (/set biocity или кнопка «Город»).');
  }

  const apiKey = settings.weatherApiKey;

  const weatherParts = await fetchWeatherParts(city, apiKey);
  const { resolveCity } = require('./weather');
  const geo = await resolveCity(city, apiKey);
  const timezone = geo.timezone || 'Europe/Moscow';
  const parts = getDateParts(new Date(), timezone);
  const daysUntil = daysUntilEvent(settings.eventDate, timezone);

  let unread = unreadValues(options);
  if (options.page && templateNeedsUnread(template)) {
    try {
      const { readUnreadCounts } = require('./max-chat-picker');
      const counts = await readUnreadCounts(options.page);
      unread = unreadValues(counts);
      console.log(
        `описание: непрочитанные — чаты ${unread.unreadChats}, сообщения ${unread.unreadMessages}`
      );
    } catch (err) {
      console.warn('описание: непрочитанные не считаются —', err.message);
    }
  }

  let text = applyTemplate(template, {
    ...parts,
    temperature: weatherParts.temperature,
    weather: weatherParts.condition,
    daysUntil,
    ...unread,
  });

  if (text.length > MAX_BIO_LENGTH) {
    text = text.slice(0, MAX_BIO_LENGTH);
  }

  return text;
}

function previewBioTemplate(template, city, timezone = 'Europe/Moscow', eventDate = '') {
  const settings = getProfileBio();
  const parts = getDateParts(new Date(), timezone);
  const daysUntil = daysUntilEvent(eventDate || settings.eventDate, timezone) || '0';
  let text = applyTemplate(template || DEFAULT_BIO_TEMPLATE, {
    ...parts,
    temperature: '+5°C',
    weather: 'облачно',
    unreadChats: '2',
    unreadMessages: '7',
    daysUntil,
  });

  if (text.length > MAX_BIO_LENGTH) {
    text = text.slice(0, MAX_BIO_LENGTH);
  }

  return { text, city: city || 'не задан', length: text.length };
}

module.exports = {
  MAX_BIO_LENGTH,
  DEFAULT_BIO_TEMPLATE,
  renderBioDescription,
  previewBioTemplate,
  applyTemplate,
  daysUntilEvent,
  formatEventDateRu,
  normalizeEventDate,
};
