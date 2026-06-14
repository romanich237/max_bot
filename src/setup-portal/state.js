const crypto = require('crypto');

const DEFAULT_PORT = 3847;

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createPortalState(token = createToken()) {
  return {
    token,
    step: 'telegram',
    message: 'Введите данные Telegram',
    waitingInput: null,
    screenshot: null,
    screenshotCaption: '',
    error: null,
    done: false,
    success: false,
    botUsername: '',
    inputResolver: null,
    choiceResolver: null,
    startedAt: Date.now(),
  };
}

function setStep(state, step, message = '') {
  state.step = step;
  state.message = message;
  state.error = null;
}

function setScreenshot(state, buffer, caption = '') {
  state.screenshot = buffer;
  state.screenshotCaption = caption;
}

function clearScreenshot(state) {
  state.screenshot = null;
  state.screenshotCaption = '';
}

function waitForWebInput(state, prompt) {
  if (state.inputResolver) {
    state.inputResolver.reject?.(new Error('Прервано новым запросом'));
  }

  state.waitingInput = {
    field: prompt.field || 'text',
    label: prompt.label || 'Введите значение',
    hint: prompt.hint || '',
    invalidMessage: prompt.invalidMessage || 'Неверный формат',
  };
  state.message = prompt.label || state.message;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.waitingInput = null;
      state.inputResolver = null;
      reject(new Error('Время ожидания ввода истекло (10 мин)'));
    }, prompt.timeoutMs || 10 * 60 * 1000);

    state.inputResolver = {
      resolve: (value) => {
        clearTimeout(timer);
        state.waitingInput = null;
        state.inputResolver = null;
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        state.waitingInput = null;
        state.inputResolver = null;
        reject(err);
      },
      validate: prompt.validate,
      invalidMessage: prompt.invalidMessage,
    };
  });
}

function submitWebInput(state, rawValue) {
  if (!state.inputResolver) {
    return { ok: false, error: 'Сейчас ввод не ожидается' };
  }

  const value = String(rawValue ?? '').trim();
  if (!value) {
    return { ok: false, error: 'Поле не может быть пустым' };
  }

  if (state.inputResolver.validate) {
    const validated = state.inputResolver.validate(value);
    if (validated === false || validated == null) {
      return {
        ok: false,
        error: state.inputResolver.invalidMessage || state.waitingInput?.invalidMessage || 'Неверный формат',
      };
    }
    state.inputResolver.resolve(typeof validated === 'string' ? validated : value);
    return { ok: true };
  }

  state.inputResolver.resolve(value);
  return { ok: true };
}

function waitForWebChoice(state, prompt) {
  state.waitingInput = {
    field: 'choice',
    label: prompt.label,
    hint: prompt.hint || '',
    choices: prompt.choices,
  };
  state.message = prompt.label;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.waitingInput = null;
      state.choiceResolver = null;
      reject(new Error('Время выбора истекло'));
    }, prompt.timeoutMs || 5 * 60 * 1000);

    state.choiceResolver = {
      resolve: (value) => {
        clearTimeout(timer);
        state.waitingInput = null;
        state.choiceResolver = null;
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        state.waitingInput = null;
        state.choiceResolver = null;
        reject(err);
      },
      choices: new Set(prompt.choices),
    };
  });
}

function submitWebChoice(state, choice) {
  if (!state.choiceResolver) {
    return { ok: false, error: 'Сейчас выбор не ожидается' };
  }
  if (!state.choiceResolver.choices.has(choice)) {
    return { ok: false, error: 'Недопустимый вариант' };
  }
  state.choiceResolver.resolve(choice);
  return { ok: true };
}

function getPublicStatus(state) {
  return {
    step: state.step,
    message: state.message,
    error: state.error,
    done: state.done,
    success: state.success,
    botUsername: state.botUsername,
    waitingInput: state.waitingInput
      ? {
          field: state.waitingInput.field,
          label: state.waitingInput.label,
          hint: state.waitingInput.hint,
          choices: state.waitingInput.choices || null,
        }
      : null,
    hasScreenshot: Boolean(state.screenshot),
    screenshotCaption: state.screenshotCaption,
  };
}

module.exports = {
  DEFAULT_PORT,
  createToken,
  createPortalState,
  setStep,
  setScreenshot,
  clearScreenshot,
  waitForWebInput,
  submitWebInput,
  waitForWebChoice,
  submitWebChoice,
  getPublicStatus,
};
