const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const APP_NAME = 'max-tg';

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true, cwd: ROOT });
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

function setupPm2(options = {}) {
  if (!fs.existsSync(path.join(ROOT, 'src', 'monitor.js'))) {
    throw new Error('Папка src/ не найдена. Залейте полный проект на сервер.');
  }

  if (
    !options.skipSessionCheck &&
    !fs.existsSync(path.join(ROOT, 'max_user_data', 'Default'))
  ) {
    throw new Error(
      'Нет сессии MAX. Выполните: bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)'
    );
  }

  console.log('Проверка зависимостей...');
  run('node scripts/ensure-deps.js');

  if (!commandExists('pm2')) {
    console.log('Установка PM2...');
    run('npm install -g pm2');
  }

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

  try {
    run(`pm2 delete ${APP_NAME} max-tg-update`);
  } catch {
    /* first run */
  }

  run('pm2 start scripts/ecosystem.config.cjs');
  run('pm2 save');

  console.log('\nАвтозапуск после перезагрузки VPS...');
  try {
    const user = process.env.USER || process.env.LOGNAME || 'root';
    const home = process.env.HOME || '/root';
    const out = execSync(`pm2 startup systemd -u ${user} --hp ${home}`, {
      encoding: 'utf8',
      shell: true,
      cwd: ROOT,
    });
    const sudoLine = out.split('\n').find((line) => line.includes('sudo env'));
    if (sudoLine) {
      console.log('Выполните эту команду один раз:');
      console.log(sudoLine.trim());
    }
  } catch {
    console.log('Не удалось настроить автозапуск. Выполните: pm2 startup');
  }

  run('pm2 status');
  console.log('\nБот работает 24/7.');
  console.log(`  Логи:      pm2 logs ${APP_NAME}`);
  console.log(`  Рестарт:   pm2 restart ${APP_NAME}`);
  console.log('  Обновления: pm2 logs max-tg-update (проверка git каждую минуту)');
}

module.exports = { setupPm2 };
