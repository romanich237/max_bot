# MAX → Telegram

Пересылает сообщения из [MAX](https://web.max.ru) в Telegram.

## Важно: европейский VPS

**Запускайте бота на европейском сервере** (Финляндия, Германия, Нидерланды, Польша и т.п.).

На российских VPS часто блокируется `api.telegram.org`, а вход в MAX по телефону упирается в капчу. Европейский сервер обычно стабильнее для Telegram API и веб-входа MAX.

Рекомендуемый провайдер: [play2go.cloud](https://play2go.cloud/?ref_id=k5jH0xQ4-_g)

## Установка (VPS)

Скрипт **сразу спросит в консоли** Telegram bot token и chat ID:

```bash
apt-get update
apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

node -v
npm -v

git clone --depth 1 https://github.com/romanich237/max_bot.git ~/max-tg
cd ~/max-tg
TG_TOKEN="токен бота из @BotFather" TG_CHAT_ID="ваш айди" npm run setup
```

Или переустановите с нуля после обновления скрипта:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

## Команды в Telegram

| Команда | Описание |
|---------|----------|
| `/menu` | Настройки (кнопки) |
| `/reauth` | Повторный вход (QR или телефон) |

Остальное — через кнопки в `/menu`: статус, старт/стоп MAX, чат уведомлений.

## На сервере

```bash
pm2 logs max-tg
pm2 restart max-tg
```

Другой порт веб-страницы — в `config.json` → `sitePortal.port`.
