let offset = 0;
let running = false;
let stopped = false;
let timer = null;
let tokenOverride = null;
let allowedUpdates = ['message', 'callback_query', 'my_chat_member'];
let defaultOnError = null;
const subscribers = new Map();
let nextId = 1;

function getApi() {
  return require('./tg-api').api;
}

function isRunning() {
  return running && !stopped;
}

function mergeAllowedUpdates() {
  const merged = new Set(allowedUpdates);
  for (const sub of subscribers.values()) {
    for (const type of sub.allowedUpdates || []) {
      merged.add(type);
    }
  }
  return [...merged];
}

async function dispatch(update) {
  const list = [...subscribers.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const sub of list) {
    try {
      const handled = await sub.handler(update);
      if (handled === true) return;
    } catch (err) {
      const reporter = sub.onError || defaultOnError;
      reporter?.(err);
    }
  }
}

async function tick() {
  if (stopped) return;

  try {
    const data = await getApi()(
      'getUpdates',
      {
        offset,
        timeout: 25,
        allowed_updates: mergeAllowedUpdates(),
      },
      tokenOverride
    );

    if (!data.ok) {
      const err = new Error(data.description || 'getUpdates failed');
      if (data.error_code === 409) {
        err.isConflict = true;
      }
      throw err;
    }

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      await dispatch(update);
    }
  } catch (err) {
    if (err.isConflict || /409|Conflict/i.test(err.message)) {
      console.error(
        'Telegram getUpdates: конфликт — уже идёт другой polling. ' +
          'Проверьте: pm2 list (должен быть один max-tg).'
      );
    }
    defaultOnError?.(err);
    const delay = err.isConflict || /409|Conflict/i.test(err.message) ? 3000 : 500;
    if (!stopped) {
      timer = setTimeout(tick, delay);
    }
    return;
  }

  if (!stopped) {
    timer = setTimeout(tick, 500);
  }
}

function ensureRunning(options = {}) {
  if (running) {
    if (options.token) tokenOverride = options.token;
    if (options.allowedUpdates?.length) {
      allowedUpdates = [...new Set([...allowedUpdates, ...options.allowedUpdates])];
    }
    if (options.onError) defaultOnError = options.onError;
    return;
  }

  running = true;
  stopped = false;
  tokenOverride = options.token || tokenOverride;
  allowedUpdates = options.allowedUpdates || allowedUpdates;
  defaultOnError = options.onError || defaultOnError;
  tick();
}

function subscribe(handler, options = {}) {
  const id = options.id || `sub-${nextId++}`;
  subscribers.set(id, {
    handler,
    priority: options.priority ?? 0,
    onError: options.onError,
    allowedUpdates: options.allowedUpdates,
  });

  ensureRunning(options);

  return () => {
    subscribers.delete(id);
    if (!subscribers.size) {
      stop();
    }
  };
}

function stop() {
  stopped = true;
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  subscribers.clear();
}

module.exports = {
  subscribe,
  isRunning,
  stop,
};
