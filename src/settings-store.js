const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

function getByPath(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setByPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function initFromExample() {
  if (!fs.existsSync(EXAMPLE_PATH)) {
    throw new Error(`Не найден ${EXAMPLE_PATH}`);
  }

  const data = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}

class SettingsStore extends EventEmitter {
  constructor() {
    super();
    this._data = null;
    this.ensureConfig();
    this.reload();
  }

  ensureConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
      initFromExample();
    }
  }

  reload() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    this._data = JSON.parse(raw);
    this.emit('change', this._data);
    return this._data;
  }

  get() {
    return this._data;
  }

  getPath(keys) {
    return getByPath(this._data, keys);
  }

  setPath(keys, value) {
    setByPath(this._data, keys, value);
    this.save();
  }

  togglePath(keys) {
    const current = Boolean(this.getPath(keys));
    this.setPath(keys, !current);
    return !current;
  }

  save() {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(this._data, null, 2)}\n`, 'utf8');
    this.emit('change', this._data);
  }
}

module.exports = new SettingsStore();
module.exports.initFromExample = initFromExample;
module.exports.CONFIG_PATH = CONFIG_PATH;
