#!/usr/bin/env bash
# one-liner: bash <(curl -fsSL https://raw.githubusercontent.com/romanich237/max_bot/main/install.sh)
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/romanich237/max_bot.git}"
REPO_SLUG="${REPO_SLUG:-romanich237/max_bot}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/max-tg}"
NODE_VERSION="${NODE_VERSION:-20.18.1}"
NVM_VERSION="${NVM_VERSION:-0.40.3}"

# IPv6 на VPS часто мёртв → ENETUNREACH
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
NODE_OPTIONS="$(echo "$NODE_OPTIONS" | xargs)"
export NODE_OPTIONS

fail() {
  echo ""
  echo "✗ $*"
  echo ""
  echo "Частые фиксы:"
  echo "  printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf"
  echo "  export NODE_OPTIONS=--dns-result-order=ipv4first"
  echo "  curl -4 -I https://github.com"
  echo "  curl -4 -I https://api.telegram.org"
  echo ""
  echo "Повтор:"
  echo "  TG_TOKEN=... TG_CHAT_ID=... bash <(curl -4 -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh)"
  exit 1
}

trap 'ec=$?; echo ""; echo "Ошибка install.sh:$LINENO код $ec"; exit "$ec"' ERR

echo "=== MAX → Telegram — установка ==="
echo "dir: $INSTALL_DIR | branch: $BRANCH"
echo ""

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

# curl всегда IPv4 + ретраи
c4() {
  curl -4 --connect-timeout 20 --retry 3 --retry-delay 2 --retry-all-errors "$@"
}

prepend_nvm_to_path() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  local bin_dir
  bin_dir="$(ls -1d "$NVM_DIR/versions/node/v"*/bin 2>/dev/null | sort -V | tail -n1 || true)"
  [ -n "$bin_dir" ] && [ -x "$bin_dir/node" ] && PATH="$bin_dir:$PATH"
  export PATH
}

refresh_path() {
  prepend_nvm_to_path
  [ -d "$HOME/.local/node/bin" ] && PATH="$HOME/.local/node/bin:$PATH"
  [ -d /usr/local/bin ] && PATH="/usr/local/bin:$PATH"
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

node_major() {
  local bin ver
  bin="$(resolve_node_bin)"
  [ -n "$bin" ] && [ -x "$bin" ] || { echo 0; return 0; }
  ver="$("$bin" -v 2>/dev/null || true)"
  ver="${ver#v}"
  ver="${ver%%.*}"
  ver="${ver//[!0-9]/}"
  echo "${ver:-0}"
}

node_version_label() {
  local bin ver
  bin="$(resolve_node_bin)"
  [ -n "$bin" ] || { echo "не найден"; return 0; }
  ver="$("$bin" -v 2>/dev/null || true)"
  echo "${ver:-не найден}"
}

has_node() {
  [ -n "$(resolve_node_bin)" ]
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return 0
  fi
  if [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1 && can_sudo; then
    echo "ставлю curl…"
    apt_install update -qq
    apt_install install -y curl ca-certificates
    return 0
  fi
  fail "нужен curl"
}

ensure_apt_packages() {
  local missing=()
  local pkg
  for pkg in "$@"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  [ "${#missing[@]}" -eq 0 ] && return 0
  echo "ставлю: ${missing[*]}"
  apt_install update -qq
  apt_install install -y "${missing[@]}"
}

ensure_git() {
  command -v git >/dev/null 2>&1 && return 0
  echo "ставлю git…"
  [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1 || fail "поставь git вручную"
  can_sudo || fail "для git нужен root/sudo"
  ensure_apt_packages git
}

ensure_unzip() {
  command -v unzip >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1 && can_sudo; then
    ensure_apt_packages unzip || true
  fi
}

# --- DNS / hosts ---

doh_a() {
  local host="$1" json ip
  json="$(c4 -fsS -H 'accept: application/dns-json' \
    "https://1.1.1.1/dns-query?name=${host}&type=A" 2>/dev/null || true)"
  ip="$(printf '%s' "$json" | grep -oE '"data":"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"' | head -n1 | cut -d'"' -f4 || true)"
  if [ -z "$ip" ]; then
    json="$(c4 -fsS "https://8.8.8.8/resolve?name=${host}&type=A" 2>/dev/null || true)"
    ip="$(printf '%s' "$json" | grep -oE '"data":"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"' | head -n1 | cut -d'"' -f4 || true)"
  fi
  # запасные IP если DoH тоже лежит
  if [ -z "$ip" ]; then
    case "$host" in
      github.com) ip="140.82.121.4" ;;
      api.github.com) ip="140.82.121.6" ;;
      codeload.github.com) ip="140.82.121.10" ;;
      raw.githubusercontent.com) ip="185.199.110.133" ;;
      objects.githubusercontent.com) ip="185.199.110.133" ;;
      deb.nodesource.com) ip="" ;;
      *) ip="" ;;
    esac
  fi
  printf '%s' "$ip"
}

