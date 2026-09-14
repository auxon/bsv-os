import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..", "..", "runner", "extension");
const read = (f) => fs.readFileSync(path.join(ext, f), "utf8");

test("extension is exactly three local files with a valid MV3 manifest", () => {
  assert.deepEqual(fs.readdirSync(ext).sort(), ["content.js", "manifest.json", "page.js"]);
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts.map((c) => c.matches), [["https://*/*"]]);
  assert.ok(!manifest.permissions?.length, "no extension API permissions needed");
});

test("no remote code, no eval, loopback-only network", () => {
  for (const f of ["content.js", "page.js"]) {
    const src = read(f);
    assert.ok(!/\beval\s*\(/.test(src), `${f}: no eval`);
    assert.ok(!/new\s+Function/.test(src), `${f}: no new Function`);
    assert.ok(!/XMLHttpRequest/.test(src), `${f}: fetch only`);
  }
  const urls = [...read("content.js").matchAll(/https?:\/\/[^\s"'`]+/g)].map((m) => m[0]);
  assert.deepEqual(urls, ["http://127.0.0.1:${port}/invoke"]);
  assert.ok(!/https?:\/\//.test(read("page.js")), "page.js makes no network calls itself");
});

test("page.js exposes the four-intent window.bsv", () => {
  const src = read("page.js");
  for (const m of ["getStatus", "getIdentity", "getBalance", "timestamp"]) {
    assert.ok(src.includes(m), `window.bsv.${m} exists`);
  }
  assert.ok(src.includes("Object.freeze"), "bridge surface is frozen");
  assert.ok(src.includes("isBSVOS"), "pages can detect the runner");
  assert.ok(src.includes("data-bsvos"), "injection leaves a DOM marker for headless tests");
  assert.ok(src.includes("bsv app open"), "outside-runner error points at the runner");
});

test("content script only relays namespaced messages with a numeric id", () => {
  const src = read("content.js");
  assert.ok(src.includes("bsv-os-page") && src.includes("bsv-os-content"));
  assert.ok(src.includes("event.source !== window"), "ignores foreign frames");
  assert.ok(src.includes("chrome.runtime.getURL"), "page script loads from the bundle");
});
