#!/usr/bin/env node
/**
 * Одноразовый ремонт обновления, когда на VPS не резолвится github.com.
 *
 *   cd ~/max-tg
 *   node scripts/repair-update.js
 *
 * Что делает:
 * 1) резолвит github.com / api / codeload через DoH (1.1.1.1 / 8.8.8.8)
 * 2) пишет IP в /etc/hosts
 * 3) тянет свежий код (git pull или zip-архив)
 * 4) npm install + pm2 restart
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

  console.log('1/3 DNS через DoH → /etc/hosts…');
  const hosts = await patchGithubHosts();
  console.log('hosts:', hosts);

  console.log('2/3 проверка и установка обновления…');
  const result = await checkForUpdates({ notify: false, performUpdate: true });
  console.log('результат:', result);

  if (result.status === 'error') {
    process.exitCode = 1;
    return;
  }

  console.log('3/3 готово. Если PM2 не перезапустился сам:');
  console.log('  pm2 restart max-tg max-tg-update');
}

main().catch((err) => {
  console.error('repair-update failed:', err.message || err);
  process.exit(1);
});
