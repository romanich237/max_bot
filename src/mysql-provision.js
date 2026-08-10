const crypto = require('crypto');
const { execSync } = require('child_process');

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

function randomToken(length = 8) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function isConfigured(db = {}) {
  return Boolean(db.host && db.user && db.password && db.database);
}

function saveDatabaseConfig(store, credentials) {
  store.setPath(['database', 'enabled'], true);
  store.setPath(['database', 'driver'], 'mysql');
  store.setPath(['database', 'host'], credentials.host);
  store.setPath(['database', 'port'], credentials.port);
  store.setPath(['database', 'user'], credentials.user);
  store.setPath(['database', 'password'], credentials.password);
  store.setPath(['database', 'database'], credentials.database);
}

function applyDatabaseFromEnv(store) {
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const database = process.env.MYSQL_DATABASE;
  if (!host || !user || !database) return null;

  const credentials = {
    enabled: true,
    host,
    port: Number.parseInt(process.env.MYSQL_PORT || '3306', 10),
    user,
    password: process.env.MYSQL_PASSWORD || '',
    database,
  };
  saveDatabaseConfig(store, credentials);
  return credentials;
}

function ensureMariaDbInstalled() {
  if (commandExists('mysql') || commandExists('mariadb')) {
    try {
      execSync('sudo systemctl start mariadb || sudo systemctl start mysql', {
        stdio: 'ignore',
        shell: true,
      });
    } catch {
      // service name may differ
    }
    return;
  }

  if (process.platform !== 'linux') {
    throw new Error('Автоустановка MySQL доступна только на Linux VPS');
  }

  console.log('Установка MariaDB...');
  execSync('sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq', {
    stdio: 'inherit',
    shell: true,
  });
  execSync(
    'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mariadb-server',
    { stdio: 'inherit', shell: true }
  );
  execSync('sudo systemctl enable mariadb || sudo systemctl enable mysql', {
    stdio: 'inherit',
    shell: true,
  });
  execSync('sudo systemctl start mariadb || sudo systemctl start mysql', {
    stdio: 'inherit',
    shell: true,
  });
}

function runRootSql(script) {
  execSync('sudo mysql', {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: true,
  });
}

function formatDatabaseTelegramMessage(credentials) {
  return [
    '<b>MySQL создана автоматически</b>',
    '',
    `Хост: <code>${credentials.host}:${credentials.port}</code>`,
    `База: <code>${credentials.database}</code>`,
    `Пользователь: <code>${credentials.user}</code>`,
    `Пароль: <code>${credentials.password}</code>`,
    '',
    'Данные сохранены в <code>config.json</code> на сервере.',
  ].join('\n');
}

async function provisionLocalDatabase(store) {
  const existing = store.getPath(['database']) || {};
  if (isConfigured(existing)) {
    console.log(`MySQL уже настроена: ${existing.host}/${existing.database}`);
    return existing;
  }

  const fromEnv = applyDatabaseFromEnv(store);
  if (fromEnv) {
    console.log(`MySQL из переменных окружения: ${fromEnv.host}/${fromEnv.database}`);
    return fromEnv;
  }

  ensureMariaDbInstalled();

  const credentials = {
    enabled: true,
    host: '127.0.0.1',
    port: 3306,
    user: `max_u_${randomToken(6)}`,
    password: randomToken(16),
    database: `max_bot_${randomToken(6)}`,
  };

  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${credentials.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${credentials.user}'@'localhost' IDENTIFIED BY '${credentials.password}';`,
    `ALTER USER '${credentials.user}'@'localhost' IDENTIFIED BY '${credentials.password}';`,
    `GRANT ALL PRIVILEGES ON \`${credentials.database}\`.* TO '${credentials.user}'@'localhost';`,
    'FLUSH PRIVILEGES;',
  ].join('\n');

  runRootSql(sql);
  saveDatabaseConfig(store, credentials);

  console.log(`MySQL создана: ${credentials.database} (user: ${credentials.user})`);
  return credentials;
}

module.exports = {
  provisionLocalDatabase,
  formatDatabaseTelegramMessage,
  isConfigured,
  saveDatabaseConfig,
};
