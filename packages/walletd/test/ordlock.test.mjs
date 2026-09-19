import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-ordlock";
import knex from "knex";
import { P2PKH, PrivateKey, Script, Spend, Transaction, UnlockingScript } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { setPolicy } from "../src/policy.ts";
import { dispatch, setBackend } from "../src/rpc.ts";
import {
  buyOrdLock, cancelOrdLock, decodeOrdLock, isOrdLock, lockOrdinal, ordlockLockScript,
} from "../src/ordlock.ts";
import { inscriptionScript } from "../src/tokens.ts";
import { p2pkhScript } from "../src/tx.ts";

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

const TO = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";
const N1 = "b".repeat(64);
const F1 = "d".repeat(64);

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
    [N1]: () => parentHex([{ scriptHex: inscriptionScript(selfAddr, "image/png", "0102"), sats: 1 }]),
    [F1]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 100_000 }]),
  };
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/1sat/ordfs/metadata")) return new Response("{}", { status: 200 });
    const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(u);
    if (m && hexes[m[1]]) return new Response(hexes[m[1]](), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  return { fetchFn, hexes };
}

async function backend() {
  const db = await memdb();
  const chain = new MockChainProvider();
  setBackend({ db, chain });
  return { db, chain };
}

function capture(chain) {
  let seen = "";
  const orig = chain.broadcast.bind(chain);
  chain.broadcast = async (hex) => {
    seen = hex;
    return orig(hex);
  };
  return () => seen;
}

async function validateInput(hex, index, sources) {
  const tx = Transaction.fromHex(hex);
  const src = sources[index];
  const spend = new Spend({
    sourceTXID: src.txid,
    sourceOutputIndex: src.vout,
    sourceSatoshis: src.satoshis,
    lockingScript: src.script,
    unlockingScript: tx.inputs[index].unlockingScript,
    transactionVersion: tx.version,
    lockTime: tx.lockTime,
    inputIndex: index,
    inputSequence: tx.inputs[index].sequence ?? 0xffffffff,
    outputs: tx.outputs,
    otherInputs: tx.inputs.filter((_, j) => j !== index),
  });
  try {
    return await spend.validate();
  } catch {
    return false;
  }
}

it("lock script round-trips through decode", async () => {
  await createWallet();
  try {
    const addr = selfAddress();
    const script = ordlockLockScript(addr, addr, 5000);
    assert.equal(isOrdLock(script.toHex()), true);
    const decoded = decodeOrdLock(script.toHex());
    assert.equal(decoded.cancelAddress, addr);
    assert.equal(decoded.price, 5000);
    assert.equal(decoded.payoutScriptHex, p2pkhScript(addr).toHex());
    assert.equal(decodeOrdLock(p2pkhScript(addr).toHex()), null);
    assert.equal(isOrdLock(p2pkhScript(addr).toHex()), false);
  } finally {
    await destroyWallet();
    __resetCache();
  }
});

