const geoCache = new Map();
const weatherCache = new Map();

const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const WEATHER_TTL_MS = 10 * 60 * 1000;

const WMO_LABELS = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'туман',
  51: 'морось',
  53: 'морось',
  55: 'морось',
  61: 'дождь',
  63: 'дождь',
  65: 'ливень',
  71: 'снег',
  73: 'снег',
  75: 'снег',
  80: 'ливень',
  81: 'ливень',
  82: 'ливень',
  95: 'гроза',
  96: 'гроза',
  99: 'гроза',
};

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || data?.reason || `HTTP ${response.status}`);
  }
  return data;
}

async function resolveCity(city, apiKey = '') {
  const key = String(city || '').trim().toLowerCase();
  if (!key) throw new Error('Город не задан');

  const cached = geoCache.get(key);
  if (cached && cached.expires > Date.now()) return cached;

  const meteoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru`;
  const meteoData = await fetchJson(meteoUrl);
  const place = meteoData.results?.[0];
  if (!place) throw new Error(`Город не найден: ${city}`);

  let lat = place.latitude;
  let lon = place.longitude;

  if (apiKey) {
    try {
      const owmUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${apiKey}`;
      const owmData = await fetchJson(owmUrl);
      const owmPlace = Array.isArray(owmData) ? owmData[0] : null;
      if (owmPlace) {
        lat = owmPlace.lat;
        lon = owmPlace.lon;
      }
    } catch {
      /* координаты open-meteo достаточно точны */
    }
  }

  const result = {
    city: place.name,
    lat,
    lon,
    timezone: place.timezone,
    expires: Date.now() + GEO_TTL_MS,
  };

  geoCache.set(key, result);
  return result;
}

function formatTemperature(temp) {
  const rounded = Math.round(Number(temp) || 0);
  const sign = rounded > 0 ? `+${rounded}` : String(rounded);
  return `${sign}°C`;
}

function weatherParts(temperature, condition) {
  const temp = formatTemperature(temperature);
  const desc = String(condition || 'нет данных').trim() || 'нет данных';
  return {
    temperature: temp,
    condition: desc,
    text: `${temp}, ${desc}`,
  };
}

async function fetchWeatherFromMeteo(geo) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&current=temperature_2m,weather_code&timezone=${encodeURIComponent(geo.timezone)}`;

  const data = await fetchJson(url);
  const code = data.current?.weather_code ?? -1;
  return weatherParts(data.current?.temperature_2m ?? 0, WMO_LABELS[code] || 'нет данных');
}

async function fetchWeatherFromOwm(geo, apiKey) {
  const url =
    `https://api.openweathermap.org/data/2.5/weather?lat=${geo.lat}&lon=${geo.lon}` +
    `&appid=${apiKey}&units=metric&lang=ru`;

  const data = await fetchJson(url);
  if (data.cod && Number(data.cod) >= 400) {
    throw new Error(data.message || 'Ошибка OpenWeatherMap');
  }

  return weatherParts(data.main?.temp ?? 0, data.weather?.[0]?.description || 'нет данных');
}

async function fetchWeatherParts(city, apiKey = '') {
  const key = String(city || '').trim().toLowerCase();
  if (!key) throw new Error('Город не задан');

  const cached = weatherCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.parts;

  const geo = await resolveCity(city, apiKey);
  let parts;

  if (apiKey) {
    try {
      parts = await fetchWeatherFromOwm(geo, apiKey);
    } catch (err) {
      console.warn(`OpenWeatherMap: ${err.message}, используем open-meteo`);
      parts = await fetchWeatherFromMeteo(geo);
    }
  } else {
    parts = await fetchWeatherFromMeteo(geo);
  }

  weatherCache.set(key, { parts, expires: Date.now() + WEATHER_TTL_MS });
  return parts;
}

async function fetchWeatherText(city, apiKey = '') {
  const parts = await fetchWeatherParts(city, apiKey);
  return parts.text;
}

module.exports = {
  resolveCity,
  fetchWeatherText,
  fetchWeatherParts,
};
