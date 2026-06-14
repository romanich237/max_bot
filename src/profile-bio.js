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
    .replace(/\{погода\}/gi, values.weather);
}

async function renderBioDescription(options = {}) {
  const settings = { ...getProfileBio(), ...options };
  const template = settings.template || DEFAULT_BIO_TEMPLATE;
  const city = String(settings.city || '').trim();

  if (!city) {
    throw new Error('Укажите город для авто-описания (/set biocity или кнопка «Город»).');
  }

  const apiKey = settings.weatherApiKey;
  if (!apiKey) {
    throw new Error('Не задан OpenWeatherMap API key (profileBio.weatherApiKey).');
  }

  const weather = await fetchWeatherText(city, apiKey);
  const { resolveCity } = require('./weather');
  const geo = await resolveCity(city, apiKey);
  const parts = getDateParts(new Date(), geo.timezone);
  let text = applyTemplate(template, { ...parts, weather });

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
