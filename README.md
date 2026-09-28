# BSV OS

Omarchy remix with a system BRC-100 wallet. Every app, agent, and shell
interaction can transact; keys never leave the daemon.

Two front ends for the same daemon:

- **Linux (Omarchy):** a Quickshell bar pill + panel — `packages/shell/plugin/`.
- **macOS:** the **bsvOS shell app** — a bundled runner app that is the
  replacement for that panel, plus the `bsv` CLI for everything.

## Install

Fresh aarch64 Omarchy machine, one command:

```bash
curl -fsSL https://raw.githubusercontent.com/auxon/bsv-os/main/scripts/install.sh | bash
```

Installs the `bsv-os-meta` package from GitHub releases (SHA256-checked),
enables the wallet daemon, and wires the shell plugin + share target.
Dev checkout path: `scripts/post-install.sh` (clones, builds, runs tests).
Full walkthrough: [UserGuide.md](UserGuide.md). Building agents and apps
that spend: [AGENT-ECONOMY.md](AGENT-ECONOMY.md). Earning with them:
[MakingMoney.md](MakingMoney.md).

### macOS

The wallet daemon is Node/TypeScript, so it runs natively on macOS (Keychain
instead of libsecret). You get the full daemon, every CLI feature, sandboxed
runner app windows in Chrome, P2P and torrents — plus **bsvOS**, a bundled
app that is the macOS replacement for the Linux Quickshell panel (see
[below](#the-bsvos-shell)).

#### 1. Prerequisites

```bash
brew install node                     # needs Node >= 22
xcode-select --install                # command-line tools (git, compilers)
```

Google Chrome (from `/Applications`) is needed for runner app windows; the
daemon and CLI work without it.

#### 2. Install

One command, no checkout needed:

```bash
curl -fsSL https://raw.githubusercontent.com/auxon/bsv-os/main/scripts/install-macos.sh | bash
```

Or from a clone: `bash scripts/install-macos.sh`. The script is idempotent —
it clones `~/bsv-os` or fast-forwards an existing one, builds
`bsv-walletd`, symlinks `bsv` into `~/.local/bin`, and installs + starts the
launchd agent `com.bsv-os.walletd` (KeepAlive). Logs:
`~/Library/Logs/bsv-walletd.log` and `.err.log`.

#### 3. Put `bsv` on your PATH  ← easy to miss

The installer symlinks `bsv` but will only *warn* that `~/.local/bin` is not
on your PATH, so `bsv` may not resolve in a new shell. Add it once:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
```

#### 4. Create and unlock the wallet

```bash
bsv create      # prints a 12-word recovery phrase — ONCE. Write it down now.
bsv unlock      # one-time macOS Keychain prompt for `node`; approve it
```

`bsv create` is deliberately terminal-only: the recovery phrase is read from a
hidden prompt (never argv) and must never pass through a browser. Already have
a phrase? `bsv import` restores it the same way. The wallet locks itself after
15 minutes idle (`BSV_WALLETD_LOCK_MS`); reading keeps working while locked,
spending does not.

#### 5. Open the bsvOS shell

```bash
bsv app open 127.0.0.1      # add & if it blocks your prompt; see below
```

That launches the shell in a sandboxed Chrome window: wallet, approvals,
policy, agents, send/receive/pay, payment requests, receipts, identity and
messaging, Twetch, the app store, and work boards. From then on the **Apps**
view can open everything else. `bsv app open` blocks for the window's
lifetime by design — background it (`&`) or use **Apps → Open** instead.

**A machine with no wallet lands on the Setup wizard**, which walks the
remaining steps: unlock, name yourself, claim starter sats, pick a first
app, and connect Twetch. Progress is read from the daemon on every visit, so
you can stop and resume. Enrolling a wallet is the one step it will not do
in the browser — that stays `bsv create` in a terminal, because
`createWallet` returns the 12-word phrase and a browser must never be in
that path. The wizard hands you the command with a copy button and offers to
check again.

#### 6. Optional: Twetch sign-in

System sign-in is a separate step, because it needs an OAuth client
registered at the issuer. In `https://id.entangleit.com/console` create an
app and **tick "public client"** (PKCE, no secret) with the redirect URI
exactly:

```
http://127.0.0.1:2122/callback
```

Paste the `twetch_…` client id into **Identity** in the shell. That is all —
a public client id is not a secret, so the shell can store it. Gotchas:

- An app created *without* "public client" is confidential and will be
  rejected (`invalid_client`). It cannot be flipped to public afterwards;
  create a new one.
- Public clients get `authorization_code` only, so no refresh token — the
  session goes stale at expiry and you re-sign-in.
- A confidential client stays terminal-only:
  `bsv login --client-id=<id> --client-secret=<secret>`.

#### 7. Verify

```bash
bsv status      # authenticated / locked / hasWallet
bsv balance     # live chain lookup
bsv doctor      # wallet, caps, requests, broadcasts, jev, panel-skew
```

#### Managing the install

```bash
bash scripts/install-macos.sh            # update: re-run to pull + rebuild
bash scripts/install-macos.sh status     # launchd + daemon + wallet status
bash scripts/install-macos.sh uninstall  # stop + remove the agent (data is kept)
```

#### macOS notes and limits

- Wallet data, the pinned TLS cert/key, and the socket live in
  `~/.local/share/bsv-os` (same layout as Linux). Back this up, not your
  recovery phrase.
- The daemon binds `127.0.0.1` only; the JSON-RPC and app bundle are
  loopback-gated. `/health` and `/v1/serve/*` are the only remotely-reachable
  routes if you ever set `BSV_WALLETD_BIND=0.0.0.0`.
- The Quickshell panel in `packages/shell/plugin/` is Linux-only and untouched;
  on macOS the shell app above replaces it.
- **One app slot per host.** An installed app is keyed by hostname, and the
  daemon binds only `127.0.0.1:2121`, so there are two identities: `127.0.0.1`
  (the shell, permanently) and `localhost` (shared by Cast / Twetch / Explorer /
  Colosseum — installing one replaces the others). Switch in **Apps**.
- **Deliberately terminal-only:** recovery ceremonies, seed-phrase entry, and
  torrent seeding (a browser has no filesystem path to offer). The shell shows
  their status and links the terminal command.
- Hosted extras (public Cast/x402 URLs) need a tunnel:
  `brew install cloudflared`.
- Depth on the runner, the bridge, and app identity:
  [packages/runner/README.md](packages/runner/README.md).

## Layout

- `packages/walletd/` — `bsv-walletd` daemon (P0 in progress)

## walletd (P0)

System BRC-100 wallet daemon: HTTPS `127.0.0.1:2121` (pinned self-signed
cert) + Unix socket `$XDG_RUNTIME_DIR/bsv-walletd.sock`, same JSON-RPC shape.

```bash
cd packages/walletd
npm install
npm test          # MockChain + custody boundary + RPC, no network
npm run dev       # boot daemon
curl -sk -X POST https://127.0.0.1:2121/ -d '{"method":"isAuthenticated","id":1}'
```

TypeScript rule: tests import `src/*.ts` directly via node type-stripping,
so write **erasable syntax only** — no parameter properties, enums, or
namespaces (`tsc --noEmit` still gates the build).

Trust rule (CI-enforced): raw key material lives only in
`packages/walletd/src/custody.ts`. Everything else talks intents.

## CLI

```bash
npm run build && npm link   # or: ./node_modules/.bin/tsx src/cli.ts
bsv status                  # locked? enrolled?
bsv login [--client-id=<id>] [--client-secret]  # Sign in with Twetch (OIDC, opens browser)
bsv whoami | bsv logout     # session profile / revoke + clear
bsv create                  # new wallet (backup shown once)
bsv unlock | bsv lock
bsv balance                 # live chain lookup
bsv anchor <sha256>         # policy-gated OP_RETURN timestamp
bsv share <file>            # hash + anchor a file (label + explorer link)
bsv allow <origin> [cap] [--auto] | bsv deny <origin> | bsv requests | bsv policies
bsv jev status              # advisor on/off, model, auto-approval thresholds
bsv jev decide --state <json|text|@file> --questions <json|@file>  # one calibrated decision
bsv agent mint <name> --budget=N [--daily=N] [--expiry=30d|YYYY-MM-DD]
bsv agent list | bsv agent show <name> | bsv agent revoke <name>
bsv pending                 # monitor queue
bsv watch [filter] [--follow] [--since 2h|300] [--limit N] [--json]  # one filtered tail: payments, streams, x402, boards, cast, approvals
bsv history                 # unified ledger: txs + requests + policies (F8 dashboard)
bsv app install <domain>  # install a Metanet app (manifest + launcher)
bsv app install https://localhost:2121/explorer/  # bundled apps: switch the shared localhost slot (cast|twetch|explorer|colosseum)
bsv app install <domain> --manifest-file <path>  # dev install: same validation, no fetch
bsv app open <domain>     # sandboxed runner window with window.bsv (browser fallback)
bsv app list | bsv app remove <domain>
bsv app update [<domain>|--all] [--approve-widening]  # re-pin; widening needs approval
bsv store                   # every bundled + catalog app, live caps + update status; slot-mates offer Switch
bsv cert put --type=<t> --certifier=<key> --field <k>=<v>  # hold a signed cert
bsv cert list | bsv cert show <id> [--fields a,b] | bsv cert revoke <id>
bsv basket list | bsv basket balance [name]  # per-basket ledger
bsv basket create <name> | bsv basket remove <name> | bsv basket assign <txid:vout> --to <basket>
bsv ord list [--address=<addr>] | bsv ord send <txid:vout> --to <address>
bsv bsv21 list [--address=<addr>] | bsv bsv21 send --id <tokenId> --to <address> --amt <base-units>
bsv msg send <@name|identityKey> --text <msg> | bsv msg sync|list|show <id>|ack <id>  # direct when the peer is live, relay otherwise
bsv p2p peers | bsv p2p status  # wallets discovered on your network (LAN beacons; BSV_P2P_PEERS for VPNs)
bsv me [name] | bsv contact add <name> <identityKey> [address] | bsv contact list|lookup|remove  # people, not raw keys
bsv pay <@name|identityKey|address> <sats> [--note=..]  # sats + encrypted note in one step
bsv faucet status | bsv faucet claim  # one starter-sat claim per wallet, identity-key signed
bsv torrent seed <file> | bsv torrent list|peers <hash>|fetch <hash|file.torrent> [--peer host:port]|remove <hash>  # real BitTorrent, trackerless (P2P discovery)
bsv request <@name|key|address> <sats> [--memo=..] | bsv request list|pay <id>|decline <id>|import <code>|code <id>  # signed asks for money
bsv receipt issue --request <id> | --txid <t> --to <who> --amount <sats> [--memo=..] | bsv receipt list  # signed 1Sat-ordinal receipt, delivered in the inscription tx
bsv sign --message "text"  # BSM signature by the wallet identity key (proofs, raised adfeed limits)
bsv board list | create <name> [--member @who] | post <board> --text "…" [--kind] [--ref] | get <board> | reply <id> --text "…" | wait/ask/subscribe  # agent-to-agent boards (signed, encrypted, p2p-first)
# cloud LLMs join the same boards through AgentBridge (MCP): https://entangleit.com/agentbridge/mcp
bsv memory remember --text "…" [--tag t] [--visibility private|public] [--live] | bsv memory recall [--query q] [--tag t] [--include-public] | bsv memory forget <id> | bsv memory init [--live]  # agent memory: shared board + bsvos.memory usenet group
bsv commitments            # every timed commitment in one view: streams, cast sessions, capsules (+ total exposure)
bsv funds attest --min <sats> [--valid-for 1h] [--anchor] | bsv funds verify --file <att.json> [--min N] | bsv funds prove --file <att.json> <txid_vout> | bsv funds list  # proof of funds: a signed claim + UTXO-set commitment, with selective disclosure
bsv stream start <addr> --rate <sats/min> --every <60s|5m|1h> --max <total> --board <board> [--name n] | bsv stream beat <id> [--text ..] | bsv stream list|ticks <id>|pause|resume|stop  # sats-streaming: pay per minute while heartbeats stay fresh
bsv evolve create --task <t> --rubric <r> --prize <sats> [--rounds N] [--fee <sats>] [--round <30m|6h|7d>] | bsv evolve submit <contest> --text <prompt ---OUTPUT--- output> --pay-to <addr> [--round N] [--parent <entry>] [--pay-now] | bsv evolve entries|score|payout|close|list  # prompt evolution market: entry fees fund blind-judged prizes
bsv capsule lock --amount <sats> --unlock-at <height|ISO date|+blocks> [--to <addr>] [--message <text>] | bsv capsule claim <id>|cancel <id>|list  # post-dated cheques: reserved funding auto-pays at maturity
bsv x402 serve|price <method> [--price N]|sales  # sell this wallet's answers: Jev decisions + memory recall over x402 (buyers: POST /v1/serve/<method> with PAYMENT-SIGNATURE)
bsv cast add --title <name> --splits <addr:pct[,addr:pct…]> [--feed <url>] [--media <http(s) audio/video/.m3u8>] [--live] | bsv cast play <episode> --rate <sats/min> --max <total> [--every <60s|5m>] | bsv cast stop <session>|episodes|sessions|live-start <episode>|live-stop <id>|live-list  # value-for-value: pay creators per minute, split with guests (player: https://localhost:2121/cast/)
bsv x402 pay <url> [--method=M] [--data=JSON]  # quote → pay → receipt
bsv x402 receipts | bsv x402 attest [--days=N] [--to=<key>]
bsv recovery setup --need <M> --guardian <name[:key]>… | bsv recovery status|rotate|restore
bsv gig board [--category=C] | bsv gig track|claim|submit|paid|untrack|list
bsv nightshift create --name <n> --agent <a> --every <1h> --budget <sats> | bsv nightshift list|runs|claim|submit|approve|fail
bsv overlay health|topics | bsv overlay lookup <tm_topic> --address <addr> | bsv overlay submit <txid> --topic <t> | bsv overlay tags <txid>
bsv recovery setup --need <M> --guardian <name[:key]>… | bsv recovery status|rotate|restore
```

First spend from a new origin is denied pending approval (`bsv allow cli`
for local flows) — that denial-then-approval loop is the whole policy model
working as designed.

## The bsvOS shell

`bsv app open 127.0.0.1` opens the system shell on macOS: a first-run setup
wizard, wallet and balance, spend approvals, policy, agent sub-wallets,
send/receive/pay, payment requests, receipts, baskets, collectibles and
tokens, **media inscribing**, identity and certificates, people/inbox/peers,
a **Twetch section** (feed, alerts, profile, memes, market), the app store,
gigs, NightShift, overlays, files, starter sats and recovery status.

Inscribing takes any file up to 256 KiB and hex-encodes it in the page, so
no filesystem path is ever sent. Fees run about 1 sat per byte, so a large
file is not cheap — the view shows the estimate against your balance and
disables the button when you cannot cover it.

It is not a port of the QML panel. Every `bsv` subcommand the panel shelled
out to is a daemon RPC method, so the shell calls the daemon directly over its
own origin — which means real error codes instead of "see the terminal", and a
handful of round trips instead of 22 process spawns per refresh. macOS
differences the panel could not survive (`wl-copy`, `xdg-open`, the native file
dialog) are handled with the clipboard API, `window.open`, and in-browser
SHA-256 straight into the `anchorFile` RPC.

The panel's always-visible bar pill becomes a status header plus real macOS
notifications when a spend request arrives — so keep the window open.

Setup, boundaries and the full panel-parity table:
[packages/runner/README.md](packages/runner/README.md#the-shell-app-appsbsvos).

## MCP (agents automate the wallet through policy, never around it)

```bash
bsv mcp --agent=research-agent   # stdio server: Claude Code, OpenCode, etc.
```

Eight tools: `get_version`, `wallet_status`, `wallet_balance`, `anchor_tip`,
`list_pending`, `x402_pay` (metered fetch, spends the agent's own budget
through policy), `jev_decide` (calibrated decision calls, ~$0.00002 each),
and `jev_status`. Every call is stamped with the agent name, so daemon policy
and the custody lock apply per-agent. A first-run denial surfaces as
`ask your human to run: bsv allow research-agent` — the agent loop closes
without ever touching keys.

Agent instructions live in [SKILLS.md](SKILLS.md) — point any MCP-capable
agent at it.

## Watch (subscribe, don't poll)

Everything the wallet does lands in one ordered, filterable feed: request
created/approved/denied, budget changes, stream payments, incoming payments,
x402 receipts, board/memory posts, cast recordings. The query runs in the
daemon, where the data already is, and the result is pushed to you.

```bash
bsv watch                                  # the whole archive, oldest first
bsv watch --follow                         # live from now
bsv watch 'type=payment sats>=100 since=1h'
bsv watch --since 2h --follow --json       # replay two hours, then tail (ndjson)
curl -Nk 'https://127.0.0.1:2121/v1/watch?filter=type%3Dpayment'   # SSE
```

Filter DSL: whitespace-separated `field op value`, ANDed. Fields `type`,
`source`, `origin`, `status`, `dir`, `detail`, `sats`, `at`; ops `=`, `!=`,
`~` (substring), `>`, `>=`, `<`, `<=`; `|` separates alternatives; `since=`
and `until=` take durations (`30s`, `15m`, `2h`, `7d`). `type` is
hierarchical (`type=request` matches `request.created`) and `type=payment`
means money moved either way. Unknown fields and bad operators are errors,
never a filter that silently matches everything.

Agents use `watch_poll` over MCP (pass the returned `cursor` back unchanged,
`wait_seconds` sleeps instead of polling) — same feed, no polling loop.

Cursors are honest: ordering is `(timestamp, source, key)` and the cursor
carries the keys already delivered at its millisecond, so a page that stops
mid-millisecond neither skips nor repeats a row, and following survives a
daemon restart. Rows inserted with a backdated timestamp (only possible from
an external writer) are not delivered to an existing cursor — sweep with
`--since 0` for those.

This is the one idea carried over from [auxon/bonsai](https://github.com/auxon/bonsai)
(2021, C#/Qactive): query the thing, push the matches, evaluate where the
data lives. See [docs/BONSAI.md](docs/BONSAI.md) for what survived the audit.

## Proof of funds (an attestation, not a zero-knowledge proof)

```bash
bsv funds attest --min 1000000 --valid-for 1h   # sign a claim, print a shareable object
bsv funds verify --file att.json --min 1000000  # check someone else's claim
bsv funds prove  --file att.json <txid_vout>    # disclose ONE UTXO as a Merkle proof
```

The object is ~430 bytes and contains: the identity key, an address, the
minimum claimed, a Merkle root over your spendable UTXO set, and an expiry.
It does **not** contain your balance, your UTXO count, or your UTXO list —
those stay in the local audit trail, and the daemon refuses to sign a claim
above the spendable total it can actually see.

What is cryptographically guaranteed:

- the statement is ECDSA-signed by the wallet identity key (BSM), so it is
  attributable and cannot be edited;
- the root commits to the exact set, so the same root cannot later be
  re-issued over a different set;
- `bsv funds prove` gives a real Merkle inclusion proof for a single UTXO —
  anyone can verify that coin is in the committed set, and nobody learns the
  other coins;
- claims expire, and the verifier names every check it ran.

What is **not** guaranteed: this is a signed claim, not a zero-knowledge
proof of the balance. A verifier cannot check "≥ N" against the root without
the set, so it trusts the issuer's key the same way an x402 buyer trusts an
address. The one promise is about this software: this daemon will not sign a
claim it knows to be false. The UTXO set comes from the configured provider
(ARC/WoC), which can answer differently between calls if it lags.

Origin: the "secure multi-party computation for critical data" line in
Bonsai's README, cut down to what is actually sound today. See
[docs/BONSAI.md](docs/BONSAI.md).

## Jev decisions
With `OPENROUTER_API_KEY` set in the daemon environment (see
`packages/walletd/bsv-walletd.service`, `EnvironmentFile`), Jev
(TypeSafe System One) scores spends and x402 quotes before policy decides:

- **Advisor** — every pending request carries a calibrated verdict + risk
  score (`bsv requests`, `bsv history`, the panel's Approvals). The human
  still approves; nothing spends on advice.
- **Auto mode** — `bsv allow <origin> <cap> --auto` lets a confident,
  routine `allow` verdict (P ≥ 0.7, risk < 0.5, confidence ≥ 0.6; tunable
  via `BSV_WALLETD_JEV_AUTO_*`) spend within the cap without waking you.
  Anything else — ask/deny verdicts, low confidence, no answer — becomes a
  pending request. Fail-closed by design.
- **x402 quote screening** — the quote's host, amount, description, and
  resource URL travel into the decision state, so suspicious quotes are
  denied before any sats move.

Turn the advisor off with `BSV_WALLETD_JEV=off`; `bsv jev decide` stays
available for agents and apps (the key never leaves the daemon).

## Roadmap

- M0 (this): daemon skeleton, MockChain tests, custody boundary ✅
- M1: real custody (libsecret/TPM, Shamir), lock lifecycle
- M2: chain + monitor (ARC, reorgs, SQLite), PocketPets regression tests
- M3: permissions + `bsv` CLI + first migrated app flow
- Then: Quickshell UI ✅, Twetch identity ✅ (OIDC sign-in; cert issuance
  binding next), agentpay/x402 rails ✅, one-command install ✅
  (`bsv-os-meta` release + `scripts/install.sh`; bootable ISO still open)
