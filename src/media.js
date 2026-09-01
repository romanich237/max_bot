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

function extForType(type, url = '') {
  if (type === 'sticker') return 'png';

  try {
    const fromUrl = path.extname(new URL(url, 'https://x').pathname).slice(1).toLowerCase();
    if (fromUrl && fromUrl.length <= 5) return fromUrl;
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

function buildFilePath(message, media, index) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(dataDir(), day);
  ensureDir(dir);

  const hash = crypto
    .createHash('md5')
    .update(`${message.key}::${media.type}::${index}`)
    .digest('hex')
    .slice(0, 8);

  const fileName = `${safeName(message.author)}_${media.type}_${hash}.${extForType(media.type, media.url)}`;
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

async function findWrapperIndex(page, message, wrapperSelector) {
  const index = await page.evaluate(
    ({ author, body, time, reply, wrapperSelector: sel }) => {
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

      for (let i = wrappers.length - 1; i >= 0; i--) {
        const text = norm(wrappers[i].innerText || '');

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
      wrapperSelector,
    }
  );

  return index;
}

async function downloadMediaItem(page, message, media, index, wrapperSelector) {
  const filePath = buildFilePath(message, media, index);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    if (media.type === 'voice') {
      const prepared = prepareOutgoingAudio(filePath);
      return { ...media, localPath: prepared.localPath, sendAs: prepared.sendAs };
    }
    return { ...media, localPath: filePath };
  }

  if (media.url) {
    await downloadFromUrl(page, media.url, filePath);
    if (media.type === 'voice') {
      const prepared = prepareOutgoingAudio(filePath);
      return { ...media, localPath: prepared.localPath, sendAs: prepared.sendAs };
    }
    return { ...media, localPath: filePath };
  }

  const wrapperIndex = await findWrapperIndex(page, message, wrapperSelector);

  if (media.type === 'voice') {
    await downloadVoice(page, wrapperIndex, filePath);
    const prepared = prepareOutgoingAudio(filePath);
    return { ...media, localPath: prepared.localPath, sendAs: prepared.sendAs };
  }

  if (media.type === 'sticker') {
    const saved = await downloadSticker(page, wrapperIndex, filePath);
    return { ...media, localPath: saved };
  }

  throw new Error(`нет URL для ${media.type}`);
}

async function downloadMessageMedia(page, message, wrapperSelector) {
  if (!message.media?.length) return [];

  ensureDir(dataDir());
  const saved = [];

  for (let i = 0; i < message.media.length; i++) {
    try {
      const item = await downloadMediaItem(page, message, message.media[i], i, wrapperSelector);
      saved.push(item);
      console.log(`  💾 ${item.type} → ${item.localPath}`);
    } catch (err) {
      console.error(`  ⚠️ не скачано (${message.media[i].type}): ${err.message}`);
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
};
