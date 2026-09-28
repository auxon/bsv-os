import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest, readCatalog } from "../src/apps.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../../runner/apps/bsvos");
const read = (f) => fs.readFileSync(path.join(appDir, f), "utf8");
const exists = (f) => fs.existsSync(path.join(appDir, f));

test("bsvos app: bundle files exist", () => {
  for (const f of ["index.html", "app.js", "styles.css", "manifest.json", "lib/rpc.js", "lib/ui.js", "lib/notify.js"]) {
    assert.ok(exists(f), `${f} present`);
  }
  for (const f of ["views/common.js", "views/wallet.js", "views/money.js", "views/social.js", "views/apps.js", "views/work.js", "views/inscribe.js", "views/twetch.js", "views/setup.js", "views/index.js"]) {
    assert.ok(exists(f), `${f} present`);
  }
});

test("bsvos app: manifest validates on its own 127.0.0.1 slot", () => {
  const raw = JSON.parse(read("manifest.json"));
  // The shell must NOT claim localhost: that slot rotates between the bundled
  // feature apps, and a system shell that gets evicted by them is useless.
  const v = validateManifest("127.0.0.1", raw);
  assert.equal(v.name, "bsvOS");
  assert.equal(v.startUrl, "https://127.0.0.1:2121/bsvos/");
  // The shell never spends on its own behalf; spends are policy-gated by the
  // daemon per request, so the manifest grants no blanket cap.
  assert.equal(v.spendCapSats, 0);
  assert.throws(() => validateManifest("localhost", raw), /escapes the app origin/);
});

test("bsvos app: served by the daemon", () => {
  const src = fs.readFileSync(path.resolve(here, "../src/index.ts"), "utf8");
  const m = /const RUNNER_APPS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "RUNNER_APPS set found");
  const names = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  assert.ok(names.includes("bsvos"), "bsvos is served by the daemon");
});

