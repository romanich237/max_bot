const fs = require('fs');
const path = require('path');
const { File } = require('node:buffer');
const { getTelegram } = require('./config');

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

async function callTelegram(method, fields, files = {}) {
  const { token, chatIds } = getTelegram();
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let success = true;

  await Promise.all(
    chatIds.map(async (id) => {
      try {
        const form = new FormData();
        form.append('chat_id', id);

        for (const [key, value] of Object.entries(fields)) {
          if (value != null && value !== '') form.append(key, String(value));
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

async function sendPhotoGroup(message, photoFiles, isCatchUp) {
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
        }
      } catch (error) {
        console.error(`Не удалось отправить альбом для ID ${chatId}:`, error);
      }
    })
  );
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

async function sendSingleMedia(message, media, isCatchUp, withCaption) {
  const { method, field } = endpointForMedia(media.type);
  const extra = {};

  if (withCaption && method !== 'sendVoice') {
    extra.caption = buildMessageText(message, isCatchUp);
    extra.parse_mode = 'HTML';
  }

  await callTelegram(method, extra, { [field]: media.localPath });
}

async function sendToTelegram(message, options = {}) {
  const { isCatchUp = false, mediaFiles = [] } = options;

  if (!mediaFiles.length) {
    const text = buildMessageText(message, isCatchUp);
    await callTelegram('sendMessage', { text, parse_mode: 'HTML' });
    return;
  }

  const photos = mediaFiles.filter((m) => m.type === 'photo');
  const others = mediaFiles.filter((m) => m.type !== 'photo');
  let captionUsed = false;

  if (photos.length > 1) {
    await sendPhotoGroup(message, photos, isCatchUp);
    captionUsed = true;
  } else if (photos.length === 1) {
    await sendSingleMedia(message, photos[0], isCatchUp, true);
    captionUsed = true;
  }

  for (let i = 0; i < others.length; i++) {
    const media = others[i];

    if (media.type === 'voice') {
      await sendVoiceWithContext(message, media, !captionUsed, isCatchUp);
      captionUsed = true;
      continue;
    }

    const withCaption = !captionUsed && i === 0;
    await sendSingleMedia(message, media, isCatchUp, withCaption);
    if (withCaption) captionUsed = true;
  }
}

module.exports = { sendToTelegram, buildMessageText };
