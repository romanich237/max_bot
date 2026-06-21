const { DEFAULT_BIO_TEMPLATE } = require('./profile-bio');

const BRAND = 'MAX → Telegram';

const COMMANDS = {
  start: 'Старт и меню',
  menu: 'Панель управления',
  reauth: 'Повторный вход в MAX',
};

const BUTTONS = {
  profileNames: 'Список имён',
  bioTemplate: 'Шаблон описания',
  bioCity: 'Город',
  maxChats: 'Чаты MAX',
  notifyChat: 'Куда приходят уведомления',
  refreshStatus: 'Обновить статус',
  stopMax: 'Остановить мониторинг',
  startMax: 'Запустить мониторинг',
  backToMenu: '« В меню',
  backToChats: '« К списку чатов',
  bindNotify: '✅ Привязать для уведомлений',
  discoverId: '🔍 Узнать ID',
  authQr: '📷 QR-код',
  authPhone: '📱 Номер телефона',
  refreshQr: '🔄 Обновить',
  checkUpdates: 'Проверить обновления',
};

const TOGGLES = {
  alwaysOnline: 'Статус «в сети»',
  profileRotate: 'Смена имени',
  profileBio: 'Смена описания',
};

const HINTS = {
  profileNames:
    'Отправьте имена через запятую — бот будет поочерёдно менять имя в MAX.\n\nПример: <code>в, ва, вас, вася</code>',
  profileBioCity:
    'Укажите город — для погоды в описании и часового пояса.\n\nПример: <code>Москва</code>',
  profileBioTemplate: [
    'Шаблон описания профиля MAX (до 400 символов после подстановки).',
    '',
    'Переменные:',
    '<code>{час}</code> <code>{минута}</code> <code>{день}</code> <code>{месяц}</code> <code>{погода}</code>',
    '',
    `По умолчанию: <code>${DEFAULT_BIO_TEMPLATE}</code>`,
  ].join('\n'),
  profileNamesEnabled: 'Смена имени включена. ',
  profileBioEnabled: 'Смена описания включена. Укажите город. ',
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
    '',
    `Чтобы узнать ID чата, нажмите «${BUTTONS.discoverId}» и выберите чат в списке.`,
  ].join('\n'),
  panel: 'Панель управления',
  help: 'Все команды и настройки — в /menu.',
};

const STATUS = {
  header: `<b>${BRAND}</b>`,
  monitoring: 'Мониторинг MAX',
  alwaysOnline: 'Статус «в сети»',
  profileRotate: 'Смена имени',
  profileBio: 'Смена описания',
  namesUnset: 'Имена: не заданы',
  cityUnset: 'Город: не задан',
  nameAuto: 'Имя в MAX: определяется автоматически',
  chatsHeader: 'Отслеживаемые чаты MAX',
  chatsUnset: 'Чаты не заданы',
  notifyUnset: 'Уведомления: не настроены',
  on: 'включён',
  off: 'выключен',
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
    ],
  },
  phoneWarningShort:
    'Для входа по номеру в MAX нужен пароль аккаунта. Если уже установлен — продолжайте.',
  sessionActive: {
    title: 'Вы уже в сети',
    lines: [
      'Сессия MAX активна — повторный вход не требуется.',
      '',
      'Чтобы войти заново: MAX → Настройки → Безопасность → Устройства — удалите это устройство.',
      'Затем отправьте /reauth.',
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
    ],
  },
  phonePrompt: {
    title: 'Номер телефона',
    lines: ['Отправьте номер, привязанный к аккаунту MAX.'],
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
    lines: ['Введите код подтверждения из SMS.'],
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
    title: 'Мониторинг остановлен',
    lines: ['Сообщения из MAX больше не пересылаются.'],
  },
  started: {
    title: 'Мониторинг запущен',
    lines: ['Сообщения из MAX снова приходят в Telegram.'],
  },
  stopUnavailable: 'Остановка недоступна. Перезапустите: <code>pm2 restart max-tg</code>',
  startUnavailable: 'Запуск недоступен. Выполните: <code>pm2 restart max-tg</code>',
};

const CHATS = {
  discoverEmpty: [
    '<b>Узнать ID чата</b>',
    '',
    `Нажмите «${BUTTONS.discoverId}» внизу — откроется список ваших чатов.`,
    'Выберите чат, и бот пришлёт его ID и название.',
    'Бот должен быть участником выбранного чата.',
  ].join('\n'),
  discoverHint: [
    'Выберите чат — бот покажет ID и название.',
    'Можно привязать чат для уведомлений из MAX.',
  ].join('\n'),
  discoverPrompt: `Нажмите «${BUTTONS.discoverId}» внизу и выберите чат в списке Telegram.`,
  infoHeader: 'Информация о чате',
  infoFooter: [
    'Скопируйте ID или нажмите «Привязать» — сюда будут приходить уведомления из MAX.',
    'Личные сообщения получают уведомления всегда; для группы — дублирование в ЛС и в группу.',
  ].join('\n'),
  notifyHeader: 'Куда приходят уведомления',
  notifyEmpty: 'Чаты для уведомлений пока не выбраны.',
  notifyFooter: [
    'По умолчанию уведомления идут в личные сообщения.',
    'Для группы — дублируются в ЛС и в саму группу.',
    '',
    `Привязать чат: «${BUTTONS.discoverId}» → выберите чат в списке.`,
  ].join('\n'),
  bound: {
    title: 'Чат привязан',
    lines: (isGroup) => [
      isGroup
        ? 'Уведомления из MAX будут приходить в личные сообщения и в эту группу.'
        : 'Уведомления из MAX будут приходить в личные сообщения.',
    ],
  },
  added: { title: 'Чат добавлен', lines: [] },
  duplicate: { title: 'Чат уже в списке', lines: ['Этот чат уже отслеживается.'] },
  addPrompt: [
    '<b>Добавить чат MAX</b>',
    '',
    'На скриншоте — ваши чаты в MAX.',
    'Отправьте <b>название</b> чата (как на скриншоте) или <b>ссылку</b>, например:',
    '<code>https://web.max.ru/-999999999999</code>',
    '',
    'Отмена: /cancel',
  ].join('\n'),
  addPromptNoScreenshot: [
    '<b>Добавить чат MAX</b>',
    '',
    'Отправьте <b>название</b> чата в MAX или <b>ссылку</b>, например:',
    '<code>https://web.max.ru/-999999999999</code>',
    '',
    'Отмена: /cancel',
  ].join('\n'),
  addPickerBusy: 'Список чатов MAX сейчас недоступен (идёт авторизация). Отправьте ссылку вручную.',
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
  primary: '⭐ Основной чат',
  secondary: 'Дополнительный чат',
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
  none: {
    title: 'Обновления',
    lines: ['Обновлений нет.'],
  },
  updating: (fromSha, toSha) => ({
    title: 'Обновление',
    lines: [
      'Вышла новая версия, обновляю…',
      fromSha && toSha ? `Версия: <code>${fromSha}</code> → <code>${toSha}</code>` : null,
    ].filter(Boolean),
  }),
  done: (fromSha, toSha) => ({
    title: 'Готово',
    lines: [
      'Бот обновлён и перезапущен.',
      fromSha && toSha ? `Версия: <code>${toSha}</code>` : null,
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
  noAccess: 'Нет доступа. Добавьте свой chat ID в <code>telegram.chatIds</code>.',
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
};
