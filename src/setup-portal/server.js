const { URL } = require('url');
const { renderSetupPage } = require('./page');
const { createPortalServer, ensurePortalSsl } = require('../portal-ssl');
const { isPortalSslEnabled } = require('../config');
const {
  getPublicStatus,
  submitWebInput,
  submitWebChoice,
  DEFAULT_PORT,
} = require('./state');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function createSetupHandler(state, handlers) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts[0] === 'setup' && parts[1] === state.token && parts.length === 2 && req.method === 'GET') {
        return sendHtml(res, renderSetupPage(state.token));
      }

      if (parts[0] !== 'api' || parts[1] !== state.token) {
        res.writeHead(404);
        return res.end('Not found');
      }

      const route = parts.slice(2).join('/');

      if (route === 'status' && req.method === 'GET') {
        return sendJson(res, 200, getPublicStatus(state));
      }

      if (route === 'screenshot' && req.method === 'GET') {
        if (!state.screenshot) {
          res.writeHead(404);
          return res.end('No screenshot');
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
        });
        return res.end(state.screenshot);
      }

      const bodyText = req.method === 'POST' ? await readBody(req) : '{}';
      const body = bodyText ? JSON.parse(bodyText) : {};

      if (route === 'telegram' && req.method === 'POST') {
        const result = await handlers.saveTelegram(body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (route === 'max' && req.method === 'POST') {
        const result = await handlers.saveMax(body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (route === 'auth/start' && req.method === 'POST') {
        const result = await handlers.startAuth(body.mode);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (route === 'auth/input' && req.method === 'POST') {
        if (state.waitingInput?.field === 'choice') {
          const result = submitWebChoice(state, body.value || body.choice);
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        const result = submitWebInput(state, body.value);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  };
}

function startSetupServer(state, handlers, options = {}) {
  const port = options.port || DEFAULT_PORT;
  const host = options.host || '0.0.0.0';
  const handler = createSetupHandler(state, handlers);

  return new Promise(async (resolve, reject) => {
    let tlsOptions = null;
    if (isPortalSslEnabled()) {
      const { resolveServerPublicIp } = require('../server-ip');
      const publicIp = options.publicIp || (await resolveServerPublicIp());
      const ssl = await ensurePortalSsl(publicIp);
      if (ssl) {
        tlsOptions = { cert: ssl.cert, key: ssl.key };
      }
    }

    const server = createPortalServer(handler, tlsOptions);
    server.on('error', reject);
    server.listen(port, host, () => {
      resolve({
        server,
        port,
        ssl: Boolean(tlsOptions),
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

function getSetupUrls(port, token, publicIp, ssl = isPortalSslEnabled()) {
  const { getLocalIpv4Addresses, buildPortalUrl } = require('../server-ip');
  const urls = [];

  if (publicIp) {
    urls.push(buildPortalUrl(publicIp, port, 'setup', token, { ssl }));
  }

  urls.push(buildPortalUrl('127.0.0.1', port, 'setup', token, { ssl }));

  for (const address of getLocalIpv4Addresses()) {
    urls.push(buildPortalUrl(address, port, 'setup', token, { ssl }));
  }

  return [...new Set(urls)];
}

module.exports = {
  DEFAULT_PORT,
  startSetupServer,
  getSetupUrls,
};
