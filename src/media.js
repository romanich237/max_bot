const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getSettings } = require('./config');

function dataDir() {
  return getSettings().dataDir;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(text) {
  return (text || 'unknown')
    .replace(/[^\w\u0400-\u04FF.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40);
}

function extForType(type, url = '', fileName = '') {
  if (type === 'sticker') return 'png';

  const fromName = path.extname(String(fileName || '')).slice(1).toLowerCase();
  if (fromName && fromName.length <= 8) return fromName;

  try {
    const fromUrl = path.extname(new URL(url, 'https://x').pathname).slice(1).toLowerCase();
    if (fromUrl && fromUrl.length <= 8) return fromUrl;
  } catch {
    /* ignore */
  }

  const map = {
    voice: 'ogg',
    photo: 'jpg',
    video: 'mp4',
    file: 'bin',
  };
  return map[type] || 'bin';
}

function sanitizeSendName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180);
}

function buildFilePath(message, media, index) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(dataDir(), day);
  ensureDir(dir);

  const hash = crypto
    .createHash('md5')
    .update(`${message.key}::${media.type}::${index}::${media.fileName || media.url || ''}`)
    .digest('hex')
    .slice(0, 8);

  const original = sanitizeSendName(media.fileName);
  const ext = `.${extForType(media.type, media.url, original)}`;
  const stem = original ? path.basename(original, path.extname(original)) : `${safeName(message.author)}_${media.type}`;
  const fileName = `${safeName(stem)}_${hash}${ext}`;
  return path.join(dir, fileName);
}

function stableMediaUrl(url) {
  const raw = String(url || '');
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    const path = parsed.pathname || '';
    if (/\.[a-z0-9]{2,5}$/i.test(path) || /\/[a-f0-9-]{16,}(?:\/|$)/i.test(path)) {
      return `${parsed.origin}${path}`;
    }

    const params = new URLSearchParams(parsed.search);
    for (const key of [...params.keys()]) {
      if (/^(x-amz-|sig|signature|expires|expiry|token|hash|ttl|ts|e|st|exp)/i.test(key)) {
        params.delete(key);
      }
    }
    const query = params.toString();
    return `${parsed.origin}${path}${query ? `?${query}` : ''}`;
  } catch {
    return raw.split('?')[0].split('#')[0];
  }
}

function buildMediaKey(media) {
  if (!media?.length) return '';
  return media
    .map((item) => {
      if (item.stickerId) return `sticker:${item.stickerId}`;
      if (item.url) return `${item.type}:${stableMediaUrl(item.url)}`;
      if (item.fileName) return `${item.type}:${String(item.fileName).toLowerCase()}`;
      if (item.duration) return `voice:${item.duration}`;
      return item.type;
    })
    .join('|');
}

function mediaLabel(media) {
  const labels = {
    voice: 'голосовое',
    photo: 'фото',
    video: 'видео',
    file: 'файл',
    sticker: 'стикер',
  };
  if (media.type === 'file' && media.fileName) {
    return media.fileName;
  }
  const base = labels[media.type] || 'медиа';
  return media.duration ? `${base} ${media.duration}` : base;
}

function bodyWithMedia(body, media) {
  if (body && !media?.length) return body;
  if (body && media?.length) return body;

  if (!media?.length) return body || '';

  if (media.length === 1) return `[${mediaLabel(media[0])}]`;
  return `[${media.length} вложения]`;
}

function sniffAudioExt(filePath) {
  try {
    const buf = fs.readFileSync(filePath).subarray(0, 16);
    if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
      return 'ogg';
    }
    if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
    if (buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
    if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
    if (buf.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  } catch {
    /* ignore */
  }
  return '';
}

function convertToOpus(filePath) {
  const outPath = filePath.replace(/\.[^.]+$/, '.ogg');
  if (/\.(ogg|oga|opus)$/i.test(filePath) && sniffAudioExt(filePath) === 'ogg') {
    return filePath;
  }

  const result = spawnSync(
    'ffmpeg',
    ['-y', '-i', filePath, '-c:a', 'libopus', '-b:a', '48k', '-vn', outPath],
    { encoding: 'utf8', timeout: 60000 }
  );
  if (result.error || result.status !== 0) return '';
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return outPath;
  }
  return '';
}

