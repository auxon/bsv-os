import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-sweep";
import knex from "knex";
import { Script, Transaction, UnlockingScript, PrivateKey } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { sweepIn, sweepOut } from "../src/engine.ts";
import { setPolicy } from "../src/policy.ts";
import { p2pkhScript } from "../src/tx.ts";

// Guarded like the other custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

const FOREIGN = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

/** A parent tx whose output 0 carries `scriptHex`, served to lockingScriptOf. */
function parentHex(scriptHex, sats) {
  const tx = new Transaction(2, [], [], 0);
  tx.addInput({
    sourceTXID: "f".repeat(64),
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: new UnlockingScript([]),
  });
  tx.addOutput({ lockingScript: Script.fromHex(scriptHex), satoshis: sats });
  return tx.toHex();
}

function pushBytes(bytes) {
  return bytes.length <= 75 ? [bytes.length, ...bytes] : [0x4c, bytes.length, ...bytes];
}

/** Generic ord envelope appended to a P2PKH script — a funding carrier. */
function inscribedScript(owner, text) {
  const prefix = Buffer.from(p2pkhScript(owner).toHex(), "hex");
  const body = Buffer.from([
    0x00, 0x63,
    ...pushBytes([...Buffer.from("ord", "utf8")]),
    0x51,
    ...pushBytes([...Buffer.from("text/plain", "utf8")]),
    0x00,
    ...pushBytes([...Buffer.from(text, "utf8")]),
    0x68,
  ]);
  return Buffer.concat([prefix, body]).toString("hex");
}

/** Serve /tx/<txid>/hex for a fixed set of outpoints. */
function netserve(fixtures) {
  return async (url) => {
    const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
    if (m && fixtures[m[1]] !== undefined) return new Response(fixtures[m[1]], { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

it("sweep out: sends balance minus fee, leaving nothing behind", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const me = selfAddress();
    const T1 = "a".repeat(64);
    const T2 = "b".repeat(64);
    chain.credit(me, { txid: T1, vout: 0, value: 300_000, height: 900 });
    chain.credit(me, { txid: T2, vout: 0, value: 200_000, height: 901 });
    const fetchFn = netserve({
      [T1]: parentHex(p2pkhScript(me).toHex(), 300_000),
      [T2]: parentHex(p2pkhScript(me).toHex(), 200_000),
    });
    const TOTAL = 500_000;

    // Policy-gated like a normal send: unknown origin is denied first.
    await rejectsCode(sweepOut({ db, chain, origin: "cli", to: FOREIGN, fetchFn }), "POLICY_DENY");
    await setPolicy(db, "cli", "allow");

    const r = await sweepOut({ db, chain, origin: "cli", to: FOREIGN, fetchFn });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.ok(r.fee >= 100, `fee ${r.fee} at least the miner minimum`);
    // The whole point: recipient gets everything that is not fee.
    assert.equal(r.sats + r.fee, TOTAL, "amount + fee === swept total (no value stranded)");
    assert.equal(r.sats, TOTAL - r.fee);

    // One payment output to the destination, and no change back to us.
    const tx = Transaction.fromHex(r.hex);
    const destScript = p2pkhScript(FOREIGN).toHex();
    const mineScript = p2pkhScript(me).toHex();
    const outs = tx.outputs.map((o) => ({ script: o.lockingScript?.toHex(), sats: o.satoshis ?? 0 }));
    assert.equal(outs.length, 1, "exactly one output — nothing left to a change address");
    assert.equal(outs[0].script, destScript, "the sole output pays the destination");
    assert.equal(outs[0].sats, r.sats);
    assert.ok(!outs.some((o) => o.script === mineScript), "no change back to the swept wallet");
    // Every credited outpoint is spent, so the wallet really is empty.
    const spent = tx.inputs.map((i) => `${i.sourceTXID}:${i.sourceOutputIndex}`).sort();
    assert.deepEqual(spent, [`${T1}:0`, `${T2}:0`].sort(), "all UTXOs consumed");
  } finally {
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});

it("sweep out: refuses when there is nothing to sweep", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    await setPolicy(db, "cli", "allow");
    await rejectsCode(sweepOut({ db, chain, origin: "cli", to: FOREIGN }), "INSUFFICIENT");
    // A bad destination is rejected before any chain work.
    await rejectsCode(sweepOut({ db, chain, origin: "cli", to: "not-an-address" }), "BAD_PARAM");
  } finally {
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});

it("sweep out: holds inscribed UTXOs back instead of burning them", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const me = selfAddress();
    const PLAIN = "c".repeat(64);
    const ORD = "d".repeat(64);
    chain.credit(me, { txid: PLAIN, vout: 0, value: 150_000, height: 900 });
    chain.credit(me, { txid: ORD, vout: 0, value: 90_000, height: 901 });
    const fetchFn = netserve({
      [PLAIN]: parentHex(p2pkhScript(me).toHex(), 150_000),
      [ORD]: parentHex(inscribedScript(me, "keep me"), 90_000),
    });
    await setPolicy(db, "cli", "allow");

    const r = await sweepOut({ db, chain, origin: "cli", to: FOREIGN, fetchFn });
    // Only the plain UTXO moves; the inscription stays put.
    const tx = Transaction.fromHex(r.hex);
    const spent = tx.inputs.map((i) => `${i.sourceTXID}:${i.sourceOutputIndex}`);
    assert.deepEqual(spent, [`${PLAIN}:0`], "the inscribed UTXO was not spent");
    assert.ok(r.sats + r.fee <= 150_000, "swept only the plain value");
    assert.ok(r.sats > 100_000, "and swept most of it");
  } finally {
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});

it("sweep in: moves a foreign key's funds to this wallet, no policy gate", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const me = selfAddress();
    const foreign = PrivateKey.fromHex("11".repeat(32));
    const wif = foreign.toWif();
    const foreignAddr = foreign.toPublicKey().toAddress();
    assert.notEqual(foreignAddr, me, "the foreign key is a different address");

    const F1 = "e".repeat(64);
    chain.credit(foreignAddr, { txid: F1, vout: 0, value: 250_000, height: 900 });
    const fetchFn = netserve({ [F1]: parentHex(p2pkhScript(foreignAddr).toHex(), 250_000) });

    // Deliberately NO setPolicy here: a sweep in is an inflow, so the policy
    // engine has nothing to refuse. If this ever starts throwing POLICY_DENY,
    // someone has turned an arrival into a permission.
    const r = await sweepIn({ db, chain, wif, fetchFn });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.equal(r.from, foreignAddr, "reports the swept address");
    assert.equal(r.to, me, "ALWAYS pays this wallet");
    assert.equal(r.sats + r.fee, 250_000, "everything except the fee arrives");
    assert.equal(r.inscribedSkipped, 0);

    const tx = Transaction.fromHex(r.hex);
    const outs = tx.outputs.map((o) => ({ script: o.lockingScript?.toHex(), sats: o.satoshis ?? 0 }));
    assert.equal(outs.length, 1, "one output, no stranded change");
    assert.equal(outs[0].script, p2pkhScript(me).toHex(), "the sole output pays THIS wallet");
    assert.equal(outs[0].sats, r.sats);
  } finally {
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});

