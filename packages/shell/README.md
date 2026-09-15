# BSV OS shell plugins (Quickshell)

Omarchy manifest plugin `bsv.wallet` (source: `plugin/`). Installed by hand
per the shell's third-party contract — `~/.config/omarchy/plugins/bsv.wallet/`
is NOT a git checkout, so re-copy on change, then rescan:

```bash
cp packages/shell/plugin/* ~/.config/omarchy/plugins/bsv.wallet/
omarchy-shell shell rescanPlugins
omarchy plugin enable bsv.wallet
omarchy bar put bsv.wallet --section right
```

Hot-reload caveat: the shell reuses the loaded component when file URLs
don't change, so QML edits often DON'T reach the running bar (stale pill,
dead clicks, teardown RangeError bursts). After editing, re-sync and
**restart the shell**: `omarchy restart shell`. Verify with a screenshot
(`grim`) — never assume a rescan was enough.

Checklist (verified on `bsvOS` 2026-09-14; shell log showed no QML errors):

- [x] Bar widget registered in the bar (`BarWidget.qml`, `Style`/`Color` theme tokens)
- [x] Click toggles wallet panel; right-click runs `bsv lock`
- [x] `Panel.qml`: F8 dashboard over `bsv history` — summary counts, per-status
      hints, approvals with Approve/Deny, policies with Approve/Revoke,
      F9 agent cards (remaining/total, daily window, Revoke),
      F1 store (catalog caps, Install/Open/Update/Remove, widening approval),
      F7 share (file picker → `bsv share`, txid + Open-in-explorer),
      F3 identity (identity key, certs with verified/self-asserted state,
        disclosure sheet with field picker + audit, Revoke),
      F4 money (per-basket balances with member counts),
      F5 gallery (inscriptions with View links, BSV21 positions; sends stay CLI),
      F6 inbox (peers, Read decrypts, Ack; ciphertext at rest),
      F10 recovery status (sets, guardians, fingerprint; ceremonies stay CLI),
      F12 board (live gigs with Track/Claim/Untrack; submit/paid stay CLI),
      F13 schedules (orders with Pause/Resume, runs with Claim/Submit/Approve/Fail),
      capped card + ScrollView (wheel-scrolls), 10s live refresh while open
- [x] Nautilus share target (`nautilus/Anchor on BSV`, post-install synced)
- [x] New spend requests summon the panel (15s `bsv requests` poll, unseen-id tracking)
- [ ] Fingerprint offer where Quattro exposes it (deferred: no fingerprint HW enrolled)

Data contract (stable): `bsv status`, `bsv balance`, `bsv pending`,
`bsv requests`, `bsv history`, `bsv allow <origin> [cap]`, `bsv deny <origin>` — all JSON.

Legacy scaffolds (`WalletPill.qml`, `PayPrompt.qml`) predate the manifest
contract and are superseded by `plugin/`; kept for reference until the
`bsv-os-meta` package ships the plugin (Phase D).
