# ARM (Apple Silicon / aarch64 Linux) notes

Target machine profile: MacBook Air M1 (MacBookAir10,1), 8 GB RAM.
Target OS path: Asahi Alarm -> omarchy-mac (Quattro) -> `bsv-os-meta` package.

## Dependency status (verified 2026-09-14)

| Dep | Pinned | linux-arm64 prebuild |
| --- | --- | --- |
| better-sqlite3 | 12.11.1 | yes (node v127/v137 = Node 22/24) |
| keytar | 7.9.0 | yes (napi-v3, ABI-stable) |
| everything else | — | pure JS, arch-independent |

Re-verify: `node scripts/check-arm.mjs [--write]`.
Unit guard: `test/arm-pins.test.mjs` fails the build if a native dep
drifts off its verified pin. Exact pins, no carets, for native modules.

## Arch system dependencies (for fallback source builds)

```bash
sudo pacman -S --needed libsecret python make gcc
```

- `keytar` needs **libsecret** at runtime (GNOME Keyring). Unlock the
  `login` keyring at graphical login (PAM `pam_gnome_keyring.so`), otherwise
  the first `unlock()` blocks on a prompt.
- If a prebuild 404s for a future Node ABI, `prebuild-install` falls back to
  `node-gyp` — hence the toolchain above.

## Runtime notes

- Node: use the Arch `nodejs` package (aarch64) or `mise`; Node 22 LTS or newer.
- SQLite files are portable across architectures — a wallet DB created on
  x86_64 opens fine on ARM (same page size, little-endian both sides).
- TPM2 sealing and fingerprint PAM flows ride on omarchy-mac's existing
  stack; walletd only needs the unlocked login keyring.
- 8 GB RAM is enough for walletd + monitor (SQLite, small mempool watch).
  Give Linux 60–70 GB; BSV chain data stays remote (ARC/WoC), never local.
