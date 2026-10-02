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
