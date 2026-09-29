# Making money with bsvOS and AI

bsvOS is a self-custody wallet that lives at the operating-system level and
speaks machine-scale payments: per-call billing (x402), per-minute streams,
atomic asset swaps, and escrow flows an AI agent can drive. Your keys stay in
the daemon; every spend is policy-gated; income simply arrives on-chain.

This document maps the earning rails that exist today, with the exact
commands, what they cost, and where they fall over. **Nothing here is passive
income.** Every path is a product, a service, or an asset — and the honest
answer to "can AI make me money?" is: an agent can do billable work or sell
compute, inside a budget you set, with you as the operator.

Related reading: [README.md](README.md) (operator reference),
[UserGuide.md](UserGuide.md) (everyday use), [SKILLS.md](SKILLS.md) (what an
MCP agent can do), [ROADMAP.md](ROADMAP.md) (what is not built yet).

---

## The money model, in one page

- **Income lands at your wallet address, on-chain.** The daemon watches every
  transaction to confirmation (`bsv pending`), labels what it can, and files
  attributed earnings into a basket — gig payouts land in `earnings`:
  `bsv basket balance earnings`.
- **Six rails earn**: selling answers per call (x402), paid work (bounty
  board), per-minute work (sats streams) and paid episodes, selling assets
  (ordinals/tokens), contest prizes, and recurring client work (NightShift).
- **Fees are real and linear**: the engine prices at **1 sat/byte**
  (`FEE_SATS_PER_KB = 1000`), with a floor of 1 sat/vB or ARC rejects the tx.
  A stream tick under 1000 sats *accrues* instead of paying — the daemon warns
  when miner fees would eat more than 20% of a tick.
- **Change needs a block.** After any spend, the change output is unconfirmed
  and not spendable until it mines; batch payments must pause between
  batches (we hit this posting a run of on-chain media).
- **Spending is gated, earning is not.** Selling, receiving and being paid
  need no policy. Anything that spends (listing fees, entry fees, buying
  resources) goes through caps, budgets, approvals, and optionally Jev.
- **Start small.** Every rail here is real but thin; caps keep mistakes cheap.
  No sats yet? `bsv faucet claim` (one claim per wallet, when funded).

---

## 1. Sell answers by the call (x402) — AI compute as a product

Your daemon can charge strangers for its own answers, settled per HTTP call.
The menu is fixed and honest:

| Method | Default price | What the buyer gets |
| --- | --- | --- |
| `jevDecide` | 50 sats | One calibrated Jev decision (`state` + typed `questions`) |
| `memoryRecall` | 20 sats | Keyword/tag recall over the shared memory board |

```bash
bsv x402 serve                          # list the menu with prices + your payTo address
bsv x402 price jevDecide --price 50     # reprice (0 unlists)
bsv x402 sales                          # revenue ledger
bsv x402 receipts                       # every metered call you paid/bought
```

**How buyers pay.** They `POST /v1/serve/<method>` with JSON params. No proof
gets a 402 quote; a `PAYMENT-SIGNATURE` carrying a transaction that pays your
address ≥ price gets the answer plus a receipt. One txid buys exactly one
call; the daemon broadcasts the payment itself if the chain does not know it
yet, so the money is real before anything is served.

**Going public.** The endpoint is loopback-only by default. For LAN/VPN
buyers set `BSV_WALLETD_BIND=0.0.0.0` (the wallet JSON-RPC stays loopback
regardless — only `/health` and `/v1/serve/*` answer remotely). To sell to
strangers, expose it with a tunnel and publish the manifest:

- `GET /v1/serve/manifest` is self-describing (base URL from
  `BSV_SERVE_PUBLIC`, tools, prices, `payTo`). Verified listings on
  **x402market** point at it.
- A cloudflared **quick tunnel** works today but its URL changes on restart
  and the listing rots — use a **named tunnel** (stable DNS) if you want the
  listing to survive.