test("a long-lived shell window notices when its build changes underneath it", () => {
  // The page imports its modules once and runs them for as long as it stays
  // open, so a git pull + daemon restart left it serving the previous build
  // with the nav quietly missing. This is the guard against that.
  const app = read("app.js");
  assert.ok(app.includes("loadedEtag"), "captures an ETag at load");
  assert.ok(app.includes("if-none-match"), "revalidates with a conditional GET");
  assert.ok(app.includes("stale-banner"), "shows a banner when the build moves");
  assert.ok(app.includes("location.reload()"), "offers a reload");
  assert.ok(app.includes("document.hidden"), "does not nag a hidden window");
  assert.ok(app.includes("getVersion"), "footer version is read from the daemon");
  // The daemon side has to actually send one, and it has to move when the
  // file does — a static ETag would never fire.
  const src = fs.readFileSync(path.resolve(here, "../src/index.ts"), "utf8");
  const at = src.indexOf("const etag =");
  assert.ok(at > 0, "app assets compute an ETag");
  const block = src.slice(at, src.indexOf("res.end(body);", at));
  assert.ok(block.includes("etag,"), "the ETag is sent as a header");
  assert.ok(block.includes("stat.mtimeMs"), "the ETag moves when the file changes");
  // But a per-file ETag on the entry module missed fixes that landed in
  // views/ (they never moved app.js, so the banner never fired). The stamp
  // the banner compares must cover the whole bundle, served at one path.
  assert.ok(app.includes('fetch("__build"'), "the shell revalidates the bundle stamp");
  assert.ok(!app.includes('fetch("app.js"'), "not just the entry module");
  assert.ok(/runnerAppStamp\(/.test(src), "the daemon computes a bundle stamp");
  assert.ok(src.includes('appMatch[2] === "/__build"'), "and serves it at /<app>/__build");
  // ...and the nav the user could not see must still be wired.
  // app.js must consume the registry, not reassemble it: that is exactly what
  // let a missing spread operator hide from the entire test suite.
  assert.ok(app.includes('from "./views/index.js"'), "app.js imports the registry");
  assert.ok(!app.includes("const VIEWS = ["), "app.js does not rebuild the view list");
  const registry = read("views/index.js");
  assert.ok(registry.includes("...twetchViews"), "twetch views are spread into the registry");
  assert.ok(registry.includes('"Twetch"'), "Twetch group is declared in the registry");
});

test("bsvos app: every module parses and nothing loads remotely", () => {
  const files = [
    "app.js", "lib/rpc.js", "lib/ui.js", "lib/notify.js",
    "views/common.js", "views/wallet.js", "views/money.js",
    "views/social.js", "views/apps.js", "views/work.js", "views/inscribe.js", "views/twetch.js", "views/setup.js", "views/index.js",
  ];
  for (const f of files) {
    // Real parse gate. These are ES modules, so a syntax error kills the
    // whole page silently — `node --check` parses them as ESM because
    // packages/runner/package.json declares "type": "module". (This gate
    // caught a real unbalanced-paren bug in money.js, which is why it is a
    // parse and not a regex.)
    const res = spawnSync(process.execPath, ["--check", path.join(appDir, f)], { encoding: "utf8" });
    assert.equal(res.status, 0, `${f} must parse:\n${res.stderr}`);
    const src = read(f);
    assert.ok(src.length > 0, `${f} is not empty`);
    assert.ok(!/\beval\s*\(/.test(src), `${f} must not eval`);
    assert.ok(!/\bnew\s+Function\s*\(/.test(src), `${f} must not build code from strings`);
  }
  // No remote scripts or stylesheets.
  const html = read("index.html");
  for (const m of [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((x) => x[1])) {
    assert.ok(!/^https?:\/\//i.test(m), `remote script: ${m}`);
  }
  for (const m of [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((x) => x[1])) {
    assert.ok(!/^https?:\/\//i.test(m), `remote stylesheet: ${m}`);
  }
  // The only module entry point is local.
  assert.ok(html.includes('src="app.js"'), "app.js is the entry point");
  assert.ok(html.includes('type="module"'), "ES modules");
});

test("bsvos app: no key material and no keychain reads", () => {
  const files = ["app.js", "lib/rpc.js", "lib/ui.js", "lib/notify.js", "views/wallet.js", "views/money.js", "views/social.js", "views/apps.js", "views/work.js", "views/inscribe.js", "views/twetch.js", "views/setup.js", "views/index.js"];
  for (const f of files) {
    const src = read(f);
    assert.ok(!/WIF\b|privateKey|mnemonic|seed phrase|identityKey\s*[:=]\s*["']/.test(src), `${f} has no key material`);
  }
});

test("bsvos app: covers the whole Quickshell panel surface", () => {
  // The panel had these sections; every one must have a home here. This is the
  // regression guard for "replace the panel entirely".
  const app = read("app.js");
  const all = [
    "views/wallet.js", "views/money.js", "views/social.js", "views/apps.js",
    "views/work.js", "views/inscribe.js", "views/twetch.js", "views/setup.js", "views/index.js",
  ]
    .map(read)
    .join("\n");
  for (const v of [
    "overview", "approvals", "transactions", "policy", "agents",
    "receive", "send", "pay", "requests", "receipts", "baskets", "collectibles", "tokens",
    "identity", "people", "inbox", "peers", "compose",
    "apps", "market", "share",
    "gigs", "nightshift", "overlays", "files", "faucet", "recovery",
  ]) {
    assert.ok(new RegExp(`id:\\s*"${v}"`).test(all), `view ${v} exists`);
  }
  assert.ok(/VIEWS/.test(app), "views are registered");
  // The panel had no Twetch surface at all; these are additions.
  for (const v of ["twetch-feed", "twetch-alerts", "twetch-profile", "twetch-memes", "twetch-market"]) {
    assert.ok(new RegExp(`id: "${v}"`).test(all), `view ${v} exists`);
  }
  // GROUP_ORDER moved into the registry, so check it there.
  assert.ok(/Twetch/.test(all), "a Twetch nav group exists");
  // Setup is where a new machine starts.
  assert.ok(new RegExp('id: "setup"').test(all), "setup view exists");
  assert.ok(/hasWallet && state\.viewId !== "setup"/.test(app), "first run lands on setup");
  // The wizard must not be a trap: it reads state from the daemon each visit.
  assert.ok(/Promise\.all\(\s*\[\s*tryRpc\("isAuthenticated"/.test(all), "setup derives progress from the daemon");
});

test("bsvos app: every daemon call is same-origin RPC", () => {
  const rpc = read("lib/rpc.js");
  assert.ok(/fetch\("\/"/.test(rpc), "RPC posts to the daemon's own origin");
  // The panel's biggest cost was 22 process spawns per refresh; the shell must
  // not reintroduce shelling out.
  // Match the module and the concrete spawn helpers, not a bare `exec(` —
  // RegExp.prototype.exec() is everywhere in this code and is not shelling out.
  const SHELL_OUT = /child_process|execSync|spawnSync|execFileSync|\bexecFile\s*\(|\bspawn\s*\(/;
  for (const f of ["app.js", "lib/ui.js", "views/wallet.js", "views/money.js", "views/social.js", "views/apps.js", "views/work.js", "views/inscribe.js", "views/twetch.js", "views/setup.js", "views/index.js"]) {
    assert.ok(!SHELL_OUT.test(read(f)), `${f} does not shell out`);
  }
});

test("bsvos app: macOS replaces the four panel-only mechanisms", () => {
  const ui = read("lib/ui.js");
  const notify = read("lib/notify.js");
  // wl-copy -> clipboard API
  assert.ok(/navigator\.clipboard\.writeText/.test(ui), "clipboard replaces wl-copy");
  // xdg-open -> window.open
  assert.ok(/window\.open/.test(ui), "window.open replaces xdg-open");
  // Qt FileDialog -> <input type=file>, hashed in the browser
  assert.ok(/input\.type = "file"/.test(ui), "file picker");
  assert.ok(/crypto\.subtle\.digest\("SHA-256"/.test(ui), "file hashed in the browser");
  const apps = read("views/apps.js");
  assert.ok(/anchorFile/.test(apps), "digest goes to the anchorFile RPC (never a disk path)");
  assert.ok(!/torrentShare/.test(read("views/work.js")), "no disk-path seeding from a browser");
  // The bar pill's auto-summon becomes a real notification.
  assert.ok(/new Notification\(/.test(notify), "macOS notifications");
  assert.ok(/policyPending/.test(notify), "watches spend requests");
});

test("bsvos app: spends are confirmed and policy errors are explained", () => {
  const common = read("views/common.js");
  const rpc = read("lib/rpc.js");
  assert.ok(/confirmSpend/.test(common), "spends pass a confirmation");
  assert.ok(/Confirm spend/.test(common), "confirmation names the amount and destination");
  // The panel could only say "see the terminal"; the shell maps real codes.
  for (const code of ["WALLET_LOCKED", "NO_WALLET", "POLICY_DENY", "RUNNER_UNAVAILABLE"]) {
    assert.ok(new RegExp(code).test(rpc), `${code} is explained`);
  }
  assert.ok(!/see the terminal/i.test([common, rpc, read("app.js")].join("\n")), "no 'see the terminal' dead ends");
});

test("bsvos app: every import specifier resolves inside the bundle", () => {
  // A module that imports a path the daemon does not serve is a blank page
  // with no error anywhere — the worst failure mode this app has. Walk the
  // real import graph instead of trusting that the files exist.
  const files = [
    "app.js", "lib/rpc.js", "lib/ui.js", "lib/notify.js",
    "views/common.js", "views/wallet.js", "views/money.js",
    "views/social.js", "views/apps.js", "views/work.js", "views/inscribe.js", "views/twetch.js", "views/setup.js", "views/index.js",
  ];
  const seen = new Set();
  const queue = [...files];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = path.join(appDir, rel);
    assert.ok(fs.existsSync(file), `${rel} exists`);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      assert.ok(!/^https?:\/\//.test(spec), `${rel} must not import a remote module (${spec})`);
      const target = path.normalize(path.join(path.dirname(rel), spec));
      assert.ok(fs.existsSync(path.join(appDir, target)), `${rel} imports ${spec} -> ${target}, which does not exist`);
      queue.push(target);
    }
    // Dynamic imports too.
    for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = path.normalize(path.join(path.dirname(rel), m[1]));
      assert.ok(fs.existsSync(path.join(appDir, target)), `${rel} dynamically imports ${m[1]} -> ${target}, missing`);
    }
  }
  // Everything reachable from app.js is accounted for.
  assert.equal(seen.size, 14, `all 14 modules reachable, saw ${seen.size}`);
});

test("bsvos app: the daemon serves every file the page can request", async () => {
  // resolveRunnerAppFile must be able to serve each path the browser will
  // ask for, including the nested lib/ and views/ directories.
  const { resolveRunnerAppFile } = await import("../src/apps.ts");
  for (const rel of [
    "/", "/app.js", "/styles.css", "/manifest.json",
    "/lib/rpc.js", "/lib/ui.js", "/lib/notify.js",
    "/views/common.js", "/views/wallet.js", "/views/money.js",
    "/views/social.js", "/views/apps.js", "/views/work.js",
  ]) {
    const asset = resolveRunnerAppFile(appDir, rel);
    assert.ok(asset, `${rel} is servable`);
    assert.match(asset.mime, /javascript|css|html|json/, `${rel} has a real mime (${asset.mime})`);
  }
  // And traversal is still refused.
  assert.equal(resolveRunnerAppFile(appDir, "/../../../etc/passwd"), null, "traversal refused");
});

test("bsvos app: OIDC setup is possible in-app, and never exposes a secret", () => {
  const social = read("views/social.js");
  const rpc = read("lib/rpc.js");
  // A public PKCE client id is not a secret, so the shell configures it.
  // Before this the only route was `bsv login --client-id=…` in a terminal,
  // which is where the panel dead-ended.
  assert.ok(/identityConfigure/.test(social), "setup persists via identityConfigure");
  assert.ok(/data-form="oidc"/.test(social), "setup form is rendered");
  assert.ok(/identityConfigStatus/.test(social), "setup state is detected, not guessed");
  // The secret must never round-trip through a page.
  assert.ok(!/clientSecret/.test(social), "no client secret field in the UI");
  const src = fs.readFileSync(path.resolve(here, "../src/rpc.ts"), "utf8");
  const status = /identityConfigStatus: async \(\) => \{([\s\S]*?)\n  \},/.exec(src);
  assert.ok(status, "identityConfigStatus handler found");
  assert.ok(!/clientSecret: c\.clientSecret/.test(status[1]), "secret is not returned");
  assert.ok(/hasSecret: Boolean\(c\.clientSecret\)/.test(status[1]), "secret is reduced to a boolean");
  // The exact callback the issuer console must be given.
  assert.ok(/http:\/\/127\.0\.0\.1:\$\{port\}\/callback/.test(social), "callback URL is shown");
  assert.ok(/SETUP_REQUIRED/.test(rpc), "SETUP_REQUIRED is explained, not dumped raw");
});

test("store catalog: every bundled app gets its own entry, localhost stays shared", () => {
  const catalog = readCatalog();
  // Identities are host + directory (variants): the bundled apps share the
  // localhost host at different paths, so domains repeat but paths must not.
  const keys = catalog.apps.map((a) => `${a.domain}${a.url ? new URL(a.url).pathname : "/"}`);
  assert.equal(new Set(keys).size, keys.length, "catalog identities are unique");
  const shell = catalog.apps.find((a) => a.domain === "127.0.0.1");
  assert.ok(shell, "bsvOS is catalogued");
  assert.equal(shell.name, "bsvOS");
  assert.equal(shell.url, "https://127.0.0.1:2121/bsvos/", "and installs from its own URL");
  const shared = catalog.apps.filter((a) => a.domain === "localhost");
  assert.deepEqual(
    shared.map((a) => a.name).sort(),
    ["Cast", "Ordinal Colosseum", "Twetch", "bsvOS Explorer"],
    "all four shared-slot apps are catalogued",
  );
  for (const app of shared) {
    assert.ok(/shares the localhost identity/i.test(app.blurb), `${app.name} documents the shared slot`);
    assert.ok(app.url && /^https:\/\/localhost:2121\/\w+\/$/.test(app.url), `${app.name} has its own path URL`);
  }
});
