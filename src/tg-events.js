const { sendMessage } = require('./tg-api');

const STATUS = {
  wait: { icon: '⏳', word: 'ожидание' },
  progress: { icon: '🔄', word: 'в процессе' },
  done: { icon: '✅', word: 'готово' },
  fail: { icon: '❌', word: 'ошибка' },
  info: { icon: 'ℹ️', word: 'информация' },
};

const PIPELINE_ICON = {
  done: '✅',
  wait: '⏳',
  progress: '🔄',
  pending: '○',
  fail: '❌',
};

function buildEventMessage({
  title,
  status = 'info',
  step,
  total,
  lines = [],
  footer,
}) {
  const st = STATUS[status] || STATUS.info;
  const parts = [];

  if (step && total) {
    parts.push(`${st.icon} <b>${title}</b> · шаг ${step}/${total}`);
  } else {
    parts.push(`${st.icon} <b>${title}</b>`);
  }

  if (lines.length) {
    parts.push('');
    parts.push(...lines);
  }

  if (footer) {
    parts.push('');
    parts.push(footer);
  }

  return parts.join('\n');
}

function buildPipeline(title, steps) {
  const lines = (steps || []).map((item) => {
    const icon = PIPELINE_ICON[item.status] || PIPELINE_ICON.pending;
    return `${icon} ${item.label}`;
  });

  return [`<b>${title}</b>`, '', ...lines].join('\n');
}

async function notifyChats(chatIds, text, options = {}) {
  for (const chatId of chatIds || []) {
    await sendMessage(chatId, text, options.extra || {}, options.token);
  }
}

async function notifyEvent(chatIds, payload, options = {}) {
  await notifyChats(chatIds, buildEventMessage(payload), options);
}

function maskPhone(phone10) {
  const digits = String(phone10 || '').replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `+7***${digits.slice(-4)}`;
}

module.exports = {
  STATUS,
  buildEventMessage,
  buildPipeline,
  notifyChats,
  notifyEvent,
  maskPhone,
};
