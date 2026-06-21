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
const { SETUP, BUTTONS } = require('./bot-texts');
const { createStepChat } = require('./tg-step-chat');

const WIZARD_STEPS = 3;

const MAX_URL_RE = /^https:\/\/web\.max\.ru\/[-\w]+/i;

function buildWizardKeyboard() {
  const rows = buildToggleRows('wizard:toggle:');
  rows.push([{ text: '✏️ Список имён', callback_data: 'wizard:profileNames' }]);
  rows.push([{ text: '✅ Завершить настройку', callback_data: 'wizard:finish' }]);
  return { inline_keyboard: rows };
}

function isMaxChatUrl(text) {
  return MAX_URL_RE.test((text || '').trim());
}

async function promptOptions(chatId, stepChat) {
  await stepChat.sendBot(
    chatId,
    buildEventMessage({
      title: SETUP.wizardTitle,
      status: 'wait',
      step: 3,
      total: WIZARD_STEPS,
      lines: [SETUP.wizardOptions],
    }),
    { reply_markup: buildWizardKeyboard() }
  );
}

function runSetupWizard(options = {}) {
  const chatIds = (options.chatIds || getAdminChatIds()).map(String);
  const adminSet = new Set(chatIds);
  const stepChat = createStepChat(options.token);

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
            await stepChat.finishStep(chatId);
            if (query.message?.message_id) {
              await stepChat.deleteMessage(chatId, query.message.message_id);
            }
            await stepChat.sendBot(chatId, PROFILE_NAMES_HINT);
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
                await stepChat.finishStep(chatId);
                if (query.message?.message_id) {
                  await stepChat.deleteMessage(chatId, query.message.message_id);
                }
                await stepChat.sendBot(chatId, 'Авто имя включено. ' + PROFILE_NAMES_HINT);
                return;
              }
            }

            stepChat.trackBot(chatId, query.message.message_id);
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
              await stepChat.finishStep(chatId);
              if (query.message?.message_id) {
                await stepChat.deleteMessage(chatId, query.message.message_id);
              }
              await stepChat.sendBot(chatId, PROFILE_NAMES_HINT);
              return;
            }

            store.setPath(['setupComplete'], true);
            await answerCallback(query.id, 'Запускаю…', options.token);
            await stepChat.finishStep(chatId);
            if (query.message?.message_id) {
              await stepChat.deleteMessage(chatId, query.message.message_id);
            }
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
        const userMessageId = update.message.message_id;

        if (step === 'profileNames') {
          const names = parseNameList(text);
          if (!names.length) {
            await stepChat.deleteUserMessage(chatId, userMessageId);
            await stepChat.sendBot(chatId, 'Не распознано. ' + PROFILE_NAMES_HINT);
            return;
          }
          saveProfileNames(names);
          step = 'options';
          await stepChat.finishStep(chatId, userMessageId);
          await stepChat.sendBot(
            chatId,
            buildEventMessage({
              title: 'Имена авто сохранены',
              status: 'done',
              step: 3,
              total: WIZARD_STEPS,
              lines: [`Список: ${names.join(' → ')}`, '', SETUP.wizardOptions],
            }),
            { reply_markup: buildWizardKeyboard() }
          );
          return;
        }

        if (step === 'chatUrl') {
          if (!isMaxChatUrl(text)) {
            await stepChat.deleteUserMessage(chatId, userMessageId);
            await stepChat.sendBot(
              chatId,
              buildEventMessage({ ...SETUP.chatUrlPrompt, status: 'wait', step: 2, total: WIZARD_STEPS })
            );
            return;
          }

          store.setPath(['max', 'chatUrl'], text);
          step = 'options';
          await stepChat.finishStep(chatId, userMessageId);
          await stepChat.sendBot(
            chatId,
            buildEventMessage({
              ...SETUP.chatSaved(text),
              status: 'done',
              step: 2,
              total: WIZARD_STEPS,
              lines: [...SETUP.chatSaved(text).lines, '', SETUP.wizardOptions],
            }),
            { reply_markup: buildWizardKeyboard() }
          );
        }
      } catch (err) {
        fail(err);
      }
    };

    (async () => {
      await deleteWebhook(options.token);
      await registerBotCommands(options.token);

      for (const chatId of chatIds) {
        await stepChat.sendBot(
          chatId,
          [
            buildPipeline('Настройка MAX → Telegram', [
              { label: 'Вход в MAX', status: 'done' },
              { label: 'Чат MAX', status: 'wait' },
              { label: 'Настройки бота', status: 'pending' },
            ]),
            '',
            buildEventMessage({ ...SETUP.chatUrlPrompt, status: 'wait', step: 2, total: WIZARD_STEPS }),
          ].join('\n')
        );
      }

      stopPoll = pollUpdates(handleUpdate, {
        priority: 10,
        token: options.token,
        onError: (err) => console.error('Ошибка мастера настройки:', err.message),
      });
    })().catch(fail);
  });
}

module.exports = { runSetupWizard, isMaxChatUrl };
