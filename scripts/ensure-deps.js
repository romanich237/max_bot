const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

const requiredFiles = [
  'config.json',
  'src/monitor.js',
  'src/parser.js',
  'src/telegram.js',
  'src/media.js',
  'src/db.js',
  'src/state.js',
  'src/config.js',
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));

if (missing.length) {
  console.error('\nОШИБКА: на сервере не хватает файлов:');
  missing.forEach((file) => console.error(`  - ${file}`));
  console.error('\nНа ПК:  npm run pack-deploy');
  console.error('На VPS:  scp max-deploy.zip root@IP:/root/max/');
  console.error('         cd /root/max && unzip -o max-deploy.zip && npm install && pm2 restart max-tg\n');
  process.exit(1);
}

const requiredDeps = ['playwright', 'mysql2', 'adm-zip'];
let missingDep = null;

for (const dep of requiredDeps) {
  try {
    require.resolve(dep, { paths: [root] });
  } catch {
    missingDep = dep;
    break;
  }
}

if (missingDep || !fs.existsSync(path.join(root, 'node_modules'))) {
  console.log(`Установка зависимостей (не хватает: ${missingDep || 'node_modules'})...`);
  execSync('npm install --omit=dev', { cwd: root, stdio: 'inherit' });
}
