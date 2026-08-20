const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { ROOT, getAutoUpdate, getAdminChatIds, store } = require('./config');
const { sendMessage } = require('./tg-api');
const { buildEventMessage } = require('./tg-events');
const { UPDATES } = require('./bot-texts');
const {
  schedulePm2Restarts,
  APP_NAME,
  UPDATE_APP_NAME,
} = require('./pm2');

const DEFAULT_REPO_SLUG = 'romanich237/max_bot';
const FETCH_RETRIES = 2;
const FETCH_RETRY_MS = 1500;
const DNS_CACHE_FILE = path.join(ROOT, 'data', '.github-dns-cache.json');
const UPDATE_SHA_FILE = path.join(ROOT, 'data', '.update-sha');

// DoH по IP — когда DNS в ахуе и github.com не резолвится
const DOH_PROVIDERS = [
  {
    ip: '1.1.1.1',
    servername: 'cloudflare-dns.com',
    host: 'cloudflare-dns.com',
    pathFor: (name) => `/dns-query?name=${encodeURIComponent(name)}&type=A`,
    accept: 'application/dns-json',
    parse: (data) => (data?.Answer || []).find((a) => a.type === 1)?.data,
  },
  {
    ip: '8.8.8.8',
    servername: 'dns.google',
    host: 'dns.google',
    pathFor: (name) => `/resolve?name=${encodeURIComponent(name)}&type=A`,
    accept: 'application/json',
    parse: (data) => (data?.Answer || []).find((a) => a.type === 1)?.data,
  },
  {
    ip: '9.9.9.9',
    servername: 'dns.quad9.net',
    host: 'dns.quad9.net',
    pathFor: (name) => `/dns-query?name=${encodeURIComponent(name)}&type=A`,
    accept: 'application/dns-json',
    parse: (data) => (data?.Answer || []).find((a) => a.type === 1)?.data,
  },
];

const GITHUB_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com'];

const PRESERVE_ON_ARCHIVE = new Set([
  '.git',
  'node_modules',
  'max_user_data',
  'data',
  'logs',
  'config.json',
  'state.json',
  'max_session.zip',
  'max-deploy.zip',
  'package-lock.json',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err) {
  const parts = [err?.stderr, err?.stdout, err?.message, err]
    .map((value) => {
      if (value == null) return '';
      if (Buffer.isBuffer(value)) return value.toString('utf8');
      return String(value);
    })
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(parts)].join('\n');
}

function run(cmd, options = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    cwd: ROOT,
    shell: true,
    stdio: options.silent ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeout,
  });
}

function runQuiet(cmd, options = {}) {
  try {
    return run(cmd, { silent: true, timeout: 45000, ...options })?.trim() || '';
  } catch (err) {
    const wrapped = new Error(errText(err));
    wrapped.status = err.status;
    throw wrapped;
  }
}

function normalizeRepoSlug(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

function getRepoSlug() {
  const fromEnv = normalizeRepoSlug(process.env.AUTO_UPDATE_REPO);
  if (fromEnv) return fromEnv;

  const fromCfg = normalizeRepoSlug(getAutoUpdate().repo);
  if (fromCfg) return fromCfg;

  try {
    const fromGit = normalizeRepoSlug(runQuiet('git remote get-url origin'));
    if (fromGit && /^[^/\s]+\/[^/\s]+$/.test(fromGit)) return fromGit;
  } catch {
    /* zip-установка без origin */
  }

  return DEFAULT_REPO_SLUG;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAppVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function readLocalPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return formatAppVersion(pkg.version);
  } catch {
    return '';
  }
}

function readGitPackageVersion(ref) {
  try {
    const pkg = JSON.parse(runQuiet(`git show ${ref}:package.json`));
    return formatAppVersion(pkg.version);
  } catch {
    return '';
  }
}

