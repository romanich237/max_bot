const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const output = path.join(root, 'max-deploy.zip');

const include = [
  'index.js',
  'config.json',
  'package.json',
  'package-lock.json',
  'ecosystem.config.cjs',
  'src',
  'scripts',
];

const excludeDirs = new Set(['node_modules', 'max_user_data', 'data', 'logs', '.git']);

function addFolder(zip, folderPath, zipPath) {
  if (!fs.existsSync(folderPath)) return;

  for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
    if (excludeDirs.has(entry.name)) continue;

    const full = path.join(folderPath, entry.name);
    const zipEntry = zipPath ? `${zipPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      addFolder(zip, full, zipEntry);
    } else {
      zip.addLocalFile(full, zipPath || '', entry.name);
    }
  }
}

if (fs.existsSync(output)) fs.unlinkSync(output);

const zip = new AdmZip();

for (const item of include) {
  const full = path.join(root, item);
  if (!fs.existsSync(full)) {
    console.error(`Пропущено (нет на диске): ${item}`);
    continue;
  }

  if (fs.statSync(full).isDirectory()) {
    addFolder(zip, full, item);
  } else {
    zip.addLocalFile(full);
  }
}

zip.writeZip(output);

const sizeMb = (fs.statSync(output).size / 1024 / 1024).toFixed(2);
console.log(`\nГотово: ${output} (${sizeMb} MB)`);
console.log('\nНа сервере:');
console.log('  cd /root/max');
console.log('  unzip -o max-deploy.zip');
console.log('  npm install');
console.log('  pm2 delete max-tg; npm run pm2');
