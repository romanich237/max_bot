async function injectOnlineGuards(page) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
    } catch {
      // ignore
    }
  });
}

async function pulseActivity(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    if (document.body) {
      document.body.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 2, clientY: 2 })
      );
    }
  });
}

function startAlwaysOnline(page, getOptions) {
  let timer = null;

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const reschedule = () => {
    stop();
    const { enabled, intervalMs } = getOptions();
    if (!enabled) return;

    timer = setInterval(async () => {
      try {
        await pulseActivity(page);
      } catch {
        // page may be busy
      }
    }, intervalMs);
  };

  reschedule();
  return { reschedule, stop };
}

module.exports = {
  injectOnlineGuards,
  pulseActivity,
  startAlwaysOnline,
};
