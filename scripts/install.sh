#!/usr/bin/env bash
# BSV OS one-command install (aarch64 Omarchy).
#
#   curl -fsSL https://raw.githubusercontent.com/auxon/bsv-os/main/scripts/install.sh | bash
#
# Installs the bsv-os-meta package from GitHub releases (checksum-verified),
# enables the wallet daemon as a user service, and wires the shell plugin and
# file-manager share target. Idempotent; re-run to upgrade. On a machine with
# no release asset yet it falls back to the source installer.
set -euo pipefail

REPO="${BSV_OS_REPO:-auxon/bsv-os}"
BRANCH="${BSV_OS_BRANCH:-main}"

if [ "$(uname -m)" != "aarch64" ]; then
  echo "bsv-os-meta ships aarch64 only (this machine is $(uname -m))." >&2
  echo "Use the source install instead: scripts/post-install.sh" >&2
  exit 1
fi
for cmd in curl pacman systemctl sha256sum; do
  command -v "$cmd" >/dev/null || { echo "missing required command: $cmd" >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "==> [1/4] fetching latest bsv-os-meta release"
asset="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oE '"browser_download_url": *"[^"]+bsv-os-meta-[^"]+aarch64\.pkg\.tar\.xz"' \
  | head -1 \
  | sed -E 's/.*"(https[^"]+)"/\1/')"
if [ -z "$asset" ]; then
  echo "    no release asset found — falling back to the source install"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/scripts/post-install.sh" -o "$tmp/post-install.sh"
  exec bash "$tmp/post-install.sh"
fi
curl -fL --progress-bar -o "$tmp/$(basename "$asset")" "$asset"
curl -fsSL "${asset%/*}/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && sha256sum -c SHA256SUMS)
echo "    verified $(basename "$asset")"

echo "==> [2/4] installing package (sudo)"
sudo pacman -U --noconfirm "$tmp/$(basename "$asset")"

echo "==> [3/4] wallet daemon user service"
systemctl --user daemon-reload
systemctl --user enable --now bsv-walletd
for _ in 1 2 3 4 5; do
  if bsv status >/dev/null 2>&1; then
    bsv status
    break
  fi
  sleep 1
done

echo "==> [4/4] shell plugin + share target (best-effort)"
if [ -d /usr/share/bsv-os/shell-plugin ]; then
  mkdir -p "$HOME/.config/omarchy/plugins/bsv.wallet"
  cp -f /usr/share/bsv-os/shell-plugin/* "$HOME/.config/omarchy/plugins/bsv.wallet/"
  if command -v omarchy-shell >/dev/null 2>&1; then
    omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
    omarchy plugin enable bsv.wallet >/dev/null 2>&1 || true
    omarchy bar put bsv.wallet --section right >/dev/null 2>&1 || true
  fi
fi
if [ -f "/usr/share/bsv-os/nautilus/Anchor on BSV" ]; then
  mkdir -p "$HOME/.local/share/nautilus/scripts"
  cp -f "/usr/share/bsv-os/nautilus/Anchor on BSV" "$HOME/.local/share/nautilus/scripts/"
  chmod +x "$HOME/.local/share/nautilus/scripts/Anchor on BSV"
fi

echo
echo "BSV OS layer installed."
echo "Next: bsv create   # BACK UP the recovery phrase it prints ONCE"
echo "Then: bsv unlock && bsv balance"
echo "Docs: https://github.com/$REPO/blob/$BRANCH/UserGuide.md"