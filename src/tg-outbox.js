const fs = require('fs');
const path = require('path');
const { resolveFromRoot } = require('./config');

const OUTBOX_PATH = resolveFromRoot('data/tg-outbox.json');
const MAX_JOBS = 80;
const MAX_AGE_MS = 36 * 60 * 60 * 1000;

function emptyOutbox() {
  return { jobs: [] };
}

function loadOutbox() {
  try {
    if (!fs.existsSync(OUTBOX_PATH)) return emptyOutbox();
    const parsed = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    return { jobs };
  } catch {
    return emptyOutbox();
  }
}

function saveOutbox(data) {
  const now = Date.now();
  const jobs = (data.jobs || [])
    .filter((job) => job?.id && now - Number(job.createdAt || now) < MAX_AGE_MS)
    .slice(-MAX_JOBS);
  fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
  fs.writeFileSync(OUTBOX_PATH, `${JSON.stringify({ jobs }, null, 2)}\n`);
}

function remainingDests(job) {
  const sent = job?.sentTo && typeof job.sentTo === 'object' ? job.sentTo : {};
  return (job?.destIds || []).map(String).filter((id) => sent[id] == null);
}

const LOCK_PATH = resolveFromRoot('data/tg-outbox.lock');
const LOCK_MS = 20_000;

function acquireFlushLock() {
  try {
    const prev = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    if (Number.isFinite(prev) && Date.now() - prev < LOCK_MS) return false;
  } catch {
    /* no lock */
  }
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, `${Date.now()}\n`);
    return true;
  } catch {
    return true;
  }
}

function releaseFlushLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* nop */
  }
}

function isJobComplete(job) {
  return remainingDests(job).length === 0;
}

function getJob(id) {
  return loadOutbox().jobs.find((job) => job.id === String(id)) || null;
}

function ensureJob(job) {
  const id = String(job.id || '');
  if (!id) return null;
  const data = loadOutbox();
  const destIds = [...new Set((job.destIds || []).map(String).filter(Boolean))];
  const existing = data.jobs.find((item) => item.id === id);
  if (existing) {
    const merged = new Set([...(existing.destIds || []), ...destIds]);
    existing.destIds = [...merged];
    if (job.method) existing.method = job.method;
    if (job.fields) existing.fields = job.fields;
    if (job.files) existing.files = job.files;
    if (job.text != null) existing.text = job.text;
    if (job.parseMode) existing.parseMode = job.parseMode;
    if (job.replyMarkup) existing.replyMarkup = job.replyMarkup;
    if (job.replyToByChat) existing.replyToByChat = job.replyToByChat;
    if (job.maxChatUrl) existing.maxChatUrl = job.maxChatUrl;
    if (job.storeId) existing.storeId = job.storeId;
    if (job.kind) existing.kind = job.kind;
    saveOutbox(data);
    return existing;
  }

  const next = {
    id,
    kind: job.kind || 'telegram',
    method: job.method || 'sendMessage',
    text: job.text || '',
    parseMode: job.parseMode || '',
    fields: job.fields || {},
    files: job.files || {},
    photos: job.photos || [],
    replyMarkup: job.replyMarkup || null,
    replyToByChat: job.replyToByChat || {},
    maxChatUrl: job.maxChatUrl || '',
    storeId: job.storeId || '',
    destIds,
    sentTo: job.sentTo && typeof job.sentTo === 'object' ? job.sentTo : {},
    createdAt: Date.now(),
  };
  data.jobs.push(next);
  saveOutbox(data);
  return next;
}

function markDelivered(id, chatId, messageId) {
  const jobId = String(id || '');
  const dest = String(chatId || '');
  if (!jobId || !dest) return null;
  const data = loadOutbox();
  const job = data.jobs.find((item) => item.id === jobId);
  if (!job) return null;
  job.sentTo = job.sentTo && typeof job.sentTo === 'object' ? job.sentTo : {};
  job.sentTo[dest] = messageId || true;
  if (isJobComplete(job)) {
    data.jobs = data.jobs.filter((item) => item.id !== jobId);
  }
  saveOutbox(data);
  return job;
}

function deliveredSet(id) {
  const job = getJob(id);
  return new Set(Object.keys(job?.sentTo || {}));
}

function listJobs(kind = null) {
  const jobs = loadOutbox().jobs;
  if (!kind) return jobs;
  return jobs.filter((job) => job.kind === kind);
}

function removeJob(id) {
  const data = loadOutbox();
  data.jobs = data.jobs.filter((job) => job.id !== String(id));
  saveOutbox(data);
}

module.exports = {
  ensureJob,
  getJob,
  markDelivered,
  remainingDests,
  isJobComplete,
  deliveredSet,
  listJobs,
  removeJob,
  acquireFlushLock,
  releaseFlushLock,
};
