const db = require('../src/db');

async function main() {
  if (!db.isEnabled()) {
    console.error('База отключена. Установите database.enabled: true в config.json');
    process.exit(1);
  }

  await db.initSchema();
  await db.testConnection();
  console.log('Таблицы созданы, подключение OK.');
  await db.close();
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
