const { execSync } = require('child_process');
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
const FETCH_RETRIES = 3;
const FETCH_RETRY_MS = 2000;
const DOH_ENDPOINTS = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/resolve'];
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

function run(cmd, options = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    cwd: ROOT,
    shell: true,
    stdio: options.silent ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    ...options,
  });
}

function runQuiet(cmd, options = {}) {
  try {
    return run(cmd, { silent: true, ...options })?.trim() || '';
  } catch (err) {
    const detail = err?.stderr || err?.stdout || err?.message || '';
    const wrapped = new Error(String(detail || err.message || err).trim());
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
  const message = String(err?.message || err || '');
  return /could not resolve host|name or service not known|temporary failure in name resolution|nodename nor servname|getaddrinfo|failed to connect|connection timed out|network is unreachable|ssl|unable to access/i.test(
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
  const message = String(err?.message || err || 'неизвестная ошибка');
  const lines = [escapeHtml(message)];

  if (/pm2|restart/i.test(message)) {
    lines.push(
      '',
      'Код на диске уже мог обновиться. Перезапустите вручную:',
      '<code>pm2 restart max-tg max-tg-update</code>',
      'или:',
      '<code>cd ~/max-tg && npm run pm2</code>'
    );
  } else if (isDnsOrNetworkError(err)) {
    lines.push(
      '',
      'DNS/сеть до GitHub недоступны. Проверьте:',
      '<code>ping -c1 github.com</code>',
      '<code>curl -I https://github.com</code>',
      'Если DNS сломан — добавьте в /etc/hosts IP github.com или смените DNS на 1.1.1.1 / 8.8.8.8',
      '',
      'Затем:',
      '<code>cd ~/max-tg && git pull --ff-only && npm install --omit=dev && pm2 restart max-tg max-tg-update</code>'
    );
  } else {
    lines.push(
      '',
      'Попробуйте вручную:',
      '<code>cd ~/max-tg && git pull --ff-only && npm install --omit=dev && pm2 restart max-tg max-tg-update</code>'
    );
  }

  return lines;
}

function httpsJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'max-tg-auto-update',
          Accept: options.accept || 'application/json',
          ...(options.headers || {}),
        },
        timeout: options.timeout || 20000,
        servername: options.servername,
        lookup: options.lookup,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            httpsJson(res.headers.location, options).then(resolve, reject);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} для ${url}`));
            return;
          }
          try {
            resolve(JSON.parse(body.toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout: ${url}`));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsDownload(url, destPath, options = {}) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, redirectsLeft) => {
      const req = https.request(
        currentUrl,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'max-tg-auto-update',
            Accept: '*/*',
            ...(options.headers || {}),
          },
          timeout: options.timeout || 60000,
          servername: options.servername,
          lookup: options.lookup,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              reject(new Error('Слишком много редиректов при скачивании архива'));
              return;
            }
            follow(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} при скачивании ${currentUrl}`));
            return;
          }

          const out = fs.createWriteStream(destPath);
          res.pipe(out);
          out.on('finish', () => resolve(destPath));
          out.on('error', reject);
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error(`timeout: ${currentUrl}`));
      });
      req.on('error', reject);
      req.end();
    };

    follow(url, 5);
  });
}

async function resolveViaDoh(hostname) {
  const errors = [];

  for (const endpoint of DOH_ENDPOINTS) {
    try {
      if (endpoint.includes('1.1.1.1')) {
        const data = await httpsJson(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`, {
          accept: 'application/dns-json',
          servername: 'cloudflare-dns.com',
        });
        const answers = data?.Answer || [];
        const ip = answers.find((a) => a.type === 1 && a.data)?.data;
        if (ip) return ip;
      } else {
        const data = await httpsJson(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`, {
          accept: 'application/json',
          servername: 'dns.google',
        });
        const ip = (data?.Answer || []).find((a) => a.type === 1)?.data;
        if (ip) return ip;
      }
    } catch (err) {
      errors.push(`${endpoint}: ${err.message}`);
    }
  }

  throw new Error(
    `DoH не смог резолвить ${hostname}` + (errors.length ? `: ${errors.join('; ')}` : '')
  );
}

function makeIpLookup(ip) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    cb(null, ip, 4);
  };
}

function upsertHostsEntry(hostname, ip) {
  const hostsPath = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts';

  try {
    if (!fs.existsSync(hostsPath)) return false;
    const raw = fs.readFileSync(hostsPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const marker = `# max-tg-auto-update ${hostname}`;
    const filtered = lines.filter(
      (line) => !line.includes(marker) && !new RegExp(`\\s${hostname.replace(/\./g, '\\.')}\\s*$`).test(line.trim())
    );
    filtered.push(`${ip} ${hostname} ${marker}`);
    const next = `${filtered.filter((l, i) => !(l === '' && filtered[i - 1] === '')).join('\n').replace(/\n*$/, '\n')}`;

    fs.writeFileSync(hostsPath, next, 'utf8');
    console.log(`auto-update: /etc/hosts → ${hostname} ${ip}`);
    return true;
  } catch (err) {
    console.warn(`auto-update: не удалось обновить hosts (${err.message})`);
    return false;
  }
}

