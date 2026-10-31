# @bsv-os/overlay

BRC-22 topic manager (`tm_bsvos_apps`) and BRC-24 lookup (`ls_bsvos_apps`)
for the bsvOS app store. Cloudflare Worker + D1. Spec:
[docs/app-store-overlay.md](../../docs/app-store-overlay.md).

```bash
npm test
node --experimental-strip-types scripts/migrate-store.mjs
```

Do not deploy or set secrets from this package until Richard creates the
D1 database (`bsvos-apps`) and the store key. `wrangler.jsonc` ships a
placeholder `database_id`.
