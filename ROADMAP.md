# BSV OS — Feature Roadmap

> Read-only planning doc. The M0–M3 + P1–P4 spine below is preserved as-is from
> `README.md` / `UserGuide.md` / `RUNBOOK-M1.md`; everything new is an
> F-item with problem → behavior → layer → size → dependencies → accept.
> `Accept` is the click-path or command transcript that proves the item:
> no item is done until its acceptance runs green on a real machine.

## Preserved spine M0–M3 + P1–P4 (do not reorder)

- **M0 — Daemon skeleton + custody boundary** ✅ (done): `bsv-walletd`
  HTTPS `127.0.0.1:2121` + Unix socket, same JSON-RPC shape; raw key
  material lives only in `packages/walletd/src/custody.ts` (CI-enforced);
  MockChain + custody-boundary + RPC tests, no network.
- **M1 — Real custody + lock lifecycle:** ✅ (done) OS keyring (`keytar`:
  libsecret on Arch, Keychain on macOS) under `bsv-walletd`/`master`,
  12-word enrollment, 15-min idle auto-lock, `create`/`import`/`unlock`/`lock`.
- **M2 — Chain + monitor:** ✅ (done) ARC writes + WhatsOnChain reads
  (`chain.ts`), every broadcast tracked seen → mined/failed with
  rebroadcast cap and reorg watch (`monitor.ts`, SQLite via `storage.ts`).
- **M3 — Policy + CLI + first app flow + MCP + apps registry:** ✅ (done) per-origin allow/deny/ask + caps
  (`policy.ts`), `bsv` CLI as policy console, anchor-only policy-gated
  engine (`engine.ts`/`tx.ts`), apps registry + `.desktop` launchers
  (`apps.ts`/`desktop.ts`), MCP agent bridge (`mcp.ts`, `SKILLS.md`).
- **P1–P4 next — Shell + identity + rails + ISO:** Quickshell `WalletPill` /
  `PayPrompt` scaffold wired to the shell surface, Twetch OIDC as system
  identity, agentpay/x402/BSVBounties rails, Omarchy M1 installer
  (`RUNBOOK-M1.md` Path A).

Size key: **S** = days, single module; **M** = ~1–2 weeks, cross-module;
**L** = multi-week, protocol or packaging lift.

## New features (F-items)

- **F1 — Metanet App Store (browse/install/updates).** Problem: `bsv app
  install <domain>` works but there is no discovery, trust signal, or
  update path, so users cannot find or safely evaluate Metanet apps.
  Behavior: launcher store tab listing curated manifests with requested
  permissions/caps shown pre-install, one-tap install/remove, background
  manifest re-pin with diff prompt on permission widening. Layer:
  daemon (apps registry + re-pin job) + shell (store UI) + packaging
   (ships in ISO). Size: **M**. Depends: **P3** (apps registry).
   Accept: `bsv store` shows requested caps pre-install; install + remove
   one-tap from the panel; a widened re-pin prompts a diff, never applies
   silently.
