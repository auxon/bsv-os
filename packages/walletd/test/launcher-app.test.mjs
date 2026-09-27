import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../src/apps.ts";
import { readCatalog } from "../src/apps.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner/apps/launcher");

test("launcher app: bundle files exist", () => {
  for (const f of ["index.html", "app.js", "styles.css", "manifest.json"]) {
    assert.ok(fs.existsSync(path.join(appDir, f)), `${f} present`);
  }
});

test("launcher app: manifest validates on its own 127.0.0.1 slot", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8"));
  // The Launcher must NOT claim localhost: that slot rotates between the
  // bundled feature apps, and a system launcher that gets evicted by them
  // would be useless. 127.0.0.1 is the daemon's other loopback identity.
  const v = validateManifest("127.0.0.1", raw);
  assert.equal(v.name, "bsvOS Launcher");
  assert.equal(v.startUrl, "https://127.0.0.1:2121/launcher/");
  // Read-only: the launcher opens and installs apps, it never spends.
  assert.equal(v.spendCapSats, 0);

  // start_url must not escape its own host (validateManifest enforces this).
  assert.throws(() => validateManifest("localhost", raw), /escapes the app origin/);
});

test("launcher app: served by the daemon on both loopback identities", async () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
    "utf8",
  );
  const m = /const RUNNER_APPS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "RUNNER_APPS set found");
  const names = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  assert.ok(names.includes("launcher"), "launcher is served by the daemon");
});

test("launcher app: no remote code and no key material", () => {
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  // Parse gate: a syntax error kills the page silently.
  assert.doesNotThrow(() => new Function(js), "app.js must parse");

  for (const src of [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(!/^https?:\/\//i.test(src), `remote script: ${src}`);
  }
  for (const href of [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(!/^https?:\/\//i.test(href), `remote stylesheet: ${href}`);
  }
  // Same-origin RPC only (the page is served by the daemon itself).
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(js), "no third-party origins");
  assert.ok(!/WIF|privateKey|mnemonic|seed phrase|identityKey/i.test(js), "no key material");
});

test("launcher app: lists, installs and opens apps over the daemon RPC", () => {
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  for (const token of ["appList", "storeList", "appInstall", "appRemove", "appLaunch", "isAuthenticated"]) {
    assert.ok(js.includes(token), token);
  }
  // Open must go through the daemon so the window gets the window.bsv
  // bridge; a bare window.open would silently lose wallet access.
  assert.ok(js.includes('rpc("appLaunch"'), "open goes through appLaunch");
  // …and must fall back rather than dead-end when no runner exists.
  assert.ok(js.includes("window.open"), "browser fallback when the runner is unavailable");
  // The launcher is a same-origin daemon app, so it drives the RPC itself
  // rather than through window.bsv.
  assert.ok(js.includes('fetch("/"'), "same-origin RPC");
});

test("store catalog: launcher owns 127.0.0.1 and localhost stays shared", () => {
  const catalog = readCatalog();
  const domains = catalog.apps.map((a) => a.domain);
  assert.equal(new Set(domains).size, domains.length, "catalog domains are unique");

  const launcher = catalog.apps.find((a) => a.domain === "127.0.0.1");
  assert.ok(launcher, "launcher is catalogued");
  assert.equal(launcher.name, "bsvOS Launcher");

  // The localhost blurb must warn that the bundled feature apps share it,
  // otherwise installing one looks like it deleted the others.
  const shared = catalog.apps.find((a) => a.domain === "localhost");
  assert.ok(shared && /share this one localhost slot/.test(shared.blurb), "localhost slot is documented as shared");
});