hosts_upsert() {
  local host="$1" ip="$2" marker="# max-tg-install ${host}" tmp
  [ -n "$ip" ] || return 1
  tmp="$(mktemp)"
  if [ -w /etc/hosts ]; then
    grep -vF "$marker" /etc/hosts 2>/dev/null | grep -vE "[[:space:]]${host}([[:space:]]|$)" >"$tmp" || true
    printf '%s %s %s\n' "$ip" "$host" "$marker" >>"$tmp"
    cat "$tmp" >/etc/hosts
  elif can_sudo; then
    grep -vF "$marker" /etc/hosts 2>/dev/null | grep -vE "[[:space:]]${host}([[:space:]]|$)" >"$tmp" || true
    printf '%s %s %s\n' "$ip" "$host" "$marker" >>"$tmp"
    run_root cp "$tmp" /etc/hosts
  else
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  echo "  hosts $host -> $ip"
}

fix_resolv() {
  [ "$(id -u)" -eq 0 ] || can_sudo || return 0
  # не трогаем systemd-resolved stub если уже ок — просто дописываем публичные NS где можно
  if [ -f /etc/resolv.conf ]; then
    if ! grep -qE 'nameserver 1\.1\.1\.1|nameserver 8\.8\.8\.8' /etc/resolv.conf 2>/dev/null; then
      {
        echo "nameserver 1.1.1.1"
        echo "nameserver 8.8.8.8"
        grep -E '^nameserver ' /etc/resolv.conf 2>/dev/null | head -n 3 || true
      } | run_root tee /etc/resolv.conf >/dev/null || true
      echo "  resolv.conf -> 1.1.1.1 / 8.8.8.8"
    fi
  fi
  command -v resolvectl >/dev/null 2>&1 && run_root resolvectl flush-caches 2>/dev/null || true
}

reach_https() {
  local url="$1"
  c4 -fsSI --max-time 12 "$url" >/dev/null 2>&1
}

ensure_network() {
  echo "сеть / DNS…"
  fix_resolv

  local host ip
  for host in github.com api.github.com codeload.github.com raw.githubusercontent.com \
    objects.githubusercontent.com api.telegram.org registry.npmjs.org deb.nodesource.com nodejs.org; do
    if getent hosts "$host" >/dev/null 2>&1 || host "$host" >/dev/null 2>&1; then
      continue
    fi
    ip="$(doh_a "$host")"
    [ -n "$ip" ] && hosts_upsert "$host" "$ip" || true
  done

  # даже если getent ок — пробьём github/telegram на всякий
  if ! reach_https "https://github.com"; then
    echo "  github тупит — ещё раз DoH → hosts"
    for host in github.com codeload.github.com raw.githubusercontent.com api.github.com; do
      ip="$(doh_a "$host")"
      [ -n "$ip" ] && hosts_upsert "$host" "$ip" || true
    done
  fi

  if reach_https "https://github.com"; then
    echo "  github.com ок"
  else
    echo "  ! github.com всё ещё плохо — будет zip/зеркало"
  fi

  if reach_https "https://api.telegram.org"; then
    echo "  api.telegram.org ок"
  else
    echo "  ! telegram API недоступен (нужен EU VPS или HTTPS_PROXY)"
  fi
}

