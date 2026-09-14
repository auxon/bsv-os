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
| Timestamp a file | `sha256sum file` → `bsv anchor <hash>` |
| See in-flight transactions | `bsv pending` (seen → mined, or failed with reason) |
| Lock up now | `bsv lock` |
| Approve an app/agent | `bsv allow <name> [capSats]` |
| Revoke | `bsv deny <name>` |
| See who's approved | `bsv policies` / `bsv requests` |

**Failed transactions are safe to retry.** If the network rejects something
(usually a lost race between two of your own payments), nothing moved —
check `bsv pending`, then just do the action again.

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
| New machine | Install, `bsv create` is NOT what you want — restore: reinstall is recovery-phrase-only in this preview; import flow ships before release |

## 8. What's coming

Quickshell bar widgets and pay prompts, Twetch login as system identity,
agentpay allowances for coding agents, per-call API payments, the bounty
board in the launcher, and the one-click installer. The roadmap lives in
[README.md](README.md) and ships milestone by milestone — wallet first,
always.