**The margin.** A Jev call costs ~$0.00002 in model fees; 50 sats is priced
well above that, and the *buyer* pays the miner fee for the settlement tx.
Your costs are uptime, the tunnel, and attention. Price in whole sats and
batch your own questions in one call when you are the buyer.

**Reality check.** This is selling a small, well-defined answer, not a
chatbot. The seller's daemon must be up **and unlocked** — while the wallet
locks itself (15 idle minutes), `/v1/serve/*` answers `503 wallet locked`, so
a serious endpoint either keeps the wallet unlocked or re-unlocks on a timer.
A locked daemon fails closed; buyers see nothing.

---

## 2. Do paid work: the bounty board

The board is read keyless; your local row walks
`tracked → claimed → submitted → paid`, and payouts land in `earnings`.

```bash
bsv gig board [--category=C]     # open bounties
bsv gig show <id>                # acceptance criteria, escrow, deadline
bsv gig track <id>               # watch it
bsv gig claim <id>               # claim (rails need an agentpay key, agp_…)
bsv gig submit <id> --hash <sha256> [--uri <url>] [--notes "…"]
bsv gig paid <id> <txid:vout>    # label the payout you received
bsv gig list                     # your gigs and lifecycle
```

- Claim/submit go through the agentpay/Bounty rails, which need an
  `AGENTPAY_KEY` (`agp_…`). Without one the daemon does **not** pretend: it
  returns the exact human step instead.
- Submit the **exact artifact hash** the acceptance block expects; a hash
  mismatch is how honest work gets rejected.
- Payouts arrive at the wallet address on-chain; `bsv gig paid` is what files
  them into the `earnings` basket so `bsv history` shows real income.

**AI angle.** This is the most natural agent-earning rail: the agent does the
work (research, indexing, generation), hashes the artifact, and submits.

---

## 3. Get paid by the minute: streams and paid episodes

### Sats streams (metered work)

A stream pays `rate × elapsed` while the worker posts fresh heartbeats. The
**payer** opens it; the worker (you, or your agent) keeps it alive:

```bash
# Payer side (a client paying you):
bsv stream start <your-address> --rate 600 --every 5m --max 60000 --board work --name "audio cleanup"

# Worker side (you):
bsv stream beat <stm_…> --text "minute 12: denoised reel 3"
bsv stream list                  # paid totals, status
bsv stream ticks <stm_…>         # per-tick ledger: paid / skipped / stale / closed + txids
```

Fresh beats keep sats flowing; staleness auto-pauses; the cap closes the
stream. Paid money stays paid; unpaid accrual is simply never sent. Ticks
below 1000 sats accrue. Pair a stream with a hash-acceptance milestone on the
payer side if the client needs proof, not just effort.

### Value-for-value episodes (listeners pay you)

Publish an episode with value splits; the bundled Cast player opens one
stream per recipient while it plays, so **listeners pay your address per
minute**:

```bash
bsv cast add --title "Episode 1" --splits <your-address>:100 [--media <http(s) url>] [--live]
bsv cast episodes                # your catalogue
bsv cast sessions                # listening sessions + ticks
```

Splits must sum to 100; guest splits settle automatically (you never touch
their money). Live works too: the player records and pushes HLS segments.
v1 caveat, stated plainly: playback beats prove the session is open, not that
ears are present — the player drives them, and a bad client could cheat.
Prove the format first with a small audience before you count on it.

---

## 4. Sell what you own: ordinals, tokens, media

Create the asset, then let the atomic market settle it without a custodian.

```bash
# Inscribe media (the page hashes it; the CLI wants hex):
xxd -p -c 100000 cat.png | tr -d '\n' > /tmp/cat.hex
bsv ord inscribe "$(cat /tmp/cat.hex)" --type image/png     # cost ≈ bytes/1000 sats + fee

# List it (ordinals lock on-chain via the OrdLock covenant; miner fee; cancel unlocks):
bsv market list <txid:vout> 250000 --title "Cat #1"
bsv market fees                  # operator fee on the venue
bsv market browse                # what else is for sale
bsv market cancel <listing>      # unlock an unsold ordinal

# Or list BSV21 tokens (stays in your wallet behind a signed offer):
bsv market list <outpoint> 50000 --kind bsv21 --token-id <txid_vout> --amount <base units>
```

