const { DEFAULT_BIO_TEMPLATE } = require('./profile-bio');

const BRAND = 'MAX → Telegram';

const BOT_ABOUT =
  'Бот который пересылает сообщений из MAX в Telegram. Подробнее: https://github.com/romanich237/max_bot';

const COMMANDS = {
  start: 'Старт и меню',
  menu: 'Панель управления',
  reauth: 'Повторный вход в MAX',
};

const BUTTONS = {
  profileNames: 'Список имён',
  bioTemplate: 'Шаблон описания',
  bioCity: 'Город для погоды',
  maxChats: 'Чаты MAX',
  notifyChat: 'Куда слать в Telegram',
  refreshStatus: 'Обновить статус',
  stopMax: 'Остановить бота',
  startMax: 'Запустить бота',
  backToMenu: '« В меню',
  backToChats: '« К списку чатов',
  bindNotify: 'Привязать для уведомлений',
  bindGroup: 'Добавить группу',
  removeNotifyGroup: 'Удалить',
  addAdmin: 'Добавить в админы',
  docs: '📄 Документация',
  notifyDmOnly: 'Только личные сообщения',
  authQr: 'QR-код',
  authPhone: 'Номер телефона',
  authSwitchQr: 'Войти по QR',
  refreshQr: '🔄 Обновить',
  checkUpdates: 'Проверить обновления',
  about: 'О сервисе',
  ourChannel: 'Наш канал',
  support: 'Тех поддержка',
  github: 'GitHub',
};

const LINKS = {
  channel: 'https://t.me/notificationsmax_in_tg',
  support: 'https://t.me/notificationsmax_in_tg?direct',
  github: 'https://github.com/romanich237/max_bot',
};

const { AsyncLocalStorage } = require('node:async_hooks');

const tgEmojiPremium = new AsyncLocalStorage();
let lastPremiumEmoji = false;

function runWithPremiumEmoji(from, fn) {
  lastPremiumEmoji = Boolean(from?.is_premium);
  return tgEmojiPremium.run({ premium: lastPremiumEmoji }, fn);
}

function isPremiumEmojiUser() {
  const ctx = tgEmojiPremium.getStore();
  if (ctx) return Boolean(ctx.premium);
  return lastPremiumEmoji;
}

const TG_EMOJI = {
  check: { id: '5427009714745517609', fallback: '✅' },
  cross: { id: '5465665476971471368', fallback: '❌' },
  pin: { id: '5974352611711651172', fallback: '📌' },
  trash: { id: '5974518878485615140', fallback: '🗑' },
  kiss: { id: '5426948459921959705', fallback: '😘' },
  plus: { id: '5397916757333654639', fallback: '➕' },
  camera: { id: '5972273671446727832', fallback: '📷' },
  phone: { id: '5407025283456835913', fallback: '📱' },
  group: { id: '4960891456869893259', fallback: '💠' },
};

function withTgEmoji(button, kind) {
  const spec = TG_EMOJI[kind];
  if (!button || !spec) return button;

  const next = { ...button, icon_custom_emoji_id: spec.id };
  const text = String(button.text || '').trim();

  if (isPremiumEmojiUser()) {
    return { ...next, text: text || spec.fallback };
  }

  if (!text) return { ...next, text: spec.fallback };
  if (text.startsWith(spec.fallback) || text.endsWith(spec.fallback)) return { ...next, text };
  return { ...next, text: `${spec.fallback} ${text}` };
}

function withOnOffEmoji(button, on) {
  return withTgEmoji(button, on ? 'check' : 'cross');
}

function tgEmojiHtml(kind) {
  const spec = TG_EMOJI[kind];
  if (!spec) return '';
  return `<tg-emoji emoji-id="${spec.id}">${spec.fallback}</tg-emoji>`;
}

const TOGGLES = {
  forwarding: 'Слать в Telegram',
  alwaysOnline: 'Всегда в сети',
  profileRotate: 'Менять имя',
  profileBio: 'Менять описание',
};

