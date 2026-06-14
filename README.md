# MAX → Telegram

Пересылает сообщения из [MAX](https://web.max.ru) в Telegram.

## Важно: европейский VPS

**Запускайте бота на европейском сервере** (Финляндия, Германия, Нидерланды, Польша и т.п.).

На российских VPS часто блокируется `api.telegram.org`, а вход в MAX по телефону упирается в капчу. Европейский сервер обычно стабильнее для Telegram API и веб-входа MAX.

Рекомендуемый провайдер: [play2go.cloud](https://play2go.cloud/?ref_id=k5jH0xQ4-_g)

Откройте порт **3847** для веб-настройки и `/site`. При установке скрипт пробует **ufw → firewalld → iptables**. Если локального файрвола нет — откройте порт в **панели VPS**:

```bash
# если есть iptables (вы root — без sudo):
iptables -I INPUT -p tcp --dport 3847 -j ACCEPT

# или установить ufw:
apt-get update && apt-get install -y ufw
ufw allow 3847/tcp
ufw enable
```

## Установка (VPS)

Скрипт **сразу спросит в консоли** Telegram bot token и chat ID:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

Или передайте заранее:

```bash
TG_TOKEN="ваш_токен" TG_CHAT_ID="ваш_id" bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

После этого бот пришлёт в Telegram ссылку на настройку MAX:

```
https://ВАШ_IP:3847/setup/ТОКЕН
```

(IP подставляется автоматически. Используется **временный HTTPS** на 90 дней — браузер может показать предупреждение о сертификате, это нормально.)

На странице: ссылка на чат MAX, пароль @Browser, вход по телефону или QR.

Скрипт сам: ставит **git**, **Node.js 20**, MariaDB, зависимости, запускает PM2. **Автообновление с GitHub всегда включено** — проверка каждую минуту.

Требования: **Linux VPS в Европе**, `curl`, `sudo` (или root).

### Если установка упала на Node.js

Node уже может быть установлен (nvm). Проверьте и продолжите:

```bash
source ~/.nvm/nvm.sh && node -v
cd ~/max-tg && git pull --ff-only
TG_TOKEN="ваш_токен" TG_CHAT_ID="ваш_id" bash scripts/resume-setup.sh
```

Или переустановите с нуля после обновления скрипта:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
```

## Команды в Telegram

| Команда | Описание |
|---------|----------|
| `/menu` | Настройки |
| `/status` | Статус |
| `/site` | **MAX в браузере** — вход по номеру без QR |
| `/reauth` | Повторный вход (QR или телефон) |

### `/site` — вход без QR

Бот пришлёт ссылку на страницу с **встроенным MAX**:

1. Откройте ссылку в браузере на телефоне или ПК
2. Нажмите «Войти по номеру телефона» на странице MAX
3. Пройдите капчу и SMS вручную
4. Нажмите **«Сохранить сессию в бот»**

Сессия сохранится в бот, мониторинг продолжится.

## На сервере

```bash
pm2 logs max-tg
pm2 restart max-tg
```

Другой порт веб-страницы — в `config.json` → `sitePortal.port`.
