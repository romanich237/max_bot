const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, getAutoUpdate, getAdminChatIds, store } = require('../src/config');
const { sendMessage } = require('../src/tg-api');
const { restartPm2Apps, restartPm2App, APP_NAME, UPDATE_APP_NAME } = require('../src/pm2');

function run(cmd, options = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    cwd: ROOT,
    shell: true,
    stdio: options.silent ? 'pipe' : 'inherit',
    ...options,
  });
}

function runQuiet(cmd) {
  return run(cmd, { silent: true })?.trim() || '';
}

function isGitRepo() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

function hasLocalChanges() {
  const status = runQuiet('git status --porcelain');
  return status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => !line.endsWith('config.json') && !line.includes(' package-lock.json'));
}

async function notifyAdmins(text) {
  const chatIds = getAdminChatIds();
  if (!chatIds.length) return;

  for (const chatId of chatIds) {
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      console.error(`auto-update: не удалось уведомить ${chatId}:`, err.message);
    }
  }
}

async function checkAndUpdate() {
  store.reload();
  const cfg = getAutoUpdate();

  if (!isGitRepo()) {
    console.log('auto-update: не git-репозиторий, пропуск');
    return false;
  }

  try {
    runQuiet(`git fetch origin ${cfg.branch}`);

    const local = runQuiet('git rev-parse HEAD');
    const remote = runQuiet(`git rev-parse origin/${cfg.branch}`);

    if (!remote) {
      console.error(`auto-update: не найдена ветка origin/${cfg.branch}`);
      return false;
    }

    if (local === remote) {
      console.log(`auto-update: актуально (${local.slice(0, 7)})`);
      return false;
    }

    if (hasLocalChanges()) {
      console.error('auto-update: есть локальные изменения, обновление пропущено');
      await notifyAdmins(
        '⚠️ <b>Автообновление пропущено</b>\nНа сервере есть локальные изменения в репозитории.'
      );
      return false;
    }

    const fromSha = local.slice(0, 7);
    const toSha = remote.slice(0, 7);
    console.log(`auto-update: обновление ${fromSha} → ${toSha}`);

    await notifyAdmins('🔄Вышла новая версия бота, обновляю сервер..');

    run(`git pull --ff-only origin ${cfg.branch}`);
    run('npm install --omit=dev --ignore-scripts');
    await restartPm2Apps([APP_NAME]);

    await notifyAdmins('✅ <b>Бот обновлён</b>\nСервер перезапущен с новой версией.');
    console.log('auto-update: бот перезапущен');

    void restartPm2App(UPDATE_APP_NAME).catch((err) => {
      console.warn(`auto-update: не удалось перезапустить ${UPDATE_APP_NAME}:`, err.message);
    });
    return true;
  } catch (err) {
    console.error('auto-update: ошибка —', err.message);
    await notifyAdmins(
      `⚠️ <b>Ошибка автообновления</b>\n<code>${err.message}</code>\n\nПопробуйте вручную:\n<code>cd ~/max-tg && git pull && npm install --omit=dev && npm run pm2</code>`
    );
    return false;
  }
}

function scheduleAutoUpdate() {
  store.reload();
  const { intervalMs } = getAutoUpdate();
  store.setPath(['autoUpdate', 'enabled'], true);

  const intervalLabel =
    intervalMs < 60000
      ? `каждые ${Math.round(intervalMs / 1000)} сек`
      : intervalMs % 60000 === 0 && intervalMs / 60000 === 1
        ? 'каждую минуту'
        : `каждые ${Math.round(intervalMs / 60000)} мин`;
  console.log(`auto-update: проверка репозитория ${intervalLabel}`);

  const tick = async () => {
    try {
      await checkAndUpdate();
    } catch (err) {
      console.error('auto-update:', err.message);
    }

    store.reload();
    const next = getAutoUpdate();
    setTimeout(tick, next.intervalMs);
  };

  tick();
}

scheduleAutoUpdate();
