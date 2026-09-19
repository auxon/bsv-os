# The bsvOS Agent Economy — Developer's Guide

Everything you need to build software that earns and spends money on a
bsvOS machine: the wallet daemon's money rails, the on-chain data rails,
the Twetch integration, the runner-app pattern, and the hard-won gotchas
from building the first two agent-economy apps (the Twetch companion and
Sell4Sats).

> Status: developer preview. The wallet daemon, CLI, policy engine, runner
> apps, and the two reference apps are live and tested (182 walletd tests,
> 14 Sell4Sats tests). This guide describes what exists today, not what is
> planned.

---

## 0. The model in one page

An **agent economy app** on bsvOS is three pieces:

```
  ┌───────────────┐      ┌──────────────────┐      ┌──────────────────┐
  │  Runner app   │─────▶│  Local agent     │─────▶│  bsv-walletd     │
  │  (UI, sandbox)│ HTTP │  (no deps, no    │  CLI │  (keys, policy,  │
  │  no keys      │      │   keys, store)   │      │   chain)         │
  └───────────────┘      └──────────────────┘      └──────────────────┘
        browser           127.0.0.x:port              systemd user unit
```

- The **daemon** holds the machine wallet. Apps never see keys.
- A **local agent** owns the app's business logic and its own state (JSON
  store, photos, orders). It talks to the wallet through the `bsv` CLI.
- A **runner app** is a static UI served by the agent (or bundled with the
  runner), sandboxed, same-origin with the agent's API.
- Every sat that leaves the machine passes **policy**: per-origin
  allow/deny, spend caps, and a first-spend denial that teaches the human
  the exact command to approve.

Reference implementations:

| App | What it proves |
| --- | --- |
| Twetch companion (`packages/runner/apps/twetch/`) | Social rails: keyless reads, custody-bound posting, on-chain media that renders on twetch.com |
| Sell4Sats (`~/Sell4Sats`, github.com/auxon/Sell4Sats) | Commerce rails: photo → AI listing → published channels → exact-amount payment watcher → order lifecycle |
| `~/bsv-recovery` | Recovery rails: deriving a legacy BRC-29 address scheme to rescue stuck funds |

---

## 1. The three laws

1. **Keys never leave the daemon.** Apps, agents, and scripts call
   `createAction`; the daemon signs. If your design includes a code path
   that reads a WIF, seed, or mnemonic, the design is wrong. The one
   exception is *app-specific identity keys* (e.g. a Twetch posting key),
   which live in their own custody slot and only ever sign app protocol
   messages — never fund transactions.
2. **Policy gates every spend.** No silent drains, ever. First spend from
   a new origin is denied and creates a pending request; the human runs
   `bsv allow <origin> [cap]` (or approves in the panel). Caps bind until
   raised.
3. **On-chain is truth.** Indexers, APIs, and local stores are caches.
   A post exists when its transaction is broadcast; an order is paid when
   the sats are in a UTXO you can see with `bsv utxos`. Verify against the
   chain when it matters.

---

## 2. Architecture map

```
packages/walletd/           the daemon (TypeScript, node type-stripping tests)
  src/custody.ts            wallet + app-key custody (OS keyring, 15-min auto-lock)
  src/policy.ts             origins, allow/deny/ask, caps, requests
  src/brc100.ts             createAction facade used by everything
  src/chain.ts              ARC writes, WoC reads, MockChainProvider
  src/rpc.ts                JSON-RPC surface (CLI + apps + panel)
  src/cli.ts                `bsv` command tree
  src/twetch.ts             Twetch surface: reads, post/media scripts, submit
  src/identity.ts           OIDC login, sessions
  src/apps.ts, src/launcher.ts  app registry + loopback serving
packages/runner/            sandboxed app host
  apps/twetch/              reference social app
packages/shell/plugin/      Panel.qml (identity, approvals, app cards)
```

