#!/usr/bin/env bash
# BSV OS on generic Linux: build the daemon from source and run it as a
# systemd user service when available, otherwise as a supervised background
# process. No Omarchy/Arch dependency — works on Debian/Ubuntu, Fedora/RHEL,
# Arch, and openSUSE (x86_64 and aarch64).
#
# Usage:
#   bash scripts/install-linux.sh              # install or update + start
#   bash scripts/install-linux.sh status       # service + daemon + wallet status
#   bash scripts/install-linux.sh uninstall    # stop + remove the service
#
# Env:
#   BSV_OS_DIR       repo checkout (default ~/bsv-os)
#   BSV_OS_BRANCH    git branch to track (default main)
#   BSV_WALLETD_DATA data dir (default ~/.local/share/bsv-os)
set -euo pipefail

DIR="${BSV_OS_DIR:-$HOME/bsv-os}"
BRANCH="${BSV_OS_BRANCH:-main}"
DATA_DIR="${BSV_WALLETD_DATA:-$HOME/.local/share/bsv-os}"
LABEL="bsv-walletd"
SERVICE="$HOME/.config/systemd/user/$LABEL.service"
PIDFILE="$DATA_DIR/walletd.pid"
LOG_OUT="$DATA_DIR/walletd.log"
LOG_ERR="$DATA_DIR/walletd.err.log"
REPO_URL="https://github.com/auxon/bsv-os"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_linux() {
  [ "$(uname -s)" = "Linux" ] || die "this script is for Linux (got $(uname -s))"
}

# True when anything the source build needs is missing: toolchain commands
# or the libsecret runtime the keytar native module links against.
need_sysdeps() {
  for cmd in git curl node npm gcc make python3; do
    command -v "$cmd" >/dev/null 2>&1 || return 0
  done
  ldconfig -p 2>/dev/null | grep -q "libsecret-1.so" || return 0
  return 1
}

# Detect the system package manager: apt > dnf > pacman > zypper.
pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v pacman >/dev/null 2>&1; then echo pacman
  elif command -v zypper >/dev/null 2>&1; then echo zypper
  else echo none; fi
}

install_sysdeps() {
  if ! need_sysdeps; then
    say "==> system deps already present — skipping"
    return 0
  fi
  local pm
  pm="$(pkg_manager)"
  case "$pm" in
    apt)
      say "==> installing system deps (apt)"
      sudo apt-get update -qq
      sudo apt-get install -y -qq git curl build-essential python3 libsecret-1-dev pkg-config dbus >/dev/null
      ;;
    dnf)
      say "==> installing system deps (dnf)"
      sudo dnf install -y -q git curl gcc gcc-c++ make python3 libsecret-devel pkg-config dbus >/dev/null
      ;;
    pacman)
      say "==> installing system deps (pacman)"
      sudo pacman -S --needed --noconfirm git base-devel libsecret curl python make gcc dbus >/dev/null
      ;;
    zypper)
      say "==> installing system deps (zypper)"
      sudo zypper install -y git curl gcc gcc-c++ make python3 libsecret-devel pkgconfig dbus-1 >/dev/null
      ;;
    none)
      say "    no supported package manager found (apt/dnf/pacman/zypper) — skipping system deps"
      say "    you need: git, curl, a C toolchain, python3, libsecret headers, dbus"
      ;;
  esac
}

require_tools() {
  command -v git >/dev/null || die "git missing"
  command -v node >/dev/null || die "node missing — install Node >= 22 (https://nodejs.org), distro packages are usually too old"
  command -v npm >/dev/null || die "npm missing — install it alongside node"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "node >= 22 required (have $(node -v))"
}

checkout() {
  if [ -d "$DIR/.git" ]; then
    say "==> updating $DIR ($BRANCH)"
    git -C "$DIR" fetch --quiet origin "$BRANCH"
    git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH" || say "    (local changes — keeping checkout as-is)"
  else
    say "==> cloning $REPO_URL -> $DIR"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
  fi
}

build() {
  say "==> building bsv-walletd"
  (cd "$DIR/packages/walletd" && npm install --silent --no-audit --no-fund && npm run build --silent)
  [ -f "$DIR/packages/walletd/dist/index.js" ] || die "build produced no dist/index.js"
}

link_cli() {
  local bin="$DIR/packages/walletd/dist/cli.js"
  chmod +x "$bin" 2>/dev/null || true
  mkdir -p "$HOME/.local/bin"
  ln -sf "$bin" "$HOME/.local/bin/bsv"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "    note: add ~/.local/bin to PATH to use 'bsv' from any shell" ;;
  esac
}

has_user_systemd() {
  systemctl --user show-environment >/dev/null 2>&1
}

