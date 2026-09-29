import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPORT_TARGET_BYTES,
  MEDIA_MAX_BYTES,
  POST_TEXT_BUDGET,
  estimateFeeSats,
  fitText,
  layoutCaption,
  splitCaption,
  splitParagraph,
} from "../../runner/apps/memestudio/caption.js";
import { readCatalog } from "../src/apps.ts";
import { validateManifest } from "../src/apps.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Proportional stub: deterministic without a canvas.
const stubMeasure = (text, px) => text.length * px * 0.6;

test("splitParagraph wraps words and splits over-long words", () => {
  assert.deepEqual(splitParagraph("hello world", 5), ["hello", "world"]);
  assert.deepEqual(splitParagraph("a bb ccc", 4), ["a bb", "ccc"]);
  assert.deepEqual(splitParagraph("abcdefgh", 3), ["abc", "def", "gh"]);
  assert.deepEqual(splitParagraph("", 10), []);
  assert.deepEqual(splitParagraph("   ", 10), []);
  assert.deepEqual(splitParagraph("one", 10), ["one"]);
});

test("splitCaption keeps explicit lines and drops blanks", () => {
  assert.deepEqual(splitCaption("top\nbottom"), ["top", "bottom"]);
  assert.deepEqual(splitCaption("a\n\nb", 10), ["a", "b"]);
  assert.deepEqual(splitCaption("", 10), []);
  assert.deepEqual(splitCaption("hello world foo", 5), ["hello", "world", "foo"]);
});

test("fitText shrinks until the widest line fits", () => {
  const r = fitText({ lines: ["hello world"], maxWidth: 100, baseSize: 40, minSize: 10, measure: stubMeasure });
  // 11 chars * size * 0.6 <= 100 -> size <= 15.15 -> 14 (steps of 2 from 40).
  assert.equal(r.size, 14);
  assert.deepEqual(r.lines, ["hello world"]);
  assert.equal(r.fits, true);
});

test("fitText floors at minSize and reports a miss", () => {
  const r = fitText({ lines: ["x".repeat(100)], maxWidth: 10, baseSize: 40, minSize: 20, measure: stubMeasure });
  assert.equal(r.size, 20);
  assert.equal(r.fits, false);
});

test("fitText with no lines keeps the base size", () => {
  const r = fitText({ lines: [], maxWidth: 10, baseSize: 40, minSize: 20, measure: stubMeasure });
  assert.deepEqual(r, { size: 40, lines: [], fits: true });
});

test("layoutCaption places top text at the top and bottom text at the bottom", () => {
  const l = layoutCaption({ top: "hi", bottom: "there", width: 500, height: 400, measure: stubMeasure });
  assert.ok(l.size > 0);
  assert.ok(l.top.firstBaselineY > 0 && l.top.firstBaselineY < 200, "top starts near the top");
  assert.ok(l.bottom.lastBaselineY > 200 && l.bottom.lastBaselineY <= 400, "bottom ends near the bottom");
  assert.deepEqual(l.top.lines, ["hi"]);
  assert.deepEqual(l.bottom.lines, ["there"]);
  assert.equal(l.fits, true);
});

test("layoutCaption with empty text yields no lines and no crash", () => {
  const l = layoutCaption({ top: "", bottom: "", width: 500, height: 400, measure: stubMeasure });
  assert.deepEqual(l.top.lines, []);
  assert.deepEqual(l.bottom.lines, []);
  assert.equal(l.top.firstBaselineY, 0);
  assert.equal(l.bottom.lastBaselineY, 0);
});

test("budgets leave room for the media ref and the media cap", () => {
  // The composer appends a b://sha256 ref (~70 chars) to the signed text.
  assert.ok(POST_TEXT_BUDGET + 100 <= 2000, "post text + media ref fits the 2000-byte signed cap");
  assert.ok(EXPORT_TARGET_BYTES < MEDIA_MAX_BYTES, "export target stays under the daemon cap");
  assert.ok(estimateFeeSats(80_000) >= 80_000, "fee estimate never under-promises the bytes");
  assert.equal(estimateFeeSats(0), 1000, "empty export still prices overhead");
});

test("memestudio manifest validates on the localhost slot", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.resolve(here, "../../runner/apps/memestudio/manifest.json"), "utf8"),
  );
  const v = validateManifest("localhost", raw);
  assert.equal(v.name, "Meme Studio");
  assert.equal(v.startUrl, "https://localhost:2121/memestudio/");
  assert.equal(v.spendCapSats, 1_000_000);
  assert.throws(() => validateManifest("127.0.0.1", raw), /escapes the app origin/);
});

test("the shipped catalog lists Meme Studio on its own localhost URL", () => {
  const catalog = readCatalog();
  const entry = catalog.apps.find((a) => a.name === "Meme Studio");
  assert.ok(entry, "Meme Studio is catalogued");
  assert.equal(entry.domain, "localhost");
  assert.equal(entry.url, "https://localhost:2121/memestudio/");
});

test("the daemon serves the memestudio app directory", () => {
  const src = fs.readFileSync(path.resolve(here, "../src/index.ts"), "utf8");
  const m = /const RUNNER_APPS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "RUNNER_APPS set found");
  assert.ok(m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).includes("memestudio"), "memestudio is served");
});
