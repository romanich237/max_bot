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

const REPO_SLUG = process.env.AUTO_UPDATE_REPO || 'romanich237/max_bot';
const FETCH_RETRIES = 2;
const FETCH_RETRY_MS = 1500;
const DNS_CACHE_FILE = path.join(ROOT, 'data', '.github-dns-cache.json');

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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isGitRepo() {
  return fs.existsSync(path.join(ROOT, '.git'));
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
      'GitHub не резолвится на VPS. Одноразовый ремонт без git:',
      '<code>cd ~/max-tg && node scripts/repair-update.js</code>',
      '',
      'Или починить DNS и обновить:',
      '<code>echo "nameserver 1.1.1.1" | tee /etc/resolv.conf >/dev/null</code>',
      '<code>cd ~/max-tg && git pull --ff-only && npm install --omit=dev && pm2 restart max-tg max-tg-update</code>'
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
    console.warn(`auto-update: не удалось сохранить DNS cache (${err.message})`);
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
    console.warn(`auto-update: DoH недоступен, беру IP из cache для ${hostname}: ${cached.ip}`);
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
    console.warn(`auto-update: hosts не записан (${err.message})`);
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

  console.warn('auto-update: origin недоступен, чиню DNS через DoH…');
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
  const apiPath = `/repos/${REPO_SLUG}/commits/${encodeURIComponent(branch)}`;
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
      url: `https://codeload.github.com/${REPO_SLUG}/zip/refs/heads/${encoded}`,
      host: 'codeload.github.com',
    },
    {
      url: `https://github.com/${REPO_SLUG}/archive/refs/heads/${encoded}.zip`,
      host: 'github.com',
    },
    {
      url: `https://ghproxy.net/https://github.com/${REPO_SLUG}/archive/refs/heads/${encoded}.zip`,
      host: null,
    },
    {
      url: `https://mirror.ghproxy.com/https://github.com/${REPO_SLUG}/archive/refs/heads/${encoded}.zip`,
      host: null,
    },
    {
      url: `https://gitclone.com/github.com/${REPO_SLUG}/archive/refs/heads/${encoded}.zip`,
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

    try {
      runQuiet(`git fetch origin ${branch}`, { timeout: 30000 });
      runQuiet(`git reset --hard origin/${branch}`);
    } catch {
      try {
        if (toSha && /^[0-9a-f]{7,40}$/i.test(toSha)) {
          runQuiet(`git update-ref HEAD ${toSha}`);
        }
      } catch {
        console.warn('auto-update: архив на месте, git ref похуй синхронизировать');
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

async function finishUpdate(fromSha, toSha, notify) {
  run('npm install --omit=dev --ignore-scripts');

  schedulePm2Restarts([APP_NAME, UPDATE_APP_NAME], {
    delayMs: 2000,
    staggerMs: 5000,
  });

  if (notify) {
    await notifyAdmins(
      buildEventMessage({
        ...UPDATES.done(fromSha, toSha),
        status: 'done',
      })
    );
  }

  console.log('auto-update: код обновлён, перезапуск PM2 запланирован');
  return { status: 'updated', fromSha, toSha };
}

async function applyUpdate(fromSha, toSha, notify, branch) {
  try {
    run(`git pull --ff-only origin ${branch}`);
  } catch (err) {
    console.warn(`auto-update: git pull не удался (${err.message}), архив…`);
    await applyArchiveUpdate(branch, fromSha, toSha);
  }

  return finishUpdate(fromSha, toSha, notify);
}

async function resolveRemoteSha(branch) {
  try {
    await ensureGithubDns();
    await fetchOriginAsync(branch);
    const remote = runQuiet(`git rev-parse origin/${branch}`);
    if (remote) return { sha: remote, via: 'git' };
  } catch (err) {
    console.warn(`auto-update: git путь недоступен — ${err.message}`);
  }

  const sha = await getRemoteShaViaApi(branch);
  return { sha, via: 'api' };
}

async function checkForUpdates(options = {}) {
  const notify = options.notify !== false;
  const performUpdate = options.performUpdate !== false;

  store.reload();
  const cfg = getAutoUpdate();

  if (!isGitRepo()) {
    return { status: 'unavailable', reason: 'not-git' };
  }

  try {
    const local = runQuiet('git rev-parse HEAD');
    const remoteInfo = await resolveRemoteSha(cfg.branch);
    const remote = remoteInfo.sha;

    if (!remote) {
      return { status: 'error', message: `Ветка ${cfg.branch} не найдена` };
    }

    if (local === remote) {
      console.log(`auto-update: актуально (${local.slice(0, 7)}) via ${remoteInfo.via}`);
      return { status: 'up-to-date', sha: local.slice(0, 7) };
    }

    if (hasLocalChanges()) {
      console.error('auto-update: есть локальные изменения, обновление пропущено');
      if (notify) {
        await notifyAdmins(buildEventMessage({ ...UPDATES.skipped, status: 'fail' }));
      }
      return { status: 'skipped', reason: 'local-changes' };
    }

    const fromSha = local.slice(0, 7);
    const toSha = remote.slice(0, 7);

    if (!performUpdate) {
      return { status: 'available', fromSha, toSha };
    }

    console.log(`auto-update: обновление ${fromSha} → ${toSha} (via ${remoteInfo.via})`);

    if (notify) {
      await notifyAdmins(
        buildEventMessage({
          ...UPDATES.updating(fromSha, toSha),
          status: 'progress',
        })
      );
    }

    if (remoteInfo.via === 'api') {
      await applyArchiveUpdate(cfg.branch, fromSha, toSha);
      return finishUpdate(fromSha, toSha, notify);
    }

    return await applyUpdate(fromSha, toSha, notify, cfg.branch);
  } catch (err) {
    console.error('auto-update: ошибка —', err.message);
    let finalErr = err;

    // последний шанс: просто скачать zip и накатить
    if (isDnsOrNetworkError(err) || /DoH|API|архив|fetch/i.test(err.message)) {
      try {
        console.warn('auto-update: всё плохо, пробую архив в лоб…');
        const local = runQuiet('git rev-parse HEAD').slice(0, 7);
        await patchGithubHosts();
        const sha = await getRemoteShaViaApi(cfg.branch).catch(() => 'archive');
        if (sha !== 'archive' && sha === runQuiet('git rev-parse HEAD')) {
          return { status: 'up-to-date', sha: local };
        }
        if (!hasLocalChanges()) {
          if (notify) {
            await notifyAdmins(
              buildEventMessage({
                ...UPDATES.updating(local, String(sha).slice(0, 7)),
                status: 'progress',
              })
            );
          }
          await applyArchiveUpdate(cfg.branch, local, String(sha).slice(0, 7));
          return finishUpdate(local, String(sha).slice(0, 7), notify);
        }
      } catch (fallbackErr) {
        console.error('auto-update: аварийный путь тоже упал —', fallbackErr.message);
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
