const { getStories, store } = require('./config');
const { BUTTONS, withOnOffEmoji } = require('./bot-texts');

const STORY_INTERVALS = [
  { ms: 15 * 60 * 1000, label: '15 мин' },
  { ms: 30 * 60 * 1000, label: '30 мин' },
  { ms: 60 * 60 * 1000, label: '1 ч' },
  { ms: 3 * 60 * 60 * 1000, label: '3 ч' },
];

function formatInterval(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} мин`;
  const hours = Math.round(min / 60);
  return hours === 1 ? '1 ч' : `${hours} ч`;
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec} с` : `${Math.round(sec / 60)} мин`;
}

function buildStoriesToggleButton(key, label, on) {
  return withOnOffEmoji(
    {
      text: label,
      callback_data: `stories:toggle:${key}`,
      style: on ? 'success' : 'danger',
    },
    on
  );
}

function buildStoriesIntervalButton(preset, currentMs) {
  const active = preset.ms === currentMs;
  return {
    text: active ? `✓ ${preset.label}` : preset.label,
    callback_data: `stories:interval:${preset.ms}`,
  };
}

function buildStoriesMenuText() {
  const settings = getStories();
  const lines = [
    '<b>Истории</b>',
    '',
    'Автопросмотр историй MAX и лайк сердцем внизу просмотрщика.',
    '',
    `Просмотр: <b>${settings.enabled ? 'вкл' : 'выкл'}</b>`,
    `Автолайк: <b>${settings.autoLike ? 'вкл' : 'выкл'}</b>`,
    `Интервал: <b>${formatInterval(settings.intervalMs)}</b>`,
    `Время на слайд: <b>${formatDuration(settings.storyDurationMs)}</b>`,
    `За проход: до <b>${settings.maxPacksPerRun}</b> авторов`,
  ];
  return lines.join('\n');
}

function buildStoriesKeyboard() {
  const settings = getStories();
  const rows = [
    [buildStoriesToggleButton('enabled', 'Просмотр', settings.enabled)],
    [buildStoriesToggleButton('autoLike', 'Автолайк', settings.autoLike)],
    STORY_INTERVALS.slice(0, 2).map((preset) => buildStoriesIntervalButton(preset, settings.intervalMs)),
    STORY_INTERVALS.slice(2).map((preset) => buildStoriesIntervalButton(preset, settings.intervalMs)),
    [{ text: BUTTONS.backToMenu, callback_data: 'discover:menu' }],
  ];
  return { inline_keyboard: rows };
}

function toggleStoriesSetting(key) {
  if (key === 'enabled') {
    store.setPath(['stories', 'enabled'], !getStories().enabled);
    return getStories().enabled;
  }
  if (key === 'autoLike') {
    store.setPath(['stories', 'autoLike'], !getStories().autoLike);
    return getStories().autoLike;
  }
  return null;
}

function setStoriesInterval(intervalMs) {
  const value = Number(intervalMs);
  if (!Number.isFinite(value) || value < 60000) return false;
  store.setPath(['stories', 'intervalMs'], value);
  return true;
}

module.exports = {
  STORY_INTERVALS,
  buildStoriesMenuText,
  buildStoriesKeyboard,
  toggleStoriesSetting,
  setStoriesInterval,
};
