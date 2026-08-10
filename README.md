# MAX → Telegram

Пересылает сообщения из [MAX](https://web.max.ru) в Telegram.

## Важно: европейский VPS

**Запускайте бота на европейском сервере** (Финляндия, Германия, Нидерланды, Польша и т.п.).

На российских VPS часто блокируется `api.telegram.org`, а вход в MAX по телефону упирается в капчу. Европейский сервер обычно стабильнее для Telegram API и веб-входа MAX.

Бот работает только на вашем VPS, данные сохраняются в вашу локальную базу данных

Рекомендуемый провайдер: [play2go.cloud](https://play2go.cloud/?ref_id=k5jH0xQ4-_g)

DE-PROMO
119₽ / мес.

- Процессор: 1 vCPU AMD Ryzen 9 5950X
- Оперативная память: 2 GB DDR4
- Хранилище: 25 GB NVMe SSD
- Скорость сети: До 100 Mbit/s
- Защита от DDoS:Мощная защита от атак L3-L4

## Установка (VPS)

Одной командой (скрипт сам чинит DNS/IPv4, ставит Node, клонит или качает zip):

```bash
TG_TOKEN="токен из @BotFather" TG_CHAT_ID="ваш chat id" \
  bash <(curl -4 -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

Если `curl` к raw.githubusercontent.com не идёт — сначала DNS, потом снова install:

```bash
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
TG_TOKEN="токен из @BotFather" TG_CHAT_ID="ваш chat id" \
  bash <(curl -4 -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

SQLite вместо MySQL:

```bash
TG_TOKEN="..." TG_CHAT_ID="..." DB_DRIVER=sqlite \
  bash <(curl -4 -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

## Команды в Telegram

| Команда | Описание |
|---------|----------|
| `/menu` | Настройки|
| `/reauth` | Повторный вход|

Остальное — через кнопки в `/menu`: статус, старт/стоп MAX, чат уведомлений.

## На сервере

```bash
pm2 logs max-tg
pm2 restart max-tg
```

Другой порт веб-страницы — в `config.json` → `sitePortal.port`.
