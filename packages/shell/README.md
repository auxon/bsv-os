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

Checklist (verified on `bsvOS` 2026-09-14; shell log showed no QML errors):

- [x] Bar widget registered in the bar (`BarWidget.qml`, `Style`/`Color` theme tokens)
- [x] Click toggles wallet panel; right-click runs `bsv lock`
- [x] `Panel.qml`: F8 dashboard over `bsv history` — summary counts, per-status
      hints, approvals with Approve/Deny, policies with Approve/Revoke
- [x] New spend requests summon the panel (15s `bsv requests` poll, unseen-id tracking)
- [ ] Fingerprint offer where Quattro exposes it (deferred: no fingerprint HW enrolled)

Data contract (stable): `bsv status`, `bsv balance`, `bsv pending`,
`bsv requests`, `bsv history`, `bsv allow <origin> [cap]`, `bsv deny <origin>` — all JSON.

Legacy scaffolds (`WalletPill.qml`, `PayPrompt.qml`) predate the manifest
contract and are superseded by `plugin/`; kept for reference until the
`bsv-os-meta` package ships the plugin (Phase D).
