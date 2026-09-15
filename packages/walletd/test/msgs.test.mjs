import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-msgs";
import knex from "knex";
import { PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import {
  __resetCache,
  brc42SignData,
  brc42SignHash,
  brc42Verify,
  brc42VerifyDigest,
  createWallet,
  destroyWallet,
  dmDecrypt,
  dmEncrypt,
  hasWallet,
  identityPubkeyHex,
  lock,
} from "../src/custody.ts";
import {
  __setRelay,
  ackDm,
  listStored,
  migrateMsgs,
  packEnvelope,
  parseEnvelope,
  readDm,
  sendDm,
  syncInbox,
} from "../src/msgs.ts";
import { msgWallet, msgWalletFull } from "../src/msgwallet.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  await migrateMsgs(db);
  return db;
}

const PEER = PrivateKey.fromRandom().toPublicKey().toString();

test("envelopes validate strictly", () => {
  const good = packEnvelope("a".repeat(66), PEER, "deadbeef");
  assert.equal(good.v, 1);
  assert.deepEqual(parseEnvelope(JSON.parse(JSON.stringify(good))), good);
  assert.throws(() => parseEnvelope(null), /object/);
  assert.throws(() => parseEnvelope({ ...good, v: 2 }), /version/);
  assert.throws(() => parseEnvelope({ ...good, from: "xyz" }), /pubkeys/);
  assert.throws(() => parseEnvelope({ ...good, body: "zz" }), /hex/);
});

function fakeRelay() {
  const calls = { sent: [], acked: [] };
  const inbox = [];
  return {
    calls,
    inbox,
    relay: {
      send: async (recipient, box, messageId, body) => {
        calls.sent.push({ recipient, box, messageId, body });
      },
      list: async () => [...inbox],
      ack: async (ids) => {
        calls.acked.push(...ids);
      },
    },
  };
}

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("DM round-trips to self; wrong peer fails closed", async () => {
  await createWallet();
  try {
    const self = identityPubkeyHex();
    const body = dmEncrypt(self, "hello self");
    assert.equal(dmDecrypt(self, body), "hello self");
    assert.throws(() => dmDecrypt(PEER, body), /decryption failed|tamper|error/i);
    assert.throws(() => dmEncrypt(self, ""), /empty/);
    assert.throws(() => dmEncrypt("nope", "hi"), /peer/);
    assert.throws(() => dmEncrypt(self, "x".repeat(33 * 1024)), /over/);
  } finally {
    await destroyWallet();
    __resetCache();
  }
});

it("BRC-42 sign/verify round-trips; counterparty direction; locked fails closed", async () => {
  await createWallet();
  const proto = [2, "test proto"];
  const data = [1, 2, 3, 4];
  try {
    const sig = brc42SignData(proto, "k1", PEER, data);
    assert.equal(brc42Verify(proto, "k1", PEER, true, data, sig), true);
    assert.equal(brc42Verify(proto, "k1", PEER, true, [9, 9], sig), false);
    const hash = new Array(32).fill(7);
    const hsig = brc42SignHash(proto, "k1", PEER, hash);
    assert.equal(brc42VerifyDigest(proto, "k1", PEER, true, hash, hsig), true);
    const self = identityPubkeyHex();
    // Counterparty direction (the server side of a handshake): a peer key
    // signs with counterparty = our identity; we verify with forSelf=false.
    const { KeyDeriver, Hash, ECDSA, BigNumber } = await import("@bsv/sdk");
    const peerRoot = PrivateKey.fromRandom();
    const peerPub = peerRoot.toPublicKey().toString();
    const peerKey = new KeyDeriver(peerRoot).derivePrivateKey(proto, "k1", self);
    const phash = Hash.sha256([8, 8, 8]);
    const psig = Array.from(
      ECDSA.sign(BigNumber.fromString(Buffer.from(phash).toString("hex"), 16), peerKey).toDER(),
    );
    assert.equal(brc42Verify(proto, "k1", peerPub, false, [8, 8, 8], psig), true);
    lock();
    // Locked: private ops fail closed, sessionless paths stay shut.
    assert.throws(() => dmEncrypt(self, "x"), (e) => e.code === "WALLET_LOCKED");
    assert.throws(() => identityPubkeyHex(), (e) => e.code === "WALLET_LOCKED");
  } finally {
    await destroyWallet();
    __resetCache();
  }
});

it("shim exposes identity, scoped signatures, no payments", async () => {
  await createWallet();
  try {
    const w = msgWallet();
    const self = identityPubkeyHex();
    assert.equal((await w.getPublicKey({ identityKey: true })).publicKey, self);
    await assert.rejects(w.getPublicKey({}), /only the identity key/);
    const data = [5, 6, 7];
    const { signature } = await w.createSignature({
      data, protocolID: [2, "auth message signature"], keyID: "n1 n2", counterparty: PEER,
    });
    assert.deepEqual(await w.verifySignature({
      data, signature, protocolID: [2, "auth message signature"], keyID: "n1 n2", counterparty: PEER, forSelf: true,
    }), { valid: true });
    await assert.rejects(w.verifySignature({
      data: [0], signature, protocolID: [2, "auth message signature"], keyID: "n1 n2", counterparty: PEER,
    }), /invalid/);
    await assert.rejects(w.createSignature({ data, protocolID: [2, "x"] }), /scoped/);
    await assert.rejects(w.createAction({}), /unsupported/);
  } finally {
    await destroyWallet();
    __resetCache();
  }
});

it("shim hmac round-trips for handshake nonces", async () => {
  await createWallet();
  try {
    const w = msgWalletFull();
    const { hmac } = await w.createHmac({
      data: [1, 2, 3], protocolID: [2, "server hmac"], keyID: "k", counterparty: PEER,
    });
    assert.equal(hmac.length, 32);
    assert.deepEqual(await w.verifyHmac({
      data: [1, 2, 3], hmac, protocolID: [2, "server hmac"], keyID: "k", counterparty: PEER,
    }), { valid: true });
    assert.deepEqual(await w.verifyHmac({
      data: [9], hmac, protocolID: [2, "server hmac"], keyID: "k", counterparty: PEER,
    }), { valid: false });
  } finally {
    await destroyWallet();
    __resetCache();
  }
});

it("outbox stores ciphertext; inbox decrypts on read; ack marks", async () => {
  const db = await memdb();
  const f = fakeRelay();
  __setRelay(f.relay);
  try {
    await createWallet();
    const self = identityPubkeyHex();
    const { id } = await sendDm(db, f.relay, self, self, "note to self");
    assert.equal(f.calls.sent.length, 1);
    assert.equal(f.calls.sent[0].box, "bsv-os-dm");
    const stored = await listStored(db, "out");
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].envelope.includes("note to self")); // ciphertext at rest

    // inbound leg: same envelope arrives via sync
    f.inbox.push({ messageId: "in-1", body: f.calls.sent[0].body });
    const sync = await syncInbox(db, f.relay);
    assert.equal(sync.fresh, 1);
    assert.equal((await syncInbox(db, f.relay)).fresh, 0); // deduped
    const read = await readDm(db, "in-1");
    assert.equal(read.text, "note to self");
    assert.equal(read.peer, self);
    const acked = await ackDm(db, f.relay, "in-1");
    assert.equal(acked.acked, true);
    assert.deepEqual(f.calls.acked, ["in-1"]);
    const all = await listStored(db);
    assert.equal(all.length, 2);
  } finally {
    __setRelay(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
