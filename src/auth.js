const readline = require('readline');
const { chromium } = require('playwright');
const { getMax, getSettings } = require('./config');

function waitForEnter(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function runAuth() {
  const { userDataDir } = getSettings();
  const { chatUrl } = getMax();

  console.log('Запуск браузера для авторизации...');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    args: ['--start-maximized'],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n==================================================');
  console.log('Войдите в MAX (QR-код или номер телефона).');
  console.log(`После входа откройте чат: ${chatUrl}`);
  console.log('Когда чат загрузится и сообщения видны — нажмите Enter в терминале.');
  console.log('==================================================\n');

  await waitForEnter('Нажмите Enter, когда чат откроется и сообщения видны... ');

  await context.close();
  console.log('Сессия сохранена.');
  console.log('Локальный тест:  npm start');
  console.log('Для VPS:  npm run export-session → scp max_session.zip → npm run import-session');
}

module.exports = { runAuth };
