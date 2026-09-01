const fs = require('fs');
const path = require('path');
const { File } = require('node:buffer');
const { getTelegram, getNotificationChatIdsForMaxChat, getMaxDisplayName, isPrivateChatId } = require('./config');
const { isOwnByAuthor } = require('./parser');
const { chatLabelFromUrl, allowsMaxReply } = require('./max-chats');
const replyStore = require('./reply-store');
const outbox = require('./tg-outbox');

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatReplyAuthor(author) {
  if (!author) return 'сообщение';
  if (isOwnByAuthor(author)) return 'Вы';
  return escapeHtml(author);
}

function formatReply(reply) {
  if (!reply) return '';

  const author = formatReplyAuthor(reply.author);
  const body = reply.isVoice
    ? '[голосовое]'
    : reply.body
      ? escapeHtml(reply.body)
      : '';

  if (!body) {
    return `↩ <b>${author}</b>`;
  }

  return `↩ <b>${author}</b>:\n${body}`;
}

function isAudioCardText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  if (/\b(m4a|mp3|aac|ogg|oga|opus|wav|flac)\b/i.test(value) && /скачать|download|\.m4a|\.mp3|\.ogg|\.aac/i.test(value)) {
    return true;
  }
  return /скачать\s*•\s*[\d.,]+\s*[kmgt]?b/i.test(value) && /\.(m4a|mp3|aac|ogg|oga|opus|wav|flac)\b/i.test(value);
}

function displayAuthor(author) {
  const clean = String(author || '').trim();
  if (!clean || clean === 'Неизвестно') return '';
  return clean;
}

function formatAuthorLine(author) {
  const clean = displayAuthor(author) || 'неизвестно';
  return `Кто написал: <b>${escapeHtml(clean)}</b>`;
}

function buildMessageText(message, isCatchUp = false, meta = {}, sendContext = {}) {
  const telegram = getTelegram();
  const showTime = telegram.showTime ?? false;
  const showServiceHeader = telegram.showServiceHeader ?? false;
  const parts = [];

  const chatName = meta.maxChatUrl ? chatLabelFromUrl(meta.maxChatUrl) : '';
  if (chatName) {
    parts.push(`Чат: <b>${escapeHtml(chatName)}</b>`);
  }
  parts.push(formatAuthorLine(message.author));

  if (showServiceHeader) {
    const maxName = getMaxDisplayName();
    const account = maxName ? ` · <code>${escapeHtml(maxName)}</code>` : '';
    parts.push(
      isCatchUp
        ? `📩 <b>Сообщение из MAX</b>${account}`
        : `📩 <b>Новое сообщение из MAX</b>${account}`
    );
  }

  if (!sendContext.useNativeReply) {
    const replyText = formatReply(message.reply);
    if (replyText) parts.push(replyText);
  }

  const header = parts.filter(Boolean).join('\n');
  const tail = [];

  if (message.body && !isAudioCardText(message.body)) tail.push(escapeHtml(message.body));

  if (showTime && (message.time || message.date)) {
    const when = [message.date, message.clock || message.time].filter(Boolean).join(' ');
    tail.push(`<i>${escapeHtml(when)}</i>`);
  }

  return [header, ...tail].filter(Boolean).join('\n\n');
}

function replyMarkupForChat(chatId, replyMarkup) {
  if (!replyMarkup || !isPrivateChatId(chatId)) return null;
  const { canTelegramUserReply } = require('./max-chats');
  if (!canTelegramUserReply(chatId)) return null;
  return replyMarkup;
}

function notifyChatIds(sendContext = {}) {
  if (Array.isArray(sendContext.destIds) && sendContext.destIds.length) {
    return [...new Set(sendContext.destIds.map(String).filter(Boolean))];
  }
  return getNotificationChatIdsForMaxChat(sendContext.maxChatUrl);
}

function outboxJobId(sendContext, method) {
  if (sendContext.outboxId) return String(sendContext.outboxId);
  const storeId = sendContext.storeId || 'msg';
  return `tg:${storeId}:${method}`;
}

function persistSendJob(sendContext, method, fields, files, extra = {}) {
  const destIds = notifyChatIds(sendContext);
  const id = outboxJobId(sendContext, method);
  sendContext.outboxId = id;
  outbox.ensureJob({
    id,
    kind: extra.kind || 'telegram',
    method,
    fields,
    files,
    photos: extra.photos || [],
    text: extra.text || fields?.text || fields?.caption || '',
    parseMode: extra.parseMode || fields?.parse_mode || '',
    replyMarkup: sendContext.replyMarkup || null,
    replyToByChat: sendContext.replyToByChat || {},
    maxChatUrl: sendContext.maxChatUrl || '',
    storeId: sendContext.storeId || '',
    destIds,
  });
  return id;
}