Transport: HTTPS `127.0.0.1:2121` plus a Unix socket at
`$XDG_RUNTIME_DIR/bsv-walletd.sock`, same JSON-RPC shape. The CLI is a thin
client. Tests run against `MockChainProvider` — no network, no real money.

**Loopback rule.** Runner apps may bind any `127.0.0.0/8` address, not just
`127.0.0.1` — that is how several apps share port 2121-space without
colliding (e.g. Sell4Sats owns `127.0.0.2:8790`). The launcher accepts the
whole range (`isLoopbackHost`/`isLoopbackUrl`).

---

## 3. Money rails

### 3.1 Origins: how the wallet knows who is spending

Every spend carries an **origin** string. Conventions:

| Origin | Used by |
| --- | --- |
| `cli` | `bsv anchor`, manual commands |
| `twetch` | the Twetch companion's posts |
| `sell4sats` | the Sell4Sats agent |
| `agent:<name>` | minted sub-wallets (`bsv agent mint`) |

Keep origins stable and specific — they are the unit of policy and the
unit of the ledger. An agent that mints its own sub-wallet gets its own
budget, daily allowance, and expiry, and spends without per-spend
approvals.

### 3.2 The policy loop (the whole game)

1. First spend from an origin is **denied** — that is the system working.
   The denial names the fix: `bsv allow <origin> [cap]`.
