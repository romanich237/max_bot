const { deleteMessage, sendMessage } = require('./tg-api');

async function deleteMessageQuiet(chatId, messageId, token) {
  if (!messageId) return;
  try {
    const res = await deleteMessage(chatId, messageId, token);
    if (
      !res?.ok &&
      !/message to delete not found|message can't be deleted|message identifier is not specified/i.test(
        res?.description || ''
      )
    ) {
      // Telegram may refuse deletion for old messages — ignore.
    }
  } catch {
    // ignore
  }
}

function createStepChat(token) {
  const botMessageId = new Map();

  return {
    trackBot(chatId, messageId) {
      if (messageId) botMessageId.set(String(chatId), messageId);
    },

    getBotMessageId(chatId) {
      return botMessageId.get(String(chatId));
    },

    async clearBot(chatId) {
      const id = botMessageId.get(String(chatId));
      if (id) await deleteMessageQuiet(chatId, id, token);
      botMessageId.delete(String(chatId));
    },

    async finishStep(chatId, userMessageId) {
      await this.clearBot(chatId);
      await deleteMessageQuiet(chatId, userMessageId, token);
    },

    async deleteUserMessage(chatId, userMessageId) {
      await deleteMessageQuiet(chatId, userMessageId, token);
    },

    async deleteMessage(chatId, messageId) {
      await deleteMessageQuiet(chatId, messageId, token);
    },

    async sendBot(chatId, text, extra = {}) {
      const result = await sendMessage(chatId, text, extra, token);
      this.trackBot(chatId, result?.result?.message_id);
      return result;
    },
  };
}

const inputPromptIds = new Map();

async function sendInputPrompt(chatId, text, extra = {}, token) {
  const key = String(chatId);
  const prev = inputPromptIds.get(key);
  if (prev) await deleteMessageQuiet(chatId, prev, token);
  const result = await sendMessage(chatId, text, extra, token);
  if (result?.result?.message_id) {
    inputPromptIds.set(key, result.result.message_id);
  }
  return result;
}

async function clearInputPrompt(chatId, userMessageId, token) {
  const key = String(chatId);
  const prev = inputPromptIds.get(key);
  if (prev) await deleteMessageQuiet(chatId, prev, token);
  inputPromptIds.delete(key);
  await deleteMessageQuiet(chatId, userMessageId, token);
}

module.exports = {
  createStepChat,
  deleteMessageQuiet,
  sendInputPrompt,
  clearInputPrompt,
};
