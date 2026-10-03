// Repair the duration fields MediaRecorder leaves at zero.
//
// Safari (and Chrome 126+) record into a fragmented MP4 whose `ftyp`/`moov`
// come first but whose `mvhd`, `tkhd`, `mdhd` and `mehd` durations are all 0.
// Players then show 0:00, refuse to start, or disable seeking — WebKit bug
// 216832; see addpipe's "Duration in MP4 Files Produced by Chrome/Safari".
// There is no on-device transcoder on the phone, so the browser that knows the
// wall-clock length (it just recorded it) writes it into the boxes.
//
// A classic script on purpose: cast/app.js is served as a plain `<script>`, so
// a bare `import` here would be a syntax error in the page (the daemon's bundle
// test has a parse gate because that happened once). The API is exposed as
// `window.CastMp4`. Pure and dependency-free: bytes in, bytes out; only zero
// durations are touched, 32- and 64-bit box versions are both handled, and
// anything unrecognised is returned unchanged.
(function (global) {
  "use strict";

  const u32 = (view, offset) => view.getUint32(offset);
  const u64 = (view, offset) => Number(view.getBigUint64(offset));

  /** Iterate the boxes that lie between `start` and `end`. */
  function* boxes(bytes, view, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        size = Number(view.getBigUint64(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return;
      yield { start: offset, end: offset + size, payloadStart: offset + header, type };
      offset += size;
    }
  }

  function findBox(bytes, view, start, end, name) {
    for (const box of boxes(bytes, view, start, end)) {
      if (box.type === name) return box;
    }
    return null;
  }

  /** Patch a full-box duration field, but only when it is still zero. */
  function patchDuration(bytes, view, box, offsetV1, offsetV0, value, width) {
    const version = bytes[box.start + 8];
    const offset = box.start + (version === 1 ? offsetV1 : offsetV0);
    const current = width === 8 ? u64(view, offset) : u32(view, offset);
    if (current !== 0 || !(value > 0)) return false;
    if (width === 8) {
      view.setBigUint64(offset, BigInt(Math.round(value)));
    } else {
      view.setUint32(offset, Math.min(value, 0xffffffff));
    }
    return true;
  }

  /**
   * Return a copy of `input` (ArrayBuffer/TypedArray) with the movie duration
   * filled in, or the input bytes unchanged when there is nothing to patch.
   * `durationMs` is the wall-clock recording length.
   */
  function fixMp4Duration(input, durationMs) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const bytes = new Uint8Array(source); // copy: never mutate the caller's view
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moov = findBox(bytes, view, 0, bytes.length, "moov");
    if (!moov) return bytes;
    const mvhd = findBox(bytes, view, moov.payloadStart, moov.end, "mvhd");
    if (!mvhd) return bytes;

    const movieVersion = bytes[mvhd.start + 8];
    const movieTimescale = movieVersion === 1
      ? u32(view, mvhd.start + 28)
      : u32(view, mvhd.start + 20);
    if (!(movieTimescale > 0)) return bytes;
    const movieDuration = Math.round((durationMs * movieTimescale) / 1000);

    patchDuration(bytes, view, mvhd, 32, 24, movieDuration, movieVersion === 1 ? 8 : 4);

    for (const box of boxes(bytes, view, moov.payloadStart, moov.end)) {
      if (box.type === "trak") {
        const tkhd = findBox(bytes, view, box.payloadStart, box.end, "tkhd");
        if (tkhd) {
          const version = bytes[tkhd.start + 8];
          patchDuration(bytes, view, tkhd, 36, 28, movieDuration, version === 1 ? 8 : 4);
        }
        const mdia = findBox(bytes, view, box.payloadStart, box.end, "mdia");
        if (mdia) {
          const mdhd = findBox(bytes, view, mdia.payloadStart, mdia.end, "mdhd");
          if (mdhd) {
            const version = bytes[mdhd.start + 8];
            const timescale = version === 1 ? u32(view, mdhd.start + 28) : u32(view, mdhd.start + 20);
            const trackDuration = timescale > 0 ? Math.round((durationMs * timescale) / 1000) : 0;
            patchDuration(bytes, view, mdhd, 32, 24, trackDuration, version === 1 ? 8 : 4);
          }
        }
      }
      if (box.type === "mvex") {
        const mehd = findBox(bytes, view, box.payloadStart, box.end, "mehd");
        if (mehd) {
          const version = bytes[mehd.start + 8];
          patchDuration(bytes, view, mehd, 12, 12, movieDuration, version === 1 ? 8 : 4);
        }
      }
    }
    return bytes;
  }

  /** True when the file looks like an MP4 with a leading moov (MediaRecorder shape). */
  function looksLikeMp4(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 12) return false;
    return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp";
  }

  /**
   * What the recording actually contains, so the recorder panel can state
   * facts instead of implying success: fragment count, media bytes, and which
   * duration fields were left at zero. Never throws; unreadable input reports
   * itself as such.
   */
  function inspectMp4(input) {
    const facts = { readable: false, fragments: 0, mediaBytes: 0, mvhdZero: null, tkhdZero: null, mdhdZero: null, hasMehd: null };
    try {
      const source = input instanceof Uint8Array ? input : new Uint8Array(input);
      const bytes = new Uint8Array(source);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      facts.readable = looksLikeMp4(bytes);
      if (!facts.readable) return facts;
      const moov = findBox(bytes, view, 0, bytes.length, "moov");
      if (moov) {
        const mvhd = findBox(bytes, view, moov.payloadStart, moov.end, "mvhd");
        if (mvhd) {
          const version = bytes[mvhd.start + 8];
          facts.mvhdZero = (version === 1 ? u64(view, mvhd.start + 32) : u32(view, mvhd.start + 24)) === 0;
        }
        for (const box of boxes(bytes, view, moov.payloadStart, moov.end)) {
          if (box.type === "trak") {
            const tkhd = findBox(bytes, view, box.payloadStart, box.end, "tkhd");
            if (tkhd) {
              const version = bytes[tkhd.start + 8];
              const zero = (version === 1 ? u64(view, tkhd.start + 36) : u32(view, tkhd.start + 28)) === 0;
              facts.tkhdZero = facts.tkhdZero === null ? zero : facts.tkhdZero && zero;
            }
            const mdia = findBox(bytes, view, box.payloadStart, box.end, "mdia");
            const mdhd = mdia ? findBox(bytes, view, mdia.payloadStart, mdia.end, "mdhd") : null;
            if (mdhd) {
              const version = bytes[mdhd.start + 8];
              const zero = (version === 1 ? u64(view, mdhd.start + 32) : u32(view, mdhd.start + 24)) === 0;
              facts.mdhdZero = facts.mdhdZero === null ? zero : facts.mdhdZero && zero;
            }
          }
          if (box.type === "mvex") {
            facts.hasMehd = !!findBox(bytes, view, box.payloadStart, box.end, "mehd");
          }
        }
      }
      for (const box of boxes(bytes, view, 0, bytes.length)) {
        if (box.type === "moof") facts.fragments += 1;
        if (box.type === "mdat") facts.mediaBytes += box.end - box.payloadStart;
      }
      return facts;
    } catch {
      return facts;
    }
  }

  global.CastMp4 = Object.freeze({ fixMp4Duration, looksLikeMp4, inspectMp4 });
})(typeof window !== "undefined" ? window : globalThis);
