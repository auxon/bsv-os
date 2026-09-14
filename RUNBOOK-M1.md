# Real install runbook — MacBookAir10,1 (M1 Air, 8 GB, macOS 26.5.2)

Preflight (2026-09-14): 124.5 GB free, FileVault OFF, NO Time Machine
destination, SIP enabled. Target: ~70 GB Linux, ~54 GB macOS headroom.

> Agent-executed steps are marked 🤖. Everything else is at-the-keyboard
> work — partitioning a live boot disk and rebooting are human jobs.
> Do not run the Apple/Asahi installer from an agent shell session.

## 0. Backup (you)

**No spare SSD? The no-disk safety net (done 2026-09-14, 🤖):**

- `gatekeep/` production worker was unversioned — now at
  `github.com/auxon/gatekeep` (live secrets excluded via `.gitignore`).
- Irreplaceables encrypted (AES-256-CBC + PBKDF2) and pushed to the
  **private** repo `github.com/auxon/macbook-air-vault`:
  `~/.ssh`, `~/.gnupg`, `~/Documents`, `~/Desktop`, `~/Pictures`
  (397 entries, decrypt-verified before upload, 3 chunks + SHA256SUMS).
- Restore: reassemble chunks → `openssl enc -d` with the passphrase shown
  once at backup time → `tar -tzf` to verify → extract over `$HOME`.
  Full steps in the vault repo's `RESTORE.md`.
- Already safe elsewhere: all code repos pushed, photos/iCloud originals in
  iCloud, iCloud Drive synced. Downloads excluded (re-downloadable).
- `twetch-oidc` still has 4 uncommitted local edits (yours, pre-existing) —
  commit or stash them before partitioning.

Understand the residual risk: no backup protects against whole-disk failure
during resize, only against file loss. APFS live-resize is mature and the
Asahi installer is widely run on this exact model — but if the SSD itself
had a bad day, recovery would mean macOS Internet Recovery, not your files.

## 1. Start the Asahi installer (you, macOS Terminal)

```bash
curl https://alx.sh | sh
```

- When it asks about the boot policy: choose **Reduced Security** and check
  "allow user management of kernel extensions" (required for m1n1/U-Boot).
  This needs your macOS admin password in a native Apple dialog.
- At sizing: give Linux **70 GB** minimum. The installer shrinks APFS live;
  expect it to take a while on a 124 GB-free disk. Do not sleep the Mac.
- When it offers an OS: pick the **Arch / Asahi Alarm** minimal option
  (omarchy-mac builds Omarchy on top of it in step 2).

Reboot into Arch when told. Log in as `root` / `root`, get online
(`ip link`, Wi-Fi via `nmcli` if needed).

## 2. One-command Omarchy (you, Arch tty1 as root)

```bash
curl -fsSL https://raw.githubusercontent.com/omarchy-mac/omarchy-mac/quattro/bin/omarchy-mac-setup | bash
```

Notes that have bitten people:

- Branch is **`quattro`** (default). `main` still carries Omarchy 3 — do not
  use it. If cloning manually: `git clone ... && cat version` must say 4.x.
- Say **yes** to encryption. Say yes to the `/boot`-to-ESP move it requires.
- Hostname `bsv-air`, your username, a strong password. It reboots ~3 times
  and resumes itself on tty1 each time (~15 min total).
- If anything stalls: `omarchy-mac-setup --status`, `--step <n>` to rerun
  one step, `--abort` to stop without undoing.

End state: encrypted btrfs Omarchy desktop, Snapper `@fresh` + `@factory`
restore points intact. Test Wi-Fi, sound, and one reboot before continuing.

## 3. BSV OS layer (you, or agent once SSH is up)

```bash
sudo pacman -S --needed git base-devel libsecret python nodejs openssh
sudo systemctl enable --now sshd   # agent access from here on
git clone https://github.com/auxon/bsv-os.git ~/bsv-os
cd ~/bsv-os/packages/walletd
npm install                 # linux-arm64 prebuilds verified for these pins
node scripts/check-arm.mjs  # re-verify prebuilds on this exact machine
npm test
```

Expected: 26/26 green, including the ARM pin guard. Then:

```bash
npm run build
./node_modules/.bin/tsx src/index.ts   # foreground first boot
```

`bsv status` → locked, no wallet. `bsv create` → back up the phrase.
Only then `systemctl --user enable --now bsv-walletd` (unit in repo).

## 4. Rollback paths (know these before step 1)

- **Before first Linux boot**: delete the Linux partitions in Disk Utility,
  expand macOS back. Harmless.
- **After Omarchy is in**: `omarchy snapshot restore` → `@fresh` (pre-Omarchy
  Arch) or `@factory` (installed, pre-you).
- **Nuclear**: wipe Linux partitions + full Time Machine restore from step 0.

## 5. Known M1 Air notes

- MacBookAir10,1 is a mature Asahi target (speakers, Wi-Fi, GPU, notch
  handling all landed; M3/M4 are the rough edges, not this machine).
- 8 GB RAM: fine for Hyprland + walletd + monitor. Close the browser before
  `npm install` if the OOM killer gets curious.
- FileVault is OFF: Asahi handles either state; leaving it off keeps the
  resize simple. Turn it on after Linux is stable if you want it.
