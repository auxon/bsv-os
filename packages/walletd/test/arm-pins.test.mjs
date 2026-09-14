import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "..", "package.json"), "utf8"));
const knownGood = JSON.parse(readFileSync(path.join(root, "..", "scripts", "arm-known-good.json"), "utf8"));

// Native deps must stay exactly pinned to versions with verified
// linux-arm64 prebuilds. Re-verify with: node scripts/check-arm.mjs --write
test("native deps are exactly pinned to ARM-verified versions", () => {
  for (const dep of ["better-sqlite3", "keytar"]) {
    const pinned = pkg.dependencies[dep];
    assert.ok(pinned && !/[\^~]/.test(pinned), `${dep} must be exactly pinned, got ${pinned}`);
    assert.equal(`v${pinned}`, knownGood[dep].tag, `${dep} pin drifted from verified ${knownGood[dep].tag}`);
    assert.equal(knownGood[dep].ok, true);
  }
});
