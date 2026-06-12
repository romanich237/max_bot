const { store, getAdminChatIds } = require('./config');
const {
  sendMessage,
  answerCallback,
  editMessageText,
  pollUpdates,
  deleteWebhook,
} = require('./tg-api');
const {
  buildToggleRows,
  parseNameList,
  saveProfileNames,
  PROFILE_NAMES_HINT,
} = require('./tg-settings');

const MAX_URL_RE = /^https:\/\/web\.max\.ru\/[-\w]+/i;

function buildWizardKeyboard() {
  const rows = buildToggleRows('wizard:toggle:');
  rows.push([{ text: '✏️ Имена ротации', callback_data: 'wizard:profileNames' }]);
  rows.push([{ text: '✅ Готово, запустить бота', callback_data: 'wizard:finish' }]);
  return { inline_keyboard: rows };
}

function isMaxChatUrl(text) {
  return MAX_URL_RE.test((text || '').trim());
}

async function promptOptions(chatId, token) {
  await sendMessage(
    chatId,
    'Настройте бота кнопками ниже (всё можно изменить позже в /menu):',
    { reply_markup: buildWizardKeyboard() },
    token
  );
}

function runSetupWizard(options = {}) {
  const chatIds = (options.chatIds || getAdminChatIds()).map(String);
  const adminSet = new Set(chatIds);

  return new Promise((resolve, reject) => {
    let step = 'chatUrl';
    let stopPoll = null;

    const finish = (result) => {
      stopPoll?.();
      resolve(result);
    };

    const fail = (err) => {
      stopPoll?.();
      reject(err);
    };

    const handleUpdate = async (update) => {
      try {
        if (update.callback_query) {
          const query = update.callback_query;
          const chatId = String(query.message?.chat?.id || '');
          if (!adminSet.has(chatId)) {
            await answerCallback(query.id, 'Нет доступа', options.token);
            return;
          }

          const data = query.data || '';

          if (data === 'wizard:profileNames') {
            step = 'profileNames';
            await answerCallback(query.id, 'Жду имена', options.token);
            await sendMessage(chatId, PROFILE_NAMES_HINT, {}, options.token);
            return;
          }

          if (data.startsWith('wizard:toggle:')) {
            const path = data.slice('wizard:toggle:'.length).split('.');
            const next = store.togglePath(path);
            await answerCallback(query.id, 'Сохранено', options.token);

            if (path.join('.') === 'profileRotate.enabled' && next) {
              const names = store.getPath(['profileRotate', 'names']) || [];
              if (!names.length) {
                step = 'profileNames';
                await sendMessage(chatId, 'Ротация включена. ' + PROFILE_NAMES_HINT, {}, options.token);
              }
            }

            await editMessageText(
              chatId,
              query.message.message_id,
              'Настройте бота кнопками ниже (всё можно изменить позже в /menu):',
              { reply_markup: buildWizardKeyboard() },
              options.token
            );
            return;
          }

          if (data === 'wizard:finish' && (step === 'options' || step === 'profileNames')) {
            const profileEnabled = store.getPath(['profileRotate', 'enabled']);
            const names = store.getPath(['profileRotate', 'names']) || [];
            if (profileEnabled && !names.length) {
              await answerCallback(query.id, 'Сначала задайте имена', options.token);
              step = 'profileNames';
              await sendMessage(chatId, PROFILE_NAMES_HINT, {}, options.token);
              return;
            }

            store.setPath(['setupComplete'], true);
            await answerCallback(query.id, 'Запускаю…', options.token);
            await sendMessage(
              chatId,
              'Настройка завершена. Запускаю бота через PM2…',
              {},
              options.token
            );
            finish({ chatUrl: store.getPath(['max', 'chatUrl']) });
          }
          return;
        }

        if (!update.message?.text) return;

        const chatId = String(update.message.chat.id);
        if (!adminSet.has(chatId)) {
          await sendMessage(chatId, 'Нет доступа.', {}, options.token);
          return;
        }

        const text = update.message.text.trim();

        if (step === 'profileNames') {
          const names = parseNameList(text);
          if (!names.length) {
            await sendMessage(chatId, 'Не распознано. ' + PROFILE_NAMES_HINT, {}, options.token);
            return;
          }
          saveProfileNames(names);
          step = 'options';
          await sendMessage(
            chatId,
            `Имена сохранены: ${names.join(' → ')}`,
            { reply_markup: buildWizardKeyboard() },
            options.token
          );
          return;
        }

        if (step === 'chatUrl') {
          if (!isMaxChatUrl(text)) {
            await sendMessage(
              chatId,
              'Отправьте ссылку на чат MAX, например:\n<code>https://web.max.ru/-68396892343002</code>',
              {},
              options.token
            );
            return;
          }

          store.setPath(['max', 'chatUrl'], text);
          step = 'options';
          await sendMessage(chatId, `Чат сохранён: <code>${text}</code>`, {}, options.token);
          await promptOptions(chatId, options.token);
        }
      } catch (err) {
        fail(err);
      }
    };

    (async () => {
      await deleteWebhook(options.token);

      for (const chatId of chatIds) {
        await sendMessage(
          chatId,
          [
            '<b>Настройка MAX → Telegram</b>',
            '',
            'Отправьте ссылку на чат MAX, который нужно мониторить.',
            'Пример: <code>https://web.max.ru/-68396892343002</code>',
          ].join('\n'),
          {},
          options.token
        );
      }

      stopPoll = pollUpdates(handleUpdate, {
        token: options.token,
        onError: (err) => console.error('Ошибка мастера настройки:', err.message),
      });
    })().catch(fail);
  });
}

module.exports = { runSetupWizard, isMaxChatUrl };