const HINTS = {
  profileNames:
    'Отправьте имена через запятую — бот будет поочерёдно менять имя в MAX.\n\nПример: <code>в, ва, вас, вася</code>',
  profileBioCity:
    'Укажите город — для погоды в описании и часового пояса.\n\nПример: <code>Москва</code>',
  profileBioCityRequired:
    'Чтобы включить смену описания, сначала укажите город.',
  profileBioTemplate: [
    'Шаблон описания профиля MAX (до 400 символов после подстановки).',
    '',
    'Переменные:',
    '<code>{час}</code> <code>{минута}</code> <code>{день}</code> <code>{месяц}</code> <code>{погода}</code>',
    '<code>{непрочитанные_чаты}</code> <code>{непрочитанные_сообщения}</code>',
    'Коротко: <code>{чаты}</code> <code>{сообщения}</code>',
    '',
    `По умолчанию: <code>${DEFAULT_BIO_TEMPLATE}</code>`,
  ].join('\n'),
  profileNamesEnabled: 'Смена имени включена. ',
  profileBioEnabled: 'Город сохранён. Смена описания включена. ',
  maxChatAdd: [
    'Отправьте ссылку на чат MAX, который нужно отслеживать.',
    '',
    'Пример: <code>https://web.max.ru/-999999999999</code>',
    '',
    'Отмена: /cancel',
  ].join('\n'),
};

const START = {
  welcome: [
    `<b>${BRAND}</b>`,
    '',
    'Бот пересылает сообщения из мессенджера MAX в Telegram.',
    'Все настройки — в меню ниже.',
  ].join('\n'),
  panel: 'Панель управления',
  about: [
    '<b>О сервисе</b>',
    '',
    'Бот пересылает сообщения из MAX в Telegram.',
    'Канал, поддержка и исходный код — по кнопкам ниже.',
  ].join('\n'),
  help: 'Все команды и настройки — в /menu.',
};

const STATUS = {
  header: `<b>${BRAND}</b>`,
  monitoring: 'Следит за MAX',
  alwaysOnline: 'Всегда в сети',
  profileRotate: 'Менять имя',
  profileBio: 'Менять описание',
  namesUnset: 'Имена для смены не заданы',
  cityUnset: 'Город не задан',
  nameAuto: 'Имя в MAX пока не считано',
  chatsHeader: 'Чаты MAX',
  chatsUnset: 'Чаты MAX не выбраны',
  notifyUnset: 'Куда слать в Telegram — не настроено',
  forwarding: 'Слать в Telegram',
  on: 'да',
  off: 'нет',
};

