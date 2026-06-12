#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/romanich237/max_bot.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/max-tg}"

echo "=== MAX → Telegram — установка ==="

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Ошибка: не найдена команда «$1»"
    exit 1
  fi
}

need_cmd git

if ! command -v node >/dev/null 2>&1; then
  echo "Ошибка: установите Node.js 18+ (https://nodejs.org/)"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Ошибка: нужен Node.js 18+, сейчас $(node -v)"
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Обновление: $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
elif [ -d "$INSTALL_DIR" ]; then
  echo "Ошибка: $INSTALL_DIR уже существует, но это не git-репозиторий"
  echo "Удалите папку или задайте другой путь: INSTALL_DIR=/path bash ..."
  exit 1
else
  echo "Клонирование в $INSTALL_DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo ""
exec npm run setup
