const { setupPm2 } = require('../src/pm2');

try {
  setupPm2();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
