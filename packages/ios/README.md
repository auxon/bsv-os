# bsvOS for iOS (`packages/ios`)

A Swift package for the iOS client. **Read [docs/ios.md](../../docs/ios.md)
first** — it holds the design, the threat model, and the staging.

```bash
swift build
swift test
```

No Xcode project yet, and deliberately no app target: this is the client
library the app will be built on.

## What is here

| | |
| --- | --- |
| `BRC100/Call.swift` | The 28 BRC-100 calls, each with its explicit wire code, plus the error envelope |
| `BRC100/Primitives.swift` | `ProtocolID` and `Counterparty`, validated exactly as the daemon validates them |
| `BRC100/Models.swift` | Wire models for the core calls, derived by reading `brc100.ts` rather than the spec prose |
| `Device/DeviceAllowlist.swift` | What a paired phone may call, and the key-material methods it never may |
| `Device/DeviceTransport.swift` | Phase 0 request building and an injectable HTTP client |
| `Device/Pairing.swift` | the pairing call, Keychain credential storage, an in-memory store for tests |
| `Wallet/WalletModels.swift` | wire models for the Phase 1 reads, taken from live daemon responses |
| `Wallet/WalletBackend.swift` | the seam the UI depends on, plus its device implementation |
| `Wallet/WalletSession.swift` | the view model: status, approvals, send, and their failure modes |
| `Wallet/BiometricGate.swift` | Face ID / Touch ID, and the stubs tests use to assert a denial stops a spend |
| `UI/` | the five Phase 1 screens, plus the app root and pairing screen |
| `Apps/AppIntent.swift` | the 13 intents, mirroring the daemon's `appInvoke` |
| `Apps/AppBridge.swift` | the native half of `window.bsv`: pinning, allowlist, error mapping |
| `Apps/AppHostView.swift` | the `WKWebView` host and the injected shim |
| `Apps/AppsView.swift` | the app list, install, remove, open |
| `Apps/BundledAppHost.swift` | hosts the daemon's own apps: asset loading, the `fetch("/")` rewrite, and `RpcBridge` |
| `Wallet/PushAction.swift` | Phase 3: notification actions, and the payload → action mapping |

## Running it

```bash
swift test                                             # 47 tests, no daemon needed
xcodebuild -scheme BSVOSWallet -destination 'generic/platform=iOS Simulator' build
```

## The app

`App/BSVOSios.xcodeproj` is the runnable target; `App/BSVOSiOSApp.swift` is the
shell around `BSVOSAppView`, and it owns the notification delegate.

```bash
xcodebuild -project App/BSVOSios.xcodeproj -scheme BSVOSios \
  -destination 'generic/platform=iOS Simulator' build
```

**Point it at your daemon**: set `BSVDaemonURL` in `App/Info.plist` to the
machine's VPN address. The default is `https://127.0.0.1:2121`, which only works
in a simulator running on the daemon's own machine — a deliberately useless
default rather than a wrong one, because a wrong address looks like a pairing
failure instead of a config mistake.

For a device build, set your signing team in Xcode. Push also needs the
`aps-environment` entitlement (already in `App/BSVOS.entitlements`) and a
provisioning profile that includes it.

Pair from the app with the code `bsv device pair` prints on the desktop; the
credential is stored in the Keychain and reused on later launches.

## Two encodings that look alike and are not

The single most useful thing to know before adding a model:

- **Byte payloads** (`plaintext`, `ciphertext`, `data`, `signature`,
  `hashToDirectlySign`) are JSON **arrays of integers 0–255**. The daemon's
  `checkBytes` rejects anything else with `BAD_PARAM: … must be a byte array`.
  Swift's `[UInt8]` already encodes as exactly that, so declare `[UInt8]` and do
  not reach for base64.
- **Scripts and headers** (`lockingScript`, `header`) are lowercase **hex
  strings** on the same wire. Declare `String`.

Both are pinned by tests, because getting them backwards is a runtime
`BAD_PARAM`, not a compile error.

## What is deliberately not here

- **No cryptography, and no key material.** Custody stays in the daemon in
  Phase 0; the phone holds a device credential, not a wallet. A test mirrors the
  daemon's `custody-boundary` test and fails if a Swift file ever grows a key
  path — so "make the phone standalone" has to be a deliberate change, not a
  helpful one.
- **No policy engine.** Policy lives in the daemon, where the audit trail is.
  Two policy engines is one too many.
- **No UI.** The SwiftUI shell, the `WKWebView` app host and the `window.bsv`
  bridge are Phase 1/2; this package is what they will call.

## Bundled apps vs downloaded apps

Two hosts, because the apps differ in how they reach the wallet:

- `AppHostView` hosts an **installed** app, which uses `window.bsv`. The bridge
  pins the app's domain and allows the 13 intents.
- `BundledAppHost` hosts the daemon's **own** apps (Twetch, Cast, Explorer,
  Colosseum, MemeStudio, AskAnything, the shell), which call the daemon's
  JSON-RPC same-origin. Their assets come from the daemon (public source), and
  the host rewrites `fetch("/")` into a native bridge call so the RPC still goes
  through the authenticated device surface.

In both cases the token stays native: neither page is ever given a credential,
and the method allowlist is enforced in Swift before anything is sent.

## Push (Phase 3)

The daemon pushes a newly queued approval to every paired device that registered
a token; `PushAction` turns the notification's payload and the button pressed
into an action. The two actions are `.authenticationRequired`, so a locked phone
cannot approve a spend — iOS asks for Face ID or the passcode first.

Delivery is **not** verified anywhere: it needs an Apple developer key, a team
id, the bundle id, and a real device. Set `BSV_APNS_KEY_ID`, `BSV_APNS_TEAM_ID`,
`BSV_APNS_TOPIC` and `BSV_APNS_KEY_P8` on the daemon to enable it; unset, the
daemon logs that push is off and carries on.

The app target must set the notification delegate and call
`PushRegistrar.registerCategories()` at launch, or the lock screen shows no
buttons.

## Guarding against drift

Four artifacts are edited by hand on two machines — the daemon's wire table, the
design doc, and now this Swift package. `packages/walletd/test/ios-parity.test.mjs`
parses them and fails when they disagree:

1. the Swift call surface matches `WIRE_CALL_CODES` exactly, both directions;
2. every wire code matches the daemon's number;
3. `DeviceAllowlist` matches the allowlist in `docs/ios.md` exactly;
4. key-material methods are excluded by name, and the callable and forbidden
   sets cannot overlap;
5. no Swift source implements a key path.

Widening the allowlist therefore means editing the doc, the Swift, and (if the
rule changed) the expectation — on purpose, in one commit.
