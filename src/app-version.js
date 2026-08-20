const fs = require('fs');

const MAX_PATCH = 10;

function parseVersion(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^v/i, '');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(parts, options = {}) {
  if (!parts) return '';
  const text = `${parts.major}.${parts.minor}.${parts.patch}`;
  return options.prefix ? `v${text}` : text;
}

function normalizeParts(parts) {
  let { major, minor, patch } = parts;
  while (patch > MAX_PATCH) {
    minor += 1;
    patch -= MAX_PATCH + 1;
  }
  return { major, minor, patch };
}

function normalizeVersion(value) {
  const parsed = parseVersion(value);
  if (!parsed) return '';
  return formatVersion(normalizeParts(parsed));
}

function formatAppVersion(value) {
  const normalized = normalizeVersion(value);
  if (normalized) return `v${normalized}`;
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function bumpVersion(value) {
  const current = parseVersion(normalizeVersion(value) || value) || {
    major: 1,
    minor: 0,
    patch: 0,
  };
  return formatVersion(normalizeParts({
    major: current.major,
    minor: current.minor,
    patch: current.patch + 1,
  }));
}

function ensurePackageJsonVersion(filePath) {
  const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const from = String(pkg.version || '').trim();
  const to = normalizeVersion(from);
  if (!to || to === from) {
    return { changed: false, version: from || to };
  }

  pkg.version = to;
  const json = `${JSON.stringify(pkg, null, 2)}\n`;
  fs.writeFileSync(filePath, json, 'utf8');
  return { changed: true, from, to, version: to };
}

module.exports = {
  MAX_PATCH,
  parseVersion,
  formatVersion,
  normalizeVersion,
  formatAppVersion,
  bumpVersion,
  ensurePackageJsonVersion,
};
