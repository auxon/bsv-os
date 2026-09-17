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
  assert.equal(v.spendCapSats, 20000);
});

test("twetch app: page has no key material and calls same-origin rpc only", () => {
  const js = fs.readFileSync(path.join(appDir, "app.js"), "utf8");
  assert.ok(js.includes("twetchFeed") && js.includes("twetchPost") && js.includes("twetchStatus"));
  assert.ok(!/https?:\/\/(?!twetch\.com|localhost|127\.0\.0\.1)/.test(js.replace(/fragment|printable/g, "")));
  assert.ok(!/WIF|privateKey|accessToken|idToken/i.test(js));
});
