const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

async function runBaseline(unreadCount) {
  const delivered = [];
  const messages = [
    { key: 'old', body: 'История', author: 'Другой' },
    { key: 'new', body: 'Новое сообщение', author: 'Другой' },
  ];
  const dependencies = {
    './config': { isForwardingEnabled: () => true },
    './max-chats': {
      chatLabelFromUrl: () => 'ЛС',
      chatIdFromUrl: () => '123456',
      scopedMessageKey: (url, key) => '123456::' + key,
    },
    './max-chat-picker': { ensureChatTitleFromPage: async () => {} },
    './max-profile-sync': { syncOwnNamesFromMessages: () => {} },
    './parser': {
      openChatPage: async () => {},
      isLoginPage: async () => false,
      readMessages: async () => messages,
      shouldForward: (message) => !message.isOwn,
      isDuplicateIdentity: (a, b) => a.key === b.key,
    },
    './db': { isEnabled: () => false },
    './media': {
      enrichVoiceTranscript: async (page, message) => message,
      downloadMessageMedia: async () => [],
    },
    './telegram': { sendToTelegram: async (message) => delivered.push(message.body) },
  };
  const context = {
    module: { exports: {} }, console,
    require: (name) => name === './chat-poll-queue' ? require('../src/chat-poll-queue') : dependencies[name] || {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/monitor.js'), 'utf8') +
    '\nmodule.exports.processChatMessages = processChatMessages;', context);
  const state = { baselineDone: false, seenKeys: new Set(), seenRecords: [], lastSnapshot: [] };
  await context.module.exports.processChatMessages(
    { isClosed: () => false, url: () => 'https://web.max.ru/123456' },
    'https://web.max.ru/123456', state, { unreadCount }
  );
  return { delivered, state };
}

test('first discovery forwards unread DM instead of discarding it with history', async () => {
  const { delivered, state } = await runBaseline(1);
  assert.deepEqual(delivered, ['Новое сообщение']);
  assert.equal(state.baselineDone, true);
  assert.equal(state.seenKeys.size, 2);
});

test('first discovery of a quiet chat does not resend history', async () => {
  const { delivered } = await runBaseline(0);
  assert.deepEqual(delivered, []);
});
