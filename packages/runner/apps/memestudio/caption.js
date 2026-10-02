// Meme caption layout: pure functions, no DOM. Unit-tested from
// packages/walletd/test/memestudio.test.mjs (plain ESM, node --test).
//
// The canvas work (measureText, drawImage, toBlob) lives in app.js and takes
// a measure callback, so every sizing decision here is testable with a stub.

/** Twetch post body budget: the signed text cap is 2000 bytes and the media
 *  ref appended by the composer costs ~70, so captions + commentary stay here. */
export const POST_TEXT_BUDGET = 1900;

/** Daemon-side media ceiling (twetchPost rejects above MEDIA_MAX_BYTES). */
export const MEDIA_MAX_BYTES = 1_000_000;

/** Export target with margin: re-encode smaller rather than flirt with the cap. */
export const EXPORT_TARGET_BYTES = 950_000;

/** Rough fee estimate for a media post: ~1 sat/byte plus tx overhead. */
export function estimateFeeSats(bytes) {
  return Math.max(0, Math.floor(Number(bytes) || 0)) + 1000;
}

/**
 * Two-step spend confirmation: the first press arms ("are you sure, naming
 * the amount"), the second press within the window fires. Pure state, no
 * DOM — the app wires it to the Post button so a ~75k-sat post can never
 * go out on a single stray click. now() is injectable for tests.
 */
export function createPostConfirm({ windowMs = 10000, now = () => Date.now() } = {}) {
  let armedUntil = 0;
  return {
    press() {
      const t = now();
      if (t < armedUntil) {
        armedUntil = 0;
        return "fire";
      }
      armedUntil = t + Math.max(1, windowMs);
      return "arm";
    },
    armed() {
      return now() < armedUntil;
    },
    reset() {
      armedUntil = 0;
    },
  };
}

/**
 * Word-wrap one paragraph to lines of at most maxChars. Over-long words are
 * split hard (URLs, hashes). Returns [] for blank input.
 */
export function splitParagraph(text, maxChars) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const width = Math.max(1, Math.floor(maxChars));
  const lines = [];
  let line = "";
  for (const word of words) {
    let rest = word;
    while (rest.length > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    const next = line ? `${line} ${rest}` : rest;
    if (next.length <= width) {
      line = next;
    } else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Split caption text on explicit newlines, wrap each paragraph, drop blanks.
 * A two-box meme passes top and bottom separately; a single string works too.
 */
export function splitCaption(text, maxChars = 24) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    out.push(...splitParagraph(para, maxChars));
  }
  return out;
}

/**
 * Shrink the font until every line fits maxWidth. measure(text, pxSize)
 * returns px width (canvas measureText in the app, a stub in tests).
 * Never goes below minSize; reports whether the fit is exact.
 */
export function fitText({ lines, maxWidth, baseSize, minSize = 20, measure }) {
  const safe = Array.isArray(lines) ? lines.filter((l) => l && l.length > 0) : [];
  if (safe.length === 0) return { size: baseSize, lines: [], fits: true };
  let size = Math.max(minSize, Math.floor(baseSize));
  for (;;) {
    const widest = Math.max(...safe.map((l) => measure(l, size)));
    if (widest <= maxWidth || size <= minSize) {
      return { size, lines: safe, fits: widest <= maxWidth };
    }
    size -= 2;
  }
}

/**
 * Free-positioned text fields. Each field: { id, text, ax, ay } with
 * ax/ay in 0..1 (center-x, first-baseline-y fractions). Classic top and
 * bottom captions are just fields at (0.5, top-pad) and (0.5, bottom).
 * layoutCaption() above is preserved byte-for-byte for its tests;
 * this generalizes it for draggable + extra fields.
 */
export function layoutFields(fields, { width, height, measure }) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const maxWidth = Math.floor(w * 0.92);
  const baseSize = Math.max(20, Math.floor(Math.min(w, h) / 9));
  const minSize = Math.max(14, Math.floor(baseSize / 2));
  return (Array.isArray(fields) ? fields : []).map((f, i) => {
    const lines = splitCaption(f.text);
    const fit = fitText({ lines, maxWidth, baseSize, minSize, measure });
    const size = fit.size;
    const lineHeight = Math.floor(size * 1.15);
    const ax = clamp01(f.ax ?? 0.5);
    const ay = clamp01(f.ay ?? (i === 0 ? 0 : 1));
    const upward = typeof f.upward === "boolean" ? f.upward : ay > 0.5;
    const cx = Math.floor(ax * w);
    const firstBaselineY = Math.floor(ay * h);
    const widths = fit.lines.map((l) => measure(l, size));
    const boxW = widths.length ? Math.max(...widths) : 0;
    const spanH = (fit.lines.length - 1) * lineHeight;
    return {
      id: f.id ?? `field-${i}`,
      lines: fit.lines,
      size,
      lineHeight,
      upward,
      cx,
      firstBaselineY,
      fits: fit.fits,
      // Hit box in canvas px (padded for fat fingers).
      box: {
        x0: cx - boxW / 2 - 8,
        x1: cx + boxW / 2 + 8,
        y0: (upward ? firstBaselineY - spanH : firstBaselineY) - size - 8,
        y1: (upward ? firstBaselineY : firstBaselineY + spanH) + 8,
      },
    };
  });
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Topmost laid-out field containing (x, y), else null. */
export function hitField(layouts, x, y) {
  for (let i = layouts.length - 1; i >= 0; i--) {
    const b = layouts[i].box;
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return layouts[i].id;
  }
  return null;
}
export function layoutCaption({ top, bottom, width, height, measure }) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const maxWidth = Math.floor(w * 0.92);
  const baseSize = Math.max(20, Math.floor(Math.min(w, h) / 9));
  const minSize = Math.max(14, Math.floor(baseSize / 2));
  const topLines = splitCaption(top);
  const bottomLines = splitCaption(bottom);
  const topFit = fitText({ lines: topLines, maxWidth, baseSize, minSize, measure });
  const bottomFit = fitText({ lines: bottomLines, maxWidth, baseSize, minSize, measure });
  const size = Math.min(topFit.size, bottomFit.size);
  const lineHeight = Math.floor(size * 1.15);
  const pad = Math.floor(size * 0.5);
  return {
    size,
    lineHeight,
    top: { lines: topFit.lines, firstBaselineY: topFit.lines.length ? pad + size : 0 },
    bottom: {
      lines: bottomFit.lines,
      lastBaselineY: bottomFit.lines.length ? h - pad : 0,
    },
    fits: topFit.fits && bottomFit.fits,
  };
}