Buyers can be humans (Atomic Market app: `bsv app install market.entangleit.com`)
or agents (`market_buy` MCP tool). Payment and asset settle in one
transaction, so a failed sale costs nothing.

**AI angle.** Generate art, memes, or media with AI, inscribe it, and list it
— the Twetch meme pipeline in this repo is exactly that shape (Meme Library
template → caption → on-chain post). **Reality check:** inscribing is
permanent and public, the venue takes a fee, and a listing price is a public
ask, not a sale.

---

## 5. Win prompt-evolution contests (Jev as judge)

Sponsors post a task, rubric, per-round prize, and entry fee; agents submit
(prompt, output) pairs; at round close Jev blind-scores every entry against
the rubric and the sponsor pays the winner on-chain.

```bash
bsv evolve list
bsv evolve submit <contest> --text "<prompt>
---OUTPUT---
<your output>" --pay-to <your-address> [--pay-now]
bsv evolve entries <contest>     # the field
```

- Entry fees are real and paid on-chain (`--pay-now`, or pay yourself and
  pass `--fee-txid`).
- The **sponsor holds the pot** — enter contests from a sponsor you trust.
- Read the rubric: Jev judges the output only, so optimize for the stated
  criteria, not for flair.

---

## 6. Recurring client work: NightShift standing orders

NightShift gives recurring agent work an OS home: a schedule, a per-cycle
escrow, and an audit trail you can invoice against.

```bash
bsv nightshift create --name "nightly index" --agent indexer --every 6h --budget 10000
bsv nightshift list
bsv nightshift runs [--order <id>]
bsv nightshift claim <run>           # agent picks up a due cycle
bsv nightshift submit <run> --proof "ipfs://… sha256:…"
bsv nightshift approve <run>         # debits the agent budget, closes the cycle
bsv nightshift fail <run>
```

The daemon never runs the work itself — it owns the schedule, the escrow
states, and the record. Cycles are gated against the agent's budget at claim
**and** approve time, so an agent cannot overspend its mandate.

**Earning angle.** Run an agent that fulfills a recurring job for a client;
each approved cycle is a receipted payment, and `bsv nightshift runs` is the
proof of delivery. Bind the client's payment to each cycle with a stream or
an x402 call if you want the money to track the work.

---

## The AI layer: what to automate, what to keep human

- **Budgets are the boundary.** `bsv agent mint <name> --budget=<sats>
  [--daily=<sats>] [--expiry=30d]` mints a sub-wallet an agent can spend
  from with **no per-spend approvals**; revoke with `bsv agent revoke <name>`.
  This is what makes an autonomous earner safe: it can buy per-call resources
  (`x402_pay`), list assets, and pay for its own supply chain — up to a cap
  and an expiry you set. Budget denials are final until you re-mint.
- **Jev is both a tool and a product.** Use it inside the daemon to screen
  spends and x402 quotes; sell the same engine per call (section 1).
- **Boards are the mailbox.** `bsv board` / `board_post` / `board_wait` let
  agents take requests, share artifact hashes, and reply — the coordination
  layer for gigs and client work.
- **Watch the money, don't poll it.** `bsv watch 'type=payment dir=in'` is one
  filtered tail over the whole wallet; MCP agents use `watch_poll` with a
  cursor.
- **Keep human.** Wallet creation/recovery, `bsv send` (arbitrary transfers),
  approvals, and policy changes. Agents have no open send tool on purpose.
- **Honest limit.** An LLM cannot be trusted with keys, and the daemon never
  exposes them. "AI made money" will always mean the agent did a billable task
  or sold compute; the wallet enforced the boundary, not the model's
  judgement.

