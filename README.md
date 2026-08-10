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

Одна команда — сама чинит DNS/IPv4, качает `install.sh`, ставит Node и бота.  
`DB_DRIVER` выбирать не надо (если MySQL уже есть — возьмёт его, иначе SQLite):

```bash
TG_TOKEN="токен из @BotFather" TG_CHAT_ID="ваш chat id" bash -c '
set -e
printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" >/etc/resolv.conf 2>/dev/null || true
export NODE_OPTIONS=--dns-result-order=ipv4first
for h in raw.githubusercontent.com github.com codeload.github.com api.github.com; do
  getent ahostsv4 "$h" >/dev/null 2>&1 && continue
  ip=$(curl -4 -fsS --connect-timeout 8 -H "accept: application/dns-json" \
    "https://1.1.1.1/dns-query?name=$h&type=A" 2>/dev/null \
    | grep -oE "\"data\":\"[0-9.]+\"" | head -1 | cut -d\" -f4 || true)
  [ -n "$ip" ] || continue
  grep -qE "[[:space:]]$h([[:space:]]|$)" /etc/hosts 2>/dev/null || echo "$ip $h # max-tg-boot" >>/etc/hosts
done
exec bash <(curl -4 -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
'
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
