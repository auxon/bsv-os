# bsvOS for iOS

Covers the daemon-side gate (Phase 0) and the app skeleton (Phase 1). The
staging beyond that is at the end.

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

**The operator tier is 109 methods** — **52** reads and **57** writes — with nine
key-material methods refused by name. The authoritative list lives in
`DEVICE_READS` / `DEVICE_WRITES` / `NEVER_DEVICE_CALLABLE` in
`packages/walletd/src/device.ts`, mirrored in
`packages/ios/Sources/BSVOSWallet/Device/DeviceAllowlist.swift`. A test compares
those two directly (a 109-name block duplicated in prose was documentation of
nothing), and checks the counts above so this paragraph cannot drift.

Roughly: every read the apps use (`twetchFeed`, `twetchMarket`, `castEpisodes`,
`msgList`, `certList`, `profileGet`, …), every operator action (`send`, `pay`,
`sweepOut`, `policyApprove`, `agentMint`, `appInstall`, …), and the app-activity
writes that carry their own origin (`twetchPost`, `castPlay`, `boardCreate`,
`askPost`, …).

**Note on names: this surface speaks the daemon's RPC table, not BRC-100.**
`getNetwork`, `getHeight` and `getHeader` are BRC-100 *wire* calls
(`WIRE_CALL_CODES`, served at `/w/<call>`), not RPC methods, and `listPending`
is spelled `pending` here. All four sat in this list from Phase 0 and were
harmless only because nothing called them — a device asking for them would have
received `NOT_FOUND`. A reachability guard now fails on names with no handler,
which is how they were found.

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

`registerPush` is the device recording where to send its own notifications — a
mutation of the device's record, not a wallet action.

`appInstall` and `appRemove` are the app store: installing adds an origin that
may *ask* to spend — the cap it requests still needs approval, and widening it
later needs approval again — so the store grants no spending authority by itself.
The daemon fetches and validates the manifest, so a device cannot install an
arbitrary page as an app.

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

## Phase 1: the app skeleton

Built in `packages/ios`, as a Swift package rather than an Xcode project so it
can be compiled and tested on a Mac: the five screens the milestone needs
(approvals, wallet/receive, send, history, policy), the session holding their
state, pairing, and Keychain-backed credential storage. 47 Swift tests, and it
compiles against the iOS Simulator SDK.

**The app target exists**: `packages/ios/App/BSVOSios.xcodeproj`, built and
verified. It is a thin shell — `BSVOSiOSApp.swift` wires `BSVOSAppView` to a
configured daemon and owns the notification delegate; everything else lives in
the package, where the tests are.

```bash
# Simulator (no signing needed)
xcodebuild -project packages/ios/App/BSVOSios.xcodeproj -scheme BSVOSios \
  -destination 'generic/platform=iOS Simulator' build

# Device: set your team in Xcode, and point the app at the daemon
#   App/Info.plist -> BSVDaemonURL
```

Two things about the target worth knowing, both found by building it rather
than by writing it:

- **The daemon address lives in an explicit `Info.plist`.** Xcode's generated
  plist silently drops keys it does not recognise — `BSVDaemonURL` never reached
  the bundle, so the app could not be pointed at a daemon without editing
  source. That is now verified by inspecting the built bundle, not by trusting
  the build setting.
- **`@preconcurrency` on the notification conformance.** `UNUserNotificationCenterDelegate`
  is not main-actor annotated while `UIApplicationDelegate` methods are, which
  Swift 6 treats as an error rather than a warning.

The notification actions deliberately do **not** re-prompt for biometrics: they
are registered with `.authenticationRequired`, so iOS has already demanded Face ID
or the passcode before the callback runs. Asking twice for one decision is not
more secure, just slower.

Decisions worth knowing:

- **Biometrics guard the action, not the launch.** Face ID is required at the
  moment of approving or sending, which is where the risk is; asking at launch
  would be theatre. A denied check returns `BIOMETRIC_DENIED` and nothing
  reaches the daemon — a test asserts the daemon is never called.
- **The session never recomputes an amount.** It validates only what the daemon
  would reject anyway (empty address, non-positive amount, more than the
  balance) and passes the figure through unchanged. Fee arithmetic and policy
  stay in the daemon; a second implementation here would be a second source of
  truth.
- **A locked wallet is a state, not an error.** Reads needing the key return
  `WALLET_LOCKED`, the UI offers Unlock, and Lock lives in the status strip.
