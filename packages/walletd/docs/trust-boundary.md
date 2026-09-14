# Trust boundary

## What the daemon sees

- The 12-word recovery phrase (once, at creation; held in memory while unlocked).
- The HD root it derives. Every signing operation.

## What apps see

Intents only: descriptions, outpoints, locking scripts, amounts, baskets,
labels. `isAuthenticated` answers and signed results. Never keys, never the
recovery phrase. The backup phrase is returned exactly once, over the local
RPC, at `createWallet` time.

## Known limitations (M1)

- Session wipe on `lock()` drops the JS reference; true zeroization awaits a
  native module. Threat model: a memory-dump attacker already owns the user
  account, at which point the keyring is also reachable.
- Authentication factor = OS login session (keyring). No TPM sealing, no PIN,
  no PAM integration yet — scheduled with the Quickshell lock-screen work.
- Identity key is the HD root pubkey. BRC-42 `keyDeriver` paths replace this
  before any identity feature ships (M2).
- Auto-lock default 15 min (`BSV_WALLETD_LOCK_MS` overrides).
