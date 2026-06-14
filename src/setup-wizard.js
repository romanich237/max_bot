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
const { registerBotCommands } = require('./tg-admin');
const { buildEventMessage, buildPipeline } = require('./tg-events');

const WIZARD_STEPS = 3;

const MAX_URL_RE = /^https:\/\/web\.max\.ru\/[-\w]+/i;

function buildWizardKeyboard() {
  const rows = buildToggleRows('wizard:toggle:');
  rows.push([{ text: '✏️ Имена авто', callback_data: 'wizard:profileNames' }]);
  rows.push([{ text: '✅ Готово, запустить бота', callback_data: 'wizard:finish' }]);
  return { inline_keyboard: rows };
}

function isMaxChatUrl(text) {
  return MAX_URL_RE.test((text || '').trim());
}

async function promptOptions(chatId, token) {
  await sendMessage(
    chatId,
    buildEventMessage({
      title: 'Настройки бота',
      status: 'wait',
      step: 3,
      total: WIZARD_STEPS,
      lines: ['Настройте бота кнопками ниже (всё можно изменить позже в /menu).'],
    }),
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
                await sendMessage(chatId, 'Авто имя включено. ' + PROFILE_NAMES_HINT, {}, options.token);
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
              [
                buildPipeline('Настройка MAX → Telegram', [
                  { label: 'Вход в MAX', status: 'done' },
                  { label: 'Чат MAX', status: 'done' },
                  { label: 'Настройки бота', status: 'done' },
                  { label: 'Запуск PM2', status: 'progress' },
                ]),
                '',
                '⏳ Запускаю бота через PM2…',
              ].join('\n'),
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
            buildEventMessage({
              title: 'Имена авто сохранены',
              status: 'done',
              step: 3,
              total: WIZARD_STEPS,
              lines: [`Список: ${names.join(' → ')}`],
            }),
            { reply_markup: buildWizardKeyboard() },
            options.token
          );
          return;
        }

        if (step === 'chatUrl') {
          if (!isMaxChatUrl(text)) {
            await sendMessage(
              chatId,
              buildEventMessage({
                title: 'Ссылка на чат MAX',
                status: 'wait',
                step: 2,
                total: WIZARD_STEPS,
                lines: [
                  'Отправьте ссылку на чат MAX, например:',
                  '<code>https://web.max.ru/-68396892343002</code>',
                ],
              }),
              {},
              options.token
            );
            return;
          }

          store.setPath(['max', 'chatUrl'], text);
          step = 'options';
          await sendMessage(
            chatId,
            buildEventMessage({
              title: 'Чат MAX сохранён',
              status: 'done',
              step: 2,
              total: WIZARD_STEPS,
              lines: [`Ссылка: <code>${text}</code>`],
            }),
            {},
            options.token
          );
          await promptOptions(chatId, options.token);
        }
      } catch (err) {
        fail(err);
      }
    };

    (async () => {
      await deleteWebhook(options.token);
      await registerBotCommands(options.token);

      for (const chatId of chatIds) {
        await sendMessage(
          chatId,
          [
            buildPipeline('Настройка MAX → Telegram', [
              { label: 'Вход в MAX', status: 'done' },
              { label: 'Чат MAX', status: 'wait' },
              { label: 'Настройки бота', status: 'pending' },
            ]),
            '',
            buildEventMessage({
              title: 'Ссылка на чат MAX',
              status: 'wait',
              step: 2,
              total: WIZARD_STEPS,
              lines: [
                'Отправьте ссылку на чат, который нужно мониторить.',
                'Пример: <code>https://web.max.ru/-68396892343002</code>',
              ],
            }),
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
