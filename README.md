# MAX → Telegram

Пересылает сообщения из [MAX](https://web.max.ru) в Telegram.

## Установка (VPS)

```bash
bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

Нужны: **Telegram bot token** и **chat ID** (или `TG_TOKEN` + `TG_CHAT_ID`).

Скрипт сам: ставит MariaDB, создаёт базу, шлёт QR для входа в MAX, настраивает бота кнопками в Telegram, запускает PM2.

## Команды в Telegram

`/menu` — настройки · `/status` — статус · `/reauth` — новый QR

## На сервере

```bash
pm2 logs max-tg
pm2 restart max-tg
```