write_systemd_unit() {
  say "==> installing systemd user service $LABEL"
  mkdir -p "$(dirname "$SERVICE")" "$DATA_DIR"
  local node_bin
  node_bin="$(command -v node)"
  cat > "$SERVICE" <<UNIT
[Unit]
Description=bsv-walletd — system BRC-100 wallet daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$node_bin $DIR/packages/walletd/dist/index.js
WorkingDirectory=$DIR/packages/walletd
Restart=on-failure
RestartSec=3
Environment=BSV_WALLETD_DATA=$DATA_DIR
StandardOutput=append:$LOG_OUT
StandardError=append:$LOG_ERR

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$LABEL"
}

start_background() {
  say "==> no systemd user bus — starting daemon as a background process"
  mkdir -p "$DATA_DIR"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    say "    already running (pid $(cat "$PIDFILE"))"
    return 0
  fi
  # Pick up daemon env (BSV_WALLETD_KEYSTORE=file etc.) the same way the
  # systemd unit does via its EnvironmentFile.
  if [ -f "$HOME/.config/bsv-os/walletd.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$HOME/.config/bsv-os/walletd.env"
    set +a
  fi
  # setsid detaches fully; nohup keeps it alive after this shell exits.
  BSV_WALLETD_DATA="$DATA_DIR" \
    setsid nohup "$(command -v node)" "$DIR/packages/walletd/dist/index.js" \
    >>"$LOG_OUT" 2>>"$LOG_ERR" < /dev/null &
  echo $! > "$PIDFILE"
  say "    started (pid $(cat "$PIDFILE"), logs $LOG_OUT)"
}

start_daemon() {
  if has_user_systemd; then
    write_systemd_unit
  else
    start_background
  fi
  wait_health || say "    daemon did not answer yet — see $LOG_ERR"
}

# Poll /health instead of a fixed sleep. A first run also has to generate the
# TLS cert and load node_modules cold, which can outrun any fixed delay and
# make a healthy daemon look dead.
wait_health() {
  local waited=0
  while [ "$waited" -lt 30 ]; do
    if curl -sk --max-time 2 https://127.0.0.1:2121/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

check_secret_service() {
  if dbus-send --session --print-reply --dest=org.freedesktop.DBus \
      /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null \
      | grep -q org.freedesktop.secrets; then
    return 0
  fi
  say "    note: no Secret Service on the session bus — 'bsv create'/'bsv unlock'"
  say "    need one (e.g. gnome-keyring-daemon). Headless alternative: the file"
  say "    backend — set BSV_WALLETD_KEYSTORE=file and BSV_WALLETD_KEYSTORE_PASSWORD"
  say "    in the daemon's environment (the 0600 walletd.env), then restart it."
  return 1
}

daemon_status() {
  if has_user_systemd; then
    say "==> systemd:"
    systemctl --user is-active "$LABEL" 2>/dev/null || say "    service not active"
  elif [ -f "$PIDFILE" ]; then
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      say "==> background daemon: running (pid $(cat "$PIDFILE"))"
    else
      say "==> background daemon: pidfile stale (was $(cat "$PIDFILE"))"
    fi
  else
    say "==> daemon: not running"
  fi
  say "==> health:"
  curl -sk --max-time 3 https://127.0.0.1:2121/health 2>/dev/null || say "    no answer on 127.0.0.1:2121 (see $LOG_ERR)"
  say ""
  if [ -x "$DIR/packages/walletd/dist/cli.js" ]; then
    node "$DIR/packages/walletd/dist/cli.js" status 2>/dev/null || say "    run: bsv create   (or: bsv import)"
  fi
}

stop_daemon() {
  if has_user_systemd; then
    systemctl --user disable --now "$LABEL" >/dev/null 2>&1 || true
    rm -f "$SERVICE"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  pkill -f "packages/walletd/dist/index.js" 2>/dev/null || true
}

uninstall() {
  say "==> stopping and removing the daemon"
  stop_daemon
  rm -f "$HOME/.local/bin/bsv"
  say "done — wallet data stays in $DATA_DIR"
}

main() {
  require_linux
  case "${1:-install}" in
    install)
      install_sysdeps
      require_tools
      checkout
      build
      link_cli
      start_daemon
      check_secret_service || true
      daemon_status
      say ""
      say "Next:"
      say "  bsv create            # new wallet (back up the phrase!), or"
      say "  bsv import            # restore an existing phrase"
      say "  bsv unlock            # needs a Secret Service (see note above)"
      say ""
      say "The Omarchy shell panel is not installed on generic Linux;"
      say "'bsv' is the console here. Logs: $LOG_OUT"
      ;;
    status) daemon_status ;;
    uninstall) uninstall ;;
    *) die "usage: install-linux.sh [install|status|uninstall]" ;;
  esac
}

main "$@"
