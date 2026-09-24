# BSV OS

Omarchy remix with a system BRC-100 wallet. Every app, agent, and shell
interaction can transact; keys never leave the daemon.

## Install

Fresh aarch64 Omarchy machine, one command:

```bash
curl -fsSL https://raw.githubusercontent.com/auxon/bsv-os/main/scripts/install.sh | bash
```

Installs the `bsv-os-meta` package from GitHub releases (SHA256-checked),
enables the wallet daemon, and wires the shell plugin + share target.
Dev checkout path: `scripts/post-install.sh` (clones, builds, runs tests).
Full walkthrough: [UserGuide.md](UserGuide.md). Building agents and apps
that spend: [AGENT-ECONOMY.md](AGENT-ECONOMY.md).

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
bsv history                 # unified ledger: txs + requests + policies (F8 dashboard)
bsv app install <domain>  # install a Metanet app (manifest + launcher)
bsv app install <domain> --manifest-file <path>  # dev install: same validation, no fetch
bsv app open <domain>     # sandboxed runner window with window.bsv (browser fallback)
bsv app list | bsv app remove <domain>
bsv app update [<domain>|--all] [--approve-widening]  # re-pin; widening needs approval
bsv store                   # curated catalog with live caps + update status
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
