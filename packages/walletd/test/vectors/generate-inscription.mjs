// Inscription envelope vectors (item 3, first step).
//
// Uses the daemon's own `inscriptionScript` from tokens.ts, so the Swift port
// is pinned to the bytes the daemon would put on chain — including the push
// encoding at the 75/255 byte boundaries, which is exactly where a hand-written
// port goes wrong.
import { writeFileSync } from "node:fs";
import { inscriptionScript } from "../../src/tokens.ts";

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

writeFileSync(
  new URL("./inscription-vectors.json", import.meta.url),
  JSON.stringify({ generatedBy: "generate-inscription.mjs", vectors }, null, 2) + "\n",
);
for (const vector of vectors) {
  console.log(`  ${vector.name.padEnd(30)} ${vector.scriptHex.length / 2} bytes`);
}
