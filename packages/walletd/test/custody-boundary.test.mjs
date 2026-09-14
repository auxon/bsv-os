import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Custody boundary: raw key material may only appear inside src/custody.ts.
 * Everything else talks intents (descriptions, outpoints, scripts) — never keys.
 */
test("no raw key material outside custody.ts", () => {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rnEi", "fromWif|PrivateKey\\.fromHex|mnemonic|seed phrase|bip39|\\bxprv\\b|BEGIN.*PRIVATE", root, "--include=*.ts"],
      { encoding: "utf8" },
    ).trim();
  } catch (err) {
    // grep exits 1 when nothing matches — exactly what we want
    if (err?.status !== 1) throw err;
  }
  const offenders = out
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.includes("src/custody.ts"));
  assert.deepEqual(offenders, [], `key material outside custody.ts:\n${offenders.join("\n")}`);
});
