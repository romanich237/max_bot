#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/romanich237/max_bot.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/max-tg}"

echo "=== MAX → Telegram — установка ==="

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

apt_install() {
  run_root env DEBIAN_FRONTEND=noninteractive apt-get "$@"
}

ensure_linux_apt() {
  if [ "$(uname -s)" != "Linux" ]; then
    echo "Ошибка: автоустановка зависимостей доступна только на Linux VPS"
    echo "Установите вручную: git, Node.js 18+, npm"
    exit 1
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Ошибка: нужен Debian/Ubuntu (apt-get) для автоустановки"
    echo "Установите вручную: git, Node.js 18+ (https://nodejs.org/)"
    exit 1
  fi
}

ensure_apt_packages() {
  local missing=()
  for pkg in "$@"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    return
  fi

  echo "Установка: ${missing[*]}..."
  apt_install update -qq
  apt_install install -y "${missing[@]}"
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi

  echo "Git не найден, устанавливаю..."
  ensure_linux_apt
  ensure_apt_packages git ca-certificates curl
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

ensure_node() {
  local major
  major="$(node_major)"

  if [ "$major" -ge 18 ]; then
    echo "Node.js $(node -v)"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    echo "Node.js $(node -v) устарел, обновляю до 20.x..."
  else
    echo "Node.js не найден, устанавливаю 20.x..."
  fi

  ensure_linux_apt
  ensure_apt_packages curl ca-certificates gnupg

  curl -fsSL https://deb.nodesource.com/setup_20.x | run_root -E bash -
  apt_install install -y nodejs

  major="$(node_major)"
  if [ "$major" -lt 18 ]; then
    echo "Ошибка: не удалось установить Node.js 18+"
    exit 1
  fi

  echo "Node.js $(node -v) готов"
}

ensure_git
ensure_node

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
