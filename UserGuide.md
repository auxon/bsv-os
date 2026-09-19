# BSV OS — User Guide

BSV OS is Omarchy Linux with a system Bitcoin (BSV) wallet built in. Your
computer can hold money, prove who you are, timestamp anything, and let AI
agents do paid work for you — with you approving every sat.

> Status: developer preview. The wallet daemon, CLI, and agent bridge work
> today. The desktop widgets and one-click installer land with the Omarchy M
> release. Until then this guide covers the terminal-first experience.

---

## 1. What you get

- **A wallet that belongs to the machine.** Not a browser extension, not an
  exchange account. It lives in a background service (`bsv-walletd`), holds
  one recovery phrase, and every app asks *it* to sign — apps never see keys.
- **Approval-first spending.** The first time anything (an app, a script, an
  AI agent) tries to spend, it is denied and you get one clear instruction
  to allow it. No silent drains, ever.
- **AI agents with allowances.** Give each agent a name and an optional cap.
  It spends within its allowance; everything else needs your word.
- **Proof, not promises.** Timestamp any file's fingerprint on-chain,
  track every transaction to confirmation, and see exactly what happened.

## 2. Installing

### Requirements

- Apple Silicon Mac in the M1/M2 family (M1 Air and friends are the
  best-tested), 8 GB RAM or more, ~70 GB free space.
- A backup you trust. No backup, no install — partitioning can always
  surprise you. (No spare disk? See the encrypted-vault procedure in
  `RUNBOOK-M1.md`.)

### Path A — Omarchy M native installer (when released)

Download the app on macOS, point it at free space, boot into BSV OS next
to macOS. No USB stick.

### Path B — omarchy-mac today (what works now)

1. From macOS Terminal: `curl https://alx.sh | sh` — Reduced Security,
   ~70 GB for Linux, reboot into Arch, log in as `root`.
2. One command: `curl -fsSL https://raw.githubusercontent.com/omarchy-mac/omarchy-mac/quattro/bin/omarchy-mac-setup | bash`
   (branch **quattro**, encryption yes, hostname `bsv-air`).
3. After the reboots finish: `bash ~/bsv-os/scripts/post-install.sh`
   (installs system packages, verifies ARM builds, runs all tests,
   enables the wallet service).

Full machine-specific steps, rollback paths, and M1 Air notes:
[`RUNBOOK-M1.md`](RUNBOOK-M1.md).

### Path C — one command (BSV OS layer, aarch64)

On an existing Omarchy install (either boot path above):

```bash
curl -fsSL https://raw.githubusercontent.com/auxon/bsv-os/main/scripts/install.sh | bash
```

Installs the `bsv-os-meta` package from GitHub releases (SHA256-checked),
enables the wallet daemon as a user service, and wires the shell plugin and
the Files share target. Re-run to upgrade. Developers who want to hack on
walletd should use `scripts/post-install.sh` (clones, builds, runs tests).
The bootable macOS-native installer app (Path A) is still separate work.

## 3. First boot: create your wallet

```bash
bsv status     # locked: true, hasWallet: false
bsv create
```

Write down the **12-word recovery phrase it prints — once, then never
again**. Anyone with those words owns everything; support cannot recover
them for you. Then:

```bash
bsv unlock     # opens the wallet for this session (auto-locks in 15 min)
bsv balance    # your address, confirmed + unconfirmed sats, UTXO count
```

Fund it by sending a little BSV to the shown address. A few cents covers
hundreds of actions — most cost a few hundred sats in miner fees.

## 4. Everyday use