# --- Node ---

install_node_via_nvm() {
  echo "Node: NVM…"
  ensure_curl || return 1
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    c4 -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash \
      || c4 -fsSL "https://ghproxy.net/https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash \
      || return 1
  fi
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm alias default 20
  prepend_nvm_to_path
}

install_node_via_nodesource() {
  echo "Node: NodeSource…"
  [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1 || return 1
  can_sudo || return 1
  ensure_curl || return 1
  ensure_apt_packages curl ca-certificates gnupg || return 1
  if [ "$(id -u)" -eq 0 ]; then
    c4 -fsSL https://deb.nodesource.com/setup_20.x | bash - || return 1
  else
    c4 -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || return 1
  fi
  apt_install install -y nodejs || return 1
}

install_node_via_binary() {
  echo "Node: binary…"
  ensure_curl || return 1
  local arch tar_arch install_dir url
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) tar_arch="x64" ;;
    aarch64|arm64) tar_arch="arm64" ;;
    *) echo "  arch $arch не поддерживается"; return 1 ;;
  esac
  install_dir="$HOME/.local/node"
  mkdir -p "$install_dir"
  url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${tar_arch}.tar.gz"
  c4 -fsSL "$url" | tar -xz -C "$install_dir" --strip-components=1
}

ensure_node() {
  refresh_path
  local major
  major="$(node_major)"
  if [ "${major:-0}" -ge 18 ] 2>/dev/null; then
    echo "Node.js $(node_version_label)"
    return 0
  fi

  echo "ставлю Node.js 20.x…"
  set +e
  local order=()
  if [ "$(id -u)" -eq 0 ]; then
    order=(install_node_via_nodesource install_node_via_binary install_node_via_nvm)
  else
    order=(install_node_via_nvm install_node_via_nodesource install_node_via_binary)
  fi
  local fn
  for fn in "${order[@]}"; do
    "$fn"
    refresh_path
    major="$(node_major)"
    if [ "${major:-0}" -ge 18 ] 2>/dev/null; then
      set -e
      echo "Node.js $(node_version_label) готов ($fn)"
      return 0
    fi
  done
  set -e
  fail "не удалось поставить Node.js 18+"
}

open_portal_port() {
  local port="${SETUP_PORT:-3847}"
  can_sudo || { echo "порт ${port}/tcp: нет sudo — открой в панели"; return 0; }

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active'; then
    run_root ufw allow "${port}/tcp" >/dev/null 2>&1 || true
    echo "порт ${port}/tcp открыт (ufw)"
    return 0
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && run_root firewall-cmd --state >/dev/null 2>&1; then
    run_root firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    run_root firewall-cmd --reload >/dev/null 2>&1 || true
    echo "порт ${port}/tcp открыт (firewalld)"
    return 0
  fi
  if command -v iptables >/dev/null 2>&1; then
    run_root iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1 \
      || run_root iptables -I INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1 \
      || true
    echo "порт ${port}/tcp (iptables)"
    return 0
  fi
  echo "порт ${port}/tcp: открой в панели хостинга"
}

# --- repo ---

download_repo_zip() {
  local dest="$1"
  local urls=(
    "https://codeload.github.com/${REPO_SLUG}/zip/refs/heads/${BRANCH}"
    "https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.zip"
    "https://ghproxy.net/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.zip"
    "https://mirror.ghproxy.com/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.zip"
    "https://gitclone.com/github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.zip"
  )
  local url
  for url in "${urls[@]}"; do
    echo "  zip ← $url"
    if c4 -fsSL --max-time 180 "$url" -o "$dest" && [ -s "$dest" ]; then
      return 0
    fi
  done
  return 1
}

