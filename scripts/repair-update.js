#!/usr/bin/env node
/**
 * DNS сдох → чиним hosts + тянем апдейт.
 * cd ~/max-tg && node scripts/repair-update.js
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

async function main() {
  console.log('=== max-tg repair-update ===');
  console.log('Каталог:', ROOT);

  const {
    checkForUpdates,
    patchGithubHosts,
  } = require('../src/auto-update');

  console.log('1/3 DoH → hosts…');
  const hosts = await patchGithubHosts();
  console.log('hosts:', hosts);

  console.log('2/3 качаю апдейт…');
  const result = await checkForUpdates({ notify: false, performUpdate: true });
  console.log('результат:', result);

  if (result.status === 'error') {
    process.exitCode = 1;
    return;
  }

  console.log('3/3 ок. если pm2 не сам: pm2 restart max-tg max-tg-update');
}

main().catch((err) => {
  console.error('repair-update failed:', err.message || err);
  process.exit(1);
});
