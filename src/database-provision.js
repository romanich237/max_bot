const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');
const {
  provisionLocalDatabase,
  isConfigured: isMysqlConfigured,
} = require('./mysql-provision');

const SQLITE_DEFAULT_FILE = './data/max.db';

function isSqliteConfigured(db = {}) {
  return db.driver === 'sqlite' && Boolean(db.file);
}

function resolveDriver(db = {}) {
  if (db.driver === 'sqlite' || db.driver === 'mysql') return db.driver;
  if (db.file) return 'sqlite';
  if (isMysqlConfigured(db)) return 'mysql';
  return null;
}

async function askDatabaseDriver(ask) {
  const fromEnv = String(process.env.DB_DRIVER || '').trim().toLowerCase();
  if (fromEnv === 'sqlite' || fromEnv === 'mysql') {
    return fromEnv;
  }

  console.log('База данных:');
  console.log('  1) MySQL (MariaDB) — рекомендуется для VPS');
  console.log('  2) SQLite — файл в папке data/, без отдельного сервера');
  const answer = await ask('Выберите [1]: ');
  if (answer === '2' || /^sqlite$/i.test(answer)) {
    return 'sqlite';
  }
  return 'mysql';
}

function provisionSqliteDatabase(store) {
  const file = SQLITE_DEFAULT_FILE;
  const absFile = path.resolve(ROOT, file);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });

  store.setPath(['database', 'enabled'], true);
  store.setPath(['database', 'driver'], 'sqlite');
  store.setPath(['database', 'file'], file);

  const credentials = {
    enabled: true,
    driver: 'sqlite',
    file,
    absFile,
  };

  console.log(`SQLite настроена: ${file}`);
  return credentials;
}

function formatDatabaseTelegramMessage(credentials) {
  if (credentials.driver === 'sqlite') {
    return [
      '<b>SQLite настроена</b>',
      '',
      `Файл: <code>${credentials.file}</code>`,
      '',
      'Данные сохранены в <code>config.json</code> на сервере.',
    ].join('\n');
  }

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

async function provisionDatabase(store, options = {}) {
  const existing = store.getPath(['database']) || {};
  const existingDriver = resolveDriver(existing);

  if (existingDriver === 'sqlite' && isSqliteConfigured(existing)) {
    console.log(`SQLite уже настроена: ${existing.file}`);
    return { ...existing, driver: 'sqlite' };
  }

  if (existingDriver === 'mysql' && isMysqlConfigured(existing)) {
    console.log(`MySQL уже настроена: ${existing.host}/${existing.database}`);
    return { ...existing, driver: 'mysql' };
  }

  const driver = options.driver || (await askDatabaseDriver(options.ask));

  if (driver === 'sqlite') {
    return provisionSqliteDatabase(store);
  }

  const credentials = await provisionLocalDatabase(store);
  return { ...credentials, driver: 'mysql' };
}

module.exports = {
  askDatabaseDriver,
  provisionDatabase,
  provisionSqliteDatabase,
  formatDatabaseTelegramMessage,
  isSqliteConfigured,
  resolveDriver,
  SQLITE_DEFAULT_FILE,
};
