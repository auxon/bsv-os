# BSV OS runner (F2): sandboxed webview shell + `window.bsv` bridge

Installed Metanet apps open in their own Chromium app window — not the
default browser — with a capability-scoped `window.bsv` injected by a
local-only MV3 extension. Ten intents, nothing else: reads (`getStatus`,
`getIdentity` public key only, `getBalance`, `getUtxos`) plus policy-gated
writes (`timestamp`, `spend`, `inscribe`, `transferNft`, `signSwapOffer`,
`completeSwap`). Every spend goes through the daemon under the app's own
origin policy, so approvals, caps, and agent budgets apply to apps exactly
like CLI and MCP callers. Pages describe intents — scripts are always
fetched and verified daemon-side, never trusted.

## How it works

```
app page --postMessage--> content.js --fetch--> 127.0.0.1 bridge --socket--> daemon appInvoke
```

- **Launch** (`packages/walletd/src/runner.ts` + `launcher.ts`, `bsv app open`
  and the daemon's `appLaunch`): per-app `--user-data-dir` (no shared
  cookies/storage), `--app=<start_url>`, `--load-extension` (this bridge
  only), `--ignore-certificate-errors` for loopback hosts only. Falls back to
  `xdg-open`/`open` without Chromium. The CLI blocks for the window's
  lifetime; `appLaunch` returns as soon as Chromium is up, and the bridge
  child exits with the window so nothing is orphaned.
- **Bridge** (`packages/walletd/src/bridge.ts` + `bridge-server.ts`, spawned
  as `bridge-main.ts`): one per window with a 128-bit token (URL fragment,
  client-side only) and a pinned domain. Requires the token AND an `Origin`
  header matching the domain; answers PNA preflights for that origin only;
  forwards to `appInvoke` only. Native messaging was rejected: unpacked
  extensions get unstable IDs, so origin pinning cannot work there.
- **Trust order**: page claims are never trusted — the launcher stamps the
  domain, the browser stamps `Origin`, the daemon checks installed-status
  and the method allowlist. The human approves spends via the panel/CLI.

## Demo click-through (loopback, no sudo, no DNS)

```bash
node packages/runner/demo/serve.mjs &      # https://127.0.0.1:8443 (throwaway cert)
bsv app install 127.0.0.1 --manifest-file packages/runner/demo/manifest.json
bsv agent mint 127.0.0.1 --budget=20000     # demo spends within budget
bsv unlock
bsv app open 127.0.0.1                      # click Timestamp in the window
```

`--manifest-file` is the dev-install path: identical validation, network
fetch skipped. Production installs stay https-manifest-only.

## Files

- `extension/`: `manifest.json`, `content.js` (isolated relay), `page.js`
  (MAIN-world `window.bsv`). No extension API permissions, no remote code,
  loopback-only network (all asserted in `test/extension.test.mjs`).
- `demo/`: `manifest.json`, `index.html`, `serve.mjs`.
- `apps/`: bundled runner apps served from the daemon's own origin —
  `bsvos/` (**the system shell**: wallet, approvals, policy, agents, money,
  identity, messaging, apps/store, and work boards — the replacement for the
  Quickshell panel on macOS), `twetch/` (companion), `explorer/` (local chain
  explorer), `cast/` (camera/mic record and value-for-value playback),
  `colosseum/` (Ordinal Colosseum: your ordinals fight), and `memestudio/`
  (Meme Studio: caption Meme Library templates, post them on-chain).
- `store.json`: curated catalog for `bsv store` — every bundled app as its
   own entry with its own install URL (the shell on `127.0.0.1`, and Cast,
   Twetch, Explorer, Colosseum and Meme Studio on the shared `localhost`
   slot), plus the
   remote Metanet apps. Two entries may share a host when their paths differ;
   the store shows which variant is installed and offers a **Switch** for its
   slot-mates.

## The shell app (`apps/bsvos/`)

`packages/shell/plugin/Panel.qml` (3,240 lines) plus `BarWidget.qml` are the
Omarchy/Quickshell wallet UX. `bsvos` replaces both on macOS.

