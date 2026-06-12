const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { ROOT, getSettings } = require('./config');

function exportSession() {
  const userDataDir = getSettings().userDataDir;
  const outputZip = path.join(ROOT, 'max_session.zip');
  const folderName = path.basename(userDataDir);

  if (!fs.existsSync(userDataDir)) {
    throw new Error(`Папка сессии не найдена: ${userDataDir}\nСначала: npm run auth`);
  }

  if (!fs.existsSync(path.join(userDataDir, 'Default'))) {
    throw new Error('Сессия пустая. Сначала: npm run auth');
  }

  console.log(`Упаковка сессии из: ${userDataDir}`);

  if (fs.existsSync(outputZip)) {
    fs.unlinkSync(outputZip);
  }

  const zip = new AdmZip();
  zip.addLocalFolder(userDataDir, folderName);
  zip.writeZip(outputZip);

  const sizeMb = (fs.statSync(outputZip).size / 1024 / 1024).toFixed(2);
  console.log(`\nГотово: ${outputZip} (${sizeMb} MB)`);
  console.log('На VPS: scp max_session.zip root@IP:~/max/');
  console.log('Затем: npm run import-session && npm run pm2');
}

function importSession() {
  const userDataDir = getSettings().userDataDir;
  const inputZip = path.join(ROOT, 'max_session.zip');
  const folderName = path.basename(userDataDir);

  if (!fs.existsSync(inputZip)) {
    throw new Error(`Файл не найден: ${inputZip}\nПоложите max_session.zip в корень проекта.`);
  }

  console.log(`Распаковка ${inputZip} → ${userDataDir}`);

  const zip = new AdmZip(inputZip);
  const entries = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'));

  const hasFolderWrapper = entries.some(
    (name) => name.startsWith(`${folderName}/`) || name === `${folderName}/`
  );

  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(userDataDir, { recursive: true });

  if (hasFolderWrapper) {
    zip.extractAllTo(path.dirname(userDataDir), true);
  } else {
    zip.extractAllTo(userDataDir, true);
  }

  if (!fs.existsSync(path.join(userDataDir, 'Default'))) {
    throw new Error(
      'После распаковки нет max_user_data/Default.\nПересоздайте архив на ПК: npm run export-session'
    );
  }

  console.log('Сессия установлена.');
  console.log('Запуск 24/7: npm run pm2');
}

module.exports = { exportSession, importSession };
