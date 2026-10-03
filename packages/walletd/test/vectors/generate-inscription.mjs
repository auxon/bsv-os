// Inscription envelope vectors (item 3, first step).
//
// Uses the daemon's own `inscriptionScript` from tokens.ts, so the Swift port
// is pinned to the bytes the daemon would put on chain — including the push
// encoding at the 75/255 byte boundaries, which is exactly where a hand-written
// port goes wrong.
import { writeFileSync } from "node:fs";
import { hasOrdEnvelope, inscriptionScript } from "../../src/tokens.ts";
import { p2pkhScript } from "../../src/tx.ts";

const OWNER = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA";

// Push boundaries: <=75 direct, <=255 OP_PUSHDATA1, larger OP_PUSHDATA2.
const cases = [
  { name: "small text", contentType: "text/plain", dataHex: Buffer.from("hello ord").toString("hex") },
  { name: "75-byte data", contentType: "text/plain", dataHex: "61".repeat(75) },
  { name: "76-byte data (PUSHDATA1)", contentType: "text/plain", dataHex: "62".repeat(76) },
  { name: "300-byte data (PUSHDATA2)", contentType: "application/octet-stream", dataHex: "63".repeat(300) },
  { name: "image content type", contentType: "image/png", dataHex: "89504e470d0a1a0a" },
];

const vectors = cases.map((testCase) => ({
  name: testCase.name,
  owner: OWNER,
  contentType: testCase.contentType,
  dataHex: testCase.dataHex,
  scriptHex: inscriptionScript(OWNER, testCase.contentType, testCase.dataHex),
}));

// The carrier check the funding selector uses. Its own edge cases: a plain
// P2PKH is not a carrier, a mutated tag is not a carrier, and a mutated OP_1
// after the tag is not either.
const plain = inscriptionScript(OWNER, "text/plain", "6869");
const mutatedTag = plain.replace("6f7264", "78797a"); // "ord" -> "xyz"
const seed = inscriptionScript(OWNER, "text/plain", "6869");
const opIndex = seed.indexOf("51", seed.indexOf("6f7264") + 6);
const mutatedOp = seed.slice(0, opIndex) + "52" + seed.slice(opIndex + 2);
const envelopeCases = [
  { name: "each inscription script is a carrier", scriptHex: null, check: "each" },
  { name: "plain P2PKH is not", scriptHex: p2pkhScript(OWNER).toHex() },
  { name: "empty is not", scriptHex: "" },
  { name: "garbage is not", scriptHex: "zz" },
  { name: "a mutated tag is not", scriptHex: mutatedTag },
  { name: "a mutated OP_1 is not", scriptHex: mutatedOp },
  { name: "a truncated carrier is not", scriptHex: plain.slice(0, 20) },
];
const resolved = [];
for (const vector of vectors) {
  resolved.push({ name: `carrier: ${vector.name}`, scriptHex: vector.scriptHex, hasEnvelope: hasOrdEnvelope(vector.scriptHex) });
}
let each = true;
for (const vector of vectors) each = each && hasOrdEnvelope(vector.scriptHex);
for (const testCase of envelopeCases) {
  if (testCase.check === "each") {
    resolved.push({ name: testCase.name, scriptHex: vectors[0].scriptHex, hasEnvelope: each });
    continue;
  }
  resolved.push({ name: testCase.name, scriptHex: testCase.scriptHex, hasEnvelope: hasOrdEnvelope(testCase.scriptHex) });
}

writeFileSync(
  new URL("./inscription-vectors.json", import.meta.url),
  JSON.stringify({ generatedBy: "generate-inscription.mjs", vectors, envelopeCases: resolved }, null, 2) + "\n",
);
for (const vector of vectors) {
  console.log(`  ${vector.name.padEnd(30)} ${vector.scriptHex.length / 2} bytes`);
}
