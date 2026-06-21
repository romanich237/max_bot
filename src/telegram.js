const fs = require('fs');
const path = require('path');
const { File } = require('node:buffer');
const { getTelegram, getNotificationChatIds, getMaxDisplayName } = require('./config');
const { isOwnByAuthor } = require('./parser');
const { chatLabelFromUrl } = require('./max-chats');
const replyStore = require('./reply-store');

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

function buildMessageText(message, isCatchUp = false, meta = {}, sendContext = {}) {
  const telegram = getTelegram();
  const showTime = telegram.showTime ?? false;
  const showServiceHeader = telegram.showServiceHeader ?? false;
  const parts = [];

  if (meta.maxChatUrl) {
    parts.push(`📁 <b>${escapeHtml(chatLabelFromUrl(meta.maxChatUrl))}</b>`, '');
  }

  if (showServiceHeader) {
    const maxName = getMaxDisplayName();
    const account = maxName ? ` · <code>${escapeHtml(maxName)}</code>` : '';
    parts.push(
      isCatchUp
        ? `📩 <b>Сообщение из MAX</b>${account}`
        : `📩 <b>Новое сообщение из MAX</b>${account}`,
      ''
    );
  }

  parts.push(`<b>${escapeHtml(message.author || 'Неизвестно')}</b>`);

  if (!sendContext.useNativeReply) {
    const replyText = formatReply(message.reply);
    if (replyText) parts.push(replyText);
  }

  if (message.body) parts.push(escapeHtml(message.body));

  if (showTime && message.time) {
    parts.push(`<i>${escapeHtml(message.time)}</i>`);
  }

  return parts.filter((p) => p !== '').join('\n');
}

function replyMarkupForChat(chatId, replyMarkup) {
  return replyMarkup || null;
}

function prepareForward(message, maxChatUrl, isCatchUp) {
  const storeId = replyStore.put(message, maxChatUrl);
  const chatIds = getNotificationChatIds();
  const replyToByChat = replyStore.resolveReplyToByChat(maxChatUrl, message.reply, chatIds);
  const useNativeReply = Boolean(message.reply && Object.keys(replyToByChat).length);
  const replyMarkup = isCatchUp
    ? null
    : {
        _storeId: storeId,
        inline_keyboard: [[{ text: '↩️ Ответить', callback_data: `reply:${storeId}` }]],
      };

  return { storeId, replyToByChat, useNativeReply, replyMarkup };
}

function buildReplyMarkup(message, maxChatUrl) {
  const storeId = replyStore.put(message, maxChatUrl);
  return {
    _storeId: storeId,
    inline_keyboard: [[{ text: '↩️ Ответить', callback_data: `reply:${storeId}` }]],
  };
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
  const chatIds = getNotificationChatIds();
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let success = true;
  const baseFields = { ...fields };
  delete baseFields.reply_markup;
  const { replyMarkup = null } = sendContext;

  await Promise.all(
    chatIds.map(async (id) => {
      try {
        const form = new FormData();
        form.append('chat_id', id);

        const chatFields = { ...baseFields };
        const markup = replyMarkupForChat(id, replyMarkup);
        if (markup) chatFields.reply_markup = stripReplyMarkup(markup);

        const replyTo = sendContext.replyToByChat?.[String(id)];
        if (replyTo) chatFields.reply_to_message_id = replyTo;

        for (const [key, value] of Object.entries(chatFields)) {
          appendFormField(form, key, value);
        }

        for (const [fieldName, filePath] of Object.entries(files)) {
          const buffer = fs.readFileSync(filePath);
          const file = new File([buffer], path.basename(filePath));
          form.append(fieldName, file);
        }

        const data = await postTelegramForm(url, form, sendContext, id);

        if (!data.ok) {
          success = false;
          console.error(`Ошибка Telegram API (${method}) для ID ${id}:`, data.description);
        } else {
          recordSendResult(id, data, sendContext, (result) => result.result?.message_id);
        }
      } catch (error) {
        success = false;
        console.error(`Не удалось отправить в Telegram (${method}) для ID ${id}:`, error);
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
    sticker: { method: 'sendPhoto', field: 'photo' },
    file: { method: 'sendDocument', field: 'document' },
  };
  return map[type] || map.file;
}

async function sendPhotoGroup(message, photoFiles, isCatchUp, sendContext, meta = {}) {
  const { token } = getTelegram();
  const chatIds = getNotificationChatIds();
  const caption = buildMessageText(message, isCatchUp, meta, sendContext);

  await Promise.all(
    chatIds.map(async (chatId) => {
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
        if (replyTo) form.append('reply_to_message_id', String(replyTo));

        const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
        const data = await postTelegramForm(url, form, sendContext, chatId);

        if (!data.ok) {
          console.error(`Ошибка sendMediaGroup для ID ${chatId}:`, data.description);
          return;
        }

        recordSendResult(chatId, data, sendContext, (result) => result.result?.[0]?.message_id);

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
  const author = escapeHtml(message.author || 'Неизвестно');
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

  const { method, field } = endpointForMedia('voice');
  const ok = await callTelegram(method, {}, { [field]: voiceFile.localPath }, sendContext);

  if (!ok) {
    await callTelegram('sendAudio', { title: message.author || 'voice' }, { audio: voiceFile.localPath }, sendContext);
  }
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
    const chatIds = getNotificationChatIds();
    await Promise.all(
      chatIds.map((chatId) => sendReplyPrompt(chatId, message, sendContext.replyMarkup, token))
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

    if (media.type === 'voice') {
      await sendVoiceWithContext(message, media, !captionUsed, isCatchUp, sendContext, meta);
      if (!captionUsed && sendContext.replyMarkup) {
        const { token } = getTelegram();
        const chatIds = getNotificationChatIds();
        await Promise.all(
          chatIds.map((chatId) => sendReplyPrompt(chatId, message, sendContext.replyMarkup, token))
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

module.exports = { sendToTelegram, buildMessageText, buildReplyMarkup, prepareForward };
