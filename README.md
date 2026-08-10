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

Рекомендуемый способ — один скрипт (сам ставит Node, чинит DNS к GitHub, клонит/zip-fallback, setup):

```bash
apt-get update && apt-get install -y curl ca-certificates
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
export NODE_OPTIONS=--dns-result-order=ipv4first
TG_TOKEN="токен из @BotFather" TG_CHAT_ID="ваш chat id" \
  bash <(curl -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

Если `raw.githubusercontent.com` / `github.com` не резолвятся — сначала hosts, потом снова install:

```bash
apt-get update && apt-get install -y curl ca-certificates
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
for h in github.com raw.githubusercontent.com codeload.github.com api.github.com; do
  ip=$(curl -fsS -H 'accept: application/dns-json' "https://1.1.1.1/dns-query?name=$h&type=A" \
    | grep -oE '"data":"[0-9.]+"' | head -1 | cut -d'"' -f4)
  [ -n "$ip" ] || continue
  grep -qE "[[:space:]]$h([[:space:]]|$)" /etc/hosts || echo "$ip $h" >> /etc/hosts
done
export NODE_OPTIONS=--dns-result-order=ipv4first
TG_TOKEN="токен из @BotFather" TG_CHAT_ID="ваш chat id" \
  bash <(curl -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

Ручная установка (если скрипт недоступен):

```bash
apt-get update && apt-get install -y git curl ca-certificates
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
export NODE_OPTIONS=--dns-result-order=ipv4first

git clone --depth 1 https://github.com/romanich237/max_bot.git ~/max-tg \
  || { curl -fsSL https://codeload.github.com/romanich237/max_bot/zip/refs/heads/main -o /tmp/max.zip \
       && apt-get install -y unzip && unzip -qo /tmp/max.zip -d /tmp && mv /tmp/max_bot-main ~/max-tg; }

cd ~/max-tg
TG_TOKEN="токен из @BotFather" TG_CHAT_ID="ваш chat id" npm run setup
```

Переустановка / обновление скрипта:

```bash
export NODE_OPTIONS=--dns-result-order=ipv4first
TG_TOKEN="..." TG_CHAT_ID="..." bash <(curl -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
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
