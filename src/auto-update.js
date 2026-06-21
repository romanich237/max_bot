const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, getAutoUpdate, getAdminChatIds, store } = require('./config');
const { sendMessage } = require('./tg-api');
const { buildEventMessage } = require('./tg-events');
const { UPDATES } = require('./bot-texts');
const {
  schedulePm2Restarts,
  APP_NAME,
  UPDATE_APP_NAME,
} = require('./pm2');

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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function formatUpdateError(err) {
  const message = String(err?.message || err || 'неизвестная ошибка');
  const lines = [escapeHtml(message)];

  if (/pm2|restart/i.test(message)) {
    lines.push(
      '',
      'Код на диске уже мог обновиться. Перезапустите вручную:',
      '<code>pm2 restart max-tg max-tg-update</code>',
      'или:',
      '<code>cd ~/max-tg && npm run pm2</code>'
    );
  } else {
    lines.push(
      '',
      'Попробуйте вручную:',
      '<code>cd ~/max-tg && git pull --ff-only && npm install --omit=dev && pm2 restart max-tg max-tg-update</code>'
    );
  }

  return lines;
}

async function applyUpdate(fromSha, toSha, notify) {
  run(`git pull --ff-only origin ${getAutoUpdate().branch}`);
  run('npm install --omit=dev --ignore-scripts');

  schedulePm2Restarts([APP_NAME, UPDATE_APP_NAME], {
    delayMs: 2000,
    staggerMs: 5000,
  });

  if (notify) {
    await notifyAdmins(
      buildEventMessage({
        ...UPDATES.done(fromSha, toSha),
        status: 'done',
      })
    );
  }

  console.log('auto-update: код обновлён, перезапуск PM2 запланирован');
  return { status: 'updated', fromSha, toSha };
}

async function checkForUpdates(options = {}) {
  const notify = options.notify !== false;
  const performUpdate = options.performUpdate !== false;

  store.reload();
  const cfg = getAutoUpdate();

  if (!isGitRepo()) {
    return { status: 'unavailable', reason: 'not-git' };
  }

  try {
    runQuiet(`git fetch origin ${cfg.branch}`);

    const local = runQuiet('git rev-parse HEAD');
    const remote = runQuiet(`git rev-parse origin/${cfg.branch}`);

    if (!remote) {
      return { status: 'error', message: `Ветка origin/${cfg.branch} не найдена` };
    }

    if (local === remote) {
      console.log(`auto-update: актуально (${local.slice(0, 7)})`);
      return { status: 'up-to-date', sha: local.slice(0, 7) };
    }

    if (hasLocalChanges()) {
      console.error('auto-update: есть локальные изменения, обновление пропущено');
      if (notify) {
        await notifyAdmins(buildEventMessage({ ...UPDATES.skipped, status: 'fail' }));
      }
      return { status: 'skipped', reason: 'local-changes' };
    }

    const fromSha = local.slice(0, 7);
    const toSha = remote.slice(0, 7);

    if (!performUpdate) {
      return { status: 'available', fromSha, toSha };
    }

    console.log(`auto-update: обновление ${fromSha} → ${toSha}`);

    if (notify) {
      await notifyAdmins(
        buildEventMessage({
          ...UPDATES.updating(fromSha, toSha),
          status: 'progress',
        })
      );
    }

    return await applyUpdate(fromSha, toSha, notify);
  } catch (err) {
    console.error('auto-update: ошибка —', err.message);
    if (notify) {
      await notifyAdmins(
        buildEventMessage({
          ...UPDATES.fail(formatUpdateError(err).join('\n')),
          status: 'fail',
        })
      );
    }
    return { status: 'error', message: err.message };
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
      await checkForUpdates();
    } catch (err) {
      console.error('auto-update:', err.message);
    }

    store.reload();
    const next = getAutoUpdate();
    setTimeout(tick, next.intervalMs);
  };

  tick();
}

module.exports = {
  checkForUpdates,
  scheduleAutoUpdate,
};
