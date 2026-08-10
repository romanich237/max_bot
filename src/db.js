const { getDatabase } = require('./config');
const mysqlDb = require('./db-mysql');
const sqliteDb = require('./db-sqlite');

function getDriver() {
  return getDatabase().driver;
}

function getBackend() {
  return getDriver() === 'sqlite' ? sqliteDb : mysqlDb;
}

function isEnabled() {
  const db = getDatabase();
  if (db.enabled !== true) return false;
  if (db.driver === 'sqlite') return true;
  return Boolean(db.host && db.user && db.database);
}

function delegate(method) {
  return async (...args) => getBackend()[method](...args);
}

module.exports = {
  isEnabled,
  initSchema: delegate('initSchema'),
  testConnection: delegate('testConnection'),
  loadSeenKeys: delegate('loadSeenKeys'),
  loadSnapshot: delegate('loadSnapshot'),
  saveSeenKeys: delegate('saveSeenKeys'),
  saveSnapshot: delegate('saveSnapshot'),
  saveMessage: delegate('saveMessage'),
  close: delegate('close'),
};
