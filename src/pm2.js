const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const APP_NAME = 'max-tg';
const UPDATE_APP_NAME = 'max-tg-update';

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

function loadPm2Module() {
  try {
    return require('pm2');
  } catch {
    const candidates = [];

    try {
      const globalRoot = execSync('npm root -g', {
        encoding: 'utf8',
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ROOT,
      }).trim();
      candidates.push(path.join(globalRoot, 'pm2'));
    } catch {
      /* ignore */
    }

    const home = process.env.HOME || '/root';
    candidates.push(path.join(home, '.npm-global/lib/node_modules/pm2'));

    for (const candidate of candidates) {
      try {
        return require(candidate);
      } catch {
        /* try next */
      }
    }

    throw new Error('PM2 не найден. Выполните: npm install -g pm2');
  }
}

function resolvePm2Bin() {
  if (process.env.PM2_BIN && fs.existsSync(process.env.PM2_BIN)) {
    return process.env.PM2_BIN;
  }

  const home = process.env.HOME || '/root';
  const enrichedPath = [
    process.env.PATH,
    '/usr/local/bin',
    '/usr/bin',
    path.join(home, '.nvm/versions/node', process.versions.node, 'bin'),
    path.join(home, '.npm-global/bin'),
  ]
    .filter(Boolean)
    .join(':');

  try {
    const found = execSync('command -v pm2', {
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, PATH: enrichedPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (found) return found;
  } catch {
    /* ignore */
  }

  throw new Error('pm2 не найден в PATH');
}

function restartPm2AppViaApi(name) {
  const pm2 = loadPm2Module();

  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);

      pm2.describe(name, (describeErr, description) => {
        if (describeErr || !description?.length) {
          pm2.disconnect();
          reject(new Error(`Процесс PM2 «${name}» не найден`));
          return;
        }

        pm2.restart(name, (restartErr) => {
          pm2.disconnect();
          if (restartErr) reject(restartErr);
          else resolve();
        });
      });
    });
  });
}

function restartPm2AppViaCli(name) {
  const pm2Bin = resolvePm2Bin();
  execSync(`"${pm2Bin}" restart ${name}`, {
    stdio: 'inherit',
    shell: true,
    cwd: ROOT,
  });
}

function startPm2AppViaCli(name) {
  const pm2Bin = resolvePm2Bin();
  execSync(`"${pm2Bin}" start scripts/ecosystem.config.cjs --only ${name}`, {
    stdio: 'inherit',
    shell: true,
    cwd: ROOT,
  });
}

async function restartPm2App(name) {
  try {
    await restartPm2AppViaApi(name);
    console.log(`pm2: перезапущен ${name} (API)`);
    return;
  } catch (apiErr) {
    console.warn(`pm2 API (${name}):`, apiErr.message);
  }

  try {
    restartPm2AppViaCli(name);
    console.log(`pm2: перезапущен ${name} (CLI)`);
    return;
  } catch (cliErr) {
    if (/не найден|not found/i.test(cliErr.message)) {
      startPm2AppViaCli(name);
      console.log(`pm2: запущен ${name}`);
      return;
    }
    throw cliErr;
  }
}

async function restartPm2Apps(names = [APP_NAME]) {
  const unique = [...new Set(names)];
  const errors = [];

  for (const name of unique) {
    try {
      await restartPm2App(name);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (errors.length) {
    throw new Error(errors.join('; '));
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

module.exports = {
  setupPm2,
  restartPm2App,
  restartPm2Apps,
  APP_NAME,
  UPDATE_APP_NAME,
};
