import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../src/apps.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner/apps/market");

test("market app: bundle files exist", () => {
  for (const f of ["index.html", "app.js", "styles.css", "manifest.json"]) {
    assert.ok(fs.existsSync(path.join(appDir, f)), `${f} present`);
  }
});

test("market app: manifest validates for the localhost domain", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8"));
  const v = validateManifest("localhost", raw);
  assert.equal(v.name, "Atomic Market");
  assert.equal(v.startUrl, "https://localhost:2121/market/");
  assert.ok(v.spendCapSats > 0);
  assert.deepEqual(v.intents.map((i) => i.action), ["app-spend", "app-swap-offer"]);
});

test("market app: no key material, URLs allowlisted, daemon-only writes", () => {
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(!/https?:\/\/(?!(?:entangleit\.com|localhost|127\.0\.0\.1))/.test(js));
  assert.ok(!/WIF|privateKey|accessToken|idToken/i.test(js));
  assert.ok(js.includes("marketBuy") && js.includes("marketList") && js.includes("bsv21Utxos"));
  assert.ok(js.includes("MARKET_WORKER"));
});

test("market app: browse, buy confirm, and sell flows are wired", () => {
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(html.includes('data-tab="browse"') && html.includes('data-tab="sell"'));
  assert.ok(html.includes('id="grid"') && html.includes('id="ord-list"') && html.includes('id="tok-list"'));
  assert.ok(js.includes("offerFromListing"));
  assert.ok(js.includes("priceSats: fresh.priceSats") && js.includes("sellerAddress: fresh.seller"));
  assert.ok(js.includes("POLICY_DENY") && js.includes("bsv allow market"));
  assert.ok(js.includes("/v1/market/buy") && js.includes("/v1/market/settle") && js.includes("/v1/market/list"));
});

test("market app: atomic buy posts settle with the swap txid", () => {
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(js.includes("transferTxid: res.txid"));
  assert.ok(js.includes("res.atomic"));
});
