const fs = require('fs');
const path = require('path');
const { File } = require('node:buffer');
const { getTelegram } = require('./config');
const replyStore = require('./reply-store');

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatReply(reply) {
  if (!reply) return '';

  const author = reply.author ? escapeHtml(reply.author) : 'сообщение';
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

function buildMessageText(message, isCatchUp = false) {
  const telegram = getTelegram();
  const showTime = telegram.showTime ?? false;
  const showServiceHeader = telegram.showServiceHeader ?? false;
  const parts = [];

  if (showServiceHeader) {
    parts.push(
      isCatchUp
        ? '📩 <b>Сообщение из MAX</b> <i>(при старте)</i>'
        : '📩 <b>Новое сообщение из MAX</b>',
      ''
    );
  }

  parts.push(`<b>${escapeHtml(message.author || 'Неизвестно')}</b>`);

  const replyText = formatReply(message.reply);
  if (replyText) parts.push(replyText);

  if (message.body) parts.push(escapeHtml(message.body));

  if (showTime && message.time) {
    parts.push(`<i>${escapeHtml(message.time)}</i>`);
  }

  return parts.filter((p) => p !== '').join('\n');
}

function isPrivateChat(chatId) {
  return Number(chatId) > 0;
}

function replyMarkupForChat(chatId, replyMarkup) {
  return replyMarkup && isPrivateChat(chatId) ? replyMarkup : null;
}

function buildReplyMarkup(message) {
  const id = replyStore.put(message);
  return {
    inline_keyboard: [[{ text: '↩️ Ответить', callback_data: `reply:${id}` }]],
  };
}

function appendFormField(form, key, value) {
  if (value == null || value === '') return;
  if (key === 'reply_markup') {
    form.append(key, JSON.stringify(value));
  } else {
    form.append(key, String(value));
  }
}

async function callTelegram(method, fields, files = {}, replyMarkup = null) {
  const { token, chatIds } = getTelegram();
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let success = true;
  const baseFields = { ...fields };
  delete baseFields.reply_markup;

  await Promise.all(
    chatIds.map(async (id) => {
      try {
        const form = new FormData();
        form.append('chat_id', id);

        const chatFields = { ...baseFields };
        const markup = replyMarkupForChat(id, replyMarkup);
        if (markup) chatFields.reply_markup = markup;

        for (const [key, value] of Object.entries(chatFields)) {
          appendFormField(form, key, value);
        }

        for (const [fieldName, filePath] of Object.entries(files)) {
          const buffer = fs.readFileSync(filePath);
          const file = new File([buffer], path.basename(filePath));
          form.append(fieldName, file);
        }

        const response = await fetch(url, { method: 'POST', body: form });
        const data = await response.json();

        if (!data.ok) {
          success = false;
          console.error(`Ошибка Telegram API (${method}) для ID ${id}:`, data.description);
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

async function sendPhotoGroup(message, photoFiles, isCatchUp, replyMarkup) {
  const { token, chatIds } = getTelegram();
  const caption = buildMessageText(message, isCatchUp);

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

        const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
        const response = await fetch(url, { method: 'POST', body: form });
        const data = await response.json();

        if (!data.ok) {
          console.error(`Ошибка sendMediaGroup для ID ${chatId}:`, data.description);
          return;
        }

        const markup = replyMarkupForChat(chatId, replyMarkup);
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
  form.append('reply_markup', JSON.stringify(replyMarkup));

  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json();
  if (!data.ok) {
    console.error(`Ошибка кнопки «Ответить» для ID ${chatId}:`, data.description);
  }
}

async function sendVoiceWithContext(message, voiceFile, withContext, isCatchUp) {
  if (withContext) {
    const contextText = buildMessageText(message, isCatchUp);
    if (contextText.trim()) {
      await callTelegram('sendMessage', { text: contextText, parse_mode: 'HTML' });
    }
  }

  const { method, field } = endpointForMedia('voice');
  const ok = await callTelegram(method, {}, { [field]: voiceFile.localPath });

  if (!ok) {
    await callTelegram('sendAudio', { title: message.author || 'voice' }, {
      audio: voiceFile.localPath,
    });
  }
}

async function sendSingleMedia(message, media, isCatchUp, withCaption, replyMarkup) {
  const { method, field } = endpointForMedia(media.type);
  const extra = {};

  if (withCaption && method !== 'sendVoice') {
    extra.caption = buildMessageText(message, isCatchUp);
    extra.parse_mode = 'HTML';
  }

  const markup = withCaption && method !== 'sendVoice' ? replyMarkup : null;
  await callTelegram(method, extra, { [field]: media.localPath }, markup);

  if (replyMarkup && method === 'sendVoice') {
    const { token, chatIds } = getTelegram();
    await Promise.all(
      chatIds
        .filter(isPrivateChat)
        .map((chatId) => sendReplyPrompt(chatId, message, replyMarkup, token))
    );
  }
}

async function sendToTelegram(message, options = {}) {
  const { isCatchUp = false, mediaFiles = [] } = options;
  const replyMarkup = isCatchUp ? null : buildReplyMarkup(message);

  if (!mediaFiles.length) {
    const text = buildMessageText(message, isCatchUp);
    await callTelegram('sendMessage', { text, parse_mode: 'HTML' }, {}, replyMarkup);
    return;
  }

  const photos = mediaFiles.filter((m) => m.type === 'photo');
  const others = mediaFiles.filter((m) => m.type !== 'photo');
  let captionUsed = false;

  if (photos.length > 1) {
    await sendPhotoGroup(message, photos, isCatchUp, replyMarkup);
    captionUsed = true;
  } else if (photos.length === 1) {
    await sendSingleMedia(message, photos[0], isCatchUp, true, replyMarkup);
    captionUsed = true;
  }

  for (let i = 0; i < others.length; i++) {
    const media = others[i];

    if (media.type === 'voice') {
      await sendVoiceWithContext(message, media, !captionUsed, isCatchUp);
      if (!captionUsed && replyMarkup) {
        const { token, chatIds } = getTelegram();
        await Promise.all(
          chatIds
            .filter(isPrivateChat)
            .map((chatId) => sendReplyPrompt(chatId, message, replyMarkup, token))
        );
      }
      captionUsed = true;
      continue;
    }

    const withCaption = !captionUsed && i === 0;
    const markup = !captionUsed && i === 0 ? replyMarkup : null;
    await sendSingleMedia(message, media, isCatchUp, withCaption, markup);
    if (withCaption) captionUsed = true;
  }
}

module.exports = { sendToTelegram, buildMessageText, buildReplyMarkup };