async function getRemotePackageVersion(branch) {
  const fromGit = readGitPackageVersion(`origin/${branch}`);
  if (fromGit) return fromGit;

  const urls = [
    `https://raw.githubusercontent.com/${getRepoSlug()}/${encodeURIComponent(branch)}/package.json`,
    `https://cdn.jsdelivr.net/gh/${getRepoSlug()}@${encodeURIComponent(branch)}/package.json`,
  ];

  for (const url of urls) {
    try {
      const data = await httpsJson(url, { timeout: 15000 });
      const version = formatAppVersion(data?.version);
      if (version) return version;
    } catch {
      /* next */
    }
  }

  return '';
}

function isGitRepo() {
  try {
    if (runQuiet('git rev-parse --is-inside-work-tree') !== 'true') return false;
    runQuiet('git rev-parse HEAD');
    return true;
  } catch {
    return false;
  }
}

function readStoredSha() {
  try {
    const stored = fs.readFileSync(UPDATE_SHA_FILE, 'utf8').trim();
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  if (!isGitRepo()) return '';
  try {
    return runQuiet('git rev-parse HEAD');
  } catch {
    return '';
  }
}

function writeStoredSha(sha) {
  const value = String(sha || '').trim();
  if (!value || value === 'archive') return;
  try {
    fs.mkdirSync(path.dirname(UPDATE_SHA_FILE), { recursive: true });
    fs.writeFileSync(UPDATE_SHA_FILE, `${value}\n`, 'utf8');
  } catch (err) {
    console.warn(`auto-update: sha не сохранился (${err.message})`);
  }
}

function isDnsOrNetworkError(err) {
  const message = errText(err);
  return /could not resolve host|name or service not known|temporary failure in name resolution|nodename nor servname|getaddrinfo|failed to connect|connection timed out|network is unreachable|ssl|unable to access|enotfound|eai_again/i.test(
    message
  );
}

function hasLocalChanges() {
  const status = runQuiet('git status --porcelain');
  return status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => !line.endsWith('config.json') && !line.includes(' package-lock.json'));
}

async function notifyAdmins(text) {
  const chatIds = getAdminChatIds();
  if (!chatIds.length) return;

  for (const chatId of chatIds) {
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      console.error(`auto-update: не удалось уведомить ${chatId}:`, err.message);
    }
  }
}

function formatUpdateError(err) {
  const message = errText(err);
  const lines = [escapeHtml(message)];

  if (/pm2|restart/i.test(message)) {
    lines.push(
      '',
      'Код на диске уже мог обновиться. Перезапустите вручную:',
      '<code>pm2 restart max-tg max-tg-update</code>'
    );
  } else if (isDnsOrNetworkError(err)) {
    lines.push(
      '',
      'GitHub не резолвится на VPS. Обновление без git:',
      '<code>cd ~/max-tg && node scripts/repair-update.js</code>'
    );
  } else {
    lines.push(
      '',
      'Попробуйте:',
      '<code>cd ~/max-tg && node scripts/repair-update.js</code>'
    );
  }

  return lines;
}

