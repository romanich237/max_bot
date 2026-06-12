require('./ensure-deps');

const { startMonitor } = require('../src/monitor');

startMonitor().catch((err) => {
  console.error('Критическая ошибка:', err.message);
  process.exit(1);
});
