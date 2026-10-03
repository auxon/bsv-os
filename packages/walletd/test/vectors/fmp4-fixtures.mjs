// Synthetic fragmented MP4s in the exact box layout Safari's MediaRecorder
// produces: ftyp, moov (mvhd, trak{tkhd, mdia{mdhd}}, mvex{mehd}), then
// moof/mdat pairs. Durations start at zero, as the platform writes them
// (WebKit 216832). Shared by the cast-mp4 tests and the duration-vector
// generator.
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const box = (type, payload) => {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
};

/** Payload = version/flags + fields, as a full box. */
export const full = (version, fields) => concat(new Uint8Array([version, 0, 0, 0]), fields);

export const mvhd = (version, timescale, duration) => {
  const head = new Uint8Array(version === 1 ? 28 : 16);
  const view = new DataView(head.buffer);
  const at = version === 1 ? 16 : 8;
  view.setUint32(at, timescale);
  if (version === 1) view.setBigUint64(at + 4, BigInt(duration));
  else view.setUint32(at + 4, duration);
  return box("mvhd", full(version, concat(head, new Uint8Array(80))));
};

export const tkhd = (version, duration) => {
  // Fields after version/flags: v0 creation 4, modification 4, track_id 4,
  // reserved 4, duration 4; v1 creation 8, modification 8, track_id 4,
  // reserved 4, duration 8.
  const head = new Uint8Array(version === 1 ? 32 : 20);
  const view = new DataView(head.buffer);
  if (version === 1) view.setBigUint64(20, BigInt(duration));
  else view.setUint32(16, duration);
  return box("tkhd", full(version, head));
};

export const mdhd = (version, timescale, duration) => {
  const head = new Uint8Array(version === 1 ? 28 : 16);
  const view = new DataView(head.buffer);
  const at = version === 1 ? 16 : 8;
  view.setUint32(at, timescale);
  if (version === 1) view.setBigUint64(at + 4, BigInt(duration));
  else view.setUint32(at + 4, duration);
  return box("mdhd", full(version, concat(head, new Uint8Array(4))));
};

export const mehd = (version, duration) => {
  const head = new Uint8Array(version === 1 ? 8 : 4);
  const view = new DataView(head.buffer);
  if (version === 1) view.setBigUint64(0, BigInt(duration));
  else view.setUint32(0, duration);
  return box("mehd", full(version, head));
};

export function sampleFile({ version = 0, movieTimescale = 600, movieDuration = 0, trackDuration = 0, mediaDuration = 0, fragmentDuration = 0, withMoov = true } = {}) {
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
export function readDuration(bytes, path, version) {
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
