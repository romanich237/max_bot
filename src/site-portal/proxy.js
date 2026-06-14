const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, store } = require('../config');

const COOKIES_PATH = path.join(ROOT, 'data', 'site-cookies.json');
const DEFAULT_PORT = 3847;

const TARGETS = {
  max: { host: 'web.max.ru', protocol: 'https:' },
  vk: { host: 'id.vk.ru', protocol: 'https:' },
};

function ensureSiteToken() {
  let token = store.getPath(['sitePortal', 'token']);
  if (!token) {
    token = crypto.randomBytes(18).toString('hex');
    store.setPath(['sitePortal', 'token'], token);
  }
  return token;
}

function getSitePort() {
  return Number(store.getPath(['sitePortal', 'port']) || DEFAULT_PORT);
}

function isEnabled() {
  return store.getPath(['sitePortal', 'enabled']) !== false;
}

function loadCookieJar() {
  try {
    if (!fs.existsSync(COOKIES_PATH)) return [];
    return JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveCookieJar(cookies) {
  fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

function mergeCookies(existing, incoming) {
  const map = new Map(existing.map((c) => [`${c.domain}|${c.name}|${c.path || '/'}`, c]));
  for (const cookie of incoming) {
    map.set(`${cookie.domain}|${cookie.name}|${cookie.path || '/'}`, cookie);
  }
  return [...map.values()];
}

function parseSetCookie(header, defaults = {}) {
  const parts = header.split(';').map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;

  const cookie = {
    name: nameValue.slice(0, eq),
    value: nameValue.slice(eq + 1),
    domain: defaults.domain || '.max.ru',
    path: defaults.path || '/',
    secure: defaults.secure !== false,
    httpOnly: false,
    sameSite: 'Lax',
  };

  for (const attr of attrs) {
    const [k, v] = attr.split('=');
    const key = k.toLowerCase();
    if (key === 'domain' && v) cookie.domain = v.startsWith('.') ? v : `.${v}`;
    if (key === 'path' && v) cookie.path = v;
    if (key === 'secure') cookie.secure = true;
    if (key === 'httponly') cookie.httpOnly = true;
    if (key === 'samesite' && v) cookie.sameSite = v;
    if (key === 'max-age' && v) {
      const sec = Number.parseInt(v, 10);
      if (!Number.isNaN(sec) && sec > 0) {
        cookie.expires = Math.floor(Date.now() / 1000) + sec;
      }
    }
    if (key === 'expires' && v) {
      const ts = Date.parse(v);
      if (!Number.isNaN(ts)) cookie.expires = Math.floor(ts / 1000);
    }
  }

  return cookie;
}

function collectSetCookies(headers, targetHost) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const cookies = [];
  for (const line of list) {
    const parsed = parseSetCookie(line, {
      domain: targetHost.endsWith('vk.ru') ? '.vk.ru' : '.max.ru',
      secure: true,
    });
    if (parsed) cookies.push(parsed);
  }
  return cookies;
}

function rewriteBody(content, token, contentType = '') {
  if (!content || typeof contentType !== 'string') return content;
  if (!/text\/|javascript|json|xml/i.test(contentType)) return content;

  let text = content.toString('utf8');
  const maxBase = `/site/${token}/max`;
  const vkBase = `/site/${token}/vk`;

  text = text
    .replace(/https:\/\/web\.max\.ru/gi, maxBase)
    .replace(/https:\\\/\\\/web\.max\.ru/gi, maxBase.replace(/\//g, '\\/'))
    .replace(/https:\/\/id\.vk\.ru/gi, vkBase)
    .replace(/https:\\\/\\\/id\.vk\.ru/gi, vkBase.replace(/\//g, '\\/'))
    .replace(/\/\/web\.max\.ru/gi, maxBase)
    .replace(/\/\/id\.vk\.ru/gi, vkBase);

  return text;
}

function buildProxyPath(token, targetKey, restPath) {
  const prefix = `/site/${token}/${targetKey}`;
  if (!restPath || restPath === '/') return prefix + '/';
  return prefix + (restPath.startsWith('/') ? restPath : `/${restPath}`);
}

function proxyRequest(req, res, token, targetKey, restPath) {
  const target = TARGETS[targetKey];
  if (!target) {
    res.writeHead(404);
    return res.end('Unknown target');
  }

  const lib = require(target.protocol === 'https:' ? 'https' : 'http');
  const query = new URL(req.url || '/', 'http://localhost').search;
  const forwardPath = (restPath || '/') + query;

  const headers = { ...req.headers, host: target.host, connection: 'close' };
  delete headers['accept-encoding'];
  delete headers.host;
  headers.Host = target.host;

  const jar = loadCookieJar();
  const relevant = jar.filter((c) => target.host.endsWith((c.domain || '').replace(/^\./, '')));
  if (relevant.length) {
    headers.Cookie = relevant.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  const proxyReq = lib.request(
    {
      protocol: target.protocol,
      hostname: target.host,
      port: target.protocol === 'https:' ? 443 : 80,
      path: forwardPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const headersOut = { ...proxyRes.headers };
      delete headersOut['x-frame-options'];
      delete headersOut['content-security-policy'];
      delete headersOut['content-security-policy-report-only'];
      delete headersOut['permissions-policy'];

      const collected = collectSetCookies(proxyRes.headers, target.host);
      if (collected.length) {
        saveCookieJar(mergeCookies(jar, collected));
      }

      if (headersOut.location) {
        headersOut.location = headersOut.location
          .replace(/https:\/\/web\.max\.ru/gi, buildProxyPath(token, 'max', ''))
          .replace(/https:\/\/id\.vk\.ru/gi, buildProxyPath(token, 'vk', ''));
      }

      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        const type = headersOut['content-type'] || '';
        const body = rewriteBody(raw, token, type);
        if (Buffer.isBuffer(body)) {
          delete headersOut['content-length'];
          res.writeHead(proxyRes.statusCode || 200, headersOut);
          res.end(body);
        } else {
          const out = Buffer.from(body, 'utf8');
          headersOut['content-length'] = String(out.length);
          res.writeHead(proxyRes.statusCode || 200, headersOut);
          res.end(out);
        }
      });
    }
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end(`Proxy error: ${err.message}`);
  });

  if (req.method === 'GET' || req.method === 'HEAD') {
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
}

async function syncCookiesToPlaywright() {
  const cookies = loadCookieJar();
  if (!cookies.length) {
    throw new Error('Нет cookies. Сначала войдите на странице /site');
  }

  const { getSettings } = require('../config');
  const { launchMaxContext } = require('../browser-context');
  const { getMax } = require('../config');

  const settings = getSettings();
  const context = await launchMaxContext(settings.userDataDir, { headless: true });
  try {
    const normalized = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.max.ru',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: Boolean(c.httpOnly),
      sameSite: c.sameSite || 'Lax',
      expires: c.expires,
    }));
    await context.addCookies(normalized);
    const page = context.pages()[0] || (await context.newPage());
    const chatUrl = getMax().chatUrl || 'https://web.max.ru/';
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2500);
  } finally {
    await context.close();
  }

  return cookies.length;
}

module.exports = {
  DEFAULT_PORT,
  TARGETS,
  ensureSiteToken,
  getSitePort,
  isEnabled,
  loadCookieJar,
  proxyRequest,
  syncCookiesToPlaywright,
  buildProxyPath,
};