- **F2 — Sandboxed runner with `window.bsv` (BRC-100 bridge).** Problem:
  installed apps today hop out to the default browser with no wallet
  bridge, so they are bookmarks, not native citizens, and any injection
  would be unenforced. Behavior: sandboxed webview shell that opens
  installed `start_url`s, injects a capability-scoped `window.bsv`
  (spend/sign only via daemon intents under the app's origin policy),
   no key/DOM-escape surface. Layer: daemon (origin-scoped RPC) +
   packaging (webview runtime). Size: **L**. Depends: **P3, F1**.
   Accept: two installed apps open concurrently from the panel with no
   blocking; every window.bsv write gates on its origin policy; the
   custody-boundary test proves no key material reaches the page.
- **F3 — Identity Center (Twetch OIDC + certs + selective disclosure).**
  Problem: the daemon has an `identityKey` but the OS has no login,
  no certificate holdings, and no way to prove attributes without
  oversharing. Behavior: Twetch OIDC as system sign-in binding the
  wallet identity, cert wallet (store/hold/present BRC- certificates),
  per-request disclosure sheet (reveal only checked fields, policy-logged).
  Layer: daemon (cert store + disclosure RPC) + shell (login +
   disclosure UI) + rails (Twetch OIDC). Size: **L**. Depends: **P4**
   (Twetch), **F8** for audit view.
   Accept: sign in with Twetch binds the wallet identity; a disclosure
   sheet reveals only checked fields and logs the disclosure.
- **F4 — Money views: baskets (multi-balance ledger).** Problem: `bsv
  balance` shows one P2PKH pot, so app-held, escrowed, or protocol-locked
  funds are invisible or conflated with spendable balance. Behavior:
  BRC- basket accounting in daemon (per-basket balances from chain +
  app attributions), CLI `bsv basket list/balance`, shell pill expands
  to per-basket rows. Layer: daemon (indexer + RPC) + shell (money
   view). Size: **M**. Depends: **P2** (chain reads), **F2** (app
   attribution).
   Accept: `bsv basket list/balance` reconciles with chain + app
   attributions; the panel pill expands to per-basket rows.
- **F5 — Money views: Ordinals (1Sat) + BSV21 tokens.** Problem: NFTs
  and fungible tokens controlled by the same keys are invisible in
  the OS, forcing users to third-party viewers that want seeds.
  Behavior: read-only-first gallery/list (inscription envelopes via
  parent-tx resolution per `resolveOutpoint`, BSV21 balances), send
  flows policy-gated like anchors, never exposing keys. Layer: daemon
   (index + send engine) + shell (gallery). Size: **M**. Depends: **P2,
   F4**.
   Accept: the gallery resolves inscription envelopes per `resolveOutpoint`
   without seeds; sends gate on policy like anchors.
- **F6 — Encrypted messaging (BRC- key exchange + transport).** Problem:
  agents, apps, and contacts have no private channel anchored to wallet
  identity, so coordination leaks to email/chat. Behavior: DM + group
  threads keyed to identity keys (ECDH, store-and-forward via overlay
  or lightweight relay), shell inbox with pay-to-message spam pricing
  optional, daemon holds no plaintext beyond delivery. Layer: daemon
   (crypto + outbox) + shell (inbox UI) + rails (relay/overlay).
   Size: **L**. Depends: **F3** (identity keys), **F11** (overlay
   transport).
   Accept: two identities exchange a DM thread end-to-end; the daemon
   never holds plaintext beyond delivery; spam pricing enforced when set.
- **F7 — Share-to-BSV (system share sheet → on-chain).** Problem:
  timestamping today is `sha256sum` + `bsv anchor`, so no GUI app can
  publish in one tap. Behavior: OS share target ("Anchor / Inscribe /
  Post") that hashes or packages the file, routes through policy +
  PayPrompt, returns txid with explorer link, history in the spend
  dashboard. Layer: shell (share sheet) + daemon (anchor/inscribe
   engine). Size: **S**. Depends: **P3** (anchor flow), **F8**.
   Accept: one tap from the share sheet returns a txid + explorer link;
   the spend lands in history under the file's label.
- **F8 — Spend dashboard (ledger + policy audit).** Problem: spend
  history is scattered across `pending`, `requests`, and `policies`,
  so users cannot answer "what did what spend, and why". Behavior:
  single view merging confirmed/in-flight txs, per-origin approvals,
  caps, and denials with retry/revoke actions; CLI `bsv history` emits
  the same JSON. Layer: daemon (unified history RPC) + shell
   (dashboard). Size: **S**. Depends: **P2, P3**.
   Accept: one view merges confirmed/in-flight txs, approvals, caps, and
   denials with working retry/revoke; `bsv history` JSON matches the view.
- **F9 — Agent sub-wallets (allowances with lifetime budgets).** Problem:
  per-agent caps today are single-action ceilings with no budget,
  expiry, or delegation, so long-running agents need repeated human
  top-ups or over-broad caps. Behavior: `bsv agent mint <name>
  --budget --daily --expiry` issuing scoped child credentials mirroring
  the agentpay subagent model, enforced in `policy.ts` alongside caps,
  revocable in one command, surfaced in the dashboard. Layer: daemon
   (policy + engine) + shell (agent cards) + rails (agentpay parity).
   Size: **M**. Depends: **P3** (policy), **F8**, **F14**.
   Accept: `bsv agent mint --budget/--daily/--expiry` then spends pass
   without prompts until the budget binds; `revoke` cuts access in one
   command; panel cards show remaining.
- **F10 — Social recovery (Shamir guardians + rotation).** Problem: the
  12-word phrase is a single point of failure (lose it = lose
  everything, copy it = expose everything). Behavior: opt-in Shamir
  split of the seed into N-of-M guardian shares (QR/print + optional
  Twetch-identity-bound guardians), recovery ceremony reconstituting
  only on-device, rotation/revocation of shares without moving funds.
  Layer: daemon (custody ceremony) + shell (guided setup) +
   packaging (recovery docs in installer). Size: **L**. Depends: **P1**
   (custody), **F3** (guardian identity).
   Accept: the N-of-M ceremony reconstitutes on-device only; shares rotate
   without moving funds; setup completes from the guided shell flow.
- **F11 — Overlay explorer (lookup + publish).** Problem: overlays are
  invisible from the OS, so users cannot verify or consume overlay-
  hosted data their apps rely on. Behavior: explorer view to resolve
  overlay topics/UTXOs, inspect advertisements, and submit overlay-
  tagged transactions through policy; CLI `bsv overlay lookup/submit`.
   Layer: daemon (overlay sync + RPC) + shell (explorer). Size: **M**.
   Depends: **P2** (chain), **F6** reuses its transport.
   Accept: `bsv overlay lookup` resolves a topic/UTXO and `submit` lands an
   overlay-tagged tx through policy.
- **F12 — BSVBounties task board in the launcher (GigsFeed citizen).**
  Problem: paid micro-work lives in a browser tab disconnected from
  wallet policy, so earning into the OS wallet takes manual juggling.
  Behavior: launcher board showing open bounties/gigs, claim → submit →
  approve flow with escrow state, earnings landing as labeled basket
   entries; **GigsFeed** is the reference feed (TikTok-style micro-gigs,
   one-tap approval). Layer: shell (board) + daemon (bounty intents +
   basket labels) + rails (BSVBounties/agentpay). Size: **M**. Depends:
   **F4, F14**.
   Accept: the board lists open bounties; claim → submit → approve lands
   earnings as labeled basket entries.
- **F13 — NightShift standing orders (always-on agent ops).** Problem:
  recurring agent work (due cycles, cron-spawned jobs) has no OS home,
  so schedules live in fragile external setups outside policy.
  Behavior: system service for standing orders with per-cycle escrow
  (claim → submit → approve), schedule management in shell, every cycle
  bound to the agent's sub-wallet budget. Layer: daemon (scheduler +
   escrow intents) + shell (schedules UI) + rails (bounties/cron).
   Size: **M**. Depends: **F9, F12**.
   Accept: a schedule fires per-cycle escrow bound to its sub-wallet
   budget; the panel shows schedules, runs, and per-cycle outcomes.
- **F14 — x402 pay-per-call + attestations rail.** Problem: apps and
  agents cannot pay per API call or prove payment history, so metered
  services and reputation pricing stay out of reach. Behavior: daemon-
  mediated x402 settlements (per-call quote → policy check → pay →
  receipt) plus signed spend-history attestations for discount/trust
  tiers; CLI `bsv x402 pay`, MCP tools for agents. Layer: daemon
   (settlement + receipts) + rails (x402 Gateway/market, attestations).
   Size: **M**. Depends: **P3** (policy/engine), **F9** (agent budgets).
   Accept: `bsv x402 pay` runs quote → policy → pay → receipt; the MCP
   tools do the same for agents; attestations verify.
- **F15 — ideas.md verdict: which apps are OS citizens.** Problem: seven
  EntangleIT app ideas compete for system status, but most should be
  store apps, not OS surface. Behavior (decision, then thin
  integration): **citizens** — GigsFeed (→ F12 board) and NightShift
  (→ F13 service); **onboarding helper** — MemeFaucet trial faucet as
  first-run starter sats (capped, one-per-wallet); **share target** —
  AskAnything (sats-attached Q&A widget as a share-sheet destination);
   **store-only** — Agent Arena, TinyBets, BitTok (linked from the store
   per F1, no system surface; TinyBets additionally age-gated out of
   defaults). Layer: shell + rails. Size: **S** (decision + links; each
   promotion later becomes its own F-item). Depends: **F1, F12, F13**.
   Accept: this verdict stays recorded in IDEAS.md; any promotion ships
   with its own F-item and acceptance.
- **F16 — Twetch companion (feed + notifications + BRC-100 posting).**
  Problem: Twetch reading/posting lives in a browser tab disconnected from
  the OS wallet, and the account key never meets system policy. Behavior:
  bundled runner app (`https://localhost:2121/twetch/`) plus `bsv twetch`
  commands — keyless public feed/notifications reads via api.twetch.com,
  and on-chain posting that rebuilds Twetch's exact B://+MAP+AIP record,
  funded by the BRC-100 wallet (policy-gated network fee) with AIP/API
  auth signed by an explicitly imported Twetch account key that never
  funds and never joins the OS identity. One-tap panel import derives that
  key from the enrolled seed at `m/44'/0'/0'/0/0` (custody-local; seed and
  WIF never leave the module) and verifies the derived pubkey against
  Twetch's key-linkage index. Layer: daemon (twetch.ts, custody
  key, RPC/CLI) + runner (app + manifest + catalog) + shell (panel
  Identity action). Size: **M**. State: pilot implemented and tested
  (166 tests); reply/media/green/paid-content remain out of scope until
  the read/post core proves out. Depends: **F2**
  (runner), **P4** (Twetch OIDC identity). Meme Library viewer shipped in
  the same app (search, category chips, grid, lightbox with copy-ref and
  open-on-Twetch); reuse/mint/crosspost remain out of scope. NFT Market
  viewer shipped alongside (active listings, recent sales, collections
  with floor/listings/owners; buy/list/delist stay in the browser).
   Profile overlay shipped: click any avatar/name/user number in the feed
   or notifications for bio, counts, banner, and recent posts.
   Accept: feed/notifications read keyless; a post rebuilds the exact
   B://+MAP+AIP record and renders on twetch.com; the account key never
   funds and never joins the OS identity.
