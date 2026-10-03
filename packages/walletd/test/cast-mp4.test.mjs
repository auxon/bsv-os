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

// The recorder helper is a classic script (cast/app.js is a plain <script>,
// so it cannot import), exposing window.CastMp4. Load it the way the page
// does: run the source and read the global.
const helperSource = readFileSync(new URL("../../runner/apps/cast/mp4.js", import.meta.url), "utf8");
const helperContext = vm.createContext({});
vm.runInContext(helperSource, helperContext);
const { fixMp4Duration, looksLikeMp4 } = helperContext.CastMp4;

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const box = (type, payload) => {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
};

/** Payload = version/flags + fields, as a full box. */
const full = (version, fields) => concat(new Uint8Array([version, 0, 0, 0]), fields);

const mvhd = (version, timescale, duration) => {
  const head = new Uint8Array(version === 1 ? 28 : 16);
  const view = new DataView(head.buffer);
  const at = version === 1 ? 16 : 8;
  view.setUint32(at, timescale);
  if (version === 1) view.setBigUint64(at + 4, BigInt(duration));
  else view.setUint32(at + 4, duration);
  return box("mvhd", full(version, concat(head, new Uint8Array(80))));
};

const tkhd = (version, duration) => {
  // Fields after version/flags: v0 creation 4, modification 4, track_id 4,
  // reserved 4, duration 4; v1 creation 8, modification 8, track_id 4,
  // reserved 4, duration 8.
  const head = new Uint8Array(version === 1 ? 32 : 20);
  const view = new DataView(head.buffer);
  if (version === 1) view.setBigUint64(20, BigInt(duration));
  else view.setUint32(16, duration);
  return box("tkhd", full(version, head));
};

const mdhd = (version, timescale, duration) => {
  const head = new Uint8Array(version === 1 ? 28 : 16);
  const view = new DataView(head.buffer);
  const at = version === 1 ? 16 : 8;
  view.setUint32(at, timescale);
  if (version === 1) view.setBigUint64(at + 4, BigInt(duration));
  else view.setUint32(at + 4, duration);
  return box("mdhd", full(version, concat(head, new Uint8Array(4))));
};

const mehd = (version, duration) => {
  const head = new Uint8Array(version === 1 ? 8 : 4);
  const view = new DataView(head.buffer);
  if (version === 1) view.setBigUint64(0, BigInt(duration));
  else view.setUint32(0, duration);
  return box("mehd", full(version, head));
};

function sampleFile({ version = 0, movieTimescale = 600, movieDuration = 0, trackDuration = 0, mediaDuration = 0, fragmentDuration = 0, withMoov = true } = {}) {
  const parts = [box("ftyp", new TextEncoder().encode("iso5isomhlsf"))];
  if (withMoov) {
    parts.push(box("moov", concat(
      mvhd(version, movieTimescale, movieDuration),
      box("trak", concat(
        tkhd(version, trackDuration),
        box("mdia", mdhd(version, 48_000, mediaDuration)),
      )),
      box("mvex", mehd(version, fragmentDuration)),
    )));
  }
  parts.push(box("moof", new Uint8Array([1, 2, 3, 4])));
  parts.push(box("mdat", new Uint8Array(16)));
  return concat(...parts);
}

/** Independent reader: walk boxes and read one duration field. */
function readDuration(bytes, path, version) {
  const find = (start, end, name) => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (size < 8 || offset + size > end) return null;
      if (type === name) return { start: offset, end: offset + size, payload: offset + 8 };
      offset += size;
    }
    return null;
  };
  let current = { start: 0, end: bytes.length, payload: 0 };
  for (const name of path) {
    const found = find(current.payload, current.end, name);
    if (!found) return null;
    current = found;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (path.at(-1) === "mehd") return version === 1 ? Number(view.getBigUint64(current.start + 12)) : view.getUint32(current.start + 12);
  if (path.at(-1) === "tkhd") return version === 1 ? Number(view.getBigUint64(current.start + 36)) : view.getUint32(current.start + 28);
  return version === 1 ? Number(view.getBigUint64(current.start + 32)) : view.getUint32(current.start + 24);
}

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