it("sweep in: the destination cannot be redirected — there is no destination parameter", async () => {
  // The security property. A "spend from an arbitrary key to an arbitrary
  // address" primitive would be an exfiltration tool: trick a user into
  // pasting a WIF and their funds leave. sweepSigner fixes the destination to
  // selfAddress(), and this asserts the API cannot express anything else.
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const me = selfAddress();
    const foreign = PrivateKey.fromHex("22".repeat(32));
    const foreignAddr = foreign.toPublicKey().toAddress();
    const F1 = "f".repeat(64);
    chain.credit(foreignAddr, { txid: F1, vout: 0, value: 120_000, height: 900 });
    const fetchFn = netserve({ [F1]: parentHex(p2pkhScript(foreignAddr).toHex(), 120_000) });

    // An attacker-supplied destination in the params object is ignored, not
    // honoured: the engine takes no such option.
    const r = await sweepIn({ db, chain, wif: foreign.toWif(), to: FOREIGN, fetchFn });
    assert.equal(r.to, me);
    const tx = Transaction.fromHex(r.hex);
    assert.equal(tx.outputs.length, 1);
    assert.notEqual(tx.outputs[0].lockingScript?.toHex(), p2pkhScript(FOREIGN).toHex(), "never pays an injected address");
    assert.equal(tx.outputs[0].lockingScript?.toHex(), p2pkhScript(me).toHex());
  } finally {
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});

it("sweep in: rejects a bad WIF and an empty key", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    await rejectsCode(sweepIn({ db, chain, wif: "not-a-wif" }), "BAD_WIF");
    await rejectsCode(sweepIn({ db, chain, wif: "   " }), "BAD_WIF");
  } finally {
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});

it("sweep in: reports inscribed carriers rather than sweeping them", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const foreign = PrivateKey.fromHex("33".repeat(32));
    const foreignAddr = foreign.toPublicKey().toAddress();
    const PLAIN = "1".repeat(64);
    const ORD = "2".repeat(64);
    chain.credit(foreignAddr, { txid: PLAIN, vout: 0, value: 200_000, height: 900 });
    chain.credit(foreignAddr, { txid: ORD, vout: 0, value: 50_000, height: 901 });
    const fetchFn = netserve({
      [PLAIN]: parentHex(p2pkhScript(foreignAddr).toHex(), 200_000),
      [ORD]: parentHex(inscribedScript(foreignAddr, "an ordinal"), 50_000),
    });
    const r = await sweepIn({ db, chain, wif: foreign.toWif(), fetchFn });
    assert.equal(r.inscribedSkipped, 1, "the inscription is reported, not swept");
    assert.ok(r.sats + r.fee <= 200_000, "only the plain UTXO moved");
  } finally {
    await destroyWallet().catch(() => {});
    __resetCache?.();
    await db.destroy();
  }
});