- **F17 — Generalized atomic asset market.** Problem: the only atomic
  market is PocketPets' pet-specific order book on a legacy worker, so
  tickets, art, game items, and Twetch NFTs have no venue where
  settlement needs no custodian. Behavior: a generic order-book worker
  (asset kinds, per-market fees, chain verification of parents, payments,
  and transfers) plus daemon swap templates per kind (v2 ordinals, v3
  BSV21 with indexer-arbiter + exact-UTXO rule) with buyer verification
  (expected seller + max price before funding), and Twetch NFT buys
  through OS custody (atomic when the seller published an offer, direct
  pay-first spend otherwise). Layer: worker (new, live market untouched)
  + daemon (swaps, twetchBuy/twetchList) + runner (twetch app).
  Size: **L**. State: shipped — worker live with verification, v2+v3
  templates tested, Twetch buy/list flows in the app, and a bundled
  Atomic Market app (`https://localhost:2121/market/`) with browse /
  buy / sell over `marketBuy` / `marketList` / `bsv21Utxos`.
  Depends: **F2** (runner), **F5** (ordinals), **F14** (fee rails).
  Accept: list → buy → settle a non-pet ordinal and a BSV21 lot
  end-to-end; a Twetch buy settles atomically with zero browser keys;
  the PocketPets suite passes unmodified.

## Dependency sketch

P3 → F1 → F2 → {F4 → F5, F12}; P3 → F7, F8, F14; F8 ← {F3, F9}; F3 →
{F6, F10}; P2 → {F4, F11} → F6; F9 → {F13, F14}; F4 → F12 → F13;
F2 + F5 → F17 (atomic market) → F12 (gig/trade assets).

## Next 3 (explicit recommendation)

1. **F2 — Sandboxed runner** (unblocks native apps; without it F1/F4/F5
   have nowhere to live).
2. **F9 — Agent sub-wallets** (turns today's single-action caps into
   real budgets; unlocks F13/F14 and safe agent autonomy).
3. **F8 — Spend dashboard** (the audit surface every later money/rails
   feature reports into; cheapest trust win).
