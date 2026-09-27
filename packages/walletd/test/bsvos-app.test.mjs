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
  for (const f of ["views/common.js", "views/wallet.js", "views/money.js", "views/social.js", "views/apps.js", "views/work.js"]) {
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

test("bsvos app: every module parses and nothing loads remotely", () => {
  const files = [
    "app.js", "lib/rpc.js", "lib/ui.js", "lib/notify.js",
    "views/common.js", "views/wallet.js", "views/money.js",
    "views/social.js", "views/apps.js", "views/work.js",
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
  const files = ["app.js", "lib/rpc.js", "lib/ui.js", "lib/notify.js", "views/wallet.js", "views/money.js", "views/social.js", "views/apps.js", "views/work.js"];
  for (const f of files) {
    const src = read(f);
    assert.ok(!/WIF\b|privateKey|mnemonic|seed phrase|identityKey\s*[:=]\s*["']/.test(src), `${f} has no key material`);
  }
});

test("bsvos app: covers the whole Quickshell panel surface", () => {
  // The panel had these sections; every one must have a home here. This is the
  // regression guard for "replace the panel entirely".
  const app = read("app.js");
  const all = ["views/wallet.js", "views/money.js", "views/social.js", "views/apps.js", "views/work.js"]
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
});

test("bsvos app: every daemon call is same-origin RPC", () => {
  const rpc = read("lib/rpc.js");
  assert.ok(/fetch\("\/"/.test(rpc), "RPC posts to the daemon's own origin");
  // The panel's biggest cost was 22 process spawns per refresh; the shell must
  // not reintroduce shelling out.
  for (const f of ["app.js", "lib/ui.js", "views/wallet.js", "views/money.js", "views/social.js", "views/apps.js", "views/work.js"]) {
    assert.ok(!/child_process|execSync|spawnSync|\bexec\(/.test(read(f)), `${f} does not shell out`);
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
    "views/social.js", "views/apps.js", "views/work.js",
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
  assert.equal(seen.size, 10, `all 10 modules reachable, saw ${seen.size}`);
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

test("store catalog: bsvOS owns 127.0.0.1 and localhost stays shared", () => {
  const catalog = readCatalog();
  const domains = catalog.apps.map((a) => a.domain);
  assert.equal(new Set(domains).size, domains.length, "catalog domains are unique");
  const shell = catalog.apps.find((a) => a.domain === "127.0.0.1");
  assert.ok(shell, "bsvOS is catalogued");
  assert.equal(shell.name, "bsvOS");
  const shared = catalog.apps.find((a) => a.domain === "localhost");
  assert.ok(shared && /share this one localhost slot/.test(shared.blurb), "localhost slot documented as shared");
});
