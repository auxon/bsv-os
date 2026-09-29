import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSWER_MAX,
  ASK_BOARD,
  DETAILS_MAX,
  MIN_AMOUNT_SATS,
  TITLE_MAX,
  validateAnswer,
  validateQuestion,
} from "../../runner/apps/askanything/ask.js";
import { readCatalog } from "../src/apps.ts";
import { validateManifest } from "../src/apps.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("client validation mirrors the daemon floor and caps", () => {
  assert.deepEqual(
    validateQuestion({ title: "Why blue?", details: "Sky reasons.", amountSats: 5000 }),
    { title: "Why blue?", details: "Sky reasons.", amountSats: 5000 },
  );
  assert.throws(() => validateQuestion({ title: "", details: "x", amountSats: 5000 }), /title required/);
  assert.throws(() => validateQuestion({ title: "x".repeat(TITLE_MAX + 1), details: "x", amountSats: 5000 }), /cap/);
  assert.throws(() => validateQuestion({ title: "a\nb", details: "x", amountSats: 5000 }), /single line/);
  assert.throws(() => validateQuestion({ title: "x", details: "", amountSats: 5000 }), /details required/);
  assert.throws(() => validateQuestion({ title: "x", details: "x".repeat(DETAILS_MAX + 1), amountSats: 5000 }), /cap/);
  assert.throws(() => validateQuestion({ title: "x", details: "y", amountSats: MIN_AMOUNT_SATS - 1 }), /at least 5000/);
  assert.deepEqual(
    validateAnswer({ text: "Because air.", payTo: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU" }),
    { text: "Because air.", payTo: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU" },
  );
  assert.throws(() => validateAnswer({ text: "", payTo: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU" }), /text required/);
  assert.throws(() => validateAnswer({ text: "x".repeat(ANSWER_MAX + 1), payTo: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU" }), /cap/);
  assert.throws(() => validateAnswer({ text: "x", payTo: "nope" }), /BSV address/);
});

test("askanything manifest validates on the localhost slot", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.resolve(here, "../../runner/apps/askanything/manifest.json"), "utf8"),
  );
  const v = validateManifest("localhost", raw);
  assert.equal(v.name, "AskAnything");
  assert.equal(v.startUrl, "https://localhost:2121/askanything/");
  assert.equal(v.spendCapSats, 1_000_000);
  assert.throws(() => validateManifest("127.0.0.1", raw), /escapes the app origin/);
});

test("the shipped catalog lists AskAnything on its own localhost URL", () => {
  const catalog = readCatalog();
  const entry = catalog.apps.find((a) => a.name === "AskAnything");
  assert.ok(entry, "AskAnything is catalogued");
  assert.equal(entry.domain, "localhost");
  assert.equal(entry.url, "https://localhost:2121/askanything/");
});

test("the daemon serves the askanything app directory", () => {
  const src = fs.readFileSync(path.resolve(here, "../src/index.ts"), "utf8");
  const m = /const RUNNER_APPS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "RUNNER_APPS set found");
  assert.ok(m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).includes("askanything"), "askanything is served");
});
