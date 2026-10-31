import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleHash, manifestHash, sha256Hex, stableStringify, verifyBundleFiles } from "../src/hash.ts";

test("stableStringify sorts object keys and keeps array order", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ z: { b: 1, a: 2 }, items: [3, 1] }), '{"items":[3,1],"z":{"a":2,"b":1}}');
});

test("manifestHash is sha256 of the stable JSON", async () => {
  const a = { name: "Cast", start_url: "/" };
  const b = { start_url: "/", name: "Cast" };
  assert.equal(await manifestHash(a), await manifestHash(b));
  assert.match(await manifestHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(await manifestHash(a), await manifestHash({ ...a, name: "Other" }));
});

test("bundleHash is over every file, not only the manifest", async () => {
  const files = [
    { path: "manifest.json", bytes: new TextEncoder().encode('{"name":"Cast"}') },
    { path: "app.js", bytes: new TextEncoder().encode("console.log(1)") },
  ];
  const hash = await bundleHash(files);
  const manifestOnly = await bundleHash(files.slice(0, 1));
  assert.notEqual(hash, manifestOnly, "adding app.js must move the bundle hash");
  const shuffled = [files[1], files[0]];
  assert.equal(hash, await bundleHash(shuffled), "path sort is canonical");
  const viaDigest = await bundleHash([
    { path: "app.js", sha256: await sha256Hex(files[1].bytes) },
    { path: "manifest.json", sha256: await sha256Hex(files[0].bytes) },
  ]);
  assert.equal(hash, viaDigest);
});

test("verifyBundleFiles rejects a wrong listing hash", async () => {
  const files = [{ path: "index.html", bytes: new TextEncoder().encode("<h1>") }];
  const hash = await bundleHash(files);
  assert.equal((await verifyBundleFiles(files, hash)).ok, true);
  const bad = await verifyBundleFiles(files, "ab".repeat(32));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /mismatch/);
});

test("bundle paths refuse traversal", async () => {
  await assert.rejects(() => bundleHash([{ path: "../secret", bytes: new Uint8Array([1]) }]), /invalid bundle path/);
});
