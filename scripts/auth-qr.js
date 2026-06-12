const { deleteWebhook } = require('../src/tg-api');
const { runAuthQrTelegram } = require('../src/auth-qr');

(async () => {
  console.log('Авторизация MAX через QR в Telegram...');
  await deleteWebhook();
  await runAuthQrTelegram();
  console.log('Сессия сохранена в max_user_data/');
})().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
