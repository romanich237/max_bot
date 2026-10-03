const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const context = {
  module: { exports: {} },
  require: (name) => name === 'crypto' ? require(name) : name === './max-chats'
    ? { chatIdFromUrl: (url) => url.match(/\/(-?\d+)$/)?.[1] || '' }
    : {},
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/parser.js'), 'utf8'), context);
const { openChatPage } = context.module.exports;

function fakePage(current, clicked) {
  let url = current;
  const calls = { navigations: [], waits: 0 };
  const page = {
    url: () => url,
    locator: () => ({ first: () => ({ isVisible: async () => true }) }),
    evaluate: async (fn, target) => {
      if (!target) return 'Старый чат';
      if (clicked) url = target;
      return clicked;
    },
    goto: async (target, options) => { calls.navigations.push(options); url = target; },
    waitForURL: async () => {},
    waitForFunction: async () => { calls.waits++; },
    waitForTimeout: async () => {},
  };
  return { page, calls };
}

test('polling the open conversation never reloads MAX', async () => {
  const { page, calls } = fakePage('https://web.max.ru/123456', false);
  await openChatPage(page, 'https://web.max.ru/123456');
  assert.equal(calls.navigations.length, 0);
  assert.equal(calls.waits, 0);
});

test('visible chat links use the MAX router without a full reload', async () => {
  const { page, calls } = fakePage('https://web.max.ru/123456', true);
  await openChatPage(page, 'https://web.max.ru/654321');
  assert.equal(calls.navigations.length, 0);
  assert.ok(calls.waits > 0);
});

test('missing sidebar link falls back to bounded navigation', async () => {
  const { page, calls } = fakePage('https://web.max.ru/123456', false);
  await openChatPage(page, 'https://web.max.ru/654321', 5000);
  assert.equal(calls.navigations.length, 1);
  assert.equal(calls.navigations[0].timeout, 15000);
});
