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

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function collectTelegramCredentials(config) {
  const token = process.env.TG_TOKEN || (await ask('Telegram bot token: '));
  const chatId = process.env.TG_CHAT_ID || (await ask('Ваш Telegram chat ID: '));

  if (!token || !chatId) {
    throw new Error('Token и chat ID обязательны (или задайте TG_TOKEN и TG_CHAT_ID)');
  }

  config.telegram = config.telegram || {};
  config.telegram.token = token;
  config.telegram.chatIds = [String(chatId)];
  config.setupComplete = false;
  saveConfig(config);

  console.log('Telegram настройки сохранены в config.json');
}

function ensureDirs() {
  for (const dir of ['logs', 'data', 'max_user_data']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
}

async function main() {
  console.log('=== Установка MAX → Telegram ===\n');

  checkNode();
  ensureConfigFile();
  const config = loadConfig();
  await collectTelegramCredentials(config);

  run('npm install --omit=dev --ignore-scripts');
  run('npx playwright install chromium');

  try {
    run('npx playwright install-deps chromium');
  } catch {
    console.log('playwright install-deps пропущен (не критично)');
  }

  ensureDirs();

  const { deleteWebhook, sendMessage } = require('../src/tg-api');
  const { registerBotCommands } = require('../src/tg-admin');
  const { runAuthQrTelegram } = require('../src/auth-qr');
  const { runSetupWizard } = require('../src/setup-wizard');
  const { setupPm2 } = require('../src/pm2');
  const {
    provisionLocalDatabase,
    formatDatabaseTelegramMessage,
  } = require('../src/mysql-provision');
  const store = require('../src/settings-store');

  store.reload();

  console.log('\n--- Установка базы данных ---\n');
  const dbCredentials = await provisionLocalDatabase(store);
  const adminChatIds = store.getPath(['telegram', 'chatIds']) || [];
  for (const chatId of adminChatIds) {
    await sendMessage(chatId, formatDatabaseTelegramMessage(dbCredentials));
  }

  console.log('\nПродолжите настройку в Telegram\n');
  await deleteWebhook();
  await registerBotCommands();
  await runAuthQrTelegram({
    introMessage: 'Продолжите настройку в Telegram.',
    useAuthCallbackPoll: true,
  });

  console.log('\n--- Настройка бота в Telegram ---\n');
  await runSetupWizard();

  const fresh = loadConfig();
  if (fresh.database?.enabled) {
    try {
      run('node scripts/init-db.js');
    } catch {
      console.log('init-db пропущен (проверьте database в config.json)');
    }
  }

  console.log('\n--- Запуск PM2 ---\n');
  setupPm2({ skipSessionCheck: true });

  console.log('\nГотово! Бот запущен 24/7.');
  console.log('В Telegram отправьте боту: /menu');
}

main().catch((err) => {
  console.error('\nОшибка установки:', err.message);
  process.exit(1);
});
