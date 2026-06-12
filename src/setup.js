const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');
const { importSession } = require('./session');
const { setupPm2 } = require('./pm2');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true, cwd: ROOT });
}

function setupVps() {
  console.log('=== Установка MAX → Telegram на VPS ===');

  try {
    run('node -v');
  } catch {
    throw new Error('Node.js не найден. Установите Node 18+.');
  }

  run('npm install --omit=dev');

try {
  run('node scripts/init-db.js');
} catch {
  console.log('init-db пропущен (проверьте database в config.json)');
}
  run('npx playwright install chromium');

  try {
    run('npx playwright install-deps chromium');
  } catch {
    console.log('playwright install-deps пропущен (не критично)');
  }

  if (fs.existsSync(path.join(ROOT, 'max_session.zip'))) {
    importSession();
  } else {
    console.log('Внимание: max_session.zip не найден.');
    console.log('С ПК: npm run export-session → scp max_session.zip на сервер');
  }

  setupPm2();
}

module.exports = { setupVps };