| I want to… | Do this |
| --- | --- |
| Check the wallet | `bsv status`, `bsv balance` |
| Show the receive address | `bsv address` (JSON) · `bsv address --qr` (terminal QR) · panel Receive section (QR + Copy button) |
| Send satoshis | `bsv send <address> <sats> [--label=..]` or the panel Send section — policy-gated like everything else |
| Sign in with Twetch | `bsv login` — one browser round-trip; `bsv whoami` shows the session, `bsv logout` revokes it |
| Timestamp a file | `sha256sum file` → `bsv anchor <hash>` |
| Share a file on-chain | `bsv share <file>` — or right-click → Scripts → Anchor on BSV in Files, or the wallet panel's Share section (txid + explorer link included) |
| See in-flight transactions | `bsv pending` (seen → mined, or failed with reason) |
| Full ledger + approvals audit | `bsv history` (txs, requests, policies — same view as the bar panel) |
| Lock up now | `bsv lock` |
| Approve an app/agent | `bsv allow <name> [capSats]` |
| Revoke | `bsv deny <name>` |
| See who's approved | `bsv policies` / `bsv requests` |
| Open an installed app | `bsv app open <domain>` (sandboxed window, not the browser) |
| Browse the app store | `bsv store` (curated apps, requested caps, update status) |
| Update apps | `bsv app update --all` (permission widening asks first) |
| Hold a certificate | `bsv cert put --type=<t> --certifier=<key> --field <k>=<v>` |
| Disclose attributes | `bsv cert show <id> --fields a,b` (only those fields, logged) |
| Split money into pots | `bsv basket create savings` → `bsv basket list` (per-basket balances) |
| See NFTs and tokens | `bsv ord list`, `bsv bsv21 list` (also in the bar panel) |
| Send NFTs and tokens | `bsv ord send <txid:vout> --to <addr>`, `bsv bsv21 send --id <id> --to <addr> --amt <base-units>` (amounts are base units; token change returns automatically) |
| Trade on the atomic market | `bsv app install market.entangleit.com` → `bsv app open market.entangleit.com` (BRC-100 app; browse, buy atomically, list your ordinals/tokens — approve once with `bsv allow market.entangleit.com [cap]`) |
| Market from the terminal / agents | `bsv market browse`, `bsv market buy <listing>`, `bsv market list <outpoint> <priceSats>`, `bsv market cancel <listing>` — buys can run under an agent budget (`--origin=<agent>`); `bsv market sync <listing> <txid>` reconciles a post that raced the indexer |
| Message privately | `bsv msg send <identityKey> --text <msg>` (ECDH, relay inbox; delivery verified peer-to-peer) |
| Pay per API call | `bsv x402 pay <url>` (quotes, pays, returns resource + receipt) |
| Work a paid gig | `bsv gig board` → `bsv gig track <id>` → claim/submit (agentpay key for rails) → earnings land in the earnings basket |
| Schedule recurring work | `bsv nightshift create --name <n> --agent <a> --every 1h --budget <sats>` — cycles claim/submit/approve against the agent's budget |
| Explore overlays | `bsv overlay topics` → `bsv overlay lookup <tm_token> --address <addr>` (token UTXOs; tagging via `overlay submit`) |
| Survive losing the phrase | `bsv recovery setup --need 2 --guardian Ana --guardian Bo` — any 2 of 3 cards re-enroll. Cards print once; rotate to revoke. |

**Failed transactions are safe to retry.** If the network rejects something
(usually a lost race between two of your own payments), nothing moved —
check `bsv pending`, then just do the action again.

### Sign in with Twetch

Your Twetch account doubles as the OS login. `bsv login` opens the hosted
Twetch sign-in page in the browser (or prints the URL with `--no-open`);
you sign with your usual Twetch method, and the daemon stores the verified
session — handle, avatar, and your public Twetch key. The bar panel's
**Identity** section then shows `@you` and which wallet key was bound at
sign-in; if the wallet was locked at sign-in, the binding fills in the
first time it is unlocked. Recovery words and private keys stay in the
browser page and never reach walletd; the daemon only ever receives a
one-time code.

One-time setup — the issuer has no automatic registration:

1. Sign in at `https://id.entangleit.com/console` and create an app.
2. Redirect URI (exact): `http://127.0.0.1:2122/callback`
   Scopes: `openid profile offline_access`.
3. Copy the client id, then run:

```bash
bsv login --client-id=<id>          # add the flag --client-secret to be
                                    # prompted hidden (enables refresh)
bsv whoami                          # session profile + bound wallet key
bsv logout                          # revoke refresh token, clear session
```

Quickshell users can also tap **Sign in with Twetch** in the panel once the
client id is configured — the CLI does the browser round-trip for you.

### Twetch companion (feed, notifications, posting)

A bundled desktop app reads the public Twetch feed and your notifications,
and posts text on-chain through the OS wallet. It runs from the daemon's own
loopback origin (`https://localhost:2121/twetch/`), so no third-party wallet
or browser extension is involved.

```bash
bsv twetch feed                 # latest 30 posts (--limit=N)
bsv twetch notifications        # replies/mentions + bell'ed accounts
bsv twetch memes pepe           # Meme Library browse/search (--folder --tag --sort)
bsv twetch meme-folders         # Meme Library categories with counts
bsv twetch market listings      # NFT Market browse: listings | sales | collections
bsv twetch user 32324           # profile + recent posts (--limit=N)
bsv twetch status               # identity + whether the posting key is imported
bsv twetch account import-seed  # one-tap: derive at m/44'/0'/0'/0/0 from your wallet seed
bsv twetch account import       # or prompt (hidden) for an external Twetch key
bsv twetch post "hello chain"   # policy-gated, network fee only
bsv twetch post "oak chair" --media photo.jpg   # embeds the photo on-chain; adds its b:// ref (renders on twetch.com)
bsv app open localhost          # open the desktop app
```

The panel's Identity section also has a one-tap **Import to Twetch** button
that runs the same seed derivation. It scans a bounded set of standard
paths for the key your signed-in Twetch account actually uses and only
stores a key on a match, then verifies it against Twetch's key index — so
you can see at a glance whether it is really your account's posting key.
If your wallet seed does not hold that key (a separate Twetch wallet),
the import says so; in that case import the Twetch wallet directly —
either its WIF (`bsv twetch account import`) or its recovery phrase
(`bsv twetch account import-phrase`, hidden prompt). Phrase import uses
the same bounded path scan against your signed-in account's key, so it
stores a key only when it actually proves out. Derivation and storage
happen inside custody — the seed and the WIF never leave the device.
Posting is refused while the imported key is not linked to your signed-in
account, so an unlinked key can never produce an orphaned on-chain post.

