import { test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-memory-tiers";
import * as openpgp from "openpgp";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  __resetCache, createWallet, destroyWallet, lock, pgpDecryptSelf, pgpEncryptTo,
  pgpEnsureDeviceKey, pgpPublicKey, syncSecret, unlock, unwrapSyncKey, wrapSyncKey,
} from "../src/custody.ts";
import { cosine, vecFromBlob, vecToBlob } from "../src/memoryTiers.ts";
import { fixtureEmbedder, lazyLocalEmbedder } from "../src/embed.ts";
import { after, before } from "node:test";

before(async () => {
  __resetCache();
  await destroyWallet().catch(() => {});
  await createWallet();
  await unlock();
});

after(async () => {
  await destroyWallet().catch(() => {});
});

function memdb() {
  return knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
}

test("tiers schema migrates all five tables", async () => {
  const db = memdb();
  try {
    await migrate(db);
    for (const t of ["memory_devices", "memory_items", "memory_vectors", "memory_sync_keys", "memory_promotions"]) {
      assert.equal(await db.schema.hasTable(t), true, t);
    }
  } finally {
    await db.destroy();
  }
});

test("pgp device key: generate once, self + shared roundtrips, wrong key fails", async () => {
  const a = await pgpEnsureDeviceKey("test-device");
  assert.match(a.fingerprint, /^[0-9A-F]{40}$/);
  assert.match(a.publicKey, /^-----BEGIN PGP PUBLIC KEY BLOCK-----/);
  const again = await pgpEnsureDeviceKey("other-label");
  assert.equal(again.fingerprint, a.fingerprint); // stable, not regenerated

  const selfPub = await pgpPublicKey();
  assert.ok(selfPub.includes("PGP PUBLIC KEY BLOCK"));

  // Self (private) roundtrip.
  const cipher = await pgpEncryptTo([selfPub], "core memory: deploy keys rotate monthly");
  assert.ok(!cipher.includes("rotate monthly"));
  assert.equal(await pgpDecryptSelf(cipher), "core memory: deploy keys rotate monthly");

  // Shared: two recipients, sender + peer both read.
  const peer = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "peer" }], format: "armored" });
  const shared = await pgpEncryptTo([selfPub, peer.publicKey], "shared memory: launch checklist");
  assert.equal(await pgpDecryptSelf(shared), "shared memory: launch checklist");
  const peerDec = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: shared }),
    decryptionKeys: await openpgp.readPrivateKey({ armoredKey: peer.privateKey }),
  });
  assert.equal(String(peerDec.data), "shared memory: launch checklist");

  // A stranger's key cannot read it.
  const stranger = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "stranger" }], format: "armored" });
  await assert.rejects(
    openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: shared }),
      decryptionKeys: await openpgp.readPrivateKey({ armoredKey: stranger.privateKey }),
    }),
  );

  // Empty recipients / empty text / garbage key fail closed.
  await assert.rejects(pgpEncryptTo([], "x"));
  await assert.rejects(pgpEncryptTo([selfPub], ""));
  await assert.rejects(pgpEncryptTo(["not a key"], "x"));
  await assert.rejects(pgpDecryptSelf("not a message"));
});

test("locked wallet refuses private PGP ops; public ops stay open", async () => {
  const pub = await pgpPublicKey();
  assert.ok(pub.length > 0);
  lock();
  const lockedCode = (p) => p.then(
    () => { throw new Error("should have thrown"); },
    (e) => { assert.equal(e.code, "WALLET_LOCKED"); },
  );
  await lockedCode(pgpEnsureDeviceKey());
  await lockedCode(pgpDecryptSelf("whatever"));
  await lockedCode(syncSecret());
  // Encrypting to someone else's public key needs no unlock (public is public).
  const peer = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "p" }], format: "armored" });
  const cipher = await pgpEncryptTo([peer.publicKey], "locked-self can still send");
  assert.ok(cipher.includes("PGP MESSAGE"));
});

test("sync secret wraps to device keys and unwraps back to the same hex", async () => {
  await unlock();
  const hex = await syncSecret();
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(await syncSecret(), hex); // stable
  const selfPub = await pgpPublicKey();
  const peer = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "device-b" }], format: "armored" });
  // Wrapped to self + peer: peer can open it with their own key...
  const wrapped = await wrapSyncKey([selfPub, peer.publicKey]);
  const opened = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: wrapped }),
    decryptionKeys: await openpgp.readPrivateKey({ armoredKey: peer.privateKey }),
  });
  assert.equal(String(opened.data), hex);
  // ...and self can adopt it back (stores without throwing).
  await unwrapSyncKey(wrapped);
  assert.equal(await syncSecret(), hex);
  await assert.rejects(unwrapSyncKey("garbage"));
  // A wrap addressed only to someone else is not adoptable here.
  const foreign = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "x" }], format: "armored" });
  const foreignPub = await openpgp.readKey({ armoredKey: foreign.publicKey });
  const foreignOnly = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: hex }),
    encryptionKeys: [foreignPub],
  });
  await assert.rejects(unwrapSyncKey(foreignOnly), (e) => e.code === "DECRYPT_FAILED");
});

test("cosine + blob codec behave on fixtures", () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 1]) - 1) < 1e-9);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  const v = Float32Array.from([1.5, -2.25, 0]);
  const back = vecFromBlob(vecToBlob(v), 3);
  assert.ok(Math.abs(back[0] - 1.5) < 1e-6 && Math.abs(back[1] + 2.25) < 1e-6 && back[2] === 0);
});

test("fixture embedder is deterministic and separates topics", async () => {
  const e = fixtureEmbedder(8);
  assert.equal(e.dims, 8);
  const [a, b, c] = await e.embed(["guitar pitch practice", "guitar pitch practice", "grocery milk eggs"]);
  assert.deepEqual([...a], [...b]);
  assert.ok(cosine(a, b) > cosine(a, c));
});

test("lazy local embedder loads a real model (downloads once, cached after)", async (t) => {
  if (!process.env.RUN_MODEL_TESTS) t.skip("set RUN_MODEL_TESTS=1 to download the ~90MB model");
  const e = lazyLocalEmbedder({});
  assert.equal(e.dims, 384);
  const [v] = await e.embed(["hello memory tiers"]);
  assert.equal(v.length, 384);
  let n = 0;
  for (const x of v) n += x * x;
  assert.ok(Math.abs(Math.sqrt(n) - 1) < 0.01); // normalized
});
