#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/max-tg}"

prepend_nvm_to_path() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  local bin_dir
  bin_dir="$(ls -1d "$NVM_DIR/versions/node/v"*/bin 2>/dev/null | sort -V | tail -n1)"
  [ -n "$bin_dir" ] && [ -x "$bin_dir/node" ] && PATH="$bin_dir:$PATH"
  export PATH
}

refresh_path() {
  prepend_nvm_to_path
  if [ -d "$HOME/.local/node/bin" ]; then
    PATH="$HOME/.local/node/bin:$PATH"
  fi
  if [ -d /usr/local/bin ]; then
    PATH="/usr/local/bin:$PATH"
  fi
  export PATH
}

resolve_node_bin() {
  refresh_path
  if [ -x "$HOME/.local/node/bin/node" ]; then
    echo "$HOME/.local/node/bin/node"
    return
  fi
  type -P node 2>/dev/null || type -P nodejs 2>/dev/null || true
}

echo "=== MAX → Telegram — продолжение установки ==="
echo ""

refresh_path

node_bin="$(resolve_node_bin)"
if [ -z "$node_bin" ]; then
  echo "Ошибка: Node.js не найден"
  echo "Установите Node 20:"
  echo "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  echo "  source ~/.nvm/nvm.sh && nvm install 20"
  exit 1
fi

echo "Node: $node_bin ($("$node_bin" -v 2>/dev/null || echo "неизвестно"))"

if ! command -v npm >/dev/null 2>&1; then
  echo "Ошибка: npm не найден"
  exit 1
fi

echo "npm:  $(command -v npm) ($(npm -v))"
echo ""

if [ ! -d "$INSTALL_DIR" ]; then
  echo "Ошибка: каталог не найден: $INSTALL_DIR"
  echo "Сначала запустите install.sh или клонируйте репозиторий"
  exit 1
fi

cd "$INSTALL_DIR"
refresh_path

if [ -z "${TG_TOKEN:-}" ]; then
  read -rp "Telegram bot token: " TG_TOKEN
  export TG_TOKEN
fi

if [ -z "${TG_CHAT_ID:-}" ]; then
  read -rp "Ваш Telegram chat ID: " TG_CHAT_ID
  export TG_CHAT_ID
fi

if [ -z "${TG_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then
  echo "Ошибка: нужны Telegram bot token и chat ID"
  exit 1
fi

if [ -z "${DB_DRIVER:-}" ]; then
  echo ""
  echo "База данных:"
  echo "  1) MySQL — рекомендуется для VPS"
  echo "  2) SQLite — файл в папке, если порт занят"
  read -rp "Выберите [1]: " db_choice
  case "$db_choice" in
    2|sqlite|SQLite) export DB_DRIVER=sqlite ;;
    *) export DB_DRIVER=mysql ;;
  esac
fi

echo ""
exec env PATH="$PATH" NVM_DIR="${NVM_DIR:-$HOME/.nvm}" TG_TOKEN="$TG_TOKEN" TG_CHAT_ID="$TG_CHAT_ID" DB_DRIVER="$DB_DRIVER" npm run setup