const AUTH = {
  chooseMode: {
    title: 'Вход в MAX',
    lines: ['Выберите удобный способ авторизации:'],
  },
  phoneWarning: {
    title: 'Вход по номеру',
    lines: [
      'Для входа по телефону в MAX нужен пароль аккаунта (личный кабинет → Безопасность).',
      'Если пароль уже установлен — можно продолжать.',
      'Если SMS не приходит — на следующем шаге можно переключиться на QR-код.',
    ],
  },
  phoneWarningShort:
    'Для входа по номеру в MAX нужен пароль аккаунта. Если уже установлен — продолжайте.',
  sessionActive: {
    title: 'Вы уже в сети ✅',
    lines: [
      'Сессия MAX активна, поэтому повторный вход не нужен.',
      '',
      'Хотите войти под другим аккаунтом или сбросить сессию?',
      '1. Перейдите в MAX → Настройки → Безопасность → Устройства.',
      '2. Нажми на кнопку выйти со всех кроме этой',
      '3. Отправьте команду /reauth — и система запросит логин заново.',
    ],
  },
  sessionExpired: {
    title: 'Сессия MAX недействительна',
    lines: [
      'Вход в MAX требуется заново. Пересылка сообщений приостановлена.',
      'Администратору: отправьте /reauth или выберите способ входа кнопками ниже.',
    ],
  },
  qrIntro: (qrSec) => ({
    title: 'Вход по QR-коду',
    lines: [
      'Сейчас пришлю скриншот — отсканируйте QR в приложении MAX.',
      `Код обновляется каждые ${qrSec} сек. При необходимости нажмите «${BUTTONS.refreshQr}».`,
    ],
  }),
  phoneIntro: {
    title: 'Вход по номеру',
    lines: [
      'Отправьте номер в формате <code>+79XXXXXXXXX</code> или <code>9XXXXXXXXX</code>.',
      'Если SMS не приходит — нажмите «Войти по QR».',
    ],
  },
  phonePrompt: {
    title: 'Номер телефона',
    lines: [
      'Отправьте номер, привязанный к аккаунту MAX.',
      'Если SMS не приходит — нажмите «Войти по QR».',
    ],
  },
  switchToQr: {
    title: 'Переключаю на QR-код',
    lines: ['SMS не пришёл — открываю вход по QR. Отсканируйте код в приложении MAX.'],
  },
  phoneAccepted: (masked) => ({
    title: 'Номер принят',
    lines: [`Открываю форму входа для <code>${masked}</code>…`],
  }),
  phoneProgress: (masked) => ({
    title: 'Вход в MAX',
    lines: [`Номер <code>${masked}</code> — продолжаю…`],
  }),
  smsPrompt: {
    title: 'Код из SMS',
    lines: [
      'Введите код подтверждения из SMS.',
      'Если SMS нет — нажмите «Войти по QR».',
    ],
  },
  smsRetry: 'Код не подошёл. Отправьте новый код из SMS.',
  smsAccepted: { title: 'Код принят', lines: ['Проверяю вход…'] },
  smsInvalid: (attempt, max) => ({
    title: 'Неверный код',
    lines: [`Попытка ${attempt} из ${max}.`, 'Отправьте код из SMS ещё раз.'],
  }),
  captchaPassed: { title: 'Проверка пройдена', lines: ['Продолжаю вход…'] },
  loginDone: { title: 'Готово', lines: ['Вход в MAX выполнен. Мониторинг запущен.'] },
  loginDoneReauth: { title: 'Сессия обновлена', lines: ['Мониторинг продолжается.'] },
  loginFail: (msg) => ({ title: 'Не удалось войти', lines: [msg] }),
  timeout:
    'Время ожидания истекло (10 мин). Запустите вход снова: /reauth',
  refreshNoAuth: 'Сейчас вход не выполняется. Отправьте /reauth.',
  alreadyAuth: 'Вход уже выполняется.',
  qrCaption: (sec) =>
    [
      '<b>🔐 Вход в MAX</b>',
      '',
      'Отсканируйте QR-код в приложении MAX.',
      `Код обновляется каждые ${sec} с.`,
      `Не успели? Нажмите «${BUTTONS.refreshQr}».`,
    ].join('\n'),
  passwordCaption: (sec, pageHint) => {
    const lines = [
      '<b>🔐 Подтверждение входа</b>',
      '',
      'MAX запрашивает пароль аккаунта.',
    ];
    if (pageHint) {
      lines.push('', `Подсказка: <code>${pageHint}</code>`);
    }
    lines.push(
      '',
      'Сохранить пароль заранее:',
      '<code>/set browserpassword ваш_пароль</code>',
      '',
      `Экран обновляется каждые ${sec} с`
    );
    return lines.join('\n');
  },
  passwordHint: (hasPassword, masked) => {
    const lines = [
      'При входе с нового устройства MAX может запросить пароль аккаунта (личный кабинет → Безопасность).',
    ];
    if (hasPassword) {
      lines.push('', `Пароль сохранён: <code>${masked}</code>`, 'Бот введёт его автоматически.');
    } else {
      lines.push('', 'Сохранить пароль: <code>/set browserpassword ваш_пароль</code>');
    }
    return lines.join('\n');
  },
  passwordPrompt: {
    title: 'Пароль аккаунта',
    lines: [
      'Отправьте пароль из личного кабинета MAX (Безопасность).',
      'Или: <code>/set browserpassword ваш_пароль</code>',
      'Отмена: /cancel',
    ],
  },
  passwordWait: {
    title: 'Нужен пароль',
    lines: (pageHint) =>
      [
        'Отправьте пароль аккаунта MAX.',
        pageHint ? `Подсказка: <code>${pageHint}</code>` : null,
        'Или заранее: <code>/set browserpassword ваш_пароль</code>',
      ].filter(Boolean),
  },
  passwordAccepted: { title: 'Пароль принят', lines: ['Ввожу пароль в MAX…'] },
  passwordSaved: {
    title: 'Пароль сохранён',
    lines: ['Бот подставит его автоматически при следующем входе @Browser.'],
  },
  passwordFail: (msg) => ({
    title: 'Пароль не принят',
    lines: [msg, 'Проверьте пароль и повторите: /reauth'],
  }),
  passwordEmpty: 'Пароль не может быть пустым. Отправьте пароль или /cancel.',
  codeAccepted: { title: 'Код принят', lines: ['Ввожу код в MAX…'] },
  inputAccepted: { title: 'Принято', lines: ['Продолжаю…'] },
  telInvalid:
    'Неверный формат. Пример: <code>+79001234567</code> или <code>9001234567</code>. Отмена: /cancel.',
  smsInvalidFormat: 'Код — 4–8 цифр из SMS. Отмена: /cancel.',
};

