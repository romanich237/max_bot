const { importSession } = require('../src/session');

try {
  importSession();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
