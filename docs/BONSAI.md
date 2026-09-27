# Bonsai → bsvOS: what survived the audit

`auxon/bonsai` is a 2021–2024 C#/.NET prototype of a decentralized software
development network on Bitcoin SV. Last commit `0b506be` is "Update
README.md". This note records what was actually in the code, what was
aspiration, and the one idea that shipped.

Audited 2026-09-27 against a fresh clone (52 commits, master).

## What it was

A reactive, queryable blockchain. Qactive ships a LINQ *expression* to a
server and streams the matching results back, so a client writes

```csharp
IQbservable<Block<string>> query =
  from block in client.Query() where block.Height > -1 select block;
```

and receives a push stream. Around that sat a toy proof-of-work chain
generator, a stock .NET MAUI Blazor app (`Counter.razor`, `FetchData.razor`,
`dotnet_bot.svg` — the untouched template, still branded "MauiBlazorNode"), a
stock ASP.NET MVC `Botcoin.Wallet`, and a `Stratis`/`HBitcoin`/`NBitcoin`
dependency pile.

Hand-written C#: **1,880 lines**. The other ~90,000 lines are generated
`Resource.designer.cs` from the Android build.

## The README vs. the code

| README claim | Code |
| --- | --- |
| Peer-to-peer source control, merge mining, royalties, copyright management | none |
| DNA computing, quantum computing, ML malware protection | none, zero lines |
| Secure multi-party computation (bulletproofs, z-snarks, homomorphic encryption) | one sketch, and broken (below) |
| Machine learning / neural networks | none |
| Reactive query network | the one real thing (~300 lines) |

## It does not build as cloned

Not a judgement call — specific lines:

- `Bonsai.Blockchain.Observables/Blockchain.cs`: `observer.OnNext(/* todo */);`
  — no argument, will not compile.
- `Bonsai.Blockchain.Observables/Blockchain.cs` names `IQbservableProvider` and
  `Qbservable` with no `using Qactive;`.
- `Bonsai.Cryptography/EncryptionExtensions..cs` uses `Observable`,
  `LambdaExpression`, `MemoryStream`, and `DataContractJsonSerializer` with no
  matching `using`s.
- Qactive is referenced as a **prebuilt DLL** at
  `..\..\Qactive\Source\Qactive\bin\Debug\Qactive.dll` — a sibling checkout
  that is not in the repo. The test projects need the same.
- Targets `net462`, `net5.0-windows` (WPF/WinForms), and `net7.0-android`.
  Windows-only, and the mobile stack is stale.

Runtime defects in code that *does* parse:

- `BSV<TId,TData>.Expression => this.Expression` — infinite recursion.
- `Sha256.GetHashCode()` does `Convert.ToInt32(<64-char hex>, 16)` — always
  throws `OverflowException`.
- `EncryptionExtensions.Decrypt` deserializes with `BinaryFormatter` (an
  insecure-by-design deserializer, removed in .NET 8) *and* mismatches the
  JSON serializer used on the encrypt side, so the round trip cannot work.
- `BlockGenerator.calculateDifficulty` is `difficulty >= 4 ? 4 : ++difficulty`
  — TODO, not a difficulty rule.
- The rename Abacus → Bonsai was cosmetic: `Abacus.Cryptography.Sha256`,
  `ABACUS_DATADIR`, `db.abc` all remain.

Honest summary: ~85% is `TODO`, `NotImplementedException`, and empty loop
bodies. There is no code to port. There is a *shape* worth keeping.

## The shape, and where it lives now

The kernel is: **the query runs where the data is, and matches are pushed to
the subscriber** — instead of every client diffing state on a timer.

That is `bsv watch` / `watch_poll` / `GET /v1/watch` (see the README section
"Watch (subscribe, don't poll)"). Same primitive, one language, no new state
table: the daemon merges the tables it already keeps, orders them by
`(timestamp, source, key)`, filters server-side, and hands out cursors that
survive restarts. Shipped 2026-09-27 (`bsv watch`).

Two more ideas from the audit have now followed, and are the honest
descendants:

1. **Time as a ledger dimension.** Bonsai's `Timechain<TId,TData>` treats
   time and duration as part of the record. bsvOS had two implementations of
   that idea — heartbeat-gated sats streams and daemon-enforced post-dated
   capsules (bare CLTV is dead on BSV; 1,500 sats were burned proving it) —
   and cast pay-per-minute, which is a *stream* underneath
   (`cast.ts` → `createStream`), not a third engine. The scheduling math is
   now one pure, tested ladder in `packages/walletd/src/commitment.ts`
   (not due → nothing left → condition unmet → too small to send → release),
   used by the stream ticker, with `bsv commitments` /
   `commitment_list` answering "what is this wallet on the hook for?" across
   streams, cast sessions, and capsules in one call. Shipped 2026-09-27.
2. **Proof without disclosure.** "MPC for critical data" reduced, in practice,
   to what could be built soundly: `bsv funds attest` signs a claim of
   "≥ N sats" bound to a Merkle root over the spendable UTXO set, with an
   expiry, publishing no balance and no UTXO list; `bsv funds prove` gives a
   real Merkle inclusion proof for a single UTXO, which a third party can
   verify with no wallet access. The `≥ N` part stays a *signed claim*, not a
   zero-knowledge proof — the docs and the verifier both say so, and
   `verifyFundsAttestation` reports every check by name. Shipped
   2026-09-27 (`packages/walletd/src/attest.ts`).

What remains genuinely unsolved, and should not be promised: proving a
balance threshold *cryptographically*. That needs range proofs (Bulletproofs
or zk-SNARKs) over commitments the chain can verify, and BSV has no such
consensus primitive. Naive substitutes leak: a "balance ≥ X" claim published
on-chain is trivially cross-checked against later spending.

## What was deliberately not done

- **Merge mining / a Bonsai chain.** A 2018 idea whose ecosystem is gone, and
  bsvOS builds *on* BSV rather than beside it.
- **A C# → TypeScript port.** There is nothing to port but the idea.
- **Reviving MAUI/WPF/Stratis.** Dead dependencies, Windows-only, unrelated
  to self-custody.

The repository stays public as written, as a museum piece. The archive is the
point: an honest record of what was tried, and one idea that survived.
