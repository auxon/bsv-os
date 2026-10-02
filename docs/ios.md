# bsvOS for iOS: Phase 0, authenticated remote access

The iOS plan is staged: a remote client first (full parity, daemon keeps the
keys), on-device custody later and only if the phone must work standalone.
Everything about the first stage rests on this document, because the daemon
today has **no authentication at all** — `isLoopbackPeer()` in
`packages/walletd/src/index.ts` returns 403 for anything that is not
`127.0.0.1`, `::1`, or their IPv4-mapped forms, and that check *is* the
security model. A phone is never loopback. So remote access is a new trust
boundary, not a configuration change.

## What is actually being protected

One keyring entry holding a 12-word HD seed, from which every BRC-100 key,
identity, certificate, and signature derives. Compromise is total and
irreversible — there is no server-side revocation of a leaked seed.

The valuable adjacent capabilities: minting agent sub-wallets with budgets,
changing spending policy, and inscribing (which spends).

## The mistake to avoid

The obvious move is `BSV_WALLETD_BIND=0.0.0.0` behind a tunnel so the phone can
reach it. That publishes a wallet with no authentication to whatever the tunnel
exposes. It is not a shortcut; it is a fund-loss bug with a network cable.

Two related traps:

- **Trusting an address range as identity.** `isLoopbackPeer` is fine only
  because loopback cannot be reached from off-box. Any "trusted subnet" test
  re-introduces the same class of bug one hop out.
- **Treating the pinned self-signed cert as a public one.** The daemon's cert
  (`CN=bsv-walletd`, self-signed, 825 days) is pinned by the app bundle and
  `--ignore-certificate-errors` on loopback. It provides no authentication of
  the *server* to a remote client, and must not be presented as if it did.

## Design

Two layers, deliberately separate. Transport authenticates the *network*;
a device credential authenticates the *app*. Neither alone is enough.

### Transport: WireGuard (or Tailscale)

The daemon stays bound to loopback or to the WireGuard interface only. The
WireGuard keys mutually authenticate the two machines and encrypt the path, so
the token below never crosses the open internet. This is the layer that makes
"the phone is on my private network" true rather than assumed.

Nginx/cloudflared-style public exposure is out of scope by design.

### Authentication: pairing, then per-device tokens

A device credential is minted by an explicit pairing step and revoked from the
desktop. Server-side we store only a hash, so a database read does not yield
usable tokens.

```
desktop:  bsv device pair
          → one-time code (8 chars, 2-minute TTL) + the daemon's VPN address

phone:    POST /v1/device/pair  { code, name, platform }
          → { deviceId, token }        # token returned exactly once

phone:    Authorization: Bearer <token>   on every later call
          token stored in the iOS Keychain, Secure-Enclave-wrapped,
          released only after Face ID
```

Daemon-side record per device:

```
deviceId, name, platform, tokenHash, createdAt, lastSeen,
revokedAt|null, apnsToken|null     # apnsToken used in Phase 3
```

Properties this buys: per-device revocation that takes effect on the next
request; a stolen token is bounded by rate limits and a scope; and the desktop
can answer "which devices can spend, and when did each last talk to me?"

mTLS would be stronger than a bearer token and is a reasonable later upgrade.
It is deferred because it multiplies the iOS key/certificate plumbing while the
transport is already mutually authenticated — the token's job is revocation and
accounting, not confidentiality.

### Authorisation: a `device` origin, enforced by the existing policy engine

The phone must not get the 192-method dispatch. Loopback has that surface
because loopback needed no auth; a remote client is a different proposition.

- Device calls arrive at a **distinct prefix** (`/v1/device/<method>`) handled
  *before* the `isLoopbackPeer` gate, which is narrowed rather than removed.
- The callable set is an **explicit allowlist**, not a prefix match on RPC
  names. Everything not listed is refused.
- Device calls run through the same `check()` from `policy.ts` under a
  `device:<name>` origin, so caps, `deny`, and the ask-then-approve loop behave
  exactly as they do for the CLI and for apps.
- **Key-material methods are never device-callable**: no `createWallet`, no
  `importWallet`, no `recoverySetup`/`Rotate`/`Restore`. The seed path stays on
  the machine that already has the terminal. The phone must not become the
  weakest key path in the system simply because it is the most convenient.

Starting allowlist (reads + wallet-critical writes, to be argued down not up):

```
read      isAuthenticated getVersion getNetwork getHeight getHeader balance
          addressQr history policyList policyPending listPending utxos
          ordList bsv21List appList
wallet    lock unlock policyApprove policyDeny send anchorFile sweepOut
          inscribe appInvoke
```

The two lines above are the authoritative list; `DEVICE_READS` / `DEVICE_WRITES`
in `packages/walletd/src/device.ts` implement it, `DeviceAllowlist` in
`packages/ios/Sources/BSVOSWallet/Device/DeviceAllowlist.swift` mirrors it, and
`test/ios-parity.test.mjs` parses all three, so widening either side alone fails
the suite.

**Reads split in two, which the list above does not show.** `getVersion`,
`getNetwork`, `getHeight` and `getHeader` answer while the wallet is locked —
they are the daemon's public methods. Everything else (`balance`, `addressQr`,
`history`, `ordList`, …) has to derive per-wallet keys, so a locked wallet
answers `WALLET_LOCKED`, not data. That is correct behaviour, not a fault, and
the client already models it: `WalletError.isLocked`.