- **Only five screens, not thirty-four.** Phase 3 reaches the long tail by
  hosting the desktop shell app in a web view rather than rewriting it, so
  writing those screens in SwiftUI now would be work thrown away.
- **Credential storage is Keychain with `WhenUnlockedThisDeviceOnly`**, so the
  token is device-bound and unreadable while locked. The Secure-Enclave wrap
  described above is a hardening step, not a Phase 1 gate: biometrics are
  enforced at the spend, which is where the exposure is.

Absent and deliberate: policy *editing* from the phone (read-only for now), and
sweep-out.

The app target must also set the notification delegate and call
`PushRegistrar.registerCategories()` before the first push arrives, or the lock
screen shows no buttons.

## Phase 2: hosting apps

The milestone is "an installed app runs on the phone and spends through
policy". Built in `packages/ios/Apps`:

  AppIntent.swift     the 13 intents, mirroring appInvoke
  AppBridge.swift     the native half: pinning, the allowlist, error mapping
  AppHostView.swift   WKWebView + the injected window.bsv
  AppsView.swift      list, install, remove, open

**iOS is a better host than the desktop, and the differences are structural.**

- **No extension and no relay.** The desktop needs a content script plus a
  per-window loopback HTTP bridge because an unpacked MV3 extension cannot use
  native messaging, and the token has to ride in a URL fragment. On iOS the page
  calls `webkit.messageHandlers.bsv` directly: one hop instead of three, no
  relay to attack, no token to leak. A test asserts the iOS host contains
  neither a fragment token nor a loopback address.
- **Origin pinning is structural rather than observed.** The desktop pins the
  app's domain from the browser's `Origin` header. Native created the web view
  for one app and holds that identity itself, so the page cannot even attempt to
  claim another.
- **The registry stays in the daemon.** `appList` is a read and
  `appInstall`/`appRemove` are device-callable, so there is one list of installed
  apps with one set of manifest hashes and caps. A second registry on the phone
  would be a second thing to keep in step. The daemon fetches and validates the
  manifest, so a device cannot install an arbitrary page as an app.
- **The store grants no spending authority.** Installing adds an origin that may
  *ask*; the cap it requests still needs approval, and widening it needs approval
  again.
- **Apps get device powers' limits, not the device's powers.** `unlock`, `send`,
  `sweepOut`, `policyApprove` and `policyDeny` are device-callable — the phone
  may do them — but are refused to apps, which ask to spend through their own
  origin policy instead of moving sats themselves. A test asserts the app intent
  list contains none of them.

The `window.bsv` surface is identical to the desktop runner's, and an npm-side
test parses both files and fails if a method is added to one and not the other:
an app written for the desktop must run here unmodified, and a missing method
would fail inside a web page, where it is hardest to notice.

Verification: 58 Swift tests; `BUILD SUCCEEDED` against the iOS Simulator SDK;
519 daemon tests including the parity guards. The app-intent guard was checked
by deliberately introducing a divergence and confirming it fails.

## What this deliberately does not do

- No seed, and no derived private key, on the phone in Phase 0.
- No public-internet exposure of the wallet RPC, ever.
- No new authority for the phone beyond the allowlist: it is another front end
  over the same policy engine, not a second wallet.
- No reimplementation of policy in Swift. Two policy engines is one too many,
  and the daemon's is the one with the audit trail.

## Phase 3: push (done), the long tail (blocked on a decision)

The milestone is "you get a push, approve from the lock screen, no app launch".

**The push half is built.**

Daemon side (`packages/walletd/src/push.ts`):

- `wireApprovalPush` is attached to the policy engine's request listener, so a
  newly queued approval pushes to every paired device that registered a token.
  It is a listener rather than an import because the policy engine must not
  depend on iOS.
- It **fails soft in both directions**: an unconfigured APNs key is a no-op that
  says so once (verified live — the daemon logs the line and comes up healthy),
  and a delivery failure is logged rather than thrown, because a phone that
  cannot be reached must not turn into a failed spend.
- The provider token is an ES256 JWT, cached for 50 minutes because Apple
  throttles regeneration, and a test verifies the signature against the public
  key. Apple's 410 is treated as a dead token to prune; a 503 is not.
- `registerPush` is device-callable so a phone can record where to push, and a
  revoked device stops being a target.