function loadDnsCache() {
  try {
    if (!fs.existsSync(DNS_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(DNS_CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveDnsCache(cache) {
  try {
    fs.mkdirSync(path.dirname(DNS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(DNS_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.warn(`auto-update: DNS cache не сохранился (${err.message})`);
  }
}

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const req = https.request(
      url,
      {
        method,
        headers: {
          'User-Agent': 'max-tg-auto-update',
          Accept: options.accept || '*/*',
          ...(options.headers || {}),
        },
        timeout: options.timeout || 25000,
        servername: options.servername,
        lookup: options.lookup,
        family: options.lookup ? undefined : 4,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            httpsRequest(res.headers.location, options).then(resolve, reject);
            return;
          }
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function httpsJson(url, options = {}) {
  const res = await httpsRequest(url, {
    ...options,
    accept: options.accept || 'application/json',
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} для ${url}`);
  }
  return JSON.parse(res.body.toString('utf8'));
}

async function httpsDownload(url, destPath, options = {}) {
  const res = await httpsRequest(url, {
    ...options,
    timeout: options.timeout || 90000,
    accept: '*/*',
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} при скачивании ${url}`);
  }
  fs.writeFileSync(destPath, res.body);
  return destPath;
}

function makeIpLookup(ip) {
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    cb(null, ip, 4);
  };
}

async function resolveViaDoh(hostname) {
  const cache = loadDnsCache();
  const cached = cache[hostname];
  if (cached?.ip && cached.expiresAt > Date.now()) {
    return cached.ip;
  }

  const errors = [];
  for (const provider of DOH_PROVIDERS) {
    try {
      const url = `https://${provider.ip}${provider.pathFor(hostname)}`;
      const data = await httpsJson(url, {
        accept: provider.accept,
        servername: provider.servername,
        headers: { Host: provider.host },
        lookup: makeIpLookup(provider.ip),
        timeout: 12000,
      });
      const ip = provider.parse(data);
      if (ip) {
        cache[hostname] = { ip, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
        saveDnsCache(cache);
        return ip;
      }
      errors.push(`${provider.host}: empty`);
    } catch (err) {
      errors.push(`${provider.host}: ${err.message}`);
    }
  }

  if (cached?.ip) {
    console.warn(`auto-update: DoH лёг, беру cache для ${hostname}: ${cached.ip}`);
    return cached.ip;
  }

  throw new Error(`DoH не резолвит ${hostname}: ${errors.join('; ')}`);
}

function upsertHostsEntry(hostname, ip) {
  const hostsPath =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
      : '/etc/hosts';

  try {
    if (!fs.existsSync(hostsPath)) return false;
    const raw = fs.readFileSync(hostsPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const marker = `# max-tg-auto-update ${hostname}`;
    const hostRe = new RegExp(`(?:^|\\s)${hostname.replace(/\./g, '\\.')}(?:\\s|$)`);
    const filtered = lines.filter((line) => !line.includes(marker) && !hostRe.test(line));
    while (filtered.length && filtered[filtered.length - 1] === '') filtered.pop();
    filtered.push(`${ip} ${hostname} ${marker}`);
    fs.writeFileSync(hostsPath, `${filtered.join('\n')}\n`, 'utf8');
    console.log(`auto-update: hosts ${hostname} → ${ip}`);
    return true;
  } catch (err) {
    console.warn(`auto-update: hosts не записался, похуй (${err.message})`);
    return false;
  }
}

async function patchGithubHosts() {
  const result = {};
  for (const host of GITHUB_HOSTS) {
    try {
      const ip = await resolveViaDoh(host);
      upsertHostsEntry(host, ip);
      result[host] = ip;
    } catch (err) {
      console.warn(`auto-update: ${host} — ${err.message}`);
    }
  }
  return result;
}

function gitReachable() {
  try {
    runQuiet('git ls-remote --heads origin', {
      timeout: 15000,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureGithubDns() {
  if (gitReachable()) return { mode: 'system' };

  console.warn('auto-update: origin мёртв, чиню DNS через DoH…');
  const hosts = await patchGithubHosts();

  if (gitReachable()) return { mode: 'hosts', hosts };

  // flush dns cache, мало ли
  try {
    spawnSync('resolvectl', ['flush-caches'], { stdio: 'ignore' });
  } catch {
    /* nop */
  }

  if (gitReachable()) return { mode: 'hosts-flushed', hosts };
  return { mode: 'offline', hosts };
}

async function fetchOriginAsync(branch) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      runQuiet(`git fetch --prune origin ${branch}`, {
        env: {
          GIT_HTTP_LOW_SPEED_LIMIT: '1000',
          GIT_HTTP_LOW_SPEED_TIME: '20',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: 60000,
      });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`auto-update: fetch ${attempt}/${FETCH_RETRIES} — ${err.message}`);
      if (attempt < FETCH_RETRIES) {
        if (isDnsOrNetworkError(err)) await patchGithubHosts();
        await sleep(FETCH_RETRY_MS * attempt);
      }
    }
  }
  throw lastErr || new Error('git fetch не удался');
}

async function getRemoteShaViaApi(branch) {
  const apiPath = `/repos/${getRepoSlug()}/commits/${encodeURIComponent(branch)}`;
  const attempts = [];

  attempts.push(async () => {
    const data = await httpsJson(`https://api.github.com${apiPath}`, {
      headers: { Accept: 'application/vnd.github+json' },
      timeout: 20000,
    });
    return data?.sha;
  });

  attempts.push(async () => {
    const ip = await resolveViaDoh('api.github.com');
    const data = await httpsJson(`https://api.github.com${apiPath}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Host: 'api.github.com',
      },
      servername: 'api.github.com',
      lookup: makeIpLookup(ip),
      timeout: 20000,
    });
    return data?.sha;
  });

  // зеркала на случай если гитхаб снова отвалится
  for (const mirror of [
    `https://ghproxy.net/https://api.github.com${apiPath}`,
    `https://mirror.ghproxy.com/https://api.github.com${apiPath}`,
  ]) {
    attempts.push(async () => {
      const data = await httpsJson(mirror, {
        headers: { Accept: 'application/vnd.github+json' },
        timeout: 25000,
      });
      return data?.sha;
    });
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      const sha = await attempt();
      if (sha) return String(sha);
    } catch (err) {
      errors.push(err.message);
    }
  }

  throw new Error(`GitHub API недоступен: ${errors.slice(0, 3).join('; ')}`);
}

function archiveUrls(branch) {
  const encoded = encodeURIComponent(branch);
  return [
    {
      url: `https://codeload.github.com/${getRepoSlug()}/zip/refs/heads/${encoded}`,
      host: 'codeload.github.com',
    },
    {
      url: `https://github.com/${getRepoSlug()}/archive/refs/heads/${encoded}.zip`,
      host: 'github.com',
    },
    {
      url: `https://ghproxy.net/https://github.com/${getRepoSlug()}/archive/refs/heads/${encoded}.zip`,
      host: null,
    },
    {
      url: `https://mirror.ghproxy.com/https://github.com/${getRepoSlug()}/archive/refs/heads/${encoded}.zip`,
      host: null,
    },
    {
      url: `https://gitclone.com/github.com/${getRepoSlug()}/archive/refs/heads/${encoded}.zip`,
      host: null,
    },
  ];
}

async function downloadArchive(branch, zipPath) {
  const errors = [];

  for (const item of archiveUrls(branch)) {
    try {
      console.log(`auto-update: архив ← ${item.url}`);
      await httpsDownload(item.url, zipPath, { timeout: 120000 });
      if (fs.statSync(zipPath).size > 1000) return item.url;
      errors.push(`${item.url}: слишком маленький файл`);
    } catch (err) {
      errors.push(`${item.url}: ${err.message}`);
    }

    if (!item.host) continue;

    try {
      const ip = await resolveViaDoh(item.host);
      console.log(`auto-update: архив через DoH IP ${item.host}=${ip}`);
      await httpsDownload(item.url, zipPath, {
        headers: { Host: item.host },
        servername: item.host,
        lookup: makeIpLookup(ip),
        timeout: 120000,
      });
      if (fs.statSync(zipPath).size > 1000) return `${item.url} @ ${ip}`;
    } catch (err) {
      errors.push(`${item.host} DoH: ${err.message}`);
    }
  }

  throw new Error(`Не удалось скачать архив: ${errors.slice(0, 4).join('; ')}`);
}

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (PRESERVE_ON_ARCHIVE.has(entry.name)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function findExtractedRoot(extractDir) {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 1) return path.join(extractDir, entries[0].name);
  return extractDir;
}

async function applyArchiveUpdate(branch, _fromSha, toSha) {
  const AdmZip = require('adm-zip');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'max-tg-update-'));
  const zipPath = path.join(tmpRoot, 'update.zip');
  const extractDir = path.join(tmpRoot, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const source = await downloadArchive(branch, zipPath);
    console.log(`auto-update: распаковка (${source}) → ${toSha}`);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    copyTree(findExtractedRoot(extractDir), ROOT);

    if (isGitRepo()) {
      try {
        runQuiet(`git fetch origin ${branch}`, { timeout: 30000 });
        runQuiet(`git reset --hard origin/${branch}`);
      } catch {
        try {
          if (toSha && /^[0-9a-f]{7,40}$/i.test(toSha)) {
            runQuiet(`git update-ref HEAD ${toSha}`);
          }
        } catch {
          console.warn('auto-update: архив на месте, git ref не синхронизирован');
        }
      }
    }
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* nop */
    }
  }
}

async function finishUpdate(fromSha, toSha, notify, fromVersion) {
  run('npm install --omit=dev --ignore-scripts');

  schedulePm2Restarts([APP_NAME, UPDATE_APP_NAME], {
    delayMs: 2000,
    staggerMs: 5000,
  });

  const toVersion = readLocalPackageVersion();
  writeStoredSha(toSha);

  if (notify) {
    await notifyAdmins(
      buildEventMessage({
        ...UPDATES.done(fromVersion, toVersion),
        status: 'done',
      })
    );
  }

  console.log('auto-update: код обновлён, перезапуск PM2 запланирован');
  return { status: 'updated', fromSha, toSha, fromVersion, toVersion };
}

async function applyUpdate(fromSha, toSha, notify, branch, fromVersion) {
  try {
    run(`git pull --ff-only origin ${branch}`);
  } catch (err) {
    console.warn(`auto-update: git pull отвалился (${err.message}), беру архив…`);
    await applyArchiveUpdate(branch, fromSha, toSha);
  }

  return finishUpdate(fromSha, toSha, notify, fromVersion);
}

async function resolveRemoteSha(branch) {
  if (isGitRepo()) {
    try {
      await ensureGithubDns();
      await fetchOriginAsync(branch);
      const remote = runQuiet(`git rev-parse origin/${branch}`);
      if (remote) return { sha: remote, via: 'git' };
    } catch (err) {
      console.warn(`auto-update: git путь недоступен — ${err.message}`);
    }
  }

  const sha = await getRemoteShaViaApi(branch);
  return { sha, via: 'api' };
}

async function checkForUpdates(options = {}) {
  const notify = options.notify !== false;
  const performUpdate = options.performUpdate !== false;

  store.reload();
  const cfg = getAutoUpdate();
  const fromVersion = readLocalPackageVersion();
  console.log(`auto-update: репо ${getRepoSlug()} ветка ${cfg.branch}`);

  try {
    let remoteInfo;
    try {
      remoteInfo = await resolveRemoteSha(cfg.branch);
    } catch (err) {
      console.warn(`auto-update: remote sha — ${err.message}`);
      await patchGithubHosts().catch(() => {});
      const sha = await getRemoteShaViaApi(cfg.branch).catch(() => '');
      remoteInfo = sha ? { sha, via: 'api' } : { sha: '', via: 'api' };
    }

    const toVersion = (await getRemotePackageVersion(cfg.branch)) || fromVersion;
    const local = readStoredSha();
    const remote = remoteInfo.sha;

    if (local && remote && local === remote) {
      console.log(`auto-update: актуально ${fromVersion || local.slice(0, 7)} via ${remoteInfo.via}`);
      return { status: 'up-to-date', sha: local.slice(0, 7), version: fromVersion };
    }

    if (!local && fromVersion && toVersion && fromVersion === toVersion) {
      if (remote) writeStoredSha(remote);
      console.log(`auto-update: актуально ${fromVersion} (без git)`);
      return { status: 'up-to-date', sha: String(remote || '').slice(0, 7), version: fromVersion };
    }

    if (isGitRepo() && hasLocalChanges()) {
      console.error('auto-update: есть локальные изменения, обновление пропущено');
      if (notify) {
        await notifyAdmins(buildEventMessage({ ...UPDATES.skipped, status: 'fail' }));
      }
      return { status: 'skipped', reason: 'local-changes' };
    }

    const fromSha = String(local || fromVersion || 'local').slice(0, 7);
    const toSha = String(remote || toVersion || 'remote').slice(0, 7);

    if (!performUpdate) {
      return { status: 'available', fromSha, toSha, fromVersion, toVersion };
    }

    console.log(`auto-update: обновление ${fromVersion || fromSha} → ${toVersion || toSha} (via ${remoteInfo.via})`);

    if (notify) {
      await notifyAdmins(
        buildEventMessage({
          ...UPDATES.updating(fromVersion, toVersion),
          status: 'progress',
        })
      );
    }

    if (!isGitRepo() || remoteInfo.via === 'api' || !remote) {
      await applyArchiveUpdate(cfg.branch, fromSha, remote || toSha);
      return finishUpdate(fromSha, remote || toSha, notify, fromVersion);
    }

    return await applyUpdate(fromSha, toSha, notify, cfg.branch, fromVersion);
  } catch (err) {
    console.error('auto-update: ошибка —', err.message);
    let finalErr = err;

    if (isDnsOrNetworkError(err) || /DoH|API|архив|fetch/i.test(err.message)) {
      try {
        console.warn('auto-update: пробую архив…');
        const local = readStoredSha().slice(0, 7) || 'local';
        await patchGithubHosts();
        const sha = await getRemoteShaViaApi(cfg.branch).catch(() => 'archive');
        if (sha !== 'archive' && sha && sha === readStoredSha()) {
          return { status: 'up-to-date', sha: local, version: fromVersion };
        }
        if (!isGitRepo() || !hasLocalChanges()) {
          const toVersion = (await getRemotePackageVersion(cfg.branch)) || fromVersion;
          if (notify) {
            await notifyAdmins(
              buildEventMessage({
                ...UPDATES.updating(fromVersion, toVersion),
                status: 'progress',
              })
            );
          }
          await applyArchiveUpdate(cfg.branch, local, String(sha));
          return finishUpdate(local, String(sha), notify, fromVersion);
        }
      } catch (fallbackErr) {
        console.error('auto-update: архивный путь тоже не сработал —', fallbackErr.message);
        finalErr = fallbackErr;
      }
    }

    if (notify) {
      await notifyAdmins(
        buildEventMessage({
          ...UPDATES.fail(formatUpdateError(finalErr).join('\n')),
          status: 'fail',
        })
      );
    }
    return { status: 'error', message: finalErr.message };
  }
}

function scheduleAutoUpdate() {
  store.reload();
  const { intervalMs } = getAutoUpdate();
  store.setPath(['autoUpdate', 'enabled'], true);

  const intervalLabel =
    intervalMs < 60000
      ? `каждые ${Math.round(intervalMs / 1000)} сек`
      : intervalMs % 60000 === 0 && intervalMs / 60000 === 1
        ? 'каждую минуту'
        : `каждые ${Math.round(intervalMs / 60000)} мин`;
  console.log(`auto-update: проверка репозитория ${intervalLabel}`);

  const tick = async () => {
    try {
      await checkForUpdates();
    } catch (err) {
      console.error('auto-update:', err.message);
    }

    store.reload();
    const next = getAutoUpdate();
    setTimeout(tick, next.intervalMs);
  };

  tick();
}

module.exports = {
  checkForUpdates,
  scheduleAutoUpdate,
  patchGithubHosts,
  resolveViaDoh,
};
