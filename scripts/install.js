const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const configPath = path.join(root, 'config.json');
const examplePath = path.join(root, 'src', 'config.example.json');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true, cwd: root });
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function checkNode() {
  const version = process.version;
  const major = Number.parseInt(version.slice(1), 10);
  if (major < 18) {
    throw new Error(`Нужен Node.js 18+, сейчас: ${version}`);
  }
  console.log(`Node.js ${version}`);
}

function ensureConfigFile() {
  if (!fs.existsSync(configPath)) {
    if (!fs.existsSync(examplePath)) {
      throw new Error('Не найден config.example.json');
    }
    fs.copyFileSync(examplePath, configPath);
    console.log('Создан config.json из config.example.json');
  }
}

function ensureDirs() {
  for (const dir of ['logs', 'data', 'max_user_data']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  require('../src/settings-store').reload();
}

async function applyTelegramCredentials(config, token, chatId) {
  config.telegram = config.telegram || {};
  config.telegram.token = String(token).trim();
  config.telegram.chatIds = [String(chatId).trim()];
  config.setupComplete = false;
  saveConfig(config);
  console.log('Telegram настройки сохранены в config.json');
}

async function ensureTelegramCredentials() {
  const config = loadConfig();

  if (process.env.TG_TOKEN && process.env.TG_CHAT_ID) {
    console.log('\n--- Telegram ---');
    console.log('Используются TG_TOKEN и TG_CHAT_ID из окружения\n');
    await applyTelegramCredentials(config, process.env.TG_TOKEN, process.env.TG_CHAT_ID);
    return;
  }

  console.log('\n--- Telegram ---\n');
  const token = process.env.TG_TOKEN || (await ask('Telegram bot token: '));
  const chatId = process.env.TG_CHAT_ID || (await ask('Ваш Telegram chat ID: '));

  if (!token?.trim() || !chatId?.trim()) {
    throw new Error('Token и chat ID обязательны (или задайте TG_TOKEN и TG_CHAT_ID)');
  }

  await applyTelegramCredentials(config, token, chatId);
}

async function runTerminalSetup() {
  const store = require('../src/settings-store');

  const { checkTelegramConnectivity } = require('../src/tg-api');
  const { deleteWebhook, sendMessage } = require('../src/tg-api');
  const { registerBotCommands } = require('../src/tg-admin');
  const { runAuthTelegram } = require('../src/auth-qr');
  const { runSetupWizard } = require('../src/setup-wizard');
  const { setupPm2 } = require('../src/pm2');
  const { provisionLocalDatabase, formatDatabaseTelegramMessage } = require('../src/mysql-provision');
  const { buildEventMessage, buildPipeline } = require('../src/tg-events');

  store.reload();

  console.log('\nПроверка связи с Telegram API...');
  const data = await checkTelegramConnectivity();
  console.log(data.result?.username ? `Telegram API доступен (@${data.result.username})\n` : 'Telegram API доступен\n');

  console.log('\n--- Установка базы данных ---\n');
  const dbCredentials = await provisionLocalDatabase(store);
  const adminChatIds = store.getPath(['telegram', 'chatIds']) || [];
  for (const chatId of adminChatIds) {
    try {
      await sendMessage(chatId, formatDatabaseTelegramMessage(dbCredentials));
    } catch (err) {
      console.warn(`Не удалось отправить данные БД в Telegram (${chatId}): ${err.message}`);
    }
  }

  await deleteWebhook();
  await registerBotCommands();
  await runAuthTelegram({
    introMessage: buildEventMessage({
      title: 'Настройка MAX → Telegram',
      status: 'progress',
      step: 1,
      total: 5,
      lines: [
        'Всё в Telegram — без веб-страницы.',
        'Выберите вход: <b>QR-код</b> или <b>номер телефона</b>.',
        'Для QR пришлю скриншот; для телефона — запросы в чате.',
      ],
    }),
    useAuthCallbackPoll: true,
    sendQrPhotos: true,
    sendCaptchaPhotos: false,
    sendPasswordPhotos: true,
  });
  await runSetupWizard();

  if (store.getPath(['database', 'enabled'])) {
    try {
      run('node scripts/init-db.js');
    } catch {
      console.log('init-db пропущен');
    }
  }

  setupPm2({ skipSessionCheck: true });

  const botUsername = data.result?.username;
  for (const chatId of adminChatIds) {
    try {
      await sendMessage(
        chatId,
        [
          buildPipeline('Установка завершена', [
            { label: 'Telegram', status: 'done' },
            { label: 'База данных', status: 'done' },
            { label: 'Вход в MAX', status: 'done' },
            { label: 'Чат MAX', status: 'done' },
            { label: 'Настройки бота', status: 'done' },
            { label: 'Запуск PM2', status: 'done' },
          ]),
          '',
          buildEventMessage({
            title: 'Бот запущен',
            status: 'done',
            lines: [
              botUsername ? `Telegram: @${botUsername}` : null,
              'Отправьте /menu для управления.',
            ].filter(Boolean),
          }),
        ].join('\n')
      );
    } catch (err) {
      console.warn(`Не удалось отправить итог установки (${chatId}): ${err.message}`);
    }
  }
}

async function main() {
  console.log('=== Установка MAX → Telegram ===\n');

  checkNode();
  ensureConfigFile();
  ensureDirs();

  run('npm install --omit=dev --ignore-scripts');

  await ensureTelegramCredentials();

  const { checkTelegramConnectivity } = require('../src/tg-api');
  console.log('Проверка связи с Telegram API...');
  const tgCheck = await checkTelegramConnectivity();
  console.log(
    tgCheck.result?.username
      ? `Telegram API доступен (@${tgCheck.result.username})\n`
      : 'Telegram API доступен\n'
  );

  run('npx playwright install chromium');

  try {
    run('npx playwright install-deps chromium');
  } catch {
    console.log('playwright install-deps пропущен (не критично)');
  }

  const { openPortalPort } = require('../src/open-firewall-port');

  if (process.env.SETUP_WEB === '1') {
    openPortalPort();
    const { runWebSetup } = require('../src/setup-portal');
    const result = await runWebSetup({
      port: Number(process.env.SETUP_PORT) || undefined,
    });

    console.log('\nГотово! Бот запущен 24/7.');
    if (result.botUsername) {
      console.log(`Telegram: @${result.botUsername} → /menu`);
    }
    return;
  }

  await runTerminalSetup();
  console.log('\nГотово! Бот запущен 24/7.');
  console.log('В Telegram отправьте боту: /menu');
}

main().catch((err) => {
  console.error('\nОшибка установки:', err.message);
  if (/api\.telegram\.org|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(err.message)) {
    console.error(
      '\nСеть: curl -I https://api.telegram.org\n' +
        'Прокси: export HTTPS_PROXY=http://host:port && npm run setup'
    );
  }
  process.exit(1);
});