---

## A small starter playbook

Pick **one**, keep it small, and measure before scaling.

**A. Sell Jev decisions (an afternoon).**
1. `printf 'OPENROUTER_API_KEY=sk-or-…\n' > ~/.config/bsv-os/walletd.env && chmod 600 …`
2. `systemctl --user restart bsv-walletd && bsv jev status`
3. `bsv x402 serve` → `bsv x402 price jevDecide --price 50`
4. Expose it: the quick tunnel (`cf-x402-tunnel` unit) works, and the
   daemon now heals rotations itself — the minutely tick reads the tunnel
   log and re-registers the x402market listing when the URL moves (same
   payTo, so the market refreshes the row instead of duplicating). A named
   tunnel is still better (stable URL, no re-list lag); the quick tunnel
   is no longer fatal. Check `bsv x402 status` for tunnel URL + listing.
5. The manifest and quotes now serve while the wallet is locked (the
   pay-to address is cached at unlock), so idle hours still sell.
6. Have a second wallet pay one call end to end, then watch `bsv x402 sales`.

**B. Earn a gig (an afternoon).** `bsv gig board` → claim → deliver the exact
hash → get paid → `bsv gig paid <id> <txid:vout>` → `bsv basket balance earnings`.

**B2. Answer paid questions (an hour).** Open the AskAnything app (or
`bsv ask list`), answer with `--pay-to <your address>`, and get paid when
the asker accepts — no agentpay key needed, asking and answering are free.

**C. Publish a paid episode (an evening).** `bsv cast add --title … --splits
<you:100>` with an mp3 URL, then play it in the Cast app and watch
`bsv cast sessions` tick while it plays.

**D. Make and sell an inscribable (a day).** AI-generate an image → caption
→ `bsv ord inscribe` → `bsv market list <outpoint> <price>` at a price you
would pay yourself → cancel if it does not move.

---

## Track the money

```bash
bsv history                            # unified ledger: txs + requests + policies
bsv watch 'type=payment dir=in since=24h'   # income as it lands
bsv basket balance earnings            # attributed earnings
bsv x402 sales                         # metered-answer revenue
bsv stream list && bsv stream ticks    # per-minute income and its evidence
bsv commitments                        # everything still on the hook (caps, next due)
bsv funds attest --min <sats>          # signed, selective proof of holdings
bsv funds verify --file <attestation.json> [--min N]
bsv funds prove  --file <attestation.json> <txid_vout>   # one-UTXO Merkle proof
```

`bsv funds attest` is the honest proof-of-earnings primitive: a signed "this
wallet holds at least N sats" bound to a Merkle root over the UTXO set, with
an expiry, revealing no balance and no list. It is a signed claim, not a
zero-knowledge proof — say so if you publish it.

---

## Reality checks (read before promising yourself anything)

- **Fees are linear and unavoidable.** 1 sat/byte, minimum 1 sat/vB. Small
  numbers get eaten: a 100-byte tip pays ~100 sats in miner fee, and stream
  ticks under 1000 sats accrue rather than pay.
- **Unconfirmed change blocks batching.** After a spend, wait for a block
  before the next one, or you will see `insufficient funds for fee` while the
  balance looks healthy.
- **Everything on-chain is public forever**: posts, inscriptions, listing
  prices, OP_RETURN notes, and the payments themselves. Nothing here is
  private except the keys.
- **Counterparties are not enforced.** The wallet gates *your* spending, not
  their honesty: gig rails, market sellers, contest sponsors, and stream
  payers can all let you down. Small caps and small bets.
- **Uptime is a cost.** Selling answers needs the daemon running and the
  endpoint stable (a rotating quick-tunnel URL rots the listing).
- **No passive income, no yield, no AI trading.** There is no staking, no
  "let the bot run" path, and nothing in this repo claims a return. Each rail
  is a product, a service, or an asset sale.
- **You own the compliance.** Income is income; taxes and local rules are
  yours, not the daemon's.
