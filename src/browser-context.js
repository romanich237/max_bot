const { chromium } = require('playwright');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
];

async function launchMaxContext(userDataDir, options = {}) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless ?? true,
    viewport: options.viewport ?? { width: 1280, height: 900 },
    deviceScaleFactor: options.deviceScaleFactor ?? 2,
    locale: 'ru-RU',
    userAgent: USER_AGENT,
    args: BROWSER_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  return context;
}

module.exports = {
  launchMaxContext,
  USER_AGENT,
  BROWSER_ARGS,
};
