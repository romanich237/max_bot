const fs = require('fs');
const path = require('path');
const { ROOT, store } = require('../config');
const { checkTelegramConnectivity } = require('../tg-api');
const { deleteWebhook } = require('../tg-api');
const { registerBotCommands } = require('../tg-admin');
const { isMaxChatUrl } = require('../setup-wizard');
const { parseNameList, saveProfileNames } = require('../tg-settings');
const { runAuthOnPage, PHONE_AUTH_WARNING_SHORT } = require('../auth-qr');
const { launchMaxContext } = require('../browser-context');
const { captureLoginScreenshot } = require('../auth-qr');
const { provisionDatabase } = require('../database-provision');
const { setupPm2 } = require('../pm2');
const { resolveServerPublicIp, buildPortalUrl } = require('../server-ip');
const { getAdminChatIds } = require('../config');
const { sendMessage } = require('../tg-api');
const {
  createPortalState,
  setStep,
  setScreenshot,
  waitForWebChoice,
  DEFAULT_PORT,
} = require('./state');
const { startSetupServer, getSetupUrls } = require('./server');

let activePortalState = null;

function getActivePortalState() {
  return activePortalState;
}

async function chooseAuthModeWeb(state) {
  setStep(state, 'auth', 'Выберите способ входа в MAX');
  return waitForWebChoice(state, {
    label: 'Выберите способ входа в MAX',
    choices: ['qr', 'phone'],
    timeoutMs: 10 * 60 * 1000,
  });
}

async function runMaxAuth(state, mode) {
  const { getAdminChatIds } = require('../config');
  const chatIds = getAdminChatIds();
  const context = await launchMaxContext(
    path.join(ROOT, 'max_user_data'),
    { headless: true, deviceScaleFactor: 2 }
  );

  let screenshotTimer = null;

  try {
    const page = context.pages()[0] || (await context.newPage());

    screenshotTimer = setInterval(async () => {
      try {
        if (page.isClosed()) return;
        const buffer = await captureLoginScreenshot(page);
        const caption =
          mode === 'qr'
            ? 'Сканируйте QR в приложении MAX'
            : state.waitingInput?.label?.includes('SMS')
              ? 'Капча и экран SMS на MAX'
              : 'Страница входа MAX';
        setScreenshot(state, buffer, caption);
      } catch {
        /* page navigating */
      }
    }, 3000);

    setStep(
      state,
      'auth',
      mode === 'phone' ? `Вход по номеру телефона. ${PHONE_AUTH_WARNING_SHORT}` : 'Вход по QR-коду'
    );

    await runAuthOnPage(page, chatIds, {
      mode,
      useWebPoll: true,
      introMessage: false,
      useAuthCallbackPoll: mode === 'qr',
    });
  } finally {
    if (screenshotTimer) clearInterval(screenshotTimer);
    await context.close().catch(() => {});
  }
}

async function finishSetup(state, options = {}) {
  setStep(state, 'finishing', 'Запуск бота...');

  const { execSync } = require('child_process');
  if (store.getPath(['database', 'enabled'])) {
    try {
      execSync('node scripts/init-db.js', { stdio: 'inherit', cwd: ROOT, shell: true });
    } catch {
      console.warn('init-db пропущен');
    }
  }

  setupPm2({ skipSessionCheck: true });

  state.done = true;
  state.success = true;
  setStep(state, 'done', 'Бот запущен');
}

