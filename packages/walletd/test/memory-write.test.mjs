import { test } from "node:test";
import assert from "node:assert/strict";
import { after, before } from "node:test";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-memory-write";
import * as openpgp from "openpgp";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { addContact } from "../src/people.ts";
import { pgpPublicKey } from "../src/custody.ts";
import {
  hotClear, hotGet, hotPut, parseWriteInput, registerSelfDevice,
  resolveRecipients, writeTierRows,
} from "../src/memoryWrite.ts";
import { fixtureEmbedder } from "../src/embed.ts";

function memdb() {
  return knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
}

before(async () => {
  const { __resetCache, createWallet, destroyWallet, unlock } = await import("../src/custody.ts");
  __resetCache();
  await destroyWallet().catch(() => {});
  await createWallet();
  await unlock();
});

after(async () => {
  const { destroyWallet } = await import("../src/custody.ts");
  await destroyWallet().catch(() => {});
});

test("write input validation: visibility trio + pin + tagPublic", () => {
  assert.deepEqual(parseWriteInput({}), { visibility: "private", forList: [], pin: false, tagPublic: null });
  assert.deepEqual(parseWriteInput({ visibility: "public" }).visibility, "public");
  const shared = parseWriteInput({ visibility: "shared", for: ["@rah", "ABCDEF1234567890ABCDEF1234567890ABCDEF12"], pin: true });
  assert.deepEqual(shared, {
    visibility: "shared", forList: ["@rah", "ABCDEF1234567890ABCDEF1234567890ABCDEF12"], pin: true, tagPublic: null,
  });
  assert.throws(() => parseWriteInput({ visibility: "shared", for: [] }), /at least one --for/);
  assert.throws(() => parseWriteInput({ visibility: "secret" }), /private, shared, or public/);
  assert.throws(() => parseWriteInput({ visibility: "private", for: ["@x"] }), /needs --visibility shared/);
  assert.equal(parseWriteInput({ tagPublic: true }).tagPublic, true);
});

test("recipient resolution: fingerprint, contact, unknown, revoked, address", async () => {
  const db = memdb();
  try {
    await migrate(db);
    const peer = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "peer" }], format: "armored" });
    const peerFp = (await openpgp.readKey({ armoredKey: peer.publicKey })).getFingerprint().toUpperCase();
    await db("memory_devices").insert({
      fingerprint: peerFp, identity_key: "02" + "ab".repeat(32), public_key: peer.publicKey,
      label: "peer", is_self: 0, approved_at: 1, revoked_at: null,
    });
    // Direct fingerprint.
    const direct = await resolveRecipients(db, [peerFp.toLowerCase()]);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].fingerprint, peerFp);
    // @contact name via identity binding.
    await addContact(db, { name: "peer", identityKey: "02" + "ab".repeat(32) });
    const viaContact = await resolveRecipients(db, ["@peer"]);
    assert.equal(viaContact[0].fingerprint, peerFp);
    // Unknown fingerprint / unknown name / raw address fail closed.
    await assert.rejects(resolveRecipients(db, ["F".repeat(40)]), /exchange keys first/);
    await assert.rejects(resolveRecipients(db, ["@nobody"]), /exchange keys first/);
    await assert.rejects(resolveRecipients(db, ["1Bv4wgSatZYLzv5Lz9JNCaHMqmn87UcuNp"]), /exchange keys first/);
    // Revoked keys are skipped over (treated as unknown).
    await db("memory_devices").where({ fingerprint: peerFp }).update({ revoked_at: 2 });
    await assert.rejects(resolveRecipients(db, [peerFp]), /exchange keys first/);
  } finally {
    await db.destroy();
  }
});

test("self-registration validates the key against its fingerprint", async () => {
  const db = memdb();
  try {
    await migrate(db);
    const { pgpEnsureDeviceKey } = await import("../src/custody.ts");
    const self = await pgpEnsureDeviceKey("test");
    const { identityPubkeyHex } = await import("../src/custody.ts");
    await registerSelfDevice(db, { fingerprint: self.fingerprint, publicKey: self.publicKey, identityKey: identityPubkeyHex() });
    const row = await db("memory_devices").where({ fingerprint: self.fingerprint }).first();
    assert.equal(row.is_self, 1);
    // Re-register updates instead of duplicating.
    await registerSelfDevice(db, { fingerprint: self.fingerprint, publicKey: self.publicKey, identityKey: identityPubkeyHex(), label: "renamed" });
    assert.equal(await db("memory_devices").where({ fingerprint: self.fingerprint }).count("* as n").first().then((r) => r.n), 1);
    // Mismatched key refused.
    const other = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "o" }], format: "armored" });
    await assert.rejects(registerSelfDevice(db, { fingerprint: self.fingerprint, publicKey: other.publicKey, identityKey: identityPubkeyHex() }), /does not match/);
  } finally {
    await db.destroy();
  }
});

test("tier rows: public gets a vector, ciphertext never does; dups ignored", async () => {
  const db = memdb();
  try {
    await migrate(db);
    const embedder = fixtureEmbedder(8);
    const pub = await writeTierRows(db, {
      text: "deploy keys rotate monthly", visibility: "public", tag: "ops",
      tagPublic: null, pin: false, fromFp: "F".repeat(40), author: "t",
      payload: "deploy keys rotate monthly", embedder,
    });
    assert.equal(pub.tagPublic, true); // follows visibility
    assert.equal(pub.vectorized, true);
    assert.equal((await db("memory_vectors").select()).length, 1);
    const priv = await writeTierRows(db, {
      text: "secret plan", visibility: "private", tag: "", tagPublic: null,
      pin: true, fromFp: "F".repeat(40), author: "t",
      payload: "-----BEGIN PGP MESSAGE-----\nabc", embedder,
    });
    assert.equal(priv.tagPublic, false);
    assert.equal(priv.vectorized, false);
    assert.equal((await db("memory_vectors").select()).length, 1); // still one
    // Duplicate hash: ignored, not duplicated.
    await writeTierRows(db, {
      text: "deploy keys rotate monthly", visibility: "public", tag: "ops",
      tagPublic: null, pin: false, fromFp: "F".repeat(40), author: "t",
      payload: "deploy keys rotate monthly", embedder,
    });
    assert.equal((await db("memory_items").select()).length, 2);
    assert.equal(pub.hash, (await db("memory_items").where({ tag: "ops" }).first()).hash);
    void pgpPublicKey;
  } finally {
    await db.destroy();
  }
});

test("hot cache: put/get/clear, TTL expiry", () => {
  hotClear();
  assert.equal(hotGet("a".repeat(64)), null);
  hotPut({ hash: "a".repeat(64), text: "x", tag: "", visibility: "private", at: 1000 });
  assert.equal(hotGet("a".repeat(64), 1000 + 10 * 60 * 1000).text, "x"); // at boundary
  assert.equal(hotGet("a".repeat(64), 1000 + 10 * 60 * 1000 + 1), null); // expired
  hotPut({ hash: "a".repeat(64), text: "x", tag: "", visibility: "private", at: 1 });
  hotClear();
  assert.equal(hotGet("a".repeat(64), 2), null);
});
