#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/romanich237/max_bot.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/max-tg}"
NODE_VERSION="${NODE_VERSION:-20.18.1}"
NVM_VERSION="${NVM_VERSION:-0.40.3}"

echo "=== MAX → Telegram — установка ==="

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

can_sudo() {
  [ "$(id -u)" -eq 0 ] || sudo -n true 2>/dev/null || sudo true 2>/dev/null
}

apt_install() {
  run_root env DEBIAN_FRONTEND=noninteractive apt-get "$@"
}

refresh_path() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
  fi

  if [ -d "$HOME/.local/node/bin" ]; then
    PATH="$HOME/.local/node/bin:$PATH"
  fi

  if [ -d /usr/local/bin ]; then
    PATH="/usr/local/bin:$PATH"
  fi

  export PATH
}

node_major() {
  refresh_path
  if command -v node >/dev/null 2>&1; then
    node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
  elif command -v nodejs >/dev/null 2>&1; then
    nodejs -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

node_cmd() {
  refresh_path
  if command -v node >/dev/null 2>&1; then
    echo node
  elif command -v nodejs >/dev/null 2>&1; then
    echo nodejs
  else
    echo node
  fi
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return 0
  fi

  if [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1 && can_sudo; then
    echo "Установка curl..."
    apt_install update -qq
    apt_install install -y curl ca-certificates
    return 0
  fi

  echo "Ошибка: нужен curl"
  return 1
}

ensure_apt_packages() {
  local missing=()
  for pkg in "$@"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    return 0
  fi

  echo "Установка: ${missing[*]}..."
  apt_install update -qq
  apt_install install -y "${missing[@]}"
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi

  echo "Git не найден, устанавливаю..."

  if [ "$(uname -s)" != "Linux" ] || ! command -v apt-get >/dev/null 2>&1; then
    echo "Ошибка: установите git вручную"
    exit 1
  fi

  if ! can_sudo; then
    echo "Ошибка: для установки git нужен sudo"
    exit 1
  fi

  ensure_apt_packages git
}

install_node_via_nvm() {
  echo "Способ 1/3: NVM..."
  ensure_curl || return 1

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash
  fi

  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  nvm install 20
  nvm alias default 20
  nvm use default
  return 0
}

install_node_via_nodesource() {
  echo "Способ 2/3: NodeSource (apt)..."

  if [ "$(uname -s)" != "Linux" ] || ! command -v apt-get >/dev/null 2>&1; then
    echo "  apt недоступен"
    return 1
  fi

  if ! can_sudo; then
    echo "  sudo недоступен"
    return 1
  fi

  ensure_curl || return 1
  ensure_apt_packages curl ca-certificates gnupg || return 1

  if ! curl -fsSL https://deb.nodesource.com/setup_20.x | run_root -E bash -; then
    echo "  NodeSource setup не удался"
    return 1
  fi

  apt_install install -y nodejs || return 1
  return 0
}

install_node_via_binary() {
  echo "Способ 3/3: бинарник nodejs.org..."
  ensure_curl || return 1

  local arch tar_arch install_dir
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) tar_arch="x64" ;;
    aarch64|arm64) tar_arch="arm64" ;;
    *)
      echo "  архитектура не поддержана: $arch"
      return 1
      ;;
  esac

  install_dir="$HOME/.local/node"
  mkdir -p "$install_dir"

  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${tar_arch}.tar.gz"
  echo "  загрузка $url"
  curl -fsSL "$url" | tar -xz -C "$install_dir" --strip-components=1
  return 0
}

ensure_node() {
  refresh_path
  local major
  major="$(node_major)"

  if [ "$major" -ge 18 ]; then
    echo "Node.js $($(node_cmd) -v)"
    return 0
  fi

  if command -v node >/dev/null 2>&1 || command -v nodejs >/dev/null 2>&1; then
    echo "Node.js $($(node_cmd) -v) устарел, ставлю 20.x..."
  else
    echo "Node.js не найден, ставлю 20.x..."
  fi

  set +e
  install_node_via_nvm
  refresh_path
  major="$(node_major)"
  if [ "$major" -ge 18 ]; then
    set -e
    echo "Node.js $($(node_cmd) -v) готов (nvm)"
    return 0
  fi

  install_node_via_nodesource
  refresh_path
  major="$(node_major)"
  if [ "$major" -ge 18 ]; then
    set -e
    echo "Node.js $($(node_cmd) -v) готов (nodesource)"
    return 0
  fi

  install_node_via_binary
  refresh_path
  major="$(node_major)"
  set -e

  if [ "$major" -ge 18 ]; then
    echo "Node.js $($(node_cmd) -v) готов (binary)"
    return 0
  fi

  echo ""
  echo "Ошибка: не удалось установить Node.js 18+"
  echo "Попробуйте вручную:"
  echo "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  echo "  source ~/.nvm/nvm.sh && nvm install 20"
  exit 1
}

ensure_git
ensure_node
refresh_path

if ! command -v npm >/dev/null 2>&1; then
  echo "Ошибка: npm не найден после установки Node.js"
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
refresh_path
echo ""
echo "Node: $(command -v node || command -v nodejs) ($($(node_cmd) -v))"
echo "npm:  $(command -v npm) ($(npm -v))"
echo ""
exec env PATH="$PATH" NVM_DIR="${NVM_DIR:-$HOME/.nvm}" npm run setup
