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

async function fetchWeatherFromMeteo(geo) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&current=temperature_2m,weather_code&timezone=${encodeURIComponent(geo.timezone)}`;

  const data = await fetchJson(url);
  const temp = Math.round(data.current?.temperature_2m ?? 0);
  const sign = temp > 0 ? `+${temp}` : String(temp);
  const code = data.current?.weather_code ?? -1;
  const desc = WMO_LABELS[code] || 'нет данных';
  return `${sign}°C, ${desc}`;
}

async function fetchWeatherFromOwm(geo, apiKey) {
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
  return `${sign}°C, ${desc}`;
}

async function fetchWeatherText(city, apiKey = '') {
  const key = String(city || '').trim().toLowerCase();
  if (!key) throw new Error('Город не задан');

  const cached = weatherCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.text;

  const geo = await resolveCity(city, apiKey);
  let text = '';

  if (apiKey) {
    try {
      text = await fetchWeatherFromOwm(geo, apiKey);
    } catch (err) {
      console.warn(`OpenWeatherMap: ${err.message}, используем open-meteo`);
      text = await fetchWeatherFromMeteo(geo);
    }
  } else {
    text = await fetchWeatherFromMeteo(geo);
  }

  weatherCache.set(key, { text, expires: Date.now() + WEATHER_TTL_MS });
  return text;
}

module.exports = {
  resolveCity,
  fetchWeatherText,
};