iOS side (`Wallet/PushAction.swift`): the notification category and its two
actions, marked `.authenticationRequired` so **a locked phone cannot approve a
spend** — iOS demands Face ID or the passcode before either button fires, which
is the same gate the app applies in-process. `PushAction.from(userInfo:)` maps a
payload to an action, and is tested against malformed inputs: a payload without
an origin does nothing rather than approving something, and a default tap is not
an approval.

**What is not verified: delivery.** That needs an Apple developer key (`.p8`),
a team id, the bundle id, and a physical device. The code path is complete and
the transport is injectable, but nothing here has spoken to Apple.

**The long tail is not built, because it needs a decision rather than code.**
Two blockers, both found by reading rather than assuming:

1. **Bundled apps cannot load off-loopback.** The static app route sits *after*
   `isLoopbackPeer`, so a phone gets 403 for `/twetch/` or `/bsvos/` today.
   Serving those bundles to paired devices is easy and safe — they are public
   source, like `/health` — but it is a deliberate widening of what leaves
   loopback.
2. **The shell calls 44 methods, including `twetchAccountImportFromSeed`**,
   which is in the never-callable set. Hosting the shell wholesale would expose
   a key-material path, so either the bridge refuses those methods and the UI
   degrades, or the shell is not hosted on the phone at all.

Beyond that, routing the long tail through a `device:<name>` origin means
threading an origin through the handlers that still hardcode `cli` (the
person-resolution path in `pay`, `requestCreate` and `requestPay` are the known
ones). That is real work, and it is the same work the deferred writes need.

### The options, sized

Measured rather than guessed. Of the methods the bundled apps and the desktop
shell call:

| | |
| --- | --- |
| methods called by apps | 105 |
| device-callable today | 27 |
| **missing** | **86** |
| forbidden (key material) | 1 — `twetchAccountImportFromSeed` |

The 85 that are not key material fall into three kinds, and the split matters
because only one kind costs anything:

- **~39 pure reads** — `twetchFeed`, `twetchMarket`, `twetchStatus`,
  `castEpisodes`, `certList`, `contactList`, `profileGet`, `requestList`,
  `storeList`, `overlayLookup`, … No origin is involved: reads are not
  policy-gated.
- **state-changing but not value-moving** — `msgSend`, `boardCreate`,
  `profileSet`, `contactAdd`, `requestCreate`, `msgAck`, `identityLoginStart`,
  `appUpdate`, `agentRevoke`, …
- **value-moving** — `twetchPost`, `twetchBuy`, `castPlay`, `streamPause`,
  `pay`, `requestPay`, `receiptIssue`, `ordInscribe`, …

Exactly **five handlers hardcode `origin: "cli"`**: `send`, `pay`,
`requestPay`, `receiptIssue`, `marketCancel`. Those five are the whole
origin-threading cost. Everything else either takes an origin already or is a
read.

One finding that changes the arithmetic: **the Twetch writes do not use the
caller's origin at all.** `twetchPost` defaults to `"twetch"`, `twetchIndex` and
`twetchBuy` hardcode it. So adding them costs no threading, and their policy
identity on the phone is the same one they have on the desktop — a cap or a
block set for `twetch` applies in both places, which is the behaviour you want.

### A. Operator tier — everything but key material

All 85. Requires the five-handler threading plus 85 names carried in three
places (`device.ts`, this document, `DeviceAllowlist.swift`).

- **Buys** full panel parity on the phone: every bundled app fully working.
- **Costs** the largest blast radius: a stolen token can post, publish, message,
  start streams, revoke agents and change policy. Spends are still policy-gated
  and key material still refused, but "everything else" is a lot of surface.
- **Effort** a day, mostly list bookkeeping and tests.

### B. Reads only

The ~39 reads. No threading at all.

- **Buys** the phone can browse: the Twetch feed, market listings, collectibles,
  contacts, receipts, the message list.
- **Costs** less than A, but not nothing: `msgShow` **decrypts messages**, so a
  stolen token reads your private correspondence. That is disclosure, not merely
  metadata.
- **Effort** half a day, mostly the three-way list sync.

### C. Skip

- **Buys** what already exists, which is more than it sounds: **Market is a
  remote app and already works** through `window.bsv` (Phase 2), as do Pocket
  Pets and any third-party app. The five wallet screens work. The gap is
  specifically the *bundled* same-origin apps.
- **Costs** nothing.
- **Loses** Twetch, Cast, Explorer and Colosseum on the phone.

### D. Twetch only — recommended