function buildReplyButtonMarkup(storeId, maxChatUrl, isCatchUp = false) {
  if (isCatchUp || !allowsMaxReply(maxChatUrl)) return null;
  return {
    _storeId: storeId,
    inline_keyboard: [[{ text: '↩️ Ответить', callback_data: `reply:${storeId}` }]],
  };
}

function prepareForward(message, maxChatUrl, isCatchUp) {
  const storeId = replyStore.put(message, maxChatUrl);
  const chatIds = getNotificationChatIdsForMaxChat(maxChatUrl);
  const replyToByChat = replyStore.resolveReplyToByChat(maxChatUrl, message.reply, chatIds);
  const useNativeReply = Boolean(message.reply && Object.keys(replyToByChat).length);
  const replyMarkup = buildReplyButtonMarkup(storeId, maxChatUrl, isCatchUp);

  return { storeId, replyToByChat, useNativeReply, replyMarkup, maxChatUrl };
}

function buildReplyMarkup(message, maxChatUrl) {
  const storeId = replyStore.put(message, maxChatUrl);
  return buildReplyButtonMarkup(storeId, maxChatUrl);
}

function stripReplyMarkup(markup) {
  if (!markup) return null;
  const { _storeId, ...rest } = markup;
  return rest;
}

function appendFormField(form, key, value) {
  if (value == null || value === '') return;
  if (key === 'reply_markup') {
    form.append(key, JSON.stringify(value));
  } else {
    form.append(key, String(value));
  }
}

function shouldRetryWithoutReply(data) {
  const description = String(data?.description || '').toLowerCase();
  return /message to be replied not found|replied message not found|message can't be replied/i.test(
    description
  );
}

async function postTelegramForm(url, form, sendContext, chatId) {
  const response = await fetch(url, { method: 'POST', body: form });
  let data = await response.json();

  if (!data.ok && sendContext?.replyToByChat?.[String(chatId)] && shouldRetryWithoutReply(data)) {
    const replyField = [...form.keys()].includes('reply_to_message_id');
    if (replyField) {
      const retryForm = new FormData();
      for (const [key, value] of form.entries()) {
        if (key === 'reply_to_message_id') continue;
        retryForm.append(key, value);
      }
      const retryResponse = await fetch(url, { method: 'POST', body: retryForm });
      data = await retryResponse.json();
      if (data.ok) {
        sendContext.useNativeReply = false;
      }
    }
  }

  return data;
}

function recordSendResult(chatId, data, sendContext, messageIdExtractor) {
  if (!data?.ok || !sendContext?.storeId) return;

  const messageId = messageIdExtractor(data);
  if (messageId) {
    replyStore.recordForward(sendContext.storeId, chatId, messageId);
  }
}

async function callTelegram(method, fields, files = {}, sendContext = {}) {
  const { token } = getTelegram();
  const chatIds = notifyChatIds(sendContext);
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let success = true;
  const baseFields = { ...fields };
  delete baseFields.reply_markup;
  const { replyMarkup = null } = sendContext;
  const jobId = persistSendJob(sendContext, method, baseFields, files);
  const already = outbox.deliveredSet(jobId);

  await Promise.all(
    chatIds.map(async (id) => {
      const chatId = String(id);
      if (already.has(chatId)) return;
      try {
        const form = new FormData();
        form.append('chat_id', chatId);

        const chatFields = { ...baseFields };
        const markup = replyMarkupForChat(chatId, replyMarkup);
        if (markup) chatFields.reply_markup = stripReplyMarkup(markup);

        const replyTo = sendContext.replyToByChat?.[chatId];
        if (replyTo) {
          chatFields.reply_to_message_id = replyTo;
          chatFields.allow_sending_without_reply = true;
        }

        for (const [key, value] of Object.entries(chatFields)) {
          appendFormField(form, key, value);
        }

        for (const [fieldName, filePath] of Object.entries(files)) {
          if (!filePath || !fs.existsSync(filePath)) continue;
          const buffer = fs.readFileSync(filePath);
          const file = new File([buffer], path.basename(filePath));
          form.append(fieldName, file);
        }

        const data = await postTelegramForm(url, form, sendContext, chatId);

        if (!data.ok) {
          success = false;
          console.error(`Ошибка Telegram API (${method}) для ID ${chatId}:`, data.description);
        } else {
          recordSendResult(chatId, data, sendContext, (result) => result.result?.message_id);
          outbox.markDelivered(jobId, chatId, data.result?.message_id);
        }
      } catch (error) {
        success = false;
        console.error(`Не удалось отправить в Telegram (${method}) для ID ${chatId}:`, error);
      }
    })
  );

  return success;
}

