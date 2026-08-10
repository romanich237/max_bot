const { exportSession } = require('../src/session');

try {
  exportSession();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