it("lockOrdinal moves the carrier into the covenant", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    chain.credit(addr, { txid: N1, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    const seen = capture(chain);
    // negative checks first: they must not spend anything
    await rejectsCode(lockOrdinal({ db, chain, origin: "cli", txid: N1, vout: 0, priceSats: 5000, fetchFn }), "POLICY_DENY");
    await setPolicy(db, "cli", "allow");
    await rejectsCode(lockOrdinal({ db, chain, origin: "cli", txid: F1, vout: 0, priceSats: 5000, fetchFn }), "BAD_PARAM");
    await rejectsCode(lockOrdinal({ db, chain, origin: "cli", txid: N1, vout: 0, priceSats: 0, fetchFn }), "BAD_PARAM");
    const r = await lockOrdinal({ db, chain, origin: "cli", txid: N1, vout: 0, priceSats: 5000, fetchFn });
    assert.equal(r.lockOutpoint, `${r.txid}.0`);
    const tx = Transaction.fromHex(seen());
    assert.equal(tx.outputs[0].satoshis, 1);
    assert.equal(isOrdLock(tx.outputs[0].lockingScript.toHex()), true);
    const decoded = decodeOrdLock(tx.outputs[0].lockingScript.toHex());
    assert.equal(decoded.price, 5000);
    assert.equal(decoded.cancelAddress, addr);
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("buyOrdLock satisfies the covenant; a wrong payment does not", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    chain.credit(addr, { txid: N1, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    const seen = capture(chain);
    await setPolicy(db, "cli", "allow");
    const locked = await lockOrdinal({ db, chain, origin: "cli", txid: N1, vout: 0, priceSats: 5000, fetchFn });
    const lockTx = Transaction.fromHex(seen());
    const lockScript = lockTx.outputs[0].lockingScript;
    // serve the lock parent so buyOrdLock can fetch the script
    const origFetch = fetchFn;
    const buyFetch = async (url, init) => {
      const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
      if (m && m[1] === locked.txid) return new Response(seen(), { status: 200 });
      return origFetch(url, init);
    };
    const r = await buyOrdLock({
      db, chain, origin: "cli", lockOutpoint: locked.lockOutpoint,
      buyerChecks: { expectedSeller: addr, maxPrice: 5000 },
      fee: { to: TO, sats: 100 }, memo: ["MARKET-BUY", locked.lockOutpoint],
      fetchFn: buyFetch,
    });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.equal(r.priceSats, 5000);
    const tx = Transaction.fromHex(seen());
    // [0] the ordinal to the buyer, [1] byte-exact payout, [2] fee, [3] memo, change
    assert.equal(tx.outputs[0].satoshis, 1);
    assert.equal(tx.outputs[0].lockingScript.toHex(), p2pkhScript(addr).toHex());
    assert.equal(tx.outputs[1].satoshis, 5000);
    assert.equal(tx.outputs[1].lockingScript.toHex(), p2pkhScript(addr).toHex());
    assert.equal(tx.outputs[2].satoshis, 100);
    // the covenant accepts the honest spend
    const sources = [
      { txid: locked.txid, vout: 0, satoshis: 1, script: lockScript },
      { txid: F1, vout: 0, satoshis: 100_000, script: Script.fromHex(p2pkhScript(addr).toHex()) },
    ];
    assert.equal(await validateInput(seen(), 0, sources), true);
    // and rejects a tx that underpays: build the same spend with 4999
    const bad = Transaction.fromHex(seen());
    bad.outputs[1].satoshis = 4999;
    const badHex = bad.toHex();
    // the embedded preimage still commits to 5000, so the covenant fails
    assert.equal(await validateInput(badHex, 0, sources), false);
    // buyerChecks bind: wrong seller / price above max refuse before funding
    await rejectsCode(
      buyOrdLock({ db, chain, origin: "cli", lockOutpoint: locked.lockOutpoint, buyerChecks: { expectedSeller: TO }, fetchFn: buyFetch }),
      "BAD_OFFER",
    );
    await rejectsCode(
      buyOrdLock({ db, chain, origin: "cli", lockOutpoint: locked.lockOutpoint, buyerChecks: { maxPrice: 4999 }, fetchFn: buyFetch }),
      "BAD_OFFER",
    );
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("cancelOrdLock validates for the seller and refuses foreign keys", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    chain.credit(addr, { txid: N1, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    const seen = capture(chain);
    await setPolicy(db, "cli", "allow");
    const locked = await lockOrdinal({ db, chain, origin: "cli", txid: N1, vout: 0, priceSats: 5000, fetchFn });
    const lockHex = seen();
    const lockScript = Transaction.fromHex(lockHex).outputs[0].lockingScript;
    const origFetch = fetchFn;
    const lockFetch = async (url, init) => {
      const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
      if (m && m[1] === locked.txid) return new Response(lockHex, { status: 200 });
      return origFetch(url, init);
    };
    const r = await cancelOrdLock({ db, chain, origin: "cli", lockOutpoint: locked.lockOutpoint, fetchFn: lockFetch });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    const tx = Transaction.fromHex(seen());
    assert.equal(tx.outputs[0].satoshis, 1);
    assert.equal(tx.outputs[0].lockingScript.toHex(), p2pkhScript(addr).toHex());
    const sources = [
      { txid: locked.txid, vout: 0, satoshis: 1, script: lockScript },
      { txid: F1, vout: 0, satoshis: 100_000, script: Script.fromHex(p2pkhScript(addr).toHex()) },
    ];
    assert.equal(await validateInput(seen(), 0, sources), true);
    // a foreign key cannot cancel: same spend, someone else's signature
    const foreign = PrivateKey.fromRandom();
    const bad = Transaction.fromHex(seen());
    const foreignUnlock = await new P2PKH()
      .unlock(foreign, "all", false, 1, lockScript)
      .sign(bad, 0);
    bad.inputs[0].unlockingScript = foreignUnlock;
    assert.equal(await validateInput(bad.toHex(), 0, sources), false);
    // a lock that is not ours to cancel refuses
    const other = ordlockLockScript(TO, TO, 100);
    assert.equal(decodeOrdLock(other.toHex()).cancelAddress, TO);
    await rejectsCode(cancelOrdLock({ db, chain, origin: "cli", lockOutpoint: "ab".repeat(32) + ".0", fetchFn }), "RAILS");
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("ordlock RPCs answer over dispatch", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    chain.credit(addr, { txid: N1, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await setPolicy(db, "cli", "allow");
      const locked = await dispatch({
        method: "ordlockLock", params: { txid: N1, vout: 0, priceSats: 7000, origin: "cli" }, id: 1,
      });
      assert.equal(locked.result.lockOutpoint, `${locked.result.txid}.0`);
      const bad = await dispatch({ method: "ordlockLock", params: { txid: "zz", vout: 0, priceSats: 1 }, id: 2 });
      assert.equal(bad.error.code, "BAD_PARAM");
      const badBuy = await dispatch({ method: "ordlockBuy", params: { lockOutpoint: "zz" }, id: 3 });
      assert.equal(badBuy.error.code, "BAD_PARAM");
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