`unlock` is on the list deliberately, and it is what makes the rest reachable: it
reads the seed from the OS keyring and takes no passphrase, so the phone can
unlock itself exactly as the desktop shell's Unlock button does. Biometric gating
is the client's job at that point — the daemon has already decided the device is
paired and allowed to call it.

Several wallet entries are provisional and need a deliberate yes each rather
than inheriting approval from the block: `sweepOut`, `inscribe`, `anchorFile`,
and `appInvoke`.

**Deferred, and deliberately not on the list above:** `pay`, `requestCreate`
and `requestPay`. Each resolves a person (a `@name`, an identity key, or a
stored address) before spending, and that path currently hardcodes the `cli`
origin. Supporting them from a device means threading an origin through the
person-resolution code rather than duplicating it, which is Phase 1 work — and
Phase 1 does not need them: its milestone is to approve a spend request and send
sats, which needs `policyApprove` and `send`.

This list is enforced, not aspirational. `device.ts` holds the same sets,
`DeviceAllowlist.swift` mirrors them, and `test/ios-parity.test.mjs` fails if any
of the three disagree — which is how the three entries above were caught stating
intent rather than reality. `appInvoke` deserves the most care: it is how hosted apps reach
the wallet, and on the phone the bridge must call the device surface with the
*app's* domain, so an app gets the same policy origin it would on the desktop
instead of inheriting the phone's blanket access.

### Hardening details worth writing down now

- **No cookies, so no CSRF**, but still require a custom header
  (`X-Bsv-Device: 1`) and **reject any request carrying an `Origin` header** —
  browsers always send one, native clients never do, so this keeps a stray
  browser (or a web page on the LAN) from ever reaching the device surface.
- **Rate limit per device**, and log every device call with method, origin, and
  outcome — the daemon already records spends, so extend that record rather
  than inventing a parallel one.
- **Constant-time token comparison** (the bridge already does this for its
  per-window token; reuse the pattern).
- **Skip the pairing code space hard enough** that 8 characters is not
  brute-forceable in its 2-minute window, and invalidate on first use.

## Code touchpoints

| Where | Change |
| --- | --- |
| `index.ts` `isLoopbackPeer()` | Narrow, do not weaken. Add `/v1/device/*` ahead of the gate; leave every existing loopback route as-is. |
| `index.ts` route table | New prefix handler, ordered before the 403, mirroring how `/v1/serve/*` is carved out today. |
| new `device.ts` | Pairing, token mint/verify/revoke, the allowlist, rate limiting. |
| `policy.ts` | `device:<name>` origins flow through `check()` unchanged. |
| new `bsv device` CLI | `pair`, `list`, `revoke`, `rename` — desktop-side management. |
| `storage.ts` | `devices` table (migration). |
| APNs (Phase 3) | `apnsToken` on the device record; push on `seedRequest` so a pending approval reaches the lock screen. `/v1/watch` already provides the event source. |

## Tests that must exist before this ships

Modelled on the existing `custody-boundary.test.mjs`, which greps the source to
prove a rule holds rather than trusting review:

1. Every device route refuses: absent token, malformed token, wrong-device
   token, revoked token — and refuses *before* touching custody.
2. A token revoked mid-flight fails on the next request.
3. The device allowlist is **exactly** the expected set; adding a method to it
   fails the suite until someone updates the expectation on purpose.
4. No key-material method is device-callable (assert against the method lists
   for `createWallet`/`importWallet`/`recovery*`).
5. Existing loopback behaviour is unchanged — the current suite is the
   regression test, so it must stay green untouched.
6. A request with an `Origin` header is refused on the device surface.

Verified live against the running daemon (2026-10-02), not only in tests: pairing
returns a 64-hex token; an authenticated read succeeds; and the refusals behave —
no token 403, `Origin` present 403, missing `X-Bsv-Device` 400, unknown token 403,
`createWallet` 403 `NOT_ALLOWED`, an off-allowlist method 403 `NOT_ALLOWED`, `GET`
405, a wrong pairing code 403. The unlock path was exercised end to end: locked
wallet → `WALLET_LOCKED` on `balance` → `unlock` 200 → `balance` returns the real
address and balance.

Point 3 is the important one. Every previous security decision in this repo was
made enforceable by a test that fails when the rule is bent; remote access
should be no different.

## What this deliberately does not do

- No seed, and no derived private key, on the phone in Phase 0.
- No public-internet exposure of the wallet RPC, ever.
- No new authority for the phone beyond the allowlist: it is another front end
  over the same policy engine, not a second wallet.
- No reimplementation of policy in Swift. Two policy engines is one too many,
  and the daemon's is the one with the audit trail.

## Open questions

1. **Where does the iOS code live?** A new repo (`auxon/bsv-os-ios`) keeps a
   Swift toolchain out of this repo's npm-based CI; `packages/ios/` keeps it
   together and visible to the front-end-split rule. Not yet decided.
2. **Standalone mode (Phase 4) shape.** If the phone ever holds keys, it should
   probably hold a *separate, capped sub-wallet* — the `agent mint` model
   already exists for exactly this — rather than a copy of the main wallet.
   Deciding this late means reconciling two disagreeing wallets.
3. **App Store posture** for a general-purpose BRC-100 app host. Worth a spike
   before Phase 2 goes deep.
