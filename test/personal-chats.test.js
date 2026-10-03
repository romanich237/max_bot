const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadModule(file, dependencies, extra = '') {
  const context = {
    module: { exports: {} },
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    URL, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8') + extra, context);
  return context.module.exports;
}

function setup(filters, batches) {
  const settings = {
    max: { monitorPersonalChats: true, monitorChatUrls: [], chatKinds: {} },
    telegram: { chatIds: ['123456'], adminChatIds: ['123456'] },
  };
  const store = {
    getPath: (keys) => keys.reduce((value, key) => value?.[key], settings),
    setPath: (keys, value) => {
      let target = settings;
      for (const key of keys.slice(0, -1)) target = target[key] ||= {};
      target[keys.at(-1)] = value;
    },
  };
  const chats = loadModule('max-chats.js', {
    './settings-store': store,
    './bot-texts': {},
  });
  const state = { filters, batches, selected: null, opened: [], restored: [] };
  const picker = loadModule('max-chat-picker.js', {
    './max-chats': chats,
    './parser': {
      isLoginPage: async () => false,
      openChatWhenReady: async (page, url) => state.restored.push(url),
    },
    'test-state': state,
  }, `
    const state = require('test-state');
    ensureChatListVisible = async () => {};
    waitForChatListDom = async () => {};
    resetChatListScroll = async () => {};
    listChatListFilters = async () => state.filters;
    openChatListFilter = async (page, label) => {
      state.selected = label;
      state.opened.push(label);
      return true;
    };
    collectAllMaxChats = async () => state.batches[state.selected] || [];
  `);
  const page = {
    isClosed: () => false,
    url: () => state.selected ? 'https://web.max.ru/' : 'https://web.max.ru/35859265',
    waitForTimeout: async () => {},
  };
  return { chats, picker, page, state, settings };
}

test('discovery scans personal and group tabs and keeps chats with identical names', async () => {
  const dm = 'https://web.max.ru/-123456';
  const group = 'https://web.max.ru/-654321';
  const { picker, page, chats, state } = setup(['Группы', 'Личные'], {
    Личные: [{ url: dm, title: 'Одинаковое имя' }],
    Группы: [{ url: group, title: 'Одинаковое имя' }],
  });
  const result = await picker.discoverMaxChatsForMonitor(page);
  assert.deepEqual(Array.from(state.opened), ['Личные', 'Группы']);
  assert.equal(result.urls.length, 2);
  assert.equal(chats.getChatKind(dm), 'personal');
  assert.equal(chats.getChatKind(group), 'group');
  const urls = chats.getForwardingMonitorChatUrls(result.urls);
  assert.ok(urls.includes(dm));
  assert.ok(!urls.includes(group));
  assert.deepEqual(Array.from(chats.getNotifyChatIdsForMaxChat(dm)), ['123456']);
  assert.deepEqual(state.restored, ['https://web.max.ru/35859265']);
});

test('all tab preserves detected personal kind before applying personal-only selection', async () => {
  const dm = 'https://web.max.ru/-123456';
  const group = 'https://web.max.ru/-654321';
  const { picker, page, chats, state } = setup(['Все', 'Личные', 'Группы'], {
    Все: [
      { url: dm, title: 'ЛС', kind: 'personal' },
      { url: group, title: 'Группа', kind: 'group' },
    ],
  });
  const result = await picker.discoverMaxChatsForMonitor(page);
  assert.deepEqual(state.opened, ['Все', 'Личные']);
  assert.ok(chats.getForwardingMonitorChatUrls(result.urls).includes(dm));
  assert.ok(!chats.getForwardingMonitorChatUrls(result.urls).includes(group));
});

test('disabled personal setting and explicitly disabled forwarding are respected', async () => {
  const dm = 'https://web.max.ru/123456';
  const { picker, page, chats, settings } = setup(['Личные'], {
    Личные: [{ url: dm, title: 'ЛС' }],
  });
  const result = await picker.discoverMaxChatsForMonitor(page);
  chats.setChatForwardEnabled(dm, false);
  assert.ok(!chats.getForwardingMonitorChatUrls(result.urls).includes(dm));
  chats.setChatForwardEnabled(dm, true);
  settings.max.monitorPersonalChats = false;
  assert.ok(!chats.getForwardingMonitorChatUrls(result.urls).includes(dm));
});

test('discovery deduplicates repeated URLs', async () => {
  const dm = 'https://web.max.ru/123456';
  const { picker, page } = setup(['Личные'], {
    Личные: [{ url: dm, title: 'ЛС' }, { url: dm, title: 'ЛС' }],
  });
  const result = await picker.discoverMaxChatsForMonitor(page);
  assert.deepEqual(Array.from(result.urls), [dm]);
});
