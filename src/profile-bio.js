const { getProfileBio } = require('./config');
const { fetchWeatherText } = require('./weather');

const MAX_BIO_LENGTH = 400;
const DEFAULT_BIO_TEMPLATE = '{час}:{минута} · {день}.{месяц} · {погода}';

function pad2(value) {
  return String(value).padStart(2, '0');
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
  return String(template || '')
    .replace(/\{час\}/gi, values.hour)
    .replace(/\{минута\}/gi, values.minute)
    .replace(/\{день\}/gi, values.day)
    .replace(/\{месяц\}/gi, values.month)
    .replace(/\{погода\}/gi, values.weather)
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
  const chats = options.unreadChats;
  const messages = options.unreadMessages;
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

  const weather = await fetchWeatherText(city, apiKey);
  const { resolveCity } = require('./weather');
  const geo = await resolveCity(city, apiKey);
  const parts = getDateParts(new Date(), geo.timezone);

  let unread = unreadValues(options);
  if (options.page && templateNeedsUnread(template)) {
    try {
      const { readUnreadCounts } = require('./max-chat-picker');
      const counts = await readUnreadCounts(options.page);
      unread = unreadValues(counts);
    } catch (err) {
      console.warn('описание: непрочитанные не считаются —', err.message);
    }
  }

  let text = applyTemplate(template, { ...parts, weather, ...unread });

  if (text.length > MAX_BIO_LENGTH) {
    text = text.slice(0, MAX_BIO_LENGTH);
  }

  return text;
}

function previewBioTemplate(template, city, timezone = 'Europe/Moscow') {
  const parts = getDateParts(new Date(), timezone);
  let text = applyTemplate(template || DEFAULT_BIO_TEMPLATE, {
    ...parts,
    weather: '+5°C, облачно',
    unreadChats: '2',
    unreadMessages: '7',
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
};