2. A `policy_requests` row is created (visible in `bsv requests` and the
   panel's approvals).
3. The human approves: `bsv allow sell4sats 500000` (mode `allow`, cap
   500,000 sats) — or approves the pending request in the panel.
4. Retry. Caps may still bind (`over spend cap`): relay, stop, wait.

**Cap semantics — read this twice.** `cap 0` means **uncapped**, not zero.
`bsv allow sell4sats` with no cap leaves an autonomous agent able to spend
the whole wallet. For anything that spends without a human watching,
always set a real cap, or better, mint a sub-wallet:

```bash
bsv agent mint sell4sats --budget=2000000 --daily=500000 --expiry=30d
```

Budget denials (`over lifetime budget`, `over daily allowance`, `expired`,
`revoked`) are final until the human re-mints.

**The Jev layer (optional).** With `OPENROUTER_API_KEY` in the daemon
environment, every pending request carries a calibrated allow/ask/deny +
risk score from Jev (visible in `bsv requests`, `bsv history`, and the
panel). Approving an origin with `bsv allow <origin> <cap> --auto` lets a
confident, routine `allow` verdict spend within the cap without waking the
human; anything else — ask/deny, low confidence, no answer — still becomes
a pending request. Agents and apps that want their own decisions call the
daemon (`bsv jev decide` or the `jev_decide` MCP tool) so the OpenRouter
key stays in the daemon environment, never in the app.

### 3.3 Spending: the createAction facade

Everything that moves money funnels through one call shape:

```ts
const action = await facade.createAction({
  description: "Twetch post: oak chair for sale",
  outputs: [
    { lockingScript: opReturnHex, satoshis: 0, outputDescription: "Twetch post" },
    { lockingScript: mediaHex,    satoshis: 0, outputDescription: "Twetch media" },
  ],
  labels: ["twetch", "post", "photo"],
  options: { randomizeOutputs: false },
}, origin);
// → { txid }
```

Rules that matter:

- **Policy is checked before signing and broadcast.** A denied action
  never spends; it seeds a request.
- **Fees are estimated from the real output sizes.** A 180 KB photo costs
  real sats (roughly size-in-bytes at the prevailing rate) — budget for
  it. `MEDIA_MAX_BYTES = 1_000_000` caps any single media output.
- **`randomizeOutputs: false`** when output order is protocol-meaningful
  (it is for B:// + media + AIP posts; indexers read outputs positionally).
- **Labels** are your ledger index: query by label to reconcile what an
  app has done.
- **Deferred signing.** If a signing round is left pending and never
  consumed, later actions fail with `CANNOT_SIGN`. Always drive the
  sign→broadcast path to completion (the note-saving bug in the field was
  exactly this).

### 3.4 Wallet states an agent must handle

| State | Meaning | Agent behavior |
| --- | --- | --- |
| `WALLET_LOCKED` | 15-min auto-lock elapsed | Stop; tell the human to run `bsv unlock`. Never cache unlock state. |
| `POLICY_DENY` | First spend / cap / mode deny | Relay the exact command, stop. Do not retry-spam or reroute. |
| `CANNOT_SIGN` | Deferred signing left pending | Rebuild the action and complete the sign round. |
| `tx_failed` / `REJECTED` in `bsv pending` | Lost a double-spend race | Funds never moved. Rebuild and retry; do not assume it landed. |
| `seen` for a long time | Mempool backlog | Wait; the daemon rebroadcasts automatically. |

### 3.5 Reading money: balance and UTXOs

```bash
bsv status          # { authenticated, locked, hasWallet, identityKey }
bsv balance         # { address, confirmed, unconfirmed, utxos }
bsv utxos           # { address, utxos: [...] } — use this for the address
```

**Gotcha:** `bsv status` has **no address**. The wallet address comes from
`bsv utxos` (or `bsv balance`). Orders that showed a null pay-to address
were built from `status` — don't repeat that.

### 3.6 Watching for payment (the exact-amount pattern)

Sell4Sats' watcher: poll `bsv utxos`, match a UTXO whose value **exactly
equals** the order's expected sats, and transition the order
`waiting → paid`. Exact matching is deliberate: it is the simplest
reliable correlation without a payment server, and it is why the order's
price must be distinctive (unique sat amounts work; round numbers race).

Once matched, treat the funds as yours when the UTXO is spendable; then
mark `sold` when the item leaves your hands. Reconciliation on restart is
just re-reading `bsv utxos` and your store.

---

## 4. Data rails: OP_RETURN protocols

bsvOS writes plain BSV transactions, so all the usual protocols apply.
The ones in production use here:

### B:// (Bitcoin data)

`OP_0 OP_RETURN <B prefix> <content bytes> <media type> [<encoding>]`

- Text posts include encoding (`UTF-8`); Twetch's own media outputs do
  **not** (verified byte-for-byte against a live reference tx).
- `B_PREFIX = 19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut`.
- The sha256 of the content bytes is the file's identity; `b://<sha256>`
  refs address it.

### MAP (metadata)

`OP_0 OP_RETURN <MAP prefix> SET <key> <value> ...` — key/value metadata in
the same script after a `|` separator. Twetch posts use
`SET app twetch type post`.

### AIP (authorship)

`<AIP prefix> BITCOIN_ECDSA <signer address> <base64 signature>`.

- `AIP_PREFIX = 15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva`.
- The signature is BSM (Bitcoin Signed Message) over
  `0x6a || concat(all pushed field bytes preceding the signature)` —
  B prefix, content, mime, encoding, MAP prefix and its fields, AIP
  prefix, algorithm, signer address.
- Verify it the way the indexer must: recover the pubkey from the
  compact signature and compare its address.

Everything is one transaction: multiple `OP_RETURN` outputs plus change.
Indexers parse outputs positionally; keep `randomizeOutputs: false`.

---

## 5. Twetch: the worked example

Twetch is the reference social rail: it has a public read API, an
auth'd post-submission API, and a web app that renders on-chain media.
All of it is reproducible from the daemon.

### 5.1 Reads (keyless)

`https://api.twetch.com` — no auth for public data:

| Endpoint | Gives |
| --- | --- |
| `/v1/feed/latest?limit=N` | global feed |
| `/v1/users/:id/posts?limit=N` | a user's posts |
| `/v1/posts/:id` | one post + author + media + replies count |
| `/v1/users/:id/notifications` | notifications |
| `/v1/feed/post-notifications` | post notifications |
| `/v1/dank-rares...`, `/v1/market/...` | meme library, market |
| `/v1/auth/user-by-pubkey/:pubkey` | key → account linkage |

### 5.2 The exact post transaction

```
OP_0 OP_RETURN
  B_PREFIX  <text>  text/markdown  UTF-8   "|"
  MAP_PREFIX  SET  app  twetch  type  post  "|"
  AIP_PREFIX  BITCOIN_ECDSA  <address>  <signature>
```

plus, when there is media, a **second output**:

```
OP_0 OP_RETURN  B_PREFIX  <media bytes>  <mime>
```

The signed text is the B:// content — so anything appended to the post
text (like a media ref) is covered by AIP and part of the on-chain record.

### 5.3 Submitting to the indexer

After broadcast, fetch the raw tx hex (WoC) and POST it:

```
POST /v1/posts
{ userId, content, metadataVersion: 2, txHex, mediaRefs?: ["b://<sha256>"] }
```

Auth headers: `x-twetch-user`, `x-twetch-ts`, `x-twetch-sig` where the
signature is BSM over:

```
`${method}\n${path}\n${userId}\n${ts}\n${body}`
```

signed with the Twetch account key. Submission is **best-effort**: a failed
submit does not fail the post (the tx is already on-chain); it only delays
indexing.

### 5.4 The media rendering lesson (read before shipping images)

Embedding an image on-chain is not enough for twetch.com to show it. The
web app renders post images from the post record's **`files` / `mediaRefs`
refs**, resolved through the indexer:

- `b://<txid>@N` → `https://api.twetch.com/v1/media/<txid>-oN.jpg?v=4`
  (outpoint-addressed; the indexer fetches the bytes from chain)
- `b://<sha256>` → `https://api.twetch.com/v1/media/<sha256>.jpg?v=4`
  (hash-addressed; only works for media Twetch itself hosts)

What the daemon does to make images render:

1. Appends the media's `b://<sha256>` ref to the **signed post text**
   (Twetch's composer behavior: "added to your post as a link").
2. Sends `mediaRefs` on submit, so the indexer links the media output.
3. The indexer parses the submitted `txHex` and adds the outpoint ref
   (`b://<txid>@1`) to `files` — the web app renders the first ref.

Verified end to end: a listing photo (11,806-byte JPEG) published as
`OP_0 OP_RETURN B_PREFIX <bytes> image/jpeg`, ref `b://<txid>@1`, resolver
returned `200 image/jpeg` with byte-identical content.

**Practical rules:** downscale photos client-side before embedding
(≤ ~180 KB JPEG is plenty; four quality steps down from 1024px), keep the
1 MB hard cap in mind, and never print raw sha256 prose in the post text —
the ref is the image.

### 5.5 Identity and the custody boundary

- Login is OIDC (`id.entangleit.com`); the daemon stores the session.
  The client is public, so there is **no refresh token** — sessions last
  ~1 hour. Handle expiry with a re-login (`bsv login --force`), not with
  retries.
- Posting uses a **custody key** imported once ("Import to Twetch" in the
  panel): WIF, seed phrase, or derived from the wallet seed by scanning
  paths until the pubkey matches the OIDC account.
- Before posting, the daemon checks key linkage via `user-by-pubkey`.
  Mismatch → `TWETCH_KEY_MISMATCH`: the post would be unattributable, so
  it is refused with instructions instead.

---

## 6. Identity rails (any app)

The Twetch flow generalizes:

1. **Reads first, keyless.** Design your protocol so browsing needs no
   key at all. It makes the app resilient and the custody story simple.
2. **App key ≠ wallet key.** An app that needs protocol signatures gets
   its own custody slot; the wallet key funds the network fee only.
3. **Link before you act.** If the protocol attributes content to an
   account, verify the key↔account link before signing, and fail closed.
4. **Sessions expire; treat that as normal.** Re-auth flows must be one
   click, and the daemon must accept a re-login while a stale session
   exists.

---

## 7. Runner apps: the app pattern

- Serve the UI from the agent (or the runner) over **HTTPS on a loopback
  address**; the runner sandbox only loads loopback origins, and the whole
  `127.0.0.0/8` range is allowed.
- The UI holds **no keys and no wallet access** — it calls the agent's
  JSON API. The agent shells out to `bsv`.
- Ship a **manifest** with the app: name, entry, and the policy spend cap
  the app will request (Sell4Sats: 500,000 sats — enough for network fees
  on photo posts). The human still approves once.
- Declare your **spend intents** in `metanet.intents`: one entry per action
  tag your memos carry (`{ action, label?, typical_sats?, description? }`).
  Declared intents show in `bsv store`, feed the Jev decision state, and a
  newly declared action counts as a permission widening on update.
- Tag every spend at the source: the **first memo entry is the action tag**
  (it becomes the policy label and the ledger label), the rest is the
  description Jev reads. A spend with no tag is judged on amount + origin
  alone — and Jev will not clear it (see the PocketPets probe: 0/9
  auto-approved without tags).
- Integrate with the panel where identity matters (the Twetch app's
  "Import to Twetch" and "Sign in again" live there, next to the app
  card).
- Keep the app installable and removable without touching wallet state.

---

## 8. The Sell4Sats blueprint

The canonical commerce agent, end to end:

```
photo ──▶ AI listing ──▶ channels ──▶ orders ──▶ payment watcher
           │              │            │             │
           │              ├─ twetch post (on-chain image)
           │              ├─ webhook / agentpay ask
           │              └─ eBay / Facebook / X (stubs)
           └─ sha256 + local photo store (data/photos/)
```

- **Agent**: zero dependencies, JSON store (`data/store.json`), HTTPS
  `127.0.0.2:8790`, systemd user unit, env-configured.
- **Listing writer**: any OpenAI-compatible chat endpoint with vision when
  available, deterministic offline fallback otherwise. The app always
  works; the model is an upgrade, not a dependency.
- **Channels**: `twetch`, `webhook`, `agentpay`, `ebay`/`facebook`/`x`
  stubs. Each channel returns `{ status, ref, url, detail }` and failures
  are recorded per channel, never fatal to the listing.
- **Orders**: created when a listing publishes with a price:
  `waiting → paid → sold`. The pay-to address comes from `bsv utxos`.
- **Watcher**: exact-amount UTXO matching (section 3.6).
- **Policy**: origin `sell4sats`; first publish is denied until
  `bsv allow sell4sats 500000`.

Study it as a template: swap the channel, keep the skeleton.

---

## 9. Testing playbook

The daemon's tests are the template (`packages/walletd/test/`):

- `node:test` + `MockChainProvider` — no network, no wallet, no money.
- **Erasable TypeScript only**: tests import `src/*.ts` directly via node
  type-stripping, so no enums, parameter properties, or namespaces.
  `tsc --noEmit` still gates the build.
- **Isolate custody**: set `BSV_WALLETD_KEYCHAIN_SUFFIX` per test file so
  tests never touch the real keyring.
- **Close the pool**: `await db.destroy()` in `finally` — knex keeps the
  event loop alive and a forgotten destroy looks like a hang.
- **Consume response bodies** (`.json()`, `.text()`) even when you only
  need the status — an unread body can hold sockets open.
- **Mock the API shape you depend on**, not the world: return
  `{ id }` for `/v1/posts`, capture `init.body` and assert on it (content,
  `mediaRefs`), assert auth headers by recomputing the signature.
- Assert protocol bytes, not just effects: build the expected script and
  compare hex; parse the broadcast tx and check output order and content.

Sell4Sats' tests follow the same rules at app scale: channel payloads,
watcher transitions, AI parsing/fallback.

---

## 10. On-chain verification recipes

When it matters, verify from the chain, not from your own logs.

```bash
# raw tx
curl -s https://api.whatsonchain.com/v1/bsv/main/tx/<txid>/hex

# what outputs exist (types, addresses, values)
curl -s https://api.whatsonchain.com/v1/bsv/main/tx/<txid> | jq '.vout'
```

Then parse locally: find the B:// pushes, hash the media bytes, and check
that what you think you posted is what is on chain (this is how the media
output format was verified byte-for-byte, and how the missing-media
"Vintage Chair" post was diagnosed — the tx simply had no second output).

For Twetch rendering specifically:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  "https://api.twetch.com/v1/media/<txid>-o1.jpg?v=4"
```

`200 image/jpeg` with the right byte count means twetch.com will render it.

---

## 11. Ops: build, restart, deploy

```bash
# daemon
cd packages/walletd
npm run build            # tsc → dist (the running service uses dist)
systemctl --user restart bsv-walletd
npm test                 # 182 tests, source-level

# an agent app
cd ~/Sell4Sats
npm test
systemctl --user restart sell4sats
```

- **The dist gotcha:** tests run `src`, the service runs `dist`. Editing
  and testing without `npm run build` leaves the running daemon on old
  code — the `--media` flag existed in source but not in the live CLI
  until the rebuild. Build and restart before end-to-end checks.
- **Services are user units** (`systemctl --user`); enable them so they
  survive login.
- **Commit and push as work lands**, per repo (bsv-os for the platform,
  the app's own repo for the app). Cross-repo features are two commits.

---

## 12. The gotcha table

| Gotcha | Reality |
| --- | --- |
| `cap 0` means uncapped | Always set a real cap or mint a budgeted sub-wallet |
| `bsv status` has no address | Use `bsv utxos` / `bsv balance` for the address |
| Wallet auto-locks after ~15 min | Check `wallet_status` before spending; `bsv unlock` needs the human's keyring |
| Deferred signing left open | `CANNOT_SIGN` forever after — consume the sign round |
| First spend denied | Working as intended; it created a pending request |
| Tests hang at exit | `db.destroy()` in `finally`; consume response bodies |
| Tests touch real keys | `BSV_WALLETD_KEYCHAIN_SUFFIX` per file |
| Editing source, testing source, running dist | `npm run build` + restart |
| 127.0.0.1 only | Runner accepts all of `127.0.0.0/8`; pick a distinct address per app |
| Image on-chain but not on twetch.com | No `files`/`mediaRefs` ref → include the `b://` ref in signed text + `mediaRefs` on submit |
| `b://<sha256>` resolver 404 | Hash-addressed media only exists for Twetch-hosted files; use the outpoint ref (`b://<txid>@N`) |
| OIDC session dies in ~1 hour | Public client, no refresh token — one-click re-login, don't retry-spam |
| Post attributed to nobody | `TWETCH_KEY_MISMATCH` guard: verify key↔account link before signing |
| Fee surprise on media posts | Fees price real bytes; downscale photos first |
| Lost double-spend race | `tx_failed`/`REJECTED` means funds never moved — rebuild, retry |

---

## 13. Cookbook

```bash
# money
bsv status | bsv balance | bsv utxos | bsv pending
bsv unlock | bsv lock
bsv policies | bsv requests
bsv probe <origin> <action> <sats> [--label=..]  # dry-run the gate first — no money moves
bsv events --wait 60                             # wake on approvals instead of polling
bsv doctor                                       # machine-check the gotchas (§12)
bsv market browse [--kind=ordinal|bsv21]         # what's for sale, with prices + fees
bsv market fees                                  # operator fee sellers list with
bsv market buy <listing> [--origin=agent] [--max=sats]   # atomic buy from a budget
bsv market list <outpoint> <priceSats> [--kind=bsv21 --token-id= --amount=] [--origin=agent]
bsv market cancel <listing>                      # seller-only delist
bsv market sync <listing> <txid>                 # reconcile a buy whose post raced the indexer
bsv allow sell4sats 500000          # origin, cap (omit cap = UNCAPPED)
bsv deny <origin>
bsv agent mint sell4sats --budget=2000000 --daily=500000 --expiry=30d

# twetch
bsv twetch feed --limit=10
bsv twetch notifications --limit=10
bsv twetch user 32324 --limit=10
bsv twetch memes | bsv twetch market
bsv twetch post "oak chair for sale" --media photo.jpg --origin=sell4sats
bsv twetch account status | bsv twetch account import
bsv login --force

# sell4sats
curl -sk https://127.0.0.2:8790/api/state
curl -sk https://127.0.0.2:8790/api/listings -X POST \
  -H 'content-type: application/json' \
  -d '{"photoBase64":"…","mime":"image/jpeg","name":"chair.jpg",
       "notes":"solid oak","priceHintSats":25000,"channels":["twetch"]}'

# atomic market (generic worker; sellers list OS-custodied assets, buyers settle atomically)
export MARKET=https://entangleit.com/atomic-market
curl -s "$MARKET/v1/market?kind=ordinal"            # active listings
curl -s -X POST "$MARKET/v1/market/list" -H 'content-type: application/json' -d '{
  "origin": "<txid>.<vout>", "assetKind": "ordinal", "title": "Show ticket",
  "priceSats": 5000, "seller": "<address>", "sellerUnlock": "<hex>",
  "payScript": "<hex>", "inputScript": "<hex>", "feeBps": 200, "feeAddress": "<address>"}'
# sellers sign offers with window.bsv signSwapOffer (ordinal) or kind bsv21
# + tokenId/tokenAmount; buyers complete with completeSwap + buyerChecks
# { expectedSeller, maxPrice }. Twetch app: per-card Buy, twetchBuy RPC.
# Atomic Market BRC-100 app: bsv app install market.entangleit.com then
# bsv app open (origin-policed window.bsv; approve with bsv allow
# market.entangleit.com [cap]) — browse, buy atomically, list holdings.
```

---

## 14. Starting a new agent-economy app: checklist

1. **Name the origin** (`yourapp`) and decide the budget: cap or minted
   sub-wallet. Write the approval command into your README on day one.
2. **Design keyless reads** and a minimal on-chain write format; document
   the exact bytes and verify against a real reference tx before coding.
3. **Agent skeleton**: zero deps if possible, JSON store, HTTPS on a
   distinct loopback address, systemd user unit, env config, offline
   fallbacks for every network dependency.
4. **Money paths through `createAction`** with meaningful labels;
   `randomizeOutputs: false` when output order is protocol.
   Probe every spend first: `bsv probe <origin> <action> <sats>`.
5. **Handle the four wallet states** (locked, denied, deferred signing,
   failed tx) explicitly, with human-readable remediation.
6. **Test with MockChain**: protocol bytes, policy paths, store
   transitions. Keychain suffix + `db.destroy()` + consume bodies.
7. **Verify on-chain** end to end once (broadcast → decode → resolve) —
   not just in mocks.
8. **Ship a runner app**: no keys, agent API only, manifest with the cap,
   panel integration if identity is involved.
9. **Document the gotchas you hit** — this guide is built from them.

---

## Appendix: error codes you will meet

| Code | Where | Meaning |
| --- | --- | --- |
| `POLICY_DENY` | createAction | Not allowed (yet) — request seeded |
| `WALLET_LOCKED` | any signing path | Auto-lock elapsed; human unlocks |
| `CANNOT_SIGN` | createAction | Deferred signing round left open |
| `NO_WALLET` / `NO_TWETCH_ACCOUNT` | daemon / twetch | Enroll / import first |
| `TWETCH_KEY_MISMATCH` | twetch post | Key not linked to the signed-in account |
| `BAD_PARAM` | RPC/CLI | Validation failed (size caps, mime, ids) |
| `RAILS` | chain/API | Upstream failed (ARC, WoC, indexer) |
| `tx_failed` / `REJECTED` | pending monitor | Network dropped it; funds unmoved |

---

*Written from the trenches: walletd P0–M3, the Twetch companion (F16), and
Sell4Sats — including the note-signing bug, the media-format
reverse-engineering, and the sha256-that-was-just-text. If you are reading
this in a future session: the code is the authority, the gotcha table is
the memory.*
