const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChatPollQueue } = require('../src/chat-poll-queue');

test('an active DM near the end of a large list is checked first', () => {
  const queue = new ChatPollQueue();
  const urls = Array.from({ length: 200 }, (_, i) => 'chat-' + i);
  queue.observe([{ url: urls[199], activityKey: 'новое сообщение', unreadCount: 2 }]);
  assert.deepEqual(queue.next(urls), [urls[199], urls[0]]);
  assert.equal(queue.unreadCount(urls[199]), 2);
  queue.done(urls[199]);
  queue.observe([{ url: urls[199], activityKey: 'новое сообщение', unreadCount: 2 }]);
  assert.deepEqual(queue.next(urls), [urls[1]]);
});

test('bounded priority batches retain pending conversations for the next tick', () => {
  const queue = new ChatPollQueue();
  const urls = ['a', 'b', 'c', 'd', 'e'];
  queue.observe(urls.map((url) => ({ url, activityKey: 'new' })));
  const first = queue.next(urls, 2);
  first.forEach((url) => queue.done(url));
  assert.deepEqual(queue.next(urls, 2), ['c', 'd', 'b']);
});

test('background sweep eventually checks every quiet conversation', () => {
  const queue = new ChatPollQueue();
  const urls = ['a', 'b', 'c'];
  assert.deepEqual(Array.from({ length: 3 }, () => queue.next(urls)[0]), urls);
  assert.deepEqual(queue.next(urls), ['a']);
});

test('failed checks remain queued and disabled chats are removed', () => {
  const queue = new ChatPollQueue();
  queue.observe([{ url: 'a', activityKey: 'new' }]);
  assert.ok(queue.next(['a', 'b']).includes('a'));
  assert.ok(queue.next(['a', 'b']).includes('a'));
  assert.deepEqual(queue.next(['b']), ['b']);
  assert.equal(queue.pending.size, 0);
});

test('a further message wakes a previously processed chat', () => {
  const queue = new ChatPollQueue();
  queue.observe([{ url: 'a', activityKey: 'first' }]);
  queue.done('a');
  queue.observe([{ url: 'a', activityKey: 'second' }]);
  assert.equal(queue.pending.has('a'), true);
});
