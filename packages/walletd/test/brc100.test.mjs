import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-brc100";
import knex from "knex";
import { createServer } from "node:http";
import { PrivateKey, Script, Transaction, UnlockingScript, WalletWireProcessor } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { createBrc100Wallet } from "../src/brc100.ts";
import { setPolicy } from "../src/policy.ts";
import { p2pkhScript } from "../src/tx.ts";

const TO = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";
const F1 = "d".repeat(64);
const F2 = "e".repeat(64);

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    return true;
  });
}

function parentHex(outputs) {
  const tx = new Transaction(2, [], [], 0);
  tx.addInput({
    sourceTXID: "f".repeat(64),
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: new UnlockingScript([]),
  });
  for (const o of outputs) {
    tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.sats });
  }
  return tx.toHex();
}

function makeNet(selfAddr) {
  const hexes = {
    [F1]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 100_000 }]),
    [F2]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 50_000 }]),
  };
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.endsWith("/chain/info")) return new Response(JSON.stringify({ blocks: 900000 }), { status: 200 });
    const mh = /\/block\/height\/(\d+)$/.exec(u);
    if (mh) {
      return new Response(JSON.stringify({
        version: 973078528, versionHex: "3a000000",
        previousblockhash: "0".repeat(63) + "1",
        merkleroot: "1".repeat(64),
        time: 1700000000, bits: "180384ba", nonce: 12345,
      }), { status: 200 });
    }
    const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(u);
    if (m && hexes[m[1]]) return new Response(hexes[m[1]](), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  return { fetchFn };
}

function wallet(db, chain, fetchFn) {
  return createBrc100Wallet({ db, chain, fetchFn });
}

test("validation rejects bad shapes with codes", async () => {
  const db = await memdb();
  try {
    const chain = new MockChainProvider();
    const { fetchFn } = makeNet(TO);
    const w = wallet(db, chain, fetchFn);
    await rejectsCode(w.createAction({ description: "x" }, "t.example"), "BAD_PARAM");
    await rejectsCode(
      w.createAction({ description: "valid description here", outputs: [{ lockingScript: "zz", satoshis: 1, outputDescription: "valid output here" }] }, "t.example"),
      "BAD_PARAM",
    );
    await rejectsCode(w.getPublicKey({}), "BAD_PARAM");
    await rejectsCode(w.revealCounterpartyKeyLinkage({ counterparty: "nope", verifier: TO }, "t"), "BAD_PARAM");
    await rejectsCode(w.encrypt({ protocolID: [2, "x"], keyID: "k", plaintext: [1] }, "t"), "BAD_PARAM");
    await rejectsCode(w.listOutputs({ basket: "adm" }, "t"), "BAD_PARAM");
    await rejectsCode(w.createSignature({ protocolID: [2, "valid proto"], keyID: "k" }, "t"), "BAD_PARAM");
    await rejectsCode(w.acquireCertificate({ type: "eA==", certifier: TO, acquisitionProtocol: "issuance", fields: {} }, "t"), "NOT_SUPPORTED");
    await rejectsCode(w.relinquishOutput({ basket: "valid basket name", output: "nope" }, "t"), "BAD_PARAM");
  } finally {
    await db.destroy();
  }
});

