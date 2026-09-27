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
  `launcher/` (the system app list: installed apps, catalog, one-click open),
  `twetch/` (companion), `explorer/` (local chain explorer), `cast/`
  (camera/mic record and value-for-value playback), and
  `colosseum/` (Ordinal Colosseum: your ordinals fight; deterministic stats
  from inscription origins, optional champion-medal inscription).
- `store.json`: curated catalog for `bsv store` (v1: the bundled Launcher,
   the two bundled feature apps' shared localhost slot, and the remote
   Metanet apps; real entries land as more apps ship manifests).

## App identity: one slot per host

An installed app is keyed by **hostname** (`apps.domain`, unique), not by
URL. The daemon only ever binds `127.0.0.1:2121`, and only `localhost` /
`::1` / `127.x` are trusted as loopback, so there are exactly two identities
available for bundled apps:

- `127.0.0.1` — owned by the **Launcher**, permanently.
- `localhost` — shared by the bundled feature apps. Cast, Twetch, Explorer
  and Colosseum all resolve to `https://localhost:2121/<name>/`, so
  installing one replaces whichever was there. Install the one you want and
  open it from the Launcher; switching is one install away.

The `Origin` header a browser sends has no path, so the bridge can only pin
a host — giving each bundled app its own policy identity needs per-app
subdomains or nonces, not a path. That is why this is documented rather than
worked around. The dev demo (`127.0.0.1:8443`) shares the Launcher's host
slot too: running the click-through below evicts the Launcher, and
`bsv app install https://127.0.0.1:2121/launcher/` puts it back.

## Store + updates (F1)

Installs pin the manifest (sha256 + canonical copy). `bsv app update`
re-fetches and diffs permissions: narrowing applies silently, widening
needs `bsv app update <domain> --approve-widening` and otherwise seeds an
`app-update` policy request so the panel prompts. Loopback manifests are
fetched with trust scoped to loopback hosts only (same trust domain as
the daemon socket); everything else keeps full TLS validation.