Reading needs nothing but the runnable daemon and your `bsv login` session.
Posting is a standard BSV transaction carrying the same B://+MAP+AIP record
Twetch's own client builds; the imported Twetch key signs authorship (AIP)
and API auth only — it never funds and never joins your OS wallet identity.
The network fee is policy-gated under the `twetch` origin: the first post is
denied until `bsv allow twetch` (optionally with a cap).

## 5. AI agents and allowances

Any MCP-capable agent (Claude Code, OpenCode, …) connects with:

```
bsv mcp --agent=<name>      # e.g. bsv mcp --agent=research-agent
```

Give each agent its own `--agent` name and point it at
[`SKILLS.md`](SKILLS.md) — it teaches the agent the rules, including the
important one: its first spend is always denied until you run
`bsv allow <name>`, optionally with a cap (`bsv allow researcher 50000`
= 50k sats max per action). Denied agents get told exactly what to ask you
for. You stay the approver; the agent stays useful.

For agents that run a long time, mint a **sub-wallet** instead of a bare
approval — a lifetime budget with an optional daily allowance and expiry:

```bash
bsv agent mint researcher --budget=100000 --daily=10000 --expiry=30d
bsv agent list            # remaining budget per agent
bsv agent revoke researcher   # one command cuts access entirely
```

Minting is the approval: a minted agent spends within its budget with no
separate `allow` needed, every spend debits the budget, and `bsv history`
(plus the bar panel) shows per-agent spend. Caps still apply per action
alongside budgets; an explicit `deny` always wins.

### Jev decisions (optional)

Give the daemon an OpenRouter key and every spend request gets a second
opinion from Jev (TypeSafe System One): a calibrated allow/ask/deny plus a
routine/unverified/harmful risk score, shown in `bsv requests` and the
panel next to the Approve button. You still approve — Jev advises.

```bash
mkdir -p ~/.config/bsv-os && printf 'OPENROUTER_API_KEY=sk-or-...\n' > ~/.config/bsv-os/walletd.env
chmod 600 ~/.config/bsv-os/walletd.env
systemctl --user restart bsv-walletd
bsv jev status              # enabled: true, model, auto thresholds
```

To let a trusted origin spend without waking you when Jev is confident it
is routine, approve it in **auto mode** with a cap:

```bash
bsv allow researcher 50000 --auto   # cap 50k sats; Jev allow + high confidence only
bsv allow researcher 50000          # plain allow: no Jev call, cap only
```

Auto mode is fail-closed: a low-confidence or ask/deny answer (or no
answer at all) becomes a normal pending request you see in Approvals.
`bsv jev decide --state '<json|text>' --questions '<json>'` lets you (and
agents, via the `jev_decide` MCP tool) ask Jev directly.

## 6. Safety rules (read once, remember forever)

1. **Recovery phrase = everything.** Paper or password manager. Never in
   screenshots, email, chat, or cloud notes.
2. **Lock when you walk away** (`bsv lock`, or Super+L on the desktop).
   The wallet also locks itself after 15 idle minutes.
3. **Caps are seatbelts.** Give agents and new apps small caps. Raise them
   deliberately, never to "make something work" under pressure.
4. **Verify big receives.** For meaningful money, confirm the address on a
   second channel before sharing it.
5. **Updates come from signed packages only.** Never `curl | bash` anything
   that claims to be wallet software except the pinned project sources.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `wallet locked` | `bsv unlock` |
| `first-run approval required` | `bsv allow <name>` (shown in the message) |
| `insufficient funds` / `short N sats` | Fund the address from `bsv balance`; amount shown is exact |
| Pending stuck on `seen` | Normal for minutes; daemon rebroadcasts automatically. Hours → check a block explorer, then retry |
| `mint/anchor didn't confirm` | Check `bsv pending` — `failed` means nothing moved; just retry |
| Forgot which agent is which | `bsv policies` lists every approval and cap |
| `login says SETUP_REQUIRED` | Create the bsv-os client at `id.entangleit.com/console` with redirect `http://127.0.0.1:2122/callback`, then `bsv login --client-id=…` |
| New machine | Install, then `bsv import` — type the 12 words at the hidden prompt (never as a command argument, never into chat). Same identity back. |
| Inbox stays empty | The relay does not list your own sends back — that is expected, not a bug. Messages from other identities arrive via `bsv msg sync` and decrypt with `bsv msg show`. |

## 8. What's coming

Certificate issuance bound to your Twetch identity, the sandboxed-runner
hardening pass, and the one-click ISO installer. The roadmap lives in
[README.md](README.md) and ships milestone by milestone — wallet first,
always.