test("status and chain reads", async () => {
  const db = await memdb();
  try {
    const chain = new MockChainProvider();
    const { fetchFn } = makeNet(TO);
    const w = wallet(db, chain, fetchFn);
    assert.deepEqual(await w.getVersion(), { version: "bsvos-0.1.0" });
    assert.deepEqual(await w.getNetwork(), { network: "mainnet" });
    assert.deepEqual(await w.getHeight(), { height: 900000 });
    const h = await w.getHeader({ height: 900000 });
    assert.equal(h.header.length, 160);
    assert.equal(h.header.slice(0, 8), "0000003a"); // version LE
    assert.equal(h.header.slice(8, 72), "01" + "00".repeat(31));
    const auth = await w.isAuthenticated();
    assert.equal(auth.authenticated, false);
  } finally {
    await db.destroy();
  }
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("crypto round-trips through custody (identity, derived, hmac, signatures, linkages)", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const self = selfAddress();
    const { fetchFn } = makeNet(self);
    const chain = new MockChainProvider();
    const w = wallet(db, chain, fetchFn);
    const id = await w.getPublicKey({ identityKey: true });
    assert.match(id.publicKey, /^[0-9a-f]{66}$/);
    const peer = PrivateKey.fromRandom().toPublicKey().toString();
    const derived = await w.getPublicKey({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer });
    assert.match(derived.publicKey, /^[0-9a-f]{66}$/);
    const ct = await w.encrypt({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, plaintext: [1, 2, 3] });
    assert.ok(ct.ciphertext.length > 3);
    const dec = await w.decrypt({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, ciphertext: ct.ciphertext });
    assert.deepEqual(dec.plaintext, [1, 2, 3]);
    const h = await w.createHmac({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, data: [9, 9] });
    assert.deepEqual(await w.verifyHmac({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, data: [9, 9], hmac: h.hmac }), { valid: true });
    await rejectsCode(
      w.verifyHmac({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, data: [9, 9], hmac: [0] }),
      "INVALID_HMAC",
    );
    const sig = await w.createSignature({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, data: [7, 7, 7] });
    assert.ok(sig.signature.length > 0);
    assert.deepEqual(
      await w.verifySignature({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, forSelf: true, data: [7, 7, 7], signature: sig.signature }),
      { valid: true },
    );
    await rejectsCode(
      w.verifySignature({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peer, forSelf: true, data: [7, 7, 8], signature: sig.signature }),
      "INVALID_SIGNATURE",
    );
    // cross-identity (the real interop case): peer signs naming us, we verify
    // with counterparty=peer and forSelf=false
    const { KeyDeriver: KD, ECDSA: ECDSA2, BigNumber: BN, Hash: H } = await import("@bsv/sdk");
    const peerRoot = PrivateKey.fromRandom();
    const peerPub = peerRoot.toPublicKey().toString();
    const peerPriv = new KD(peerRoot).derivePrivateKey([2, "test proto"], "k1", id.publicKey);
    const digest = H.sha256([7, 7, 7]);
    const peerSig = Array.from(ECDSA2.sign(BN.fromString(Buffer.from(digest).toString("hex"), 16), peerPriv, true).toDER());
    assert.deepEqual(
      await w.verifySignature({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peerPub, forSelf: false, data: [7, 7, 7], signature: peerSig }),
      { valid: true },
    );
    await rejectsCode(
      w.verifySignature({ protocolID: [2, "test proto"], keyID: "k1", counterparty: peerPub, forSelf: true, data: [7, 7, 7], signature: peerSig }),
      "INVALID_SIGNATURE",
    );
    const link = await w.revealCounterpartyKeyLinkage({ counterparty: peer, verifier: peer });
    assert.equal(link.prover, id.publicKey);
    assert.ok(link.encryptedLinkage.length > 0 && link.encryptedLinkageProof.length > 0);
    assert.match(link.revelationTime, /^\d{4}-\d{2}-\d{2}T/);
    const specific = await w.revealSpecificKeyLinkage({
      counterparty: peer, verifier: peer, protocolID: [2, "test proto"], keyID: "k1",
    });
    assert.equal(specific.proofType, 0);
    assert.ok(specific.encryptedLinkage.length > 0);
    void self;
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("createAction funds, labels, tracks; lists filter; outputs relinquish", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    const w = wallet(db, chain, fetchFn);
    await rejectsCode(w.createAction({ description: "paying for test goods here" }, "shop.example"), "POLICY_DENY");
    await setPolicy(db, "shop.example", "allow");
    const r = await w.createAction({
      description: "paying for test goods here",
      outputs: [{
        lockingScript: p2pkhScript(TO).toHex(), satoshis: 5000,
        outputDescription: "paying the merchant now", basket: "merchant flows", tags: ["test-tag"],
      }],
      labels: ["shop-test"],
    }, "shop.example");
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    const listed = await w.listActions({ labels: ["shop-test"], includeLabels: true, includeOutputs: true });
    assert.equal(listed.totalActions, 1);
    assert.equal(listed.actions[0].description, "paying for test goods here");
    assert.deepEqual(listed.actions[0].labels, ["shop-test"]);
    assert.equal(listed.actions[0].isOutgoing, true);
    assert.ok(["sending", "unproven", "completed"].includes(listed.actions[0].status));
    assert.equal(listed.actions[0].outputs.length, 2); // payment + change
    const outs = await w.listOutputs({ basket: "merchant flows", includeTags: true });
    assert.equal(outs.totalOutputs, 1);
    assert.equal(outs.outputs[0].satoshis, 5000);
    assert.deepEqual(outs.outputs[0].tags, ["test-tag"]);
    assert.equal(outs.outputs[0].spendable, false);
    const change = await w.listOutputs({ basket: "change" });
    assert.equal(change.totalOutputs, 1);
    assert.ok(change.outputs[0].spendable);
    assert.deepEqual(await w.relinquishOutput({ basket: "merchant flows", output: outs.outputs[0].outpoint }), { relinquished: true });
    assert.equal((await w.listOutputs({ basket: "merchant flows" })).totalOutputs, 0);
    await rejectsCode(w.relinquishOutput({ basket: "merchant flows", output: outs.outputs[0].outpoint }), "NOT_FOUND");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("sign-later flow stages, signs, aborts", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    chain.credit(addr, { txid: F2, vout: 0, value: 50_000, height: 900 });
    const w = wallet(db, chain, fetchFn);
    await setPolicy(db, "shop.example", "allow");
    const staged = await w.createAction({
      description: "staged payment for later",
      outputs: [{ lockingScript: p2pkhScript(TO).toHex(), satoshis: 3000, outputDescription: "deferred merchant pay" }],
      options: { signAndProcess: false },
    }, "shop.example");
    assert.ok(staged.signableTransaction?.reference);
    assert.ok(!staged.txid);
    const done = await w.signAction({ reference: staged.signableTransaction.reference, spends: {} });
    assert.match(done.txid, /^[0-9a-f]{64}$/);
    await rejectsCode(w.abortAction({ reference: "nope" }), "NOT_FOUND");
    const staged2 = await w.createAction({
      description: "will abort this one",
      outputs: [{ lockingScript: p2pkhScript(TO).toHex(), satoshis: 1000, outputDescription: "aborted merchant pay" }],
      options: { signAndProcess: false },
    }, "shop.example");
    assert.deepEqual(await w.abortAction({ reference: staged2.signableTransaction.reference }), { aborted: true });
    await rejectsCode(w.signAction({ reference: staged2.signableTransaction.reference, spends: {} }), "NOT_FOUND");
    const staged3 = await w.createAction({
      description: "a nosend action here",
      outputs: [{ lockingScript: p2pkhScript(TO).toHex(), satoshis: 1000, outputDescription: "nosend merchant pay" }],
      options: { noSend: true },
    }, "shop.example");
    assert.match(staged3.txid, /^[0-9a-f]{64}$/);
    assert.deepEqual(await w.abortAction({ reference: staged3.txid }), { aborted: true });
    await rejectsCode(w.createAction({
      description: "batching is not supported",
      outputs: [{ lockingScript: p2pkhScript(TO).toHex(), satoshis: 1000, outputDescription: "batched merchant pay" }],
      options: { sendWith: ["a".repeat(64)] },
    }, "shop.example"), "NOT_SUPPORTED");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("internalizeAction credits described outputs; tampered scripts rejected", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    const w = wallet(db, chain, fetchFn);
    const { Transaction: Tx2, UnlockingScript: UL } = await import("@bsv/sdk");
    const tx = new Tx2(2, [], [], 0);
    tx.addInput({
      sourceTXID: "f".repeat(64), sourceOutputIndex: 0, sequence: 0xffffffff,
      unlockingScript: new UL([]),
    });
    tx.addOutput({ lockingScript: Script.fromHex(p2pkhScript(addr).toHex()), satoshis: 7777 });
    const atomic = Array.from(tx.toAtomicBEEF(true));
    const r = await w.internalizeAction({
      tx: atomic,
      outputs: [{
        outputIndex: 0, protocol: "basket insertion",
        insertionRemittance: { basket: "peer drops", tags: ["probe"], customInstructions: "hello" },
      }],
      description: "peer drop",
      labels: ["peer-test"],
    }, "peer.example");
    assert.deepEqual(r, { accepted: true });
    const outs = await w.listOutputs({ basket: "peer drops", includeTags: true, includeCustomInstructions: true });
    assert.equal(outs.totalOutputs, 1);
    assert.equal(outs.outputs[0].satoshis, 7777);
    assert.deepEqual(outs.outputs[0].tags, ["probe"]);
    assert.equal(outs.outputs[0].customInstructions, "hello");
    assert.ok(outs.outputs[0].spendable);
    const acts = await w.listActions({ labels: ["peer-test"] });
    assert.equal(acts.totalActions, 1);
    assert.equal(acts.actions[0].isOutgoing, false);
    const tx2 = new Tx2(2, [], [], 0);
    tx2.addInput({
      sourceTXID: "f".repeat(64), sourceOutputIndex: 0, sequence: 0xffffffff,
      unlockingScript: new UL([]),
    });
    tx2.addOutput({ lockingScript: Script.fromHex(p2pkhScript(TO).toHex()), satoshis: 7777 });
    await rejectsCode(w.internalizeAction({
      tx: Array.from(tx2.toAtomicBEEF(true)),
      outputs: [{ outputIndex: 0, protocol: "wallet payment" }],
      description: "bogus claim here",
    }, "peer.example"), "NOT_OURS");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("certificates direct-store, discover, prove, relinquish", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const { fetchFn } = makeNet(TO);
    const chain = new MockChainProvider();
    const w = wallet(db, chain, fetchFn);
    const { PrivateKey: PK2, ECDSA: EE2 } = await import("@bsv/sdk");
    const { certDigest } = await import("../src/certs.ts");
    const id = await w.getPublicKey({ identityKey: true });
    const certPriv = PK2.fromRandom();
    const certifier = certPriv.toPublicKey().toString();
    const type = "test.handle";
    const b64type = Buffer.from(type, "utf8").toString("base64");
    const fields = { handle: "@satoshi" };
    const digest = certDigest(type, certifier, id.publicKey, fields);
    const sigHex = Buffer.from(EE2.sign(digest, certPriv, true).toDER()).toString("hex");
    const acquired = await w.acquireCertificate({
      type: b64type, certifier, acquisitionProtocol: "direct", fields, signature: sigHex,
    }, "id.example");
    assert.equal(acquired.subject, id.publicKey);
    assert.deepEqual(acquired.fields, fields);
    const listed = await w.listCertificates({ certifiers: [certifier], types: [b64type] });
    assert.equal(listed.totalCertificates, 1);
    assert.equal((await w.discoverByIdentityKey({ identityKey: id.publicKey })).totalCertificates, 1);
    assert.equal((await w.discoverByAttributes({ attributes: { handle: "@satoshi" } })).totalCertificates, 1);
    assert.equal((await w.discoverByAttributes({ attributes: { handle: "nope" } })).totalCertificates, 0);
    const peer = PK2.fromRandom().toPublicKey().toString();
    const proof = await w.proveCertificate({
      certificate: { type: b64type, serialNumber: acquired.serialNumber, certifier },
      fieldsToReveal: ["handle"],
      verifier: peer,
    });
    assert.equal(Buffer.from(proof.keyringForVerifier.handle, "base64").toString("utf8"), "@satoshi");
    assert.equal(proof.verifier, peer);
    assert.deepEqual(await w.relinquishCertificate({
      type: b64type, serialNumber: acquired.serialNumber, certifier,
    }), { relinquished: true });
    assert.equal((await w.listCertificates({ certifiers: [certifier], types: [b64type] })).totalCertificates, 0);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("real WalletClient round-trips over binary wire frames", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const { fetchFn } = makeNet(TO);
    const chain = new MockChainProvider();
    const facade = wallet(db, chain, fetchFn);
    const {
      WalletClient, WalletWireProcessor, WalletWireTransceiver, HTTPWalletWire,
    } = await import("@bsv/sdk");
    const processor = new WalletWireProcessor(facade);
    const codes = {
      createAction: 1, signAction: 2, abortAction: 3, listActions: 4,
      internalizeAction: 5, listOutputs: 6, relinquishOutput: 7,
      getPublicKey: 8, revealCounterpartyKeyLinkage: 9,
      revealSpecificKeyLinkage: 10, encrypt: 11, decrypt: 12,
      createHmac: 13, verifyHmac: 14, createSignature: 15,
      verifySignature: 16, acquireCertificate: 17, listCertificates: 18,
      proveCertificate: 19, relinquishCertificate: 20,
      discoverByIdentityKey: 21, discoverByAttributes: 22,
      isAuthenticated: 23, waitForAuthentication: 24, getHeight: 25,
      getHeader: 26, getNetwork: 27, getVersion: 28,
    };
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const call = req.url.replace(/^\/+/, "");
        const code = codes[call];
        if (code == null) throw new Error("unknown call: " + call);
        const origin = req.headers.origin || "";
        const ob = Buffer.from(origin, "utf8");
        const payload = Buffer.concat(chunks);
        const frame = Buffer.concat([
          Buffer.from([code, ob.length]), ob, payload,
        ]);
        const out = await processor.transmitToWalletUint8Array(new Uint8Array(frame));
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String((e instanceof Error ? e.message : e)) }));
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const client = new WalletClient(
        new WalletWireTransceiver(new HTTPWalletWire("wire.example", `http://127.0.0.1:${port}`)),
        "wire.example",
      );
      assert.deepEqual(await client.getVersion(), { version: "bsvos-0.1.0" });
      assert.deepEqual(await client.getNetwork(), { network: "mainnet" });
      const id = await client.getPublicKey({ identityKey: true });
      assert.match(id.publicKey, /^[0-9a-f]{66}$/);
      assert.deepEqual(await client.isAuthenticated(), { authenticated: true });
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
