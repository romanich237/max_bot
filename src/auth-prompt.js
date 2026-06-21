const { pollUpdates, sendMessage } = require('./tg-api');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptViaAdminPoll(chatIds, promptMessage, options = {}) {
  const { registerAuthInputWaiter, clearAuthInputWaiter } = require('./tg-admin');
  const admins = (chatIds || []).map(String);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearAuthInputWaiter();
      reject(new Error('Время ожидания ответа в Telegram истекло (10 мин)'));
    }, timeoutMs);

    registerAuthInputWaiter({
      chatIds: admins,
      field: options.field,
      label: options.label,
      validate: options.validate,
      invalidMessage: options.invalidMessage,
      onValid: (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      onCancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Вход отменён'));
      },
    });

    if (promptMessage) {
      for (const chatId of admins) {
        sendMessage(chatId, promptMessage, options.extra || {}, options.token).catch(() => {});
      }
    }
  });
}

function promptViaWeb(promptMessage, options = {}) {
  const { getActivePortalState } = require('./setup-portal/runner');
  const { waitForWebInput, setStep } = require('./setup-portal/state');
  const state = getActivePortalState();

  if (!state) {
    throw new Error('Веб-портал настройки не запущен');
  }

  if (promptMessage) {
    setStep(state, 'auth', promptMessage.replace(/<[^>]+>/g, ''));
  }

  return waitForWebInput(state, {
    field: options.field || 'text',
    label: options.label || promptMessage?.replace(/<[^>]+>/g, '') || 'Введите значение',
    hint: options.hint || options.invalidMessage || '',
    invalidMessage: options.invalidMessage,
    validate: options.validate,
    timeoutMs: options.timeoutMs,
  });
}

function promptTelegramText(chatIds, promptMessage, options = {}) {
  if (options.useWebPoll) {
    return promptViaWeb(promptMessage, {
      field: options.field || (/парол|password/i.test(promptMessage || '') ? 'password' : 'text'),
      label: promptMessage?.replace(/<[^>]+>/g, ''),
      hint: options.invalidMessage,
      ...options,
    });
  }

  if (options.useAdminPoll) {
    return promptViaAdminPoll(chatIds, promptMessage, options);
  }

  const admins = new Set((chatIds || []).map(String));
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const token = options.token;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopPoll = null;
    let timer = null;

    const finish = async (value) => {
      if (settled) return;
      settled = true;
      stopPoll?.();
      if (timer) clearTimeout(timer);
      if (options.onAccepted) {
        try {
          await options.onAccepted(value);
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      stopPoll?.();
      if (timer) clearTimeout(timer);
      reject(err);
    };

    const handleUpdate = async (update) => {
      try {
        const text = update.message?.text?.trim();
        if (!text) return false;

        const chatId = String(update.message.chat.id);
        if (!admins.has(chatId)) return false;

        if (/^\/cancel$/i.test(text)) {
          fail(new Error('Вход отменён'));
          return true;
        }

        const { parseBrowserPasswordCommand, acceptBrowserPassword } = require('./auth-browser');
        const browserCmd = parseBrowserPasswordCommand(text);
        if (browserCmd?.password) {
          const result = acceptBrowserPassword(browserCmd.password);
          finish(result.password);
          return true;
        }
        if (browserCmd?.error) {
          await sendMessage(chatId, browserCmd.error, {}, token);
          return true;
        }

        if (text.startsWith('/') && !/^\/cancel$/i.test(text)) {
          return false;
        }

        if (options.validate) {
          const validated = options.validate(text);
          if (validated === false || validated == null) {
            await sendMessage(
              chatId,
              options.invalidMessage || 'Неверный формат. Попробуйте ещё раз или /cancel.',
              {},
              token
            );
            return true;
          }
          finish(typeof validated === 'string' ? validated : text);
          return true;
        }

        finish(text);
        return true;
      } catch (err) {
        fail(err);
        return true;
      }
    };

    timer = setTimeout(() => {
      fail(new Error('Время ожидания ответа в Telegram истекло (10 мин)'));
    }, timeoutMs);

    (async () => {
      if (promptMessage) {
        for (const chatId of admins) {
          await sendMessage(chatId, promptMessage, options.extra || {}, token);
        }
      }

      stopPoll = pollUpdates(handleUpdate, {
        priority: 10,
        token,
        onError: (err) => console.error('auth-prompt:', err.message),
      });
    })().catch(fail);
  });
}

module.exports = {
  promptTelegramText,
  sleep,
};
