const dns = require('dns');

// VPS без IPv6 → ENETUNREACH на AAAA, форсим v4
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

try {
  const undici = require('undici');
  if (undici?.Agent && undici?.setGlobalDispatcher) {
    undici.setGlobalDispatcher(
      new undici.Agent({
        connect: { family: 4 },
      })
    );
  }
} catch {
  /* undici может ещё не стоять на самом старте install */
}

module.exports = {};