function endpointForMedia(type) {
  const map = {
    photo: { method: 'sendPhoto', field: 'photo' },
    video: { method: 'sendVideo', field: 'video' },
    voice: { method: 'sendVoice', field: 'voice' },
    audio: { method: 'sendAudio', field: 'audio' },
    sticker: { method: 'sendPhoto', field: 'photo' },
    file: { method: 'sendDocument', field: 'document' },
  };
  return map[type] || map.file;
}

async function sendPhotoGroup(message, photoFiles, isCatchUp, sendContext, meta = {}) {
  const { token } = getTelegram();
  const chatIds = notifyChatIds(sendContext);
  const caption = sendContext.outboxCaption || buildMessageText(message, isCatchUp, meta, sendContext);

  const jobId = persistSendJob(sendContext, 'sendMediaGroup', { caption, parse_mode: 'HTML' }, {}, {
    photos: photoFiles.map((photo) => photo.localPath).filter(Boolean),
  });
  const already = outbox.deliveredSet(jobId);

  await Promise.all(
    chatIds.map(async (chatId) => {
      const dest = String(chatId);
      if (already.has(dest)) return;
      try {
        const form = new FormData();
        form.append('chat_id', chatId);

        const media = photoFiles.map((photo, index) => {
          const attachName = `file${index}`;
          const buffer = fs.readFileSync(photo.localPath);
          const file = new File([buffer], path.basename(photo.localPath));
          form.append(attachName, file);

          return {
            type: 'photo',
            media: `attach://${attachName}`,
            ...(index === 0 ? { caption, parse_mode: 'HTML' } : {}),
          };
        });

        form.append('media', JSON.stringify(media));

        const replyTo = sendContext.replyToByChat?.[String(chatId)];
        if (replyTo) {
          form.append('reply_to_message_id', String(replyTo));
          form.append('allow_sending_without_reply', 'true');
        }

        const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
        const data = await postTelegramForm(url, form, sendContext, chatId);

        if (!data.ok) {
          console.error(`Ошибка sendMediaGroup для ID ${chatId}:`, data.description);
          return;
        }

        recordSendResult(chatId, data, sendContext, (result) => result.result?.[0]?.message_id);
        outbox.markDelivered(jobId, dest, data.result?.[0]?.message_id);

        const markup = replyMarkupForChat(chatId, sendContext.replyMarkup);
        if (markup) {
          await sendReplyPrompt(chatId, message, markup, token);
        }
      } catch (error) {
        console.error(`Не удалось отправить альбом для ID ${chatId}:`, error);
      }
    })
  );
}

async function sendReplyPrompt(chatId, message, replyMarkup, token) {
  const author = escapeHtml(displayAuthor(message.author) || 'сообщение');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('text', `↩️ Ответить: ${author}`);
  form.append('parse_mode', 'HTML');
  form.append('reply_markup', JSON.stringify(stripReplyMarkup(replyMarkup)));

  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json();
  if (!data.ok) {
    console.error(`Ошибка кнопки «Ответить» для ID ${chatId}:`, data.description);
  } else if (replyMarkup?._storeId && data.result?.message_id) {
    replyStore.linkTelegramMessage(chatId, data.result.message_id, replyMarkup._storeId);
  }
}

async function sendVoiceWithContext(message, voiceFile, withContext, isCatchUp, sendContext, meta = {}) {
  if (withContext) {
    const contextText = buildMessageText(message, isCatchUp, meta, sendContext);
    if (contextText.trim()) {
      await callTelegram('sendMessage', { text: contextText, parse_mode: 'HTML' }, {}, sendContext);
    }
  }

  const sendAs =
    voiceFile.sendAs ||
    (/\.(ogg|oga|opus)$/i.test(voiceFile.localPath || '') ? 'voice' : 'audio');

  if (sendAs === 'voice') {
    const ok = await callTelegram('sendVoice', {}, { voice: voiceFile.localPath }, sendContext);
    if (ok) return;
  }

  await callTelegram(
    'sendAudio',
    { title: message.author || 'voice' },
    { audio: voiceFile.localPath },
    sendContext
  );
}

async function sendSingleMedia(message, media, isCatchUp, withCaption, sendContext, meta = {}) {
  const { method, field } = endpointForMedia(media.type);
  const extra = {};

  if (withCaption && method !== 'sendVoice') {
    extra.caption = buildMessageText(message, isCatchUp, meta, sendContext);
    extra.parse_mode = 'HTML';
  }

  const context = withCaption && method !== 'sendVoice' ? sendContext : { ...sendContext, replyMarkup: null };
  await callTelegram(method, extra, { [field]: media.localPath }, context);

  if (sendContext.replyMarkup && method === 'sendVoice') {
    const { token } = getTelegram();
    const chatIds = notifyChatIds(sendContext);
    await Promise.all(
      chatIds.map((chatId) => {
        const markup = replyMarkupForChat(chatId, sendContext.replyMarkup);
        return markup ? sendReplyPrompt(chatId, message, markup, token) : null;
      })
    );
  }
}

