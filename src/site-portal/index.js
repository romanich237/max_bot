const http = require('http');
const { URL } = require('url');
const { renderSitePage } = require('./page');
const {
  ensureSiteToken,
  getSitePort,
  isEnabled,
  proxyRequest,
  syncCookiesToPlaywright,
} = require('./proxy');
const { resolveServerPublicIp, buildPortalUrl, getLocalIpv4Addresses } = require('../server-ip');

function getPublicUrls(port, token, publicIp) {
  const urls = [];

  if (publicIp) {
    urls.push(buildPortalUrl(publicIp, port, 'site', token));
  }

  urls.push(buildPortalUrl('127.0.0.1', port, 'site', token));

  for (const address of getLocalIpv4Addresses()) {
    urls.push(buildPortalUrl(address, port, 'site', token));
  }

  return [...new Set(urls)];
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function createSiteServer(token) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts[0] !== 'site' || parts[1] !== token) {
        res.writeHead(404);
        return res.end('Not found');
      }

      const section = parts[2] || '';

      if (!section && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderSitePage(token));
      }

      if (section === 'sync' && req.method === 'POST') {
        try {
          const count = await syncCookiesToPlaywright();
          return sendJson(res, 200, { ok: true, cookies: count });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (section === 'max' || section === 'vk') {
        const rest = '/' + parts.slice(3).join('/');
        return proxyRequest(req, res, token, section, rest === '/' ? '/' : rest);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });
}

let portalInstance = null;

function startSitePortal(options = {}) {
  if (!isEnabled()) {
    return null;
  }

  if (portalInstance) {
    return portalInstance;
  }

  const token = ensureSiteToken();
  const port = options.port || getSitePort();
  const server = createSiteServer(token);

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Site portal: порт ${port} занят`);
        resolve(null);
        return;
      }
      reject(err);
    });

    server.listen(port, options.host || '0.0.0.0', async () => {
      const publicIp = await resolveServerPublicIp();
      const urls = getPublicUrls(port, token, publicIp);
      portalInstance = { server, port, token, publicIp, urls };
      console.log('MAX Site portal:');
      console.log(`  ${urls[0]}`);
      for (const u of urls.slice(1)) console.log(`  ${u}`);
      resolve(portalInstance);
    });
  });
}

function getSiteUrls() {
  if (portalInstance) {
    return portalInstance.urls;
  }
  const token = ensureSiteToken();
  const port = getSitePort();
  const { getLocalIpv4 } = require('../server-ip');
  return getPublicUrls(port, token, getLocalIpv4());
}

module.exports = {
  startSitePortal,
  getSiteUrls,
  getPublicUrls,
};
