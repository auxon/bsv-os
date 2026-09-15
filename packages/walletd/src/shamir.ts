/**
 * Shamir's Secret Sharing over GF(2^8) (AES field, 0x11b).
 *
 * Splits arbitrary byte secrets into N shares where any M reconstruct.
 * Custom envelope (NOT SLIP-0039 compatible — different field packing and
 * no wordlist layer; our shares print as hex cards, never words, so they
 * cannot be mistaken for recovery phrases).
 *
 * Security properties callers must preserve:
 * - x coordinates 1..255, never 0 (the secret lives at f(0)).
 * - Fewer than M shares reveal NOTHING (information-theoretic).
 * - No integrity built in — callers bind shares to a set fingerprint.
 */
import { randomBytes } from "node:crypto";

const EXP = new Array<number>(512);
const LOG = new Array<number>(256);

function xtime(a: number): number {
  return ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
}

(function initTables() {
  // Walk powers of 0x03 (a primitive element: full 255-cycle). NOTE: bare
  // xtime walks powers of 0x02, which has order 51 and corrupts the tables.
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = xtime(x) ^ x;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255];
}

/** Evaluate f(x) = secret + c1*x + ... via Horner (secret is the intercept). */
function evalPoly(secret: number, coeffs: number[], x: number): number {
  let y = 0;
  for (let j = coeffs.length - 1; j >= 0; j--) {
    y = coeffs[j]! ^ gfMul(y, x);
  }
  return secret ^ gfMul(y, x);
}

export interface Share {
  x: number;
  y: Uint8Array;
}

/**
 * Split a secret (any length; every byte shared independently).
 * threshold M (1..total), total N (1..255). M=1 degenerates to N copies.
 */
export function split(secret: Uint8Array, threshold: number, total: number, rand: (n: number) => Uint8Array = randomBytes): Share[] {
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error("threshold must be >= 1");
  if (!Number.isInteger(total) || total < 1 || total > 255) throw new Error("total must be 1..255");
  if (threshold > total) throw new Error("threshold cannot exceed total");
  if (secret.length === 0) throw new Error("secret must not be empty");
  const xs = new Set<number>();
  while (xs.size < total) {
    const x = 1 + rand(1)[0]! % 255;
    xs.add(x);
  }
  const xList = [...xs];
  // One polynomial per byte position — coefficients drawn ONCE here, then
  // evaluated at every x. (Drawing per share puts shares on different
  // lines that can never combine: the classic SSS implementation bug.)
  const polys: number[][] = [];
  for (let i = 0; i < secret.length; i++) polys.push(Array.from(rand(threshold - 1)));
  return xList.map((x) => {
    const y = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i++) {
      y[i] = evalPoly(secret[i]!, polys[i]!, x);
    }
    return { x, y };
  });
}

/** Reconstruct from shares. NOTE: this function cannot know the threshold —
 * fewer than M shares yield well-formed GARBAGE. Callers must require at
 * least M shares and verify the result against the set fingerprint. */
export function combine(shares: Share[]): Uint8Array {
  if (shares.length === 0) throw new Error("need at least one share");
  const len = shares[0]!.y.length;
  const seen = new Set<number>();
  const use: Share[] = [];
  for (const s of shares) {
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > 255) throw new Error("share x out of range");
    if (s.y.length !== len) throw new Error("share length mismatch");
    if (seen.has(s.x)) throw new Error("duplicate share x");
    seen.add(s.x);
    use.push(s);
  }
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let secret = 0;
    for (let j = 0; j < use.length; j++) {
      let num = 1;
      let den = 1;
      for (let m = 0; m < use.length; m++) {
        if (m === j) continue;
        num = gfMul(num, use[m]!.x);
        den = gfMul(den, use[m]!.x ^ use[j]!.x);
      }
      secret ^= gfMul(use[j]!.y[i]!, gfDiv(num, den));
    }
    out[i] = secret;
  }
  return out;
}