async function sendToTelegram(message, options = {}) {
  const { isCatchUp = false, mediaFiles = [], maxChatUrl = null } = options;
  const meta = { maxChatUrl };
  const sendContext = prepareForward(message, maxChatUrl, isCatchUp);

  if (!mediaFiles.length) {
    const text = buildMessageText(message, isCatchUp, meta, sendContext);
    await callTelegram('sendMessage', { text, parse_mode: 'HTML' }, {}, sendContext);
    return;
  }

  const photos = mediaFiles.filter((m) => m.type === 'photo');
  const others = mediaFiles.filter((m) => m.type !== 'photo');
  let captionUsed = false;

  if (photos.length > 1) {
    await sendPhotoGroup(message, photos, isCatchUp, sendContext, meta);
    captionUsed = true;
  } else if (photos.length === 1) {
    await sendSingleMedia(message, photos[0], isCatchUp, true, sendContext, meta);
    captionUsed = true;
  }

  for (let i = 0; i < others.length; i++) {
    const media = others[i];

    if (media.type === 'voice' || media.type === 'audio') {
      await sendVoiceWithContext(message, media, !captionUsed, isCatchUp, sendContext, meta);
      if (!captionUsed && sendContext.replyMarkup) {
        const { token } = getTelegram();
        const chatIds = notifyChatIds(sendContext);
        await Promise.all(
          chatIds.map((chatId) => {
            const markup = replyMarkupForChat(chatId, sendContext.replyMarkup);
            return markup ? sendReplyPrompt(chatId, message, markup, token) : null;
          })
        );
      }
      captionUsed = true;
      continue;
    }

    const withCaption = !captionUsed && i === 0;
    const context =
      !captionUsed && i === 0
        ? sendContext
        : { ...sendContext, replyMarkup: null, replyToByChat: {} };
    await sendSingleMedia(message, media, isCatchUp, withCaption, context, meta);
    if (withCaption) captionUsed = true;
  }
}

async function flushTelegramOutbox() {
  if (!outbox.acquireFlushLock()) return 0;
  try {
    const jobs = outbox.listJobs();
    if (!jobs.length) return 0;

    let flushed = 0;
    for (const job of jobs) {
    const left = outbox.remainingDests(job);
    if (!left.length) {
      outbox.removeJob(job.id);
      continue;
    }

    const sendContext = {
      outboxId: job.id,
      destIds: job.destIds,
      replyMarkup: job.replyMarkup || null,
      replyToByChat: job.replyToByChat || {},
      maxChatUrl: job.maxChatUrl || '',
      storeId: job.storeId || '',
      outboxCaption: job.fields?.caption || job.text || '',
    };

    try {
      if (job.kind === 'update-done' || (job.method === 'sendMessage' && job.text && !Object.keys(job.files || {}).length)) {
        const { sendMessage } = require('./tg-api');
        for (const chatId of left) {
          try {
            const extra = job.parseMode ? { parse_mode: job.parseMode } : {};
            const data = await sendMessage(chatId, job.text, extra);
            if (data?.ok) {
              outbox.markDelivered(job.id, chatId, data.result?.message_id);
            }
          } catch (err) {
            console.warn(`outbox: не отправил в ${chatId}: ${err.message}`);
          }
        }
      } else if (job.method === 'sendMediaGroup') {
        const photos = (job.photos || [])
          .filter((filePath) => filePath && fs.existsSync(filePath))
          .map((localPath) => ({ localPath }));
        if (!photos.length) {
          outbox.removeJob(job.id);
          continue;
        }
        await sendPhotoGroup({ author: '', body: '' }, photos, false, sendContext, {
          maxChatUrl: job.maxChatUrl,
        });
      } else {
        const files = {};
        for (const [field, filePath] of Object.entries(job.files || {})) {
          if (filePath && fs.existsSync(filePath)) files[field] = filePath;
        }
        await callTelegram(job.method || 'sendMessage', job.fields || {}, files, sendContext);
      }
      flushed += 1;
    } catch (err) {
      console.warn(`outbox: задание ${job.id}: ${err.message}`);
    }
    }

    return flushed;
  } finally {
    outbox.releaseFlushLock();
  }
}

module.exports = {
  sendToTelegram,
  buildMessageText,
  buildReplyMarkup,
  prepareForward,
  flushTelegramOutbox,
};