**Why it is not a port.** Every one of the panel's 51 `bsv` subcommands maps
1:1 to a daemon RPC method — the panel shelled out only because QML had no
choice. So the shell calls `dispatch` directly over its own origin. That is
strictly better on every axis the panel was fighting:

| Panel | Shell |
| --- | --- |
| 22 `Process` spawns per refresh, each parsing its own stdout | a handful of same-origin `fetch` calls; `history` alone replaces six polls |
| branched on `onExited(code)` — failures said "see the terminal" | real `error.code` (`POLICY_DENY`, `WALLET_LOCKED`, …) mapped to wording in `lib/rpc.js` |
| one shared `actionProc` guarded by `if (running) return` — concurrent actions silently dropped | no such limit |
| `wl-copy` (Wayland only) | `navigator.clipboard` |
| `xdg-open` (absent on macOS) | `window.open` |
| Qt `FileDialog` → `bsv share <path>` | `<input type=file>` + `crypto.subtle` SHA-256 → `anchorFile {sha256}`; the daemon never sees a path |
| `systemd-run --user … bsv app open` (Linux only) | the daemon's `appLaunch` |
| `bsv login` spawned the browser and blocked 10 min | `identityLoginStart` + `window.open` + poll `identityLoginStatus`; the daemon already owns the loopback callback |
| bar pill auto-summoned the panel on a new request | `new Notification(...)` driven by a `policyPending` poll |

Deliberate boundaries kept from the panel:

- **Recovery ceremonies stay terminal-only.** Setup/rotate/restore move key
  material, so the shell shows status metadata and nothing more.
- **Seed-phrase entry stays terminal-only** (`bsv create` / `bsv import` use a
  hidden stdin prompt). A browser must never be in that path. `unlock` *is*
  offered in-app: it reads the seed from the OS keyring, needs no passphrase
  and no TTY.
- **Torrent seeding is not offered.** It needs a filesystem path, and there
  is no RPC that accepts file bytes. Fetching by infohash works; seeding stays
  in the terminal.
- **Spending is confirmed in the UI.** The panel had no such gate — the policy
  engine was the only brake. The shell always shows amount and destination
  first, because a mis-click in a GUI is cheaper to prevent than reverse.

**Trust.** The shell is served by the daemon from its own HTTPS origin, so it
is loopback-gated and has the same authority as the `bsv` CLI — it is an
operator surface, not a sandboxed third-party app, and its manifest carries a
0 sat cap because every spend is policy-gated per request by the daemon.

## App identity: one slot per host

An installed app is keyed by **hostname** (`apps.domain`, unique), not by
URL. The daemon only ever binds `127.0.0.1:2121`, and only `localhost` /
`::1` / `127.x` are trusted as loopback, so there are exactly two identities
available for bundled apps:

- `127.0.0.1` — owned by the **shell**, permanently.
- `localhost` — shared by the bundled feature apps. Cast, Twetch, Explorer,
  Colosseum and Meme Studio all resolve to `https://localhost:2121/<name>/`,
  so installing one replaces whichever was there. The store lists every one
  of them separately: the entry whose path matches the installed `start_url`
  is the installed variant, and the others are offered as a **Switch**
  (installing their URL replaces the holder). One click, no removal first.

The `Origin` header a browser sends has no path, so the bridge can only pin
a host — giving each bundled app its own policy identity needs per-app
subdomains or nonces, not a path. That is why this is documented rather than
worked around. The dev demo (`127.0.0.1:8443`) shares the shell's host slot
too: running the click-through below evicts the shell, and
`bsv app install https://127.0.0.1:2121/bsvos/` puts it back.

## Store + updates (F1)

Installs pin the manifest (sha256 + canonical copy). `bsv app update`
re-fetches and diffs permissions: narrowing applies silently, widening
needs `bsv app update <domain> --approve-widening` and otherwise seeds an
`app-update` policy request so the panel prompts. Loopback manifests are
fetched with trust scoped to loopback hosts only (same trust domain as
the daemon socket); everything else keeps full TLS validation.