const SETUP = {
  wizardOptions: 'Настройте бота кнопками ниже. Всё можно изменить позже в /menu.',
  wizardTitle: 'Первичная настройка',
  chatUrlPrompt: {
    title: 'Чат для мониторинга',
    lines: [
      'Отправьте ссылку на чат MAX, сообщения из которого нужно пересылать.',
      'Пример: <code>https://web.max.ru/-999999999999</code>',
      'После установки чат можно добавить и по названию через /menu → Чаты MAX.',
    ],
  },
  chatUrlInvalid: {
    title: 'Некорректная ссылка',
    lines: [
      'Отправьте ссылку на чат MAX, например:',
      '<code>https://web.max.ru/-999999999999</code>',
    ],
  },
  chatSaved: (url) => ({
    title: 'Чат сохранён',
    lines: [`Ссылка: <code>${url}</code>`],
  }),
  namesSaved: (names) => ({
    title: 'Имена сохранены',
    lines: [`Порядок смены: ${names}`],
  }),
  installDone: (botUsername) => ({
    pipeline: 'Установка завершена',
    title: 'Бот запущен',
    lines: [
      botUsername ? `Telegram-бот: @${botUsername}` : null,
      'Откройте /menu — там все настройки.',
    ].filter(Boolean),
  }),
  installIntro: {
    title: 'Настройка MAX → Telegram',
    lines: [
      'Дальше всё в Telegram — без веб-страниц.',
      'Выберите вход: <b>QR-код</b> или <b>номер телефона</b>.',
      'Для QR пришлю скриншот; для телефона — запросы в этом чате.',
    ],
  },
};

const REPLY = {
  stale: 'Сообщение устарело. Нажмите «Ответить» на актуальном сообщении из MAX.',
  unavailable: 'Ответы временно недоступны. Перезапустите бота: <code>pm2 restart max-tg</code>',
  sent: (author) => ({
    title: 'Ответ отправлен',
    lines: [`Получатель в MAX: <b>${author}</b>`],
  }),
  failed: (msg) => ({ title: 'Не удалось отправить', lines: [msg] }),
  prompt: (author) => [
    `<b>Ответ для ${author}</b>`,
    '',
    'Напишите текст сообщения.',
    'Отмена: /cancel',
  ].join('\n'),
};

const MONITORING = {
  stopped: {
    title: 'Бот остановлен',
    lines: [
      'Полная пауза: MAX не проверяется, имя и описание не меняются.',
      'Чтобы только не слать уведомления, но оставить бота работать — выключите «Слать в Telegram».',
    ],
  },
  started: {
    title: 'Бот запущен',
    lines: [
      'Снова следит за MAX.',
      'Уведомления в Telegram зависят от кнопки «Слать в Telegram».',
    ],
  },
  stopUnavailable: 'Остановка недоступна. Перезапустите: <code>pm2 restart max-tg</code>',
  startUnavailable: 'Запуск недоступен. Выполните: <code>pm2 restart max-tg</code>',
};

