# BSV OS — session handoff (2026-09-14, dual-boot day)

For the next AI session, running **on the Linux box** (Omarchy). Read this
whole file before touching anything.

## 1. Machine & OS state

- MacBookAir10,1 (M1, 8 GB RAM). Dual-boot: macOS Tahoe 26.6.2 + Omarchy
  (Quattro, installed via omarchy-mac `quattro` branch onto Asahi Alarm).
- Partition saga (resolved): APFS shrink kept failing (-69605) on an
  immovable `com.apple.os.update` snapshot; freed ~70 GB of dev cruft
  (simulators, old DeviceSupport, DerivedData, EVE); discovered the first
  installer run had shrunk the filesystem to 425 GB without committing the
  partition map; a map-only `resizeContainer disk0s2 425g` synced it; the
  installer then proceeded. If disk weirdness recurs: snapshots pin shrinks,
  `diskutil apfs resizeContainer <disk> limits` shows ground truth.
- Hostname chosen: `bsv-air`. Expected user dir for the repo clone:
  `~/bsv-os`. Bootstrap: `scripts/post-install.sh` (idempotent).
- Developer on macOS side: user `rah`, shell zsh. Repos live under
  `/Users/rah/<name>` there; on Linux they will be under `~/...`.

## 2. Repo map (all github.com/auxon unless noted)

| Repo | What | State |
| --- | --- | --- |
| `bsv-os` | This repo. P0–M3 walletd, SKILLS.md, UserGuide.md, RUNBOOK-M1.md, ROADMAP.md, `packages/arch`, `packages/shell`, `scripts/post-install.sh` | Current, pushed |
| `gatekeep` | x402 Gateway upstream + PocketPets market/PvP order-book worker (Cloudflare + D1 `pocketpets-market`) + `/v1/utxos`, `/v1/broadcast`, `/v1/tx`, `/v1/txstatus` CORS proxies | Current, pushed (secrets git-ignored) |
| `pocketpets` | The reference game (React SPA, live at entangleit.com/pocketpets) | Current, pushed |
| `twetch-oidc` | Twetch OIDC issuer (id.entangleit.com) + paste-a-signature login | Has 4 UNCOMMITTED local edits (package.json, schema.sql, db.ts, wrangler.jsonc) — user's WIP, do not touch blindly |
| `macbook-air-vault` (PRIVATE) | AES-256-CBC backup of ssh/gnupg/docs/desktop/pictures | Passphrase shown once to user 2026-09-14 — **we do not have it** |

## 3. What works (all tested, all pushed)

- **walletd** (`packages/walletd`): HTTPS 127.0.0.1:2121 + Unix socket JSON-RPC;
  locked-by-default custody (12-word HD, OS keyring, 15-min auto-lock,
  create/import/unlock/lock/destroy); policy engine (allow/deny/ask+caps,
  first-run denial loop); chain layer (ARC writes, WoC reads, MockChain);
  monitor (seen→mined/failed, rebroadcast cap, reorg watch, SQLite);
  anchor engine (policy-gated OP_RETURN); Metanet app registry
  (manifest validate/install, `.desktop` launchers); MCP server
  (`bsv mcp --agent=NAME`, 5 tools, per-agent origins). 38 tests green.
- **CLI** (`bsv ...`): status/create/import/unlock/lock/pending/balance/
  anchor/allow/deny/requests/policies/app/mcp. Import uses hidden stdin
  prompt (never argv). Verified live against mainnet up to the money
  boundary (empty-wallet `short 144 sats` failure = full path proven).
- **Agent import was added then REMOVED** (prompt-injection re-homing risk).
  Do not re-add without relitigating: SKILLS.md documents the rule.
- **ARM-proofed**: better-sqlite3 12.11.1 + keytar 7.9.0 exact-pinned with
  verified linux-arm64 prebuilds; `scripts/check-arm.mjs` + pin test;
  `docs/arm.md` (Arch sysdeps: libsecret, gnome-keyring, python, make, gcc).

## 4. Secrets & credentials map (read before operating)

- **User's wallet backup**: only the user has it. Never ask for seeds/keys.
- **Gatekeep admin key**: `/Users/rah/gatekeep/.admin_key` (macOS side) —
  NEVER in git (gitignored with DEPLOYED.md). Needed for gateway admin ops.
- **Twetch OIDC**: `COOKIE_KEYS`, `SESSION_SECRET` in Cloudflare Workers;
  D1 `entangleit` holds `oauth_clients` (includes public `pocketpets` client).
- **Cloudflare**: account `4fce158a1a762f052c33df97d0799b63`; Workers
  `gatekeep-upstream`, `twetch-oidc` (id.entangleit.com), Pages project
  `richard-hein-portfolio` (entangleit.com). D1 `pocketpets-market`.
- **Money addresses**: fee/pot `1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4`.
  Operator (user) controls these keys, not us.
- **Keychain hygiene**: tests partition the keyring via
  `BSV_WALLETD_KEYCHAIN_SUFFIX`; committed code must never touch the
  un-suffixed production entries. macOS login keychain currently clean.

## 5. Hard-won gotchas (do not relearn)

- TS in walletd must be **erasable-syntax-only** (node strip-types in tests):
  no parameter properties, no enums/namespaces.
- **WOC address indexes can never contain inscription envelopes**
  (`addresses: None`): absence ≠ spent. Parent-tx + local history decide.
- Miner fees ≥1 sat/vB or ARC rejects ("fees insufficient").
- Broadcast-accepted ≠ confirmed: every spend is watched to terminal state;
  losers of double-spend races cost nothing — say so in UX copy.
- `public/_worker.js` on the portfolio: route blocks must live OUTSIDE the
  `/auth|/api` conditional (a whole feature once shipped dead-nested).
- Deploy pocketpets only via `scripts/deploy-entangleit.sh` (absolute
  paths; a relative `dist` once staged the wrong app live).
- Env vars don't persist across agent shell calls on macOS side — pass
  explicitly per command.

## 6. Immediate next actions (Linux session)

1. Run `scripts/post-install.sh`, then `node scripts/check-arm.mjs`, `npm test`.
2. `bsv create` (back up phrase), `systemctl --user enable --now bsv-walletd`.
3. Wire Quickshell pill + PayPrompt to the real shell (`packages/shell/README.md`
   checklist), register bar widget, try a real mainnet anchor + top-up.
4. Build `bsv-os-meta` (`packages/arch/bsv-os-meta/PKGBUILD`) with makepkg.
5. Then, in order: Twetch login as system identity → agentpay sub-wallets →
   PocketPets cutover onto walletd → x402/BSVBounties rails (see ROADMAP.md;
   recommended next-3: sandboxed runner, agent sub-wallets, spend dashboard).
