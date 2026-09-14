# BSV OS shell plugins (Quickshell)

Scaffold for P1. Verified on-device against omarchy-mac's plugin surface
before calling done:

- [ ] `WalletPill.qml` registered in the bar; theme tokens swapped in
- [ ] Click opens wallet panel; right-click runs `bsv lock`
- [ ] `PayPrompt.qml` wired to the shell notification/polkit surface
- [ ] Pending-request polling matches daemon `policyPending` shape
- [ ] Fingerprint offer where Quattro exposes it

Data contract (stable): `bsv status`, `bsv balance`, `bsv pending`,
`bsv requests`, `bsv allow <origin> [cap]`, `bsv deny <origin>` — all JSON.