async function runWebSetup(options = {}) {
  const state = createPortalState(options.token);
  activePortalState = state;

  const existingToken = store.getPath(['telegram', 'token']);
  const existingChatIds = store.getPath(['telegram', 'chatIds']) || [];
  if (existingToken && existingChatIds.length) {
    try {
      const data = await checkTelegramConnectivity(existingToken);
      state.botUsername = data.result?.username || '';
      setStep(state, 'max', 'Заполните настройки MAX');
    } catch (err) {
      setStep(state, 'telegram', 'Проверьте данные Telegram: ' + err.message);
    }
  }

  let authPromise = null;

  const handlers = {
    async saveTelegram(body) {
      try {
        const token = String(body.token || '').trim();
        const chatId = String(body.chatId || '').trim();
        if (!token || !chatId) {
          return { ok: false, error: 'Укажите token и chat ID' };
        }

        store.setPath(['telegram', 'token'], token);
        store.setPath(['telegram', 'chatIds'], [chatId]);
        store.setPath(['telegram', 'adminChatIds'], [chatId]);
        store.setPath(['setupComplete'], false);
        store.reload();

        const data = await checkTelegramConnectivity(token);
        state.botUsername = data.result?.username || '';
        setStep(state, 'max', 'Заполните настройки MAX');
        return { ok: true, botUsername: state.botUsername };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async saveMax(body) {
      try {
        const chatUrl = String(body.chatUrl || '').trim();
        if (!isMaxChatUrl(chatUrl)) {
          return { ok: false, error: 'Неверная ссылка на чат MAX' };
        }

        store.setPath(['max', 'chatUrl'], chatUrl);
        if (body.browserPassword) {
          store.setPath(['max', 'browserPassword'], String(body.browserPassword));
        }
        store.setPath(['profileRotate', 'enabled'], Boolean(body.profileRotate));
        store.setPath(['alwaysOnline', 'enabled'], Boolean(body.alwaysOnline));
        store.setPath(['autoUpdate', 'enabled'], true);

        if (body.profileNames) {
          const names = parseNameList(String(body.profileNames));
          if (names.length) saveProfileNames(names);
        }

        store.setPath(['setupComplete'], false);
        setStep(state, 'auth', 'Выберите способ входа в MAX');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async startAuth(mode) {
      try {
        const authMode = String(mode || '').trim();
        if (!['qr', 'phone'].includes(authMode)) {
          return { ok: false, error: 'Выберите qr или phone' };
        }
        if (authPromise) {
          return { ok: false, error: 'Авторизация уже идёт' };
        }

        authPromise = (async () => {
          try {
            await deleteWebhook();
            await registerBotCommands();
            await provisionDatabase(store, { driver: process.env.DB_DRIVER });
            await runMaxAuth(state, authMode);
            store.setPath(['setupComplete'], true);
            store.setPath(['max', 'monitoringEnabled'], true);
            await finishSetup(state, options);
          } catch (err) {
            state.error = err.message;
            authPromise = null;
            setStep(state, 'auth', 'Ошибка: ' + err.message);
            throw err;
          }
        })();

        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };

  const publicIp = await resolveServerPublicIp();
  const portal = await startSetupServer(state, handlers, {
    port: options.port || Number(process.env.SETUP_PORT) || DEFAULT_PORT,
    host: options.host || '0.0.0.0',
    publicIp,
  });

  const useSsl = portal.ssl;
  const primaryUrl = buildPortalUrl(publicIp, portal.port, 'setup', state.token, { ssl: useSsl });
  const urls = getSetupUrls(portal.port, state.token, publicIp, useSsl);

  console.log('\n=== Веб-настройка MAX → Telegram ===\n');
  console.log('  ' + primaryUrl);
  for (const url of urls) {
    if (url !== primaryUrl) console.log('  ' + url);
  }
  console.log('\nСсылка также отправлена в Telegram.');
  console.log('Страница доступна только во время установки.\n');

  for (const chatId of getAdminChatIds()) {
    try {
      await sendMessage(
        chatId,
        [
          '<b>Настройка MAX → Telegram</b>',
          '',
          useSsl
            ? 'Откройте ссылку (временный HTTPS, браузер может предупредить о сертификате):'
            : 'Откройте ссылку и заполните настройки MAX (чат, вход):',
          '',
          `<a href="${primaryUrl}">${primaryUrl}</a>`,
          `<code>${primaryUrl}</code>`,
        ].join('\n'),
        { disable_web_page_preview: false }
      );
    } catch (err) {
      console.warn(`Не удалось отправить ссылку в Telegram (${chatId}): ${err.message}`);
    }
  }

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'data', 'setup-portal.json'),
    JSON.stringify(
      { token: state.token, port: portal.port, publicIp, primaryUrl, urls, createdAt: new Date().toISOString() },
      null,
      2
    )
  );

  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (state.done && state.success) {
        clearInterval(check);
        portal.close().then(() => {
          activePortalState = null;
          resolve({ token: state.token, botUsername: state.botUsername });
        });
      }
      if (state.error && state.step === 'auth' && !authPromise) {
        /* user can retry */
      }
    }, 1000);

    state._rejectSetup = (err) => {
      clearInterval(check);
      portal.close().finally(() => {
        activePortalState = null;
        reject(err);
      });
    };
  });
}

module.exports = {
  runWebSetup,
  getActivePortalState,
  chooseAuthModeWeb,
  DEFAULT_PORT,
};
