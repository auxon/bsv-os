#!/usr/bin/env bash
# BSV OS bootstrap for a fresh omarchy-mac (Quattro, aarch64) machine.
# Idempotent: safe to re-run. Run as your normal user (sudo used where needed).
set -euo pipefail

echo "==> [1/6] system deps"
sudo pacman -S --needed --noconfirm git base-devel libsecret gnome-keyring \
  sqlite python make gcc nodejs openssh

echo "==> [2/6] keyring unlock at login"
# GNOME Keyring must be open before walletd needs it; PAM wires it on Arch
# once the package is installed. Verify the daemon socket exists:
loginctl show-session "$(loginctl | awk -v u="$USER" '$3==u{print $1; exit}')" -p State 2>/dev/null | head -1 || true

echo "==> [3/6] bsv-os source"
if [ ! -d "$HOME/bsv-os/.git" ]; then
  git clone https://github.com/auxon/bsv-os.git "$HOME/bsv-os"
else
  git -C "$HOME/bsv-os" pull --ff-only
fi

echo "==> [4/6] walletd install + verify"
cd "$HOME/bsv-os/packages/walletd"
npm install --no-audit --no-fund
node scripts/check-arm.mjs
npm test
npm run build

echo "==> [5/6] user service"
mkdir -p ~/.local/bin
ln -sf "$HOME/bsv-os/packages/walletd/dist/cli.js" ~/.local/bin/bsv
chmod +x ~/.local/bin/bsv
systemctl --user daemon-reload
systemctl --user enable --now bsv-walletd
sleep 2
export PATH="$HOME/.local/bin:$PATH"
bsv status

echo "==> [6/6] done"
echo "Next: bsv create   # BACK UP the recovery phrase it prints ONCE"
echo "Then: bsv unlock && bsv balance"
echo "Shell plugins: see packages/shell/README.md (Quickshell integration)."
