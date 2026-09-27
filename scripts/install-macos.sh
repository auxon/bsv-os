#!/usr/bin/env bash
# BSV OS on macOS: build the daemon from source and run it as a launchd
# user agent. Ubuntu-style one-liner lives in README (install.sh is the
# Omarchy/pacman path); this is the macOS path.
#
# Usage:
#   bash scripts/install-macos.sh              # install or update + start
#   bash scripts/install-macos.sh status       # service + wallet status
#   bash scripts/install-macos.sh uninstall    # stop + remove the agent
#
# Env:
#   BSV_OS_DIR       repo checkout (default ~/bsv-os)
#   BSV_OS_BRANCH    git branch to track (default main)
#   BSV_WALLETD_DATA data dir (default ~/.local/share/bsv-os)
set -euo pipefail

DIR="${BSV_OS_DIR:-$HOME/bsv-os}"
BRANCH="${BSV_OS_BRANCH:-main}"
LABEL="com.bsv-os.walletd"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
UID_NUM="$(id -u)"
REPO_URL="https://github.com/auxon/bsv-os"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_mac() {
  [ "$(uname -s)" = "Darwin" ] || die "this script is for macOS (got $(uname -s))"
}

require_tools() {
  command -v git >/dev/null || die "git missing — run: xcode-select --install"
  command -v node >/dev/null || die "node missing — run: brew install node"
  command -v npm >/dev/null || die "npm missing — run: brew install node"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "node >= 22 required (have $(node -v)) — brew install node"
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
  (cd "$DIR/packages/walletd" && npm install --silent && npm run build --silent)
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

write_agent() {
  say "==> writing launchd agent $AGENT"
  mkdir -p "$(dirname "$AGENT")" "$LOG_DIR"
  local node_bin
  node_bin="$(command -v node)"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$DIR/packages/walletd/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR/packages/walletd</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/bsv-walletd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/bsv-walletd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST
}

load_agent() {
  say "==> (re)starting the agent"
  launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "gui/$UID_NUM" "$AGENT" >/dev/null 2>&1; then
    launchctl unload "$AGENT" >/dev/null 2>&1 || true
    launchctl load -w "$AGENT"
  fi
  wait_health
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

status() {
  say "==> launchd:"
  launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -E "state = |pid = " | head -2 || say "    agent not loaded"
  say "==> daemon:"
  curl -sk --max-time 3 https://127.0.0.1:2121/health || say "    no answer on 127.0.0.1:2121 (see $LOG_DIR/bsv-walletd.err.log)"
  say ""
  if [ -x "$DIR/packages/walletd/dist/cli.js" ]; then
    node "$DIR/packages/walletd/dist/cli.js" status 2>/dev/null || say "    run: bsv create   (or: bsv import)"
  fi
}

uninstall() {
  say "==> stopping and removing the agent"
  launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
  rm -f "$AGENT"
  rm -f "$HOME/.local/bin/bsv"
  say "done — wallet data stays in ${BSV_WALLETD_DATA:-$HOME/.local/share/bsv-os}"
}

main() {
  require_mac
  case "${1:-install}" in
    install)
      require_tools
      checkout
      build
      link_cli
      write_agent
      load_agent
      status
      say ""
      say "Next:"
      say "  bsv create            # new wallet (back up the phrase!), or"
      say "  bsv import            # restore an existing phrase"
      say "  bsv unlock            # macOS will ask once for Keychain access"
      say ""
      say "Runner apps open in Google Chrome (install it if missing)."
      say "The Hyprland panel is Linux-only; 'bsv' is the console here."
      say "Logs: $LOG_DIR/bsv-walletd.log"
      ;;
    status) status ;;
    uninstall) uninstall ;;
    *) die "usage: install-macos.sh [install|status|uninstall]" ;;
  esac
}

main "$@"