install_from_zip() {
  ensure_unzip
  command -v unzip >/dev/null 2>&1 || fail "нужен unzip (apt-get install -y unzip)"

  local tmp src
  tmp="$(mktemp -d)"
  echo "ставлю из zip…"
  download_repo_zip "$tmp/repo.zip" || { rm -rf "$tmp"; fail "не скачал архив репо"; }

  mkdir -p "$tmp/extract" "$INSTALL_DIR"
  unzip -qo "$tmp/repo.zip" -d "$tmp/extract"
  src="$(find "$tmp/extract" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$src" ] || { rm -rf "$tmp"; fail "пустой zip"; }

  # обновляем поверх, не снося сессию/конфиг если уже стояло
  cp -a "$src"/. "$INSTALL_DIR"/
  rm -rf "$tmp"

  if [ ! -d "$INSTALL_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    git -C "$INSTALL_DIR" init >/dev/null 2>&1 || true
    git -C "$INSTALL_DIR" remote remove origin >/dev/null 2>&1 || true
    git -C "$INSTALL_DIR" remote add origin "$REPO_URL" >/dev/null 2>&1 || true
    git -C "$INSTALL_DIR" checkout -B "$BRANCH" >/dev/null 2>&1 || true
  fi
  echo "репо из zip → $INSTALL_DIR"
}

clone_or_update_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "обновляю $INSTALL_DIR…"
    if git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" \
      && git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"; then
      return 0
    fi
    echo "git update отвалился — zip"
    install_from_zip
    return 0
  fi

  if [ -d "$INSTALL_DIR" ]; then
    if [ -f "$INSTALL_DIR/package.json" ]; then
      echo "$INSTALL_DIR уже есть — обновляю zip-ом"
      install_from_zip
      return 0
    fi
    fail "$INSTALL_DIR занята и это не max-tg. INSTALL_DIR=/other/path bash …"
  fi

  echo "клонирую → $INSTALL_DIR"
  if git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"; then
    return 0
  fi
  echo "git clone мимо — zip"
  install_from_zip
}

# --- main ---

ensure_curl
ensure_network
ensure_git
ensure_unzip || true

echo "проверка Node…"
ensure_node
refresh_path

command -v npm >/dev/null 2>&1 || fail "npm не найден после установки Node"

clone_or_update_repo
cd "$INSTALL_DIR"
refresh_path
open_portal_port

echo ""
echo "Node: $(resolve_node_bin) ($(node_version_label))"
echo "npm:  $(command -v npm) ($(npm -v 2>/dev/null || echo '?'))"
echo "NODE_OPTIONS=$NODE_OPTIONS"
echo ""

if [ -z "${TG_TOKEN:-}" ]; then
  read -rp "Telegram bot token (@BotFather): " TG_TOKEN
  export TG_TOKEN
fi
if [ -z "${TG_CHAT_ID:-}" ]; then
  read -rp "Ваш Telegram chat ID: " TG_CHAT_ID
  export TG_CHAT_ID
fi
[ -n "${TG_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ] || fail "нужны TG_TOKEN и TG_CHAT_ID"

if [ -z "${DB_DRIVER:-}" ]; then
  if [ -t 0 ]; then
    echo ""
    echo "База:"
    echo "  1) MySQL/MariaDB (VPS)"
    echo "  2) SQLite (файл, проще)"
    read -rp "Выбор [1]: " db_choice
    case "$db_choice" in
      2|sqlite|SQLite) export DB_DRIVER=sqlite ;;
      *) export DB_DRIVER=mysql ;;
    esac
  else
    export DB_DRIVER="${DB_DRIVER:-mysql}"
    echo "DB_DRIVER=$DB_DRIVER (неинтерактивно)"
  fi
fi

echo ""
echo "запускаю npm run setup…"
exec env \
  PATH="$PATH" \
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}" \
  NODE_OPTIONS="$NODE_OPTIONS" \
  TG_TOKEN="$TG_TOKEN" \
  TG_CHAT_ID="$TG_CHAT_ID" \
  DB_DRIVER="$DB_DRIVER" \
  npm run setup
