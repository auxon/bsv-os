import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-swaps";
import knex from "knex";
import { Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { inscribeMint, spendTo } from "../src/engine.ts";
import { installApp } from "../src/apps.ts";
import { seedRequest, setPolicy } from "../src/policy.ts";
import { dispatch, setBackend } from "../src/rpc.ts";
import { completeSwap, signSwapOffer, SWAP_LOCKTIME, SWAP_SEQ, SWAP_VERSION } from "../src/swaps.ts";
import { inscriptionScript } from "../src/tokens.ts";
import { p2pkhScript } from "../src/tx.ts";

const TO = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";
const N1 = "b".repeat(64);
const F1 = "d".repeat(64);
const X1 = "e".repeat(64);
const F3 = "1".repeat(64);

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
    [F3]: () => parentHex([{ scriptHex: inscriptionScript(selfAddr, "image/png", "abcd"), sats: 200_000 }]),
    [X1]: () => parentHex([{ scriptHex: inscriptionScript(TO, "image/png", "0102"), sats: 1 }]),
  };
  const fetchFn = async (url) => {
    const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
    if (m && hexes[m[1]]) return new Response(hexes[m[1]](), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  return { fetchFn };
}

const MANIFEST = {
  name: "Game Demo",
  start_url: "/play",
  metanet: { groupPermissions: { spendingAuthorization: { amount: 100000 } } },
};

async function gameBackend() {
  const db = await memdb();
  const chain = new MockChainProvider();
  setBackend({ db, chain });
  await installApp(db, "game.example", {
    seedPolicyRequest: (origin, amountSats, action) => seedRequest(db, origin, amountSats, action),
  }, { fetchManifest: async () => MANIFEST });
  return { db, chain };
}

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("swap offer is template-exact and always pays self", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    await setPolicy(db, "game.example", "allow");
    const offer = await signSwapOffer({
      db, chain, origin: "game.example", txid: N1, vout: 0, priceSats: 5000, fetchFn,
    });
    assert.equal(offer.version, SWAP_VERSION);
    assert.equal(offer.lockTime, SWAP_LOCKTIME);
    assert.deepEqual(offer.input, {
      txid: N1, vout: 0,
      scriptHex: inscriptionScript(addr, "image/png", "0102"),
      sequence: SWAP_SEQ,
    });
    assert.equal(offer.payScriptHex, p2pkhScript(addr).toHex());
    assert.equal(offer.priceSats, 5000);
    assert.match(offer.unlockHex, /^[0-9a-f]+$/);
    // unlock is a real P2PKH unlock (sig + pubkey), not a stub
    const unlock = Script.fromHex(offer.unlockHex);
    assert.ok(unlock.chunks.length >= 2);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("offer refuses foreign, non-dust, plain carriers and bad params", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    await setPolicy(db, "game.example", "allow");
    const base = { db, chain, origin: "game.example", txid: N1, vout: 0, priceSats: 5000, fetchFn };
    await rejectsCode(signSwapOffer({ ...base, txid: X1 }), "NOT_OURS");
    await rejectsCode(signSwapOffer({ ...base, txid: F1, vout: 0 }), "BAD_PARAM"); // plain, not inscribed
    await rejectsCode(signSwapOffer({ ...base, priceSats: 0 }), "BAD_PARAM");
    await rejectsCode(signSwapOffer({ ...base, priceSats: -5 }), "BAD_PARAM");
    await rejectsCode(signSwapOffer({ ...base, txid: "zzz" }), "BAD_PARAM");
    await rejectsCode(signSwapOffer({ ...base, txid: F1, vout: 0, priceSats: 10 }), "BAD_PARAM");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("offer signing is policy-gated", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    await rejectsCode(
      signSwapOffer({ db, chain, origin: "game.example", txid: N1, vout: 0, priceSats: 5000, fetchFn }),
      "POLICY_DENY",
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("completion settles payment plus NFT atomically", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    let seen = "";
    const origBroadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (hex) => {
      seen = hex;
      return origBroadcast(hex);
    };
    await setPolicy(db, "game.example", "allow");
    const offer = await signSwapOffer({
      db, chain, origin: "game.example", txid: N1, vout: 0, priceSats: 5000, fetchFn,
    });
    const r = await completeSwap({
      db, chain, origin: "game.example", offer,
      fee: { to: TO, sats: 100 }, memo: ["POCKETPETS-BUY", "test"],
      fetchFn,
    });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.ok(r.fee >= 100);
    const tx = Transaction.fromHex(seen);
    const ins = tx.inputs.map((i) => `${i.sourceTXID}:${i.sourceOutputIndex}`);
    assert.deepEqual(ins[0], `${N1}:0`);
    assert.ok(ins.some((s) => s.startsWith(F1)));
    // output 0: byte-exact seller terms; output 1: NFT sat to buyer
    assert.equal(tx.outputs[0].lockingScript.toHex(), offer.payScriptHex);
    assert.equal(tx.outputs[0].satoshis, 5000);
    assert.equal(tx.outputs[1].lockingScript.toHex(), p2pkhScript(addr).toHex());
    assert.equal(tx.outputs[1].satoshis, 1);
    // output 2: market fee; output 3: memo
    assert.equal(tx.outputs[2].lockingScript.toHex(), p2pkhScript(TO).toHex());
    assert.equal(tx.outputs[2].satoshis, 100);
    assert.ok(tx.outputs[3].lockingScript.toHex().startsWith("006a"));
    assert.ok(tx.outputs[3].lockingScript.toHex().includes(Buffer.from("POCKETPETS-BUY", "utf8").toString("hex")));
    const rows = await db("pending_txs").where({ txid: r.txid });
    assert.equal(rows.length, 1);
    assert.match(rows[0].label, /^swap buy 5000/);
    const labels = await db("basket_members").where({ txid: r.txid });
    assert.ok(labels.length >= 2); // NFT + sat change
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("completion rejects tampered offers before signing", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    await setPolicy(db, "game.example", "allow");
    const good = await signSwapOffer({
      db, chain, origin: "game.example", txid: N1, vout: 0, priceSats: 5000, fetchFn,
    });
    const base = { db, chain, origin: "game.example", fetchFn };
    await rejectsCode(completeSwap({ ...base, offer: {} }), "BAD_OFFER");
    await rejectsCode(completeSwap({ ...base, offer: { ...good, version: 3 } }), "BAD_OFFER");
    await rejectsCode(completeSwap({ ...base, offer: { ...good, lockTime: 1 } }), "BAD_OFFER");
    await rejectsCode(
      completeSwap({ ...base, offer: { ...good, input: { ...good.input, sequence: 0 } } }),
      "BAD_OFFER",
    );
    await rejectsCode(completeSwap({ ...base, offer: { ...good, payScriptHex: "00" } }), "BAD_OFFER");
    await rejectsCode(
      completeSwap({ ...base, offer: { ...good, input: { ...good.input, scriptHex: inscriptionScript(TO, "image/png", "0102") } } }),
      "BAD_OFFER",
    );
    await rejectsCode(completeSwap({ ...base, offer: { ...good, unlockHex: "zz" } }), "BAD_OFFER");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("spendTo pays many with memo and skips inscribed funding", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: F3, vout: 0, value: 200_000, height: 900 });
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    let seen = "";
    const origBroadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (hex) => {
      seen = hex;
      return origBroadcast(hex);
    };
    await rejectsCode(
      spendTo({ db, chain, origin: "game.example", payments: [{ to: TO, sats: 1000 }], fetchFn }),
      "POLICY_DENY",
    );
    await setPolicy(db, "game.example", "allow");
    const r = await spendTo({
      db, chain, origin: "game.example",
      payments: [{ to: TO, sats: 1000 }, { to: addr, sats: 2000 }],
      memo: ["POCKETPETS-TEST", "x"], label: "t", fetchFn,
    });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    const tx = Transaction.fromHex(seen);
    const ins = tx.inputs.map((i) => `${i.sourceTXID}:${i.sourceOutputIndex}`);
    assert.ok(!ins.some((s) => s.startsWith(F3)), "inscribed funding skipped");
    assert.ok(ins.some((s) => s.startsWith(F1)));
    assert.equal(tx.outputs[0].satoshis, 1000);
    assert.equal(tx.outputs[1].satoshis, 2000);
    const memoOut = tx.outputs.find((o) => o.lockingScript.toHex().startsWith("006a"));
    assert.ok(memoOut);
    assert.ok(memoOut.lockingScript.toHex().includes(Buffer.from("POCKETPETS-TEST", "utf8").toString("hex")));
    await rejectsCode(spendTo({ db, chain, origin: "game.example", payments: [], fetchFn }), "BAD_PARAM");
    await rejectsCode(
      spendTo({
        db, chain, origin: "game.example", payments: [{ to: TO, sats: 1 }],
        memo: ["a", "b", "c", "d", "e", "f"], fetchFn,
      }),
      "BAD_PARAM",
    );
    await rejectsCode(
      spendTo({ db, chain, origin: "game.example", payments: [{ to: "nope", sats: 1 }], fetchFn }),
      "BAD_PARAM",
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("inscribe mints bounded inscriptions policy-gated", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const chain = new MockChainProvider();
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    let seen = "";
    const origBroadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (hex) => {
      seen = hex;
      return origBroadcast(hex);
    };
    const dataHex = Buffer.from("pixel-pet", "utf8").toString("hex");
    await assert.rejects(
      inscribeMint({ db, chain, origin: "game.example", dataHex, contentType: "image/png", fetchFn }),
      /first-run approval/,
    );
    await setPolicy(db, "game.example", "allow");
    const r = await inscribeMint({ db, chain, origin: "game.example", dataHex, contentType: "image/png", fetchFn });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    const tx = Transaction.fromHex(seen);
    assert.equal(tx.outputs[0].lockingScript.toHex(), inscriptionScript(addr, "image/png", dataHex));
    assert.equal(tx.outputs[0].satoshis, 1);
    const r2 = await inscribeMint({
      db, chain, origin: "game.example", dataHex, contentType: "image/png",
      fee: { to: TO, sats: 500 }, memo: ["POCKETPETS-MINT", "pet-1"], fetchFn,
    });
    assert.match(r2.txid, /^[0-9a-f]{64}$/);
    const tx2 = Transaction.fromHex(seen);
    assert.equal(tx2.outputs[1].lockingScript.toHex(), p2pkhScript(TO).toHex());
    assert.equal(tx2.outputs[1].satoshis, 500);
    assert.ok(tx2.outputs[2].lockingScript.toHex().startsWith("006a"));
    await rejectsCode(
      inscribeMint({ db, chain, origin: "game.example", dataHex: "zz", contentType: "image/png", fetchFn }),
      "BAD_PARAM",
    );
    await rejectsCode(
      inscribeMint({ db, chain, origin: "game.example", dataHex, contentType: "has space", fetchFn }),
      "BAD_PARAM",
    );
    await rejectsCode(
      inscribeMint({ db, chain, origin: "game.example", dataHex: "ab", contentType: "image/png", to: "nope", fetchFn }),
      "BAD_PARAM",
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("appInvoke serves game intents under the app origin", async () => {
  const { db, chain } = await gameBackend();
  // spendTo verifies funding scripts over HTTP — stub the network for the
  // MockChain outpoints (production uses the live indexer the same way).
  const realFetch = globalThis.fetch;
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    globalThis.fetch = fetchFn;
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    chain.credit(addr, { txid: N1, vout: 0, value: 1, height: 900 });
    const invoke = (method, callParams) => dispatch({
      method: "appInvoke", params: { domain: "game.example", method, callParams }, id: 1,
    });
    const utxos = await invoke("getUtxos", {});
    assert.equal(utxos.result.address, addr);
    assert.equal(utxos.result.utxos.length, 2);
    assert.deepEqual(Object.keys(utxos.result.utxos[0]).sort(), ["height", "txid", "value", "vout"]);
    const denied = await invoke("spend", { payments: [{ to: TO, sats: 1000 }] });
    assert.equal(denied.error.code, "POLICY_DENY");
    await setPolicy(db, "game.example", "allow");
    const spent = await invoke("spend", { payments: [{ to: TO, sats: 1000 }], memo: ["POCKETPETS-TEST"] });
    assert.match(spent.result.txid, /^[0-9a-f]{64}$/);
    const bad = await invoke("spend", { payments: [] });
    assert.equal(bad.error.code, "BAD_PARAM");
    const moved = await invoke("transferNft", { txid: N1, vout: 0, to: TO });
    assert.match(moved.result.txid, /^[0-9a-f]{64}$/);
  } finally {
    globalThis.fetch = realFetch;
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
