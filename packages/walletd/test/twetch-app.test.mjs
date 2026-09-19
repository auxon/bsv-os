import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../src/apps.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner/apps/twetch");

test("twetch app: bundle files exist", () => {
  for (const f of ["index.html", "app.js", "styles.css", "manifest.json"]) {
    assert.ok(fs.existsSync(path.join(appDir, f)), `${f} present`);
  }
});

test("twetch app: manifest validates for the localhost domain", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8"));
  const v = validateManifest("localhost", raw);
  assert.equal(v.name, "Twetch");
  assert.equal(v.startUrl, "https://localhost:2121/twetch/");
  assert.equal(v.spendCapSats, 100000000);
});

test("twetch app: page has no key material and calls same-origin rpc only", () => {
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(js.includes("twetchFeed") && js.includes("twetchPost") && js.includes("twetchStatus"));
  assert.ok(!/https?:\/\/(?!(?:api\.)?twetch\.com|media\.ordinalswallet\.com|atomic-market\.richard-hein\.workers\.dev|localhost|127\.0\.0\.1)/.test(js));
  assert.ok(!/WIF|privateKey|accessToken|idToken/i.test(js));
});

test("twetch app: meme library tab and endpoints are wired", () => {
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(html.includes('data-tab="memes"'));
  assert.ok(html.includes('id="meme-grid"'));
  assert.ok(js.includes("twetchMemes") && js.includes("twetchMemeFolders"));
});

test("twetch app: market tab and endpoints are wired", () => {
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(html.includes('data-tab="market"'));
  assert.ok(html.includes('id="market-grid"'));
  assert.ok(js.includes("twetchMarket"));
});

test("twetch app: market buys and sells route through the daemon", () => {
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(js.includes("twetchBuy") && js.includes("twetchList"));
  assert.ok(js.includes("MARKET_WORKER") && js.includes("marketOffer"));
  assert.ok(html.includes('id="sell-go"') && html.includes('id="sell-outpoint"'));
  assert.ok(js.includes("POLICY_DENY") && js.includes("bsv allow twetch"));
});

test("twetch app: profile overlay is wired to post heads and notifications", () => {
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(html.includes('id="profile"') && html.includes('id="profile-posts"'));
  assert.ok(js.includes("twetchUser") && js.includes("openProfile(post.userId)") && js.includes("openProfile(n.actorUserId)"));
});

test("twetch app: media resolver covers both icon shapes (b:// and relative)", () => {
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(js.includes("api.twetch.com/v1/media/"));
  assert.ok(js.includes("media.ordinalswallet.com/"));
  assert.ok(js.includes("avatarEl(post.user)"));
});