The 11 methods Twetch needs, none of which need threading because Twetch
already owns its origin.

- **Buys** the one bundled app with real value away from the desk: the feed,
  alerts, memes, the market and posting, with the existing `twetch` policy
  applying unchanged.
- **Costs** a policy surface that already exists on the desktop, so the
  incremental exposure is small. Posting spends a network fee and is gated by
  the `twetch` origin exactly as it is today.
- **Effort** an hour: 11 names in three places, plus tests.
- **Leaves out** Cast, Explorer and Colosseum, which are read-mostly and add
  little on a phone.

**Chosen: A, the operator tier.** Implemented and verified; what follows is
what it took and what it means in practice.

### What option A required

- **Four handlers extracted**, not forty: `pay`, `requestPay`, `receiptIssue`
  and `marketCancel` became `payFor(origin, …)` and friends, with the RPC
  handlers delegating as `payFor("cli", …)`. `send` already took an origin via
  `deviceInvoke`. The origin is a *parameter*, never read from the request body:
  a caller-supplied origin would let the phone spend as `cli` and bypass every
  cap keyed to it.
- **Everything else delegates.** `deviceInvoke`'s default now forwards any
  allowlisted write to the RPC table, keeping one implementation of each method
  instead of a second copy that could drift. That is also honest about what the
  tier is: the same methods the desktop has, reachable from the phone.

### Two things this surfaced

**A pre-existing bug, found by the new guard.** `getNetwork`, `getHeight` and
`getHeader` sat in the device allowlist from Phase 0 and are not RPC methods at
all — they are BRC-100 *wire* calls — and `listPending` is spelled `pending` on
this surface. A device asking for them would have received `NOT_FOUND`. They were
harmless only because nothing called them. The reachability guard — every
allowlisted method must resolve to a handler — is what found them, and it is what
makes a 109-name list safe to maintain.

**Per-device origins.** A phone's own spending runs under `device:<name>`, so
each device needs its own approval and devices do not share a cap. That is the
useful direction for blast radius, and a deliberate consequence:
`bsv allow device:<name> <cap>` is per phone.

### Verified live

From a paired device: `twetchStatus`, `twetchFeed`, `agentList`, `doctor`,
`storeList`, `requestList`, `msgList`, `castEpisodes` and `askList` all answer
200 where they were refused before; `createWallet` and
`twetchAccountImportFromSeed` still answer 403 `NOT_ALLOWED`; and a device `pay`
is refused under `device:origin-spend` with the daemon naming exactly the
approval command, which is the extracted-origin path proving itself.

### The bundled apps on the phone, finished

Two halves, both done.

**Assets.** The bundled-app GET route moved *above* the loopback gate, with the
serving code extracted into `serveRunnerApp` so loopback and a paired device
share one implementation. Narrow by construction, and a test asserts the
narrowness rather than trusting it: GET only, only names in `RUNNER_APPS`, and
traversal refused by `resolveRunnerAppFile` (verified live — `/twetch/../../…`
answers 404 both unencoded and percent-encoded). Everything else stayed below the
gate, and the same test fails if `/`, `/v1/watch`, cast media, cast live segments,
the JSON-RPC or the BRC-100 wire ever drift above it.

Serving these to a peer that can already reach the daemon leaks nothing: they are
public source in this repository, the same reasoning as `/health`.

**The RPC they call.** The bundled apps call the daemon's JSON-RPC
*same-origin* via `fetch("/")`, which works on the desktop because the page is
loaded from loopback. On a phone it cannot, and the RPC should stay
loopback-only. So `BundledAppHost` injects a shim that rewrites that one call
shape into a native bridge message, and `RpcBridge` forwards it to the
authenticated device surface.

The property that makes the rewrite worth doing: **the token never enters the
page.** The alternative — handing the page a credential and letting it call
`/v1/device/<method>` directly — would put a wallet token in a web view, which is
exactly what the desktop design avoids. The allowlist is checked natively before
anything is sent, so a bundled app asking for key material is refused on the
phone, and a test asserts the shim contains no `Bearer`, no `Authorization`, no
`bsv-token`, and no device URL.

The shim also carries `window.bsv` unchanged, so a bundled app that uses the
bridge and one that uses same-origin RPC both work in the same host.

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
4. **Where the app target lives.** A `packages/ios/` Xcode project keeps it
   together; a separate one keeps Xcode's project file noise out of this repo.
   The package works either way, which is why this could wait.
