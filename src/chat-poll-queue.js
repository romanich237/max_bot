// Keep sidebar changes ahead of the periodic fallback sweep.
class ChatPollQueue {
  constructor() {
    this.signals = new Map();
    this.pending = new Map();
    this.cursor = 0;
  }

  observe(chats) {
    for (const chat of chats) {
      if (!chat.url || !chat.activityKey) continue;
      const previous = this.signals.get(chat.url);
      this.signals.set(chat.url, chat.activityKey);
      if (previous !== chat.activityKey) {
        this.pending.set(chat.url, { unreadCount: chat.unreadCount || 0 });
      }
    }
  }

  next(urls, limit = 3) {
    const active = new Set(urls);
    for (const url of this.pending.keys()) {
      if (!active.has(url)) this.pending.delete(url);
    }
    for (const url of this.signals.keys()) {
      if (!active.has(url)) this.signals.delete(url);
    }
    const selected = [...this.pending.keys()].slice(0, limit);
    // One background chat per tick prevents quiet or off-screen chats from starving.
    if (urls.length) {
      this.cursor %= urls.length;
      const background = urls[this.cursor++];
      if (!selected.includes(background)) selected.push(background);
    }
    return selected;
  }

  unreadCount(url) {
    return this.pending.get(url)?.unreadCount || 0;
  }

  done(url) {
    this.pending.delete(url);
  }
}

module.exports = { ChatPollQueue };
