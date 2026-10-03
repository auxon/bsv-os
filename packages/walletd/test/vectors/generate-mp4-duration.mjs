// MP4 duration-repair vectors for the Swift port.
//
// The page runs `cast/mp4.js`; the server re-runs the same repair on upload
// with the recorder's wall-clock length. The Swift must produce the same bytes
// as the page, so the expected outputs come from the page's own patcher,
// applied to synthetic fragmented MP4s in Safari's box layout.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { sampleFile } from "./fmp4-fixtures.mjs";

const source = readFileSync(new URL("../../../runner/apps/cast/mp4.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const { fixMp4Duration } = context.CastMp4;

const hex = (bytes) => Buffer.from(bytes).toString("hex");

const cases = [
  { name: "v0 zeros", input: sampleFile(), durationMs: 5_000 },
  { name: "v1 zeros", input: sampleFile({ version: 1, movieTimescale: 1_000 }), durationMs: 2_500 },
  {
    name: "already dated",
    input: sampleFile({ movieDuration: 3_000, trackDuration: 3_000, mediaDuration: 240_000, fragmentDuration: 3_000 }),
    durationMs: 5_000,
  },
  { name: "no moov", input: sampleFile({ withMoov: false }), durationMs: 5_000 },
  { name: "zero duration", input: sampleFile(), durationMs: 0 },
];

const out = cases.map((c) => ({
  name: c.name,
  inputHex: hex(c.input),
  durationMs: c.durationMs,
  expectedHex: hex(fixMp4Duration(c.input, c.durationMs)),
}));

console.log(JSON.stringify(out, null, 2));