function prepareOutgoingAudio(filePath) {
  let current = filePath;
  const sniffed = sniffAudioExt(filePath);
  if (sniffed) {
    const renamed = filePath.replace(/\.[^.]+$/, `.${sniffed}`);
    if (renamed !== filePath) {
      try {
        fs.renameSync(filePath, renamed);
        current = renamed;
      } catch {
        current = filePath;
      }
    }
  }

  const opus = convertToOpus(current);
  if (opus) {
    return { localPath: opus, sendAs: 'voice' };
  }

  return {
    localPath: current,
    sendAs: /\.(ogg|oga|opus)$/i.test(current) ? 'voice' : 'audio',
  };
}

async function downloadFromUrl(page, url, filePath) {
  const response = await page.request.get(url);
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} для ${url.slice(0, 80)}`);
  }
  fs.writeFileSync(filePath, await response.body());
  return filePath;
}

async function downloadBlob(page, blobUrl, filePath) {
  const buffer = await page.evaluate(async (url) => {
    const response = await fetch(url);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return Array.from(new Uint8Array(arrayBuffer));
  }, blobUrl);

  fs.writeFileSync(filePath, Buffer.from(buffer));
  return filePath;
}

function isAudioResponse(url, contentType) {
  const type = (contentType || '').toLowerCase();
  return (
    type.includes('audio') ||
    type.includes('mpeg') ||
    type.includes('ogg') ||
    type.includes('mp4') ||
    /voice|audio|\.oga|\.ogg|\.mp3|\.m4a/i.test(url)
  );
}

async function downloadVoice(page, wrapperIndex, filePath) {
  const audioUrl = await new Promise((resolve) => {
    let resolved = false;
    const candidates = [];

    const tryResolve = () => {
      if (resolved || !candidates.length) return;
      resolved = true;
      page.off('response', onResponse);
      resolve(candidates[candidates.length - 1]);
    };

    const onResponse = (response) => {
      const url = response.url();
      const type = response.headers()['content-type'] || '';
      if (isAudioResponse(url, type) && response.ok()) {
        candidates.push(url);
        tryResolve();
      }
    };

    page.on('response', onResponse);

    page
      .evaluate(({ idx, sel }) => {
        const opened = document.querySelector('.openedChat');
        const wrappers = opened
          ? opened.querySelectorAll('.messageWrapper')
          : document.querySelectorAll(sel);
        const wrapper = wrappers[idx];
        if (!wrapper) return;

        const play = wrapper.querySelector('.attachAudio .button');
        if (play) {
          play.click();
          return;
        }

        const audioLink = wrapper.querySelector(
          'a[href*=".m4a"], a[href*=".mp3"], a[href*=".ogg"], a[href*=".aac"], a[href*=".opus"], a[download]'
        );
        if (audioLink) {
          audioLink.click();
          return;
        }

        const downloadBtn = [...wrapper.querySelectorAll('a, button')].find((el) =>
          /скачать|download/i.test(el.innerText || el.getAttribute('aria-label') || '')
        );
        downloadBtn?.click();
      }, { idx: wrapperIndex, sel: '.messageWrapper' })
      .catch(() => {});

    setTimeout(() => {
      if (!resolved) {
        page.off('response', onResponse);
        resolve(candidates.length ? candidates[candidates.length - 1] : null);
      }
    }, 15000);
  });

  if (audioUrl) {
    if (audioUrl.startsWith('blob:')) {
      await downloadBlob(page, audioUrl, filePath);
    } else {
      await downloadFromUrl(page, audioUrl, filePath);
    }
    return filePath;
  }

  const audioSrc = await page.evaluate(({ idx, sel }) => {
    const opened = document.querySelector('.openedChat');
    const wrappers = opened
      ? opened.querySelectorAll('.messageWrapper')
      : document.querySelectorAll(sel);
    const wrapper = wrappers[idx];
    const audio = wrapper?.querySelector('audio');
    return audio?.src || audio?.currentSrc || null;
  }, { idx: wrapperIndex, sel: '.messageWrapper' });

  if (audioSrc) {
    if (audioSrc.startsWith('blob:')) {
      await downloadBlob(page, audioSrc, filePath);
    } else {
      await downloadFromUrl(page, audioSrc, filePath);
    }
    return filePath;
  }

  throw new Error('не удалось получить URL голосового');
}

async function downloadSticker(page, wrapperIndex, filePath) {
  const opened = page.locator('.openedChat .messageWrapper');
  const wrappers = (await opened.count()) > 0 ? opened : page.locator('.messageWrapper');
  const sticker = wrappers.nth(wrapperIndex).locator('.sticker[data-testid]').first();

  if ((await sticker.count()) === 0) {
    throw new Error('стикер не найден в DOM');
  }

  const pngPath = filePath.replace(/\.[^.]+$/, '.png');
  ensureDir(path.dirname(pngPath));
  await sticker.screenshot({ path: pngPath, type: 'png' });
  return pngPath;
}

function isDirectFileUrl(url) {
  const raw = String(url || '');
  if (!raw || raw.startsWith('javascript:') || raw.startsWith('blob:')) return false;
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk|json|bin)(\?|$)/i.test(raw)) return true;
  return /oneme\.ru|max\.ru\/.+download/i.test(raw);
}

function isBinaryFileResponse(response, fileName) {
  const url = response.url();
  const headers = response.headers();
  const type = String(headers['content-type'] || '').toLowerCase();
  const disposition = String(headers['content-disposition'] || '').toLowerCase();
  if (disposition.includes('attachment') || disposition.includes('filename')) return true;
  if (/text\/html|text\/css|javascript|application\/json|image\/svg/i.test(type)) return false;
  const name = String(fileName || '').toLowerCase();
  const ext = path.extname(name).toLowerCase();
  if (ext && (url.toLowerCase().includes(ext) || decodeURIComponent(url).toLowerCase().includes(ext))) {
    return true;
  }
  if (name && disposition.includes(name)) return true;
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|apk|txt)(\?|$)/i.test(url)) return true;
  return /application\/pdf|octet-stream|msword|spreadsheet|officedocument|presentationml|zip|rar/i.test(type);
}

async function clickFileCard(page, wrapperIndex, fileName) {
  const opened = page.locator('.openedChat .messageWrapper');
  const list = (await opened.count()) > 0 ? opened : page.locator('.messageWrapper');
  const wrap = list.nth(wrapperIndex);
  await wrap.scrollIntoViewIfNeeded().catch(() => {});

  const cards = wrap.locator(
    '.attaches button, .attaches a, [class*="attachFile"], [class*="attachDoc"], button[aria-label*="качать" i], button[aria-label*="download" i]'
  );
  const named = fileName ? cards.filter({ hasText: fileName }) : cards;
  const target = (await named.count()) ? named.first() : cards.first();
  if (await target.count()) {
    try {
      await target.click({ force: true, timeout: 4000 });
      return true;
    } catch {
      /* evaluate fallback */
    }
  }

  return page.evaluate(
    ({ idx, sel, fileName }) => {
      const opened = document.querySelector('.openedChat');
      const wrappers = opened?.querySelectorAll('.messageWrapper')?.length
        ? opened.querySelectorAll('.messageWrapper')
        : document.querySelectorAll(sel);
      const wrapper = wrappers[idx];
      if (!wrapper) return false;
      const cards = [
        ...wrapper.querySelectorAll(
          '.attaches button, .attaches a, [class*="attachFile"], [class*="attachDoc"]'
        ),
      ];
      const needle = String(fileName || '').toLowerCase();
      const match =
        cards.find((el) => needle && String(el.innerText || '').toLowerCase().includes(needle)) ||
        cards[0];
      if (!match) return false;
      match.click();
      return true;
    },
    { idx: wrapperIndex, sel: '.messageWrapper', fileName: fileName || '' }
  );
}

async function downloadFileAttachment(page, wrapperIndex, filePath, fileName) {
  if (wrapperIndex < 0) {
    throw new Error('карточка файла не найдена в DOM');
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);

  const urlPromise = new Promise((resolve) => {
    let resolved = false;
    const finish = (url) => {
      if (resolved) return;
      resolved = true;
      page.off('response', onResponse);
      resolve(url);
    };
    const onResponse = (response) => {
      if (response.ok() && isBinaryFileResponse(response, fileName)) {
        finish(response.url());
      }
    };
    page.on('response', onResponse);
    setTimeout(() => finish(null), 20000);
  });

  const clicked = await clickFileCard(page, wrapperIndex, fileName);
  if (!clicked) {
    throw new Error('кнопка скачивания файла не найдена');
  }

  const download = await downloadPromise;
  if (download) {
    await download.saveAs(filePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      return filePath;
    }
  }

  const url = await urlPromise;
  if (url) {
    if (url.startsWith('blob:')) {
      await downloadBlob(page, url, filePath);
    } else {
      await downloadFromUrl(page, url, filePath);
    }
    return filePath;
  }

  throw new Error('не удалось скачать файл');
}

async function findWrapperIndex(page, message, wrapperSelector) {
  const fileNames = (message.media || [])
    .map((item) => String(item.fileName || '').trim())
    .filter(Boolean);
  const index = await page.evaluate(
    ({ author, body, time, reply, fileNames, wrapperSelector: sel }) => {
      const wrappers = (() => {
        const opened = document.querySelector('.openedChat');
        if (opened) {
          const inner = opened.querySelectorAll('.messageWrapper');
          if (inner.length) return inner;
        }
        return document.querySelectorAll(sel);
      })();
      const norm = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      const needle = norm(body);
      const authorNeedle = norm(author);
      const replyNeedle = norm(reply?.body);
      const fileNeedles = (fileNames || []).map(norm).filter(Boolean);

      for (let i = wrappers.length - 1; i >= 0; i--) {
        const text = norm(wrappers[i].innerText || '');

        if (fileNeedles.some((name) => name && text.includes(name))) {
          if (!authorNeedle || text.includes(authorNeedle) || wrappers[i].querySelector('.fileIcon, [class*="attachFile"], [class*="attachDoc"]')) {
            return i;
          }
        }

        if (needle && authorNeedle && text.includes(needle) && text.includes(authorNeedle)) {
          return i;
        }

        if (
          replyNeedle &&
          authorNeedle &&
          text.includes(replyNeedle) &&
          text.includes(authorNeedle)
        ) {
          return i;
        }

        if (needle && text.includes(needle)) return i;

        if (authorNeedle && /голосовое|m4a|mp3|ogg|скачать/.test(`${needle} ${text}`)) {
          if (text.includes(authorNeedle) && /m4a|mp3|ogg|голосовое|скачать|attach/.test(text)) {
            return i;
          }
        }

        if (time && text.includes(time) && needle && text.includes(needle.slice(0, 20))) {
          return i;
        }
      }
      return -1;
    },
    {
      author: message.author,
      body: message.body,
      time: message.time,
      reply: message.reply,
      fileNames,
      wrapperSelector,
    }
  );

  return index;
}

function voiceDurationOf(message) {
  return String((message.media || []).find((item) => item.duration)?.duration || '').trim();
}

function isVoicePlaceholder(text) {
  return /^\s*\[голосовое(?:\s+\d{1,2}:\d{2})?\]\s*$/i.test(String(text || '').trim());
}

function transcriptTimeoutMs(message) {
  const match = voiceDurationOf(message).match(/(\d+):(\d{2})/);
  const sec = match ? Number(match[1]) * 60 + Number(match[2]) : 20;
  return Math.min(90000, Math.max(25000, 12000 + sec * 800));
}

async function resolveVoiceWrapperIndex(page, message, wrapperSelector) {
  const sel = wrapperSelector || '.messageWrapper';
  const hinted = Number.isInteger(message.index) ? message.index : -1;
  const duration = voiceDurationOf(message);
  return page.evaluate(
    ({ hinted, author, duration, body, sel }) => {
      const opened = document.querySelector('.openedChat');
      const wrappers = opened?.querySelectorAll('.messageWrapper')?.length
        ? opened.querySelectorAll('.messageWrapper')
        : document.querySelectorAll(sel);
      const hasAudio = (node) => Boolean(node?.querySelector('.attachAudio, [class*="attachAudio"]'));
      if (hinted >= 0 && hasAudio(wrappers[hinted])) return hinted;

      const norm = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      const authorNeedle = norm(author);
      const durationNeedle = norm(duration).replace(/^0/, '');
      const bodyNeedle = norm(body);

      for (let i = wrappers.length - 1; i >= 0; i--) {
        if (!hasAudio(wrappers[i])) continue;
        const text = norm(wrappers[i].innerText || '');
        if (authorNeedle && !text.includes(authorNeedle)) continue;
        if (durationNeedle && text.includes(durationNeedle)) return i;
        if (bodyNeedle && /голосовое/.test(bodyNeedle) && /голосовое|\d+:\d{2}/.test(text)) return i;
        if (authorNeedle) return i;
      }
      return -1;
    },
    {
      hinted,
      author: message.author,
      duration,
      body: message.body,
      sel,
    }
  );
}

async function readVoiceTranscript(page, wrapperIndex, wrapperSelector, duration) {
  return page.evaluate(
    ({ idx, sel, duration }) => {
      const opened = document.querySelector('.openedChat');
      const wrappers = opened?.querySelectorAll('.messageWrapper')?.length
        ? opened.querySelectorAll('.messageWrapper')
        : document.querySelectorAll(sel);
      const wrapper = wrappers[idx];
      if (!wrapper) return '';

      const noise = (value) => {
        const text = String(value || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text) return true;
        if (/^голосовое(\s+сообщение)?$/i.test(text)) return true;
        if (/^\[\s*голосовое/i.test(text)) return true;
        if (/^\d{1,2}:\d{2}(\s*(AM|PM))?$/i.test(text)) return true;
        if (duration && text === String(duration).trim()) return true;
        if (/^(расшифровк|распознаван|загрузк|секунду|подождите|транскрип)/i.test(text)) return true;
        return false;
      };

      const bubble = wrapper.querySelector('.bubbleContent') || wrapper;
      const audio = wrapper.querySelector('.attachAudio, [class*="attachAudio"]');
      const chunks = [];

      for (const el of bubble.querySelectorAll('.text, [class*="transcript"], [class*="Transcript"], p')) {
        if (el.closest('.meta, .header, .mark, button, .wave, .duration')) continue;
        const text = String(el.innerText || '').trim();
        if (!noise(text)) chunks.push(text);
      }

      if (!chunks.length) {
        const lines = String(bubble.innerText || '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !noise(line));
        if (lines.length) return lines.join('\n').trim();
      }

      return [...new Set(chunks)].join('\n').trim();
    },
    { idx: wrapperIndex, sel: wrapperSelector || '.messageWrapper', duration: duration || '' }
  );
}

async function clickVoiceTranscribe(page, wrapperIndex, wrapperSelector) {
  const sel = wrapperSelector || '.messageWrapper';
  const opened = page.locator('.openedChat .messageWrapper');
  const list = (await opened.count()) > 0 ? opened : page.locator(sel);
  const wrap = list.nth(wrapperIndex);
  await wrap.scrollIntoViewIfNeeded().catch(() => {});

  const transcribe = wrap.locator('.attachAudio button.button--inside, [class*="attachAudio"] button.button--inside').first();
  if (await transcribe.count()) {
    try {
      await transcribe.click({ force: true, timeout: 2500 });
      return true;
    } catch {
      /* evaluate fallback */
    }
  }

  return page.evaluate(
    ({ idx, sel }) => {
      const opened = document.querySelector('.openedChat');
      const wrappers = opened?.querySelectorAll('.messageWrapper')?.length
        ? opened.querySelectorAll('.messageWrapper')
        : document.querySelectorAll(sel);
      const audio = wrappers[idx]?.querySelector('.attachAudio, [class*="attachAudio"]');
      const btn =
        audio?.querySelector('button.button--inside') ||
        audio?.querySelector('button.button--start') ||
        [...(audio?.querySelectorAll('button') || [])].find(
          (el) => !el.querySelector('use[href*="play"]') && !el.querySelector('[href*="icon_play"]')
        );
      if (!btn) return false;
      btn.click();
      return true;
    },
    { idx: wrapperIndex, sel }
  );
}

async function transcribeVoiceMessage(page, message, wrapperSelector) {
  const hasVoice = (message.media || []).some((item) => item.type === 'voice' || item.type === 'audio');
  if (!hasVoice && !isVoicePlaceholder(message.body)) return '';

  const sel = wrapperSelector || '.messageWrapper';
  const idx = await resolveVoiceWrapperIndex(page, message, sel);
  if (idx < 0) {
    console.warn('голосовое: сообщение не найдено в DOM');
    return '';
  }

  const duration = voiceDurationOf(message);
  const existing = await readVoiceTranscript(page, idx, sel, duration);
  if (existing) return existing;

  const clicked = await clickVoiceTranscribe(page, idx, sel);
  if (!clicked) {
    console.warn('голосовое: кнопка расшифровки не найдена');
    return '';
  }

  const deadline = Date.now() + transcriptTimeoutMs(message);
  while (Date.now() < deadline) {
    const text = await readVoiceTranscript(page, idx, sel, duration);
    if (text) {
      console.log(`  📝 расшифровка: ${text.slice(0, 120)}`);
      return text;
    }
    await page.waitForTimeout(500);
  }

  console.warn('голосовое: расшифровка не появилась');
  return '';
}

async function enrichVoiceTranscript(page, message, wrapperSelector) {
  const hasVoice = (message.media || []).some((item) => item.type === 'voice');
  if (!hasVoice) return message;

  try {
    const text = await transcribeVoiceMessage(page, message, wrapperSelector);
    if (!text) return message;
    const duration = voiceDurationOf(message);
    const tag = duration ? `[голосовое ${duration}]` : '[голосовое]';
    return { ...message, body: `${tag}\n${text}` };
  } catch (err) {
    console.warn('голосовое: расшифровка —', err.message);
    return message;
  }
}

async function downloadMediaItem(page, message, media, index, wrapperSelector) {
  const filePath = buildFilePath(message, media, index);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    if (media.type === 'voice') {
      const prepared = prepareOutgoingAudio(filePath);
      return { ...media, localPath: prepared.localPath, sendAs: prepared.sendAs };
    }
    return withSendName(media, filePath);
  }

  if (media.url && (media.type !== 'file' || isDirectFileUrl(media.url))) {
    await downloadFromUrl(page, media.url, filePath);
    if (media.type === 'voice') {
      const prepared = prepareOutgoingAudio(filePath);
      return { ...media, localPath: prepared.localPath, sendAs: prepared.sendAs };
    }
    return withSendName(media, filePath);
  }

  const wrapperIndex = Number.isInteger(message.index) && message.index >= 0
    ? message.index
    : await findWrapperIndex(page, message, wrapperSelector);

  if (media.type === 'voice') {
    await downloadVoice(page, wrapperIndex, filePath);
    const prepared = prepareOutgoingAudio(filePath);
    return { ...media, localPath: prepared.localPath, sendAs: prepared.sendAs };
  }

  if (media.type === 'sticker') {
    const saved = await downloadSticker(page, wrapperIndex, filePath);
    return { ...media, localPath: saved };
  }

  if (media.type === 'file') {
    await downloadFileAttachment(page, wrapperIndex, filePath, media.fileName);
    return withSendName(media, filePath);
  }

  throw new Error(`нет URL для ${media.type}`);
}

function withSendName(media, filePath) {
  return {
    ...media,
    localPath: filePath,
    fileName: sanitizeSendName(media.fileName) || path.basename(filePath),
  };
}

async function downloadMessageMedia(page, message, wrapperSelector) {
  if (!message.media?.length) return [];

  ensureDir(dataDir());
  const saved = [];

  for (let i = 0; i < message.media.length; i++) {
    if (message.media[i].type === 'voice') continue;
    try {
      const item = await downloadMediaItem(page, message, message.media[i], i, wrapperSelector);
      if (item?.localPath && fs.existsSync(item.localPath)) {
        const size = fs.statSync(item.localPath).size;
        if (size > 49 * 1024 * 1024) {
          console.error(`  ⚠️ файл слишком большой для Telegram (${item.fileName || item.type}): ${size} байт`);
          continue;
        }
      }
      saved.push(item);
      console.log(`  💾 ${item.type}${item.fileName ? ` ${item.fileName}` : ''} → ${item.localPath}`);
    } catch (err) {
      console.error(`  ⚠️ не скачано (${message.media[i].type}${message.media[i].fileName ? ` ${message.media[i].fileName}` : ''}): ${err.message}`);
    }
  }

  return saved;
}

module.exports = {
  buildMediaKey,
  bodyWithMedia,
  downloadMessageMedia,
  mediaLabel,
  findWrapperIndex,
  transcribeVoiceMessage,
  enrichVoiceTranscript,
  isVoicePlaceholder,
};
