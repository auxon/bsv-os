import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { combine, gfMul, split } from "../src/shamir.ts";

test("field arithmetic is sound", () => {
  assert.equal(gfMul(0, 123), 0);
  assert.equal(gfMul(1, 200), 200);
  // commutativity + associativity spot checks over random triples
  for (let i = 0; i < 50; i++) {
    const a = randomBytes(1)[0];
    const b = randomBytes(1)[0];
    const c = randomBytes(1)[0];
    assert.equal(gfMul(a, b), gfMul(b, a));
    assert.equal(gfMul(gfMul(a, b), c), gfMul(a, gfMul(b, c)));
  }
});

test("round-trips at many shapes, exact-threshold and over", () => {
  for (const [n, m] of [[1, 1], [2, 2], [3, 2], [5, 3], [9, 5]]) {
    const secret = randomBytes(16);
    const shares = split(secret, m, n);
    assert.equal(shares.length, n);
    assert.equal(new Set(shares.map((s) => s.x)).size, n);
    assert.deepEqual(Buffer.from(combine(shares.slice(0, m))), Buffer.from(secret));
    assert.deepEqual(Buffer.from(combine(shares)), Buffer.from(secret));
    assert.deepEqual(Buffer.from(combine([...shares].reverse().slice(0, m))), Buffer.from(secret));
  }
});

test("fewer than M shares reconstruct nothing usable", () => {
  const secret = randomBytes(16);
  const shares = split(secret, 3, 5);
  for (let trials = 0; trials < 20; trials++) {
    const two = [...shares].sort(() => Math.random() - 0.5).slice(0, 2);
    assert.notDeepEqual(Buffer.from(combine(two)), Buffer.from(secret));
  }
});

test("malformed inputs fail closed", () => {
  const secret = randomBytes(16);
  assert.throws(() => split(secret, 0, 3), /threshold/);
  assert.throws(() => split(secret, 4, 3), /exceed/);
  assert.throws(() => split(secret, 1, 256), /1..255/);
  assert.throws(() => split(new Uint8Array(0), 1, 1), /empty/);
  assert.throws(() => combine([]), /at least one/);
  const shares = split(secret, 2, 3);
  assert.throws(() => combine([...shares.slice(0, 1), { x: shares[0].x, y: shares[0].y }]), /duplicate/);
  assert.throws(() => combine([{ x: 0, y: shares[0].y }]), /range/);
  assert.throws(() => combine([{ x: 1, y: new Uint8Array(15) }, { x: 2, y: new Uint8Array(16) }]), /mismatch/);
});
