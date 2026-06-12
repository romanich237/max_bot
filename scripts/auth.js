const { runAuth } = require('../src/auth');

runAuth().catch((err) => {
  console.error('Ошибка при авторизации:', err);
  process.exit(1);
});