const CHATS = {
  discoverEmpty: [
    '<b>Чаты Telegram</b>',
    '',
    'Пока нет известных чатов. Добавьте группу через «Куда слать в Telegram».',
  ].join('\n'),
  discoverHint: [
    'Выберите чат — бот покажет ID и название.',
    'Можно привязать чат для уведомлений из MAX.',
  ].join('\n'),
  infoHeader: 'Информация о чате',
  infoFooter: [
    'Скопируйте ID или нажмите «Привязать» — сюда будут приходить уведомления из MAX.',
    'Личные сообщения получают уведомления всегда; для группы — дублирование в ЛС и в группу.',
  ].join('\n'),
  notifyHeader: 'Куда приходят уведомления',
  notifyEmpty: 'Чаты для уведомлений пока не выбраны.',
  notifyDualMode: 'Режим: сообщения из MAX дублируются в личные сообщения и во все привязанные группы.',
  notifyDmMode: 'Режим: уведомления только в личные сообщения.',
  bindGroupPrompt: [
    'Нажмите «Добавить группу» внизу и выберите группу в Telegram.',
    'Бот будет добавлен в группу администратором с правами писать и удалять сообщения — ID заранее узнавать не нужно.',
    '',
    'В списке уведомлений останутся все выбранные группы, новая не затрёт старые.',
  ].join('\n'),
  notAdmin: {
    title: 'Бот не администратор',
    lines: (title) =>
      [
        title ? `Группа: <b>${title}</b>` : null,
        'Бот не админ в этой группе — сообщения из MAX могут не доходить.',
        '',
        'Нажмите «Добавить в админы»: Telegram откроет добавление бота с правами писать, править и удалять сообщения.',
      ].filter(Boolean),
  },
  notifyFooter: [
    'Все привязанные группы получают уведомления вместе с личкой (если для чата MAX выбрано «группа» или «оба»).',
    '',
    '✅ справа — бот админ в группе, ❌ — выдайте права администратора.',
    '«Удалить группу» убирает её из рассылки. «Добавить группу» снова приглашает бота с правами администратора.',
  ].join('\n'),
  bound: {
    title: 'Чат привязан',
    lines: (isGroup) => [
      isGroup
        ? 'Группа добавлена в список. Уведомления из MAX могут идти в личные сообщения и во все привязанные группы.'
        : 'Уведомления из MAX будут приходить в личные сообщения.',
    ],
  },
  added: { title: 'Чат добавлен', lines: [] },
  destinationSaved: { title: 'Куда слать сохранено', lines: [] },
  duplicate: { title: 'Чат уже в списке', lines: ['Этот чат уже отслеживается.'] },
  addPrompt: [
    '<b>Добавить чат MAX</b>',
    '',
    'На скриншоте — список чатов слева в MAX.',
    'На кнопках — ссылки https://web.max.ru/… из этого списка. Личные чаты сразу уходят в ЛС; для групп можно выбрать ЛС, группу или оба.',
    'Если чатов много — листайте список кнопками ◀️ ▶️.',
    'Можно отправить название или ссылку вручную, например:',
    '<code>https://web.max.ru/-999999999999</code>',
    '',
    'Отмена: /cancel',
  ].join('\n'),
  addPromptNoScreenshot: [
    '<b>Добавить чат MAX</b>',
    '',
    'На кнопках — ссылки https://web.max.ru/… из списка слева. Личные чаты сразу уходят в ЛС; для групп можно выбрать ЛС, группу или оба.',
    'Если чатов много — листайте список кнопками ◀️ ▶️.',
    'Можно отправить название или ссылку вручную, например:',
    '<code>https://web.max.ru/-999999999999</code>',
    '',
    'Отмена: /cancel',
  ].join('\n'),
  addPickerBusy: 'Список чатов MAX сейчас недоступен (идёт авторизация). Отправьте ссылку вручную.',
  addPickerWait: ['Готовлю список чатов', '<i>Это может занять несколько минут</i>'].join('\n'),
  addPickerFail: (message) =>
    [
      '<b>Не удалось показать список чатов</b>',
      message ? String(message) : 'Повторите позже.',
      '',
      'Отправьте название чата или ссылку вручную.',
      'Отмена: /cancel',
    ].join('\n'),
  addNotFound:
    'Чат не найден. Проверьте название на скриншоте или отправьте полную ссылку на чат.',
  addAmbiguous: (titles) =>
    [
      'Найдено несколько чатов:',
      ...titles.map((title) => `• ${title}`),
      '',
      'Уточните название — отправьте более точное совпадение.',
    ].join('\n'),
  requiredPinned: '📌 Обязательный — удалить нельзя, пересылку можно выключить.',
  requiredForwardOn: 'Пересылка в Telegram: ✅ да',
  requiredForwardOff: 'Пересылка в Telegram: ❌ нет',
  notifyTargetDm: 'Куда слать: только в личные сообщения.',
  notifyTargetGroup: 'Куда слать: только в группу.',
  notifyTargetBoth: 'Куда слать: в личные сообщения и в группу.',
};

