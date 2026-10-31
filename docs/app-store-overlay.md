# bsvOS app store overlay

The hand-written catalog (`packages/runner/store.json`) stays a
**mirror/fallback**. Real discovery is a BSV overlay: one listing token
type, a BRC-22 topic manager, and a BRC-24 lookup service hosted as a
Cloudflare Worker + D1.

Nothing on this branch is deployed. Richard creates the D1 database, the
store key, and the Worker secrets.

## Why an overlay

`store.json` has domain, URL, name, blurb — no price, version, or publisher
key. walletd already fetches `/manifest.json`, pins its sha256, seeds
permissions/spend cap, and asks again when an update widens those. That is
not a registry: anyone can serve a manifest, and a publisher key over a
shared `localhost` identity does not prove who shipped the bytes.

## Listing token (`bsvos.app`)

One type. JSON in `OP_FALSE OP_RETURN "bsvos.app" <json>`, plus a sat
locked to the publisher (the output that must be spent to update or delist)
and a publishing-fee output to the store address.

| Field | Meaning |
| --- | --- |
| `name` | Display name (≤80) |
| `version` | Dotted numbers (`1.0.0`) |
| `domain` / `url` | App identity and install directory (https, same host) |
| `bundleHash` | sha256 of the sorted `path\\nfileSha256\\n` catalogue — **the app bundle**, not only the manifest |
| `manifestHash` | sha256 of key-order-stable manifest JSON (same algorithm as walletd) |
| `publisherKey` | BRC-100 identity pubkey (33-byte compressed hex) |
| `priceSats` | Install price; `0` is free |
| `permissions` | Requested spend cap, protocol/basket/cert counts, intent names |
| `signature` | BSM over the canonical JSON of every field except `signature` |

Updates set `prevOutpoint` and spend that listing sat. Only the publisher
can update or delist (the sat is P2PKH to their key, and the topic manager
re-checks the key).

Shared identity hosts (`localhost`, `127.0.0.1`, `::1`) are **rejected**.
Use `cast.localhost` or a public host before the first real listing.

## Topic manager (`tm_bsvos_apps`)

BRC-22 admission (`packages/overlay/src/topic-manager.ts`):

1. Valid signed listing (or delist / install receipt).
2. Listing sat locked to the publisher.
3. **Publishing fee** ≥ `PUBLISHING_FEE_SATS` (default 1000) to the store
   address. This is the anti-spam check; it is enforced here and in the
   lookup apply path, not by Script.
4. Updates/delists must spend the previous listing; publisher key must match.

Install receipts are **not** a second listing type. They are admitted only
when the payment includes the configured store-cut output. A third-party
wallet that pays only the publisher is not admitted and is never licensed.

## Lookup (`ls_bsvos_apps`)

BRC-24 queries (`POST /lookup` `{ service, query }`):

- `{ latest: true }` — live listings, highest version per domain
- `{ name }`, `{ category }`, `{ publisher }`, `{ domain }`
- `{ licensed: { listingOutpoint, paymentTxid? } }` — `true` only after an
  admitted install payment that included the store cut

Convenience: `GET /apps?name=&category=&publisher=&latest=1`.

Standard overlay endpoints are also served: `/submit`, `/listTopicManagers`,
`/listLookupServiceProviders`, documentation routes. JSON `{ topics, tx }`
submit is the host's test/dev framing; BEEF submit returns 415 until that
framing is wired (no public host runs the SDK routes today).

## Payments

**Publishing fee.** Required on every admitted listing. Configurable
(`PUBLISHING_FEE_SATS`, store address).

**Paid install.** One transaction, two outputs:

- publisher: `price - storeCut`
- store: `storeCut = max(1, floor(price * STORE_CUT_BPS / 10000))` (default
  10%)

Nothing on-chain enforces the cut. The topic manager and lookup do: no
store-cut output → not admitted → not licensed. walletd builds this split
itself (`spendTo`) and refuses to pin a priced overlay listing without it.

Free listings (`priceSats = 0`) skip payment.

## Bundle hashing

```
files sorted by POSIX relative path
catalogue = concat(path + "\n" + sha256(bytes) + "\n")
bundleHash = sha256(catalogue)
```

Overlay installs must present `bundle.json` at the listing URL (or a local
bundled app directory) so walletd can fetch each file, check per-file
hashes, and match the listing. A publisher signature without this check
does not prove who shipped the code.

`store.json` fallback installs keep the old manifest-only pin.

## Per-app subdomains

The wallet keys an app by hostname. Path-sharing on `localhost` meant Cast
and Twetch were one identity. The daemon now also serves:

| Host | App |
| --- | --- |
| `127.0.0.1` | shell (`/bsvos/`) |
| `cast.localhost` | Cast at `/` |
| `twetch.localhost` | Twetch at `/` |
| `explorer.localhost` | Explorer |
| `colosseum.localhost` | Colosseum |
| `memestudio.localhost` | Meme Studio |
| `askanything.localhost` | AskAnything |
| `predict.localhost` | Predict |

`*.localhost` is treated as loopback (cert ignore, manifest fetch). Path
URLs (`https://localhost:2121/cast/`) still serve files. Production
listings should use a real public hostname once one exists.

## Worker (do not deploy from this PR)

`packages/overlay`:

- `wrangler.jsonc` — Worker + D1 binding, placeholder `database_id`
- `migrations/0001_init.sql` — `listings`, `licenses`
- vars: `STORE_ADDRESS`, `STORE_PUBKEY`, `PUBLISHING_FEE_SATS`, `STORE_CUT_BPS`

Richard:

1. `npx wrangler d1 create bsvos-apps` and put the id in `wrangler.jsonc`
2. Create the store key; set `STORE_ADDRESS` / `STORE_PUBKEY` (vars or secrets)
3. `npx wrangler d1 migrations apply bsvos-apps --remote`
4. Deploy the Worker; point walletd at it with `BSV_APPSTORE_OVERLAY`
5. Set `BSV_APPSTORE_STORE_ADDRESS` (and optional `BSV_APPSTORE_STORE_CUT_BPS`)
   on the daemon so paid installs can pay the cut
6. Sign and submit the first real listings (migration script only prints
   unsigned drafts)

## Migration script

```bash
cd packages/overlay
npm test
node --experimental-strip-types scripts/migrate-store.mjs --out /tmp/listings.json
```

Walks `store.json`, hashes local runner bundles, and writes unsigned
listing drafts. Shared-identity rows and remote-only entries are flagged
as not ready.

## walletd / UI

- `storeList` asks `ls_bsvos_apps` when `BSV_APPSTORE_OVERLAY` is set;
  `store.json` fills gaps and is the whole catalog when lookup is down
- `appInstall` of an overlay listing verifies manifest hash + bundle hash,
  then pays the split for priced listings, then pins as before
  (permissions, spend cap, re-approval on widening — unchanged)
- Apps tab shows version, price, overlay vs catalog, publisher key prefix