async function ensureGithubDns() {
  let systemOk = false;
  try {
    runQuiet('git ls-remote --heads origin', { timeout: 20000 });
    systemOk = true;
  } catch {
    systemOk = false;
  }
  if (systemOk) return { mode: 'system' };

  console.warn('auto-update: git не достучался до origin, пробую DoH…');
  const githubIp = await resolveViaDoh('github.com');
  upsertHostsEntry('github.com', githubIp);

  try {
    const apiIp = await resolveViaDoh('api.github.com');
    upsertHostsEntry('api.github.com', apiIp);
  } catch {
    /* optional */
  }

  try {
    const codeloadIp = await resolveViaDoh('codeload.github.com');
    upsertHostsEntry('codeload.github.com', codeloadIp);
  } catch {
    /* optional */
  }

  return { mode: 'doh', githubIp };
}

async function fetchOriginAsync(branch) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      runQuiet(`git fetch --prune origin ${branch}`, {
        env: {
          GIT_HTTP_LOW_SPEED_LIMIT: '1000',
          GIT_HTTP_LOW_SPEED_TIME: '30',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`auto-update: fetch попытка ${attempt}/${FETCH_RETRIES} — ${err.message}`);
      if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_MS * attempt);
    }
  }
  throw lastErr || new Error('git fetch не удался');
}

async function getRemoteShaViaApi(branch) {
  const url = `https://api.github.com/repos/${REPO_SLUG}/commits/${encodeURIComponent(branch)}`;
  try {
    const data = await httpsJson(url, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (data?.sha) return String(data.sha);
  } catch (err) {
    console.warn(`auto-update: API github.com — ${err.message}, пробую через DoH IP…`);
  }

  const ip = await resolveViaDoh('api.github.com');
  const data = await httpsJson(url, {
    headers: { Accept: 'application/vnd.github+json', Host: 'api.github.com' },
    servername: 'api.github.com',
    lookup: makeIpLookup(ip),
  });
  if (!data?.sha) throw new Error('GitHub API не вернул sha');
  return String(data.sha);
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

async function applyArchiveUpdate(branch, fromSha, toSha) {
  const AdmZip = require('adm-zip');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'max-tg-update-'));
  const zipPath = path.join(tmpRoot, 'update.zip');
  const extractDir = path.join(tmpRoot, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  const zipUrl = `https://codeload.github.com/${REPO_SLUG}/zip/refs/heads/${encodeURIComponent(branch)}`;
  console.log(`auto-update: скачиваю архив ${branch} (${toSha})…`);

  try {
    await httpsDownload(zipUrl, zipPath);
  } catch (err) {
    console.warn(`auto-update: codeload напрямую — ${err.message}, пробую через DoH IP…`);
    const ip = await resolveViaDoh('codeload.github.com');
    await httpsDownload(zipUrl, zipPath, {
      headers: { Host: 'codeload.github.com' },
      servername: 'codeload.github.com',
      lookup: makeIpLookup(ip),
    });
  }

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);
  const srcRoot = findExtractedRoot(extractDir);
  copyTree(srcRoot, ROOT);

  try {
    runQuiet(`git fetch origin ${branch}`);
    runQuiet(`git reset --hard origin/${branch}`);
  } catch {
    try {
      runQuiet(`git update-ref HEAD ${toSha}`);
    } catch {
      console.warn('auto-update: файлы обновлены из архива, git ref не синхронизирован');
    }
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
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
    if (!isDnsOrNetworkError(err)) throw err;
    console.warn(`auto-update: git pull не удался (${err.message}), обновляю через архив…`);
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
    console.warn(`auto-update: git fetch недоступен — ${err.message}`);
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
    if (notify) {
      await notifyAdmins(
        buildEventMessage({
          ...UPDATES.fail(formatUpdateError(err).join('\n')),
          status: 'fail',
        })
      );
    }
    return { status: 'error', message: err.message };
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
};