const SAVED = {
  city: (city) => ({ title: 'Город сохранён', lines: [`Город: <code>${city}</code>`] }),
  template: (preview) => ({
    title: 'Шаблон сохранён',
    lines: ['Предпросмотр:', `<code>${preview}</code>`],
  }),
  setting: (key, value) => ({
    title: 'Настройка сохранена',
    lines: [`<code>${key}</code> = <code>${value}</code>`],
  }),
};

const UPDATES = {
  none: (version) => ({
    title: 'Обновления',
    lines: ['Обновлений нет.', version ? `Текущая версия: <code>${version}</code>` : null].filter(Boolean),
  }),
  updating: (fromVer) => ({
    title: 'Обновление',
    lines: [
      'Вышла новая версия, обновляю…',
      fromVer ? `Версия: <code>${fromVer}</code>` : null,
    ].filter(Boolean),
  }),
  done: (fromVer, toVer) => ({
    title: 'Готово',
    lines: [
      'Код обновлён. Бот перезапускается через несколько секунд.',
      fromVer && toVer && fromVer !== toVer
        ? `Версия: <code>${fromVer}</code> → <code>${toVer}</code>`
        : fromVer || toVer
          ? `Версия: <code>${toVer || fromVer}</code>`
          : null,
    ].filter(Boolean),
  }),
  skipped: {
    title: 'Обновление пропущено',
    lines: ['На сервере есть локальные изменения в репозитории.'],
  },
  unavailable: {
    title: 'Недоступно',
    lines: ['Проверка обновлений возможна только на сервере с git-репозиторием.'],
  },
  fail: (message) => ({
    title: 'Ошибка обновления',
    lines: [message],
  }),
};

const ERRORS = {
  noAccess:
    'Чтобы понять что происходит в этом боте — почитайте репозиторий:\n' +
    'https://github.com/romanich237/max_bot',
  cancelled: 'Действие отменено.',
  notRecognized: 'Не удалось распознать. ',
  cityNotRecognized: 'Город не распознан. ',
  templateNotRecognized: 'Шаблон не распознан. ',
  reinstall:
    'Перезапустите установку:\n<code>bash &lt;(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)</code>',
  invalidFormat: 'Неверный формат. Попробуйте ещё раз или /cancel.',
  unknownKey: (keys) => `Неизвестный параметр. Доступно: ${keys}`,
  chatUrlRequired: 'Укажите ссылку на чат MAX.',
  namesRequired: 'Укажите имена через запятую.',
  valueRequired: 'Укажите значение после названия параметра.',
  numberRequired: 'Нужно целое число.',
};

module.exports = {
  BRAND,
  BOT_ABOUT,
  COMMANDS,
  BUTTONS,
  TOGGLES,
  HINTS,
  START,
  STATUS,
  AUTH,
  SETUP,
  REPLY,
  MONITORING,
  CHATS,
  SAVED,
  UPDATES,
  ERRORS,
  LINKS,
  TG_EMOJI,
  withTgEmoji,
  withOnOffEmoji,
  tgEmojiHtml,
  runWithPremiumEmoji,
};
