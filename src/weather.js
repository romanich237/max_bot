const geoCache = new Map();
const weatherCache = new Map();

const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const WEATHER_TTL_MS = 10 * 60 * 1000;

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || data?.reason || `HTTP ${response.status}`);
  }
  return data;
}

async function resolveCity(city, apiKey) {
  const key = String(city || '').trim().toLowerCase();
  if (!key) throw new Error('Город не задан');

  const cached = geoCache.get(key);
  if (cached && cached.expires > Date.now()) return cached;

  const meteoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru`;
  const meteoData = await fetchJson(meteoUrl);
  const place = meteoData.results?.[0];
  if (!place) throw new Error(`Город не найден: ${city}`);

  const owmUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${apiKey}`;
  const owmData = await fetchJson(owmUrl);
  const owmPlace = Array.isArray(owmData) ? owmData[0] : null;
  if (!owmPlace) throw new Error(`Город не найден в OpenWeatherMap: ${city}`);

  const result = {
    city: place.name,
    lat: owmPlace.lat,
    lon: owmPlace.lon,
    timezone: place.timezone,
    expires: Date.now() + GEO_TTL_MS,
  };

  geoCache.set(key, result);
  return result;
}

async function fetchWeatherText(city, apiKey) {
  const key = String(city || '').trim().toLowerCase();
  if (!key) throw new Error('Город не задан');
  if (!apiKey) throw new Error('Не задан OpenWeatherMap API key');

  const cached = weatherCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.text;

  const geo = await resolveCity(city, apiKey);
  const url =
    `https://api.openweathermap.org/data/2.5/weather?lat=${geo.lat}&lon=${geo.lon}` +
    `&appid=${apiKey}&units=metric&lang=ru`;

  const data = await fetchJson(url);
  if (data.cod && Number(data.cod) >= 400) {
    throw new Error(data.message || 'Ошибка OpenWeatherMap');
  }

  const temp = Math.round(data.main?.temp ?? 0);
  const sign = temp > 0 ? `+${temp}` : String(temp);
  const desc = data.weather?.[0]?.description || 'нет данных';
  const text = `${sign}°C, ${desc}`;

  weatherCache.set(key, { text, expires: Date.now() + WEATHER_TTL_MS });
  return text;
}

module.exports = {
  resolveCity,
  fetchWeatherText,
};
