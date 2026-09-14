# BSV OS

Omarchy remix with a system BRC-100 wallet. Every app, agent, and shell
interaction can transact; keys never leave the daemon.

## Layout

- `packages/walletd/` — `bsv-walletd` daemon (P0 in progress)

## walletd (P0)

System BRC-100 wallet daemon: HTTPS `127.0.0.1:2121` (pinned self-signed
cert) + Unix socket `$XDG_RUNTIME_DIR/bsv-walletd.sock`, same JSON-RPC shape.

```bash
cd packages/walletd
npm install
npm test          # MockChain + custody boundary + RPC, no network
npm run dev       # boot daemon
curl -sk -X POST https://127.0.0.1:2121/ -d '{"method":"isAuthenticated","id":1}'
```

TypeScript rule: tests import `src/*.ts` directly via node type-stripping,
so write **erasable syntax only** — no parameter properties, enums, or
namespaces (`tsc --noEmit` still gates the build).

Trust rule (CI-enforced): raw key material lives only in
`packages/walletd/src/custody.ts`. Everything else talks intents.

## CLI

```bash
npm run build && npm link   # or: ./node_modules/.bin/tsx src/cli.ts
bsv status                  # locked? enrolled?
bsv create                  # new wallet (backup shown once)
bsv unlock | bsv lock
bsv balance                 # live chain lookup
bsv anchor <sha256>         # policy-gated OP_RETURN timestamp
bsv allow <origin> [cap] | bsv deny <origin> | bsv requests | bsv policies
bsv pending                 # monitor queue
```

First spend from a new origin is denied pending approval (`bsv allow cli`
for local flows) — that denial-then-approval loop is the whole policy model
working as designed.

## Roadmap

- M0 (this): daemon skeleton, MockChain tests, custody boundary ✅
- M1: real custody (libsecret/TPM, Shamir), lock lifecycle
- M2: chain + monitor (ARC, reorgs, SQLite), PocketPets regression tests
- M3: permissions + `bsv` CLI + first migrated app flow
- Then: Quickshell UI, Twetch identity, agentpay/x402 rails, ISO
