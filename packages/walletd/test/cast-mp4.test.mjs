// The Cast recorder's MP4 duration repair.
//
// Safari (and Chrome 126+) record fragmented MP4s whose mvhd/tkhd/mdhd/mehd
// durations are zero: players show 0:00 and often refuse to start (WebKit
// 216832). The browser knows the wall-clock length and patches the boxes before
// preview and upload; these tests build synthetic fragmented MP4s with the
// exact box layout Safari produces and check the fields the phone writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { sampleFile, readDuration } from "./vectors/fmp4-fixtures.mjs";

// The recorder helper is a classic script (cast/app.js is a plain <script>,
// so it cannot import), exposing window.CastMp4. Load it the way the page
// does: run the source and read the global.
const helperSource = readFileSync(new URL("../../runner/apps/cast/mp4.js", import.meta.url), "utf8");
const helperContext = vm.createContext({});
vm.runInContext(helperSource, helperContext);
const { fixMp4Duration, looksLikeMp4 } = helperContext.CastMp4;

test("a 32-bit fragmented MP4 gets its zero durations filled from wall time", () => {
  const original = sampleFile();
  assert.equal(looksLikeMp4(original), true);
  const fixed = fixMp4Duration(original, 5_000);
  assert.equal(fixed.length, original.length, "no bytes added or removed");

  assert.equal(readDuration(fixed, ["moov", "mvhd"], 0), 3_000, "5s at timescale 600");
  assert.equal(readDuration(fixed, ["moov", "trak", "tkhd"], 0), 3_000, "movie timescale");
  assert.equal(readDuration(fixed, ["moov", "trak", "mdia", "mdhd"], 0), 240_000, "5s at 48kHz");
  assert.equal(readDuration(fixed, ["moov", "mvex", "mehd"], 0), 3_000);

  // Untouched regions survive byte for byte (the parser offsets are exact).
  assert.equal(fixed[original.length - 20], original[original.length - 20]);
  assert.equal(String.fromCharCode(fixed[4], fixed[5], fixed[6], fixed[7]), "ftyp");
});

test("64-bit boxes are patched too", () => {
  const fixed = fixMp4Duration(sampleFile({ version: 1, movieTimescale: 1_000 }), 2_500);
  assert.equal(readDuration(fixed, ["moov", "mvhd"], 1), 2_500);
  assert.equal(readDuration(fixed, ["moov", "trak", "tkhd"], 1), 2_500);
  assert.equal(readDuration(fixed, ["moov", "trak", "mdia", "mdhd"], 1), 120_000, "2.5s at 48kHz");
  assert.equal(readDuration(fixed, ["moov", "mvex", "mehd"], 1), 2_500);
});

test("a file that already has a duration is left alone", () => {
  const original = sampleFile({ movieDuration: 3_000, trackDuration: 3_000, mediaDuration: 240_000, fragmentDuration: 3_000 });
  const fixed = fixMp4Duration(original, 5_000);
  assert.deepEqual(Array.from(fixed), Array.from(original), "not a byte changes");
});

test("inspection reports the boxes the recorder panel shows", () => {
  const { inspectMp4 } = helperContext.CastMp4;
  const zero = inspectMp4(sampleFile());
  assert.equal(zero.readable, true);
  assert.equal(zero.fragments, 1);
  assert.ok(zero.mediaBytes >= 16, "the mdat body counts");
  assert.equal(zero.mvhdZero, true);
  assert.equal(zero.tkhdZero, true);
  assert.equal(zero.mdhdZero, true);
  assert.equal(zero.hasMehd, true, "the synthetic layout includes mehd");

  const dated = inspectMp4(sampleFile({ movieDuration: 3_000, trackDuration: 3_000, mediaDuration: 240_000, fragmentDuration: 3_000 }));
  assert.equal(dated.mvhdZero, false);
  assert.equal(dated.tkhdZero, false);
  assert.equal(dated.mdhdZero, false);

  const noMoov = inspectMp4(sampleFile({ withMoov: false }));
  assert.equal(noMoov.fragments, 1);
  assert.equal(noMoov.mvhdZero, null, "nothing to read, nothing claimed");
  assert.equal(inspectMp4(new Uint8Array([1, 2, 3])).readable, false);
});

test("nonsense input is returned unchanged", () => {
  const noMoov = sampleFile({ withMoov: false });
  assert.deepEqual(Array.from(fixMp4Duration(noMoov, 5_000)), Array.from(noMoov));
  const garbage = new Uint8Array([1, 2, 3]);
  assert.deepEqual(Array.from(fixMp4Duration(garbage, 5_000)), Array.from(garbage));
  assert.equal(looksLikeMp4(garbage), false);
  // A zero-length recording patches nothing rather than writing zeroes.
  const zero = sampleFile();
  assert.deepEqual(Array.from(fixMp4Duration(zero, 0)), Array.from(zero));
});
