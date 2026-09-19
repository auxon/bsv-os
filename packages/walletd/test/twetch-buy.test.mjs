import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-twetchbuy";
import knex from "knex";
import { Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { setPolicy } from "../src/policy.ts";
import { dispatch, setBackend } from "../src/rpc.ts";
import { inscriptionScript } from "../src/tokens.ts";
import { p2pkhScript } from "../src/tx.ts";

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

const N1 = "b".repeat(64);
const F1 = "d".repeat(64);
const X1 = "e".repeat(64);
const TO = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";
const OUT = `${"a".repeat(64)}.0`;

function parentHex(outputs) {
  const tx = new Transaction();
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
    [X1]: () => parentHex([{ scriptHex: inscriptionScript(TO, "image/png", "0102"), sats: 1 }]),
  };
  const fetchFn = async (url) => {
    const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
    if (m && hexes[m[1]]) return new Response(hexes[m[1]](), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  return { fetchFn, hexes };
}

async function backend() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  const chain = new MockChainProvider();
  setBackend({ db, chain });
  return { db, chain };
}

it("twetchBuy direct pays the seller through policy", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
      await setPolicy(db, "twetch", "allow");
      const res = await dispatch({
        method: "twetchBuy",
        params: { outpoint: OUT, priceSats: 5000, sellerAddress: TO },
        id: 1,
      });
      assert.match(res.result.txid, /^[0-9a-f]{64}$/);
      assert.equal(res.result.atomic, false);
      assert.ok(res.result.fee > 0);
      const rows = await db("pending_txs").where({ txid: res.result.txid });
      assert.equal(rows.length, 1);
      assert.match(rows[0].label, /^twetch buy /);
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

it("twetchBuy denies without approval and validates input", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
      const denied = await dispatch({
        method: "twetchBuy",
        params: { outpoint: OUT, priceSats: 5000, sellerAddress: TO },
        id: 2,
      });
      assert.equal(denied.error.code, "POLICY_DENY");
      const badOut = await dispatch({
        method: "twetchBuy", params: { outpoint: "nope", priceSats: 5, sellerAddress: TO }, id: 3,
      });
      assert.equal(badOut.error.code, "BAD_PARAM");
      const badPrice = await dispatch({
        method: "twetchBuy", params: { outpoint: OUT, priceSats: 0, sellerAddress: TO }, id: 4,
      });
      assert.equal(badPrice.error.code, "BAD_PARAM");
      const badSeller = await dispatch({
        method: "twetchBuy", params: { outpoint: OUT, priceSats: 5 }, id: 5,
      });
      assert.equal(badSeller.error.code, "BAD_PARAM");
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

it("twetchBuy atomic completes swap offers", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
      await setPolicy(db, "twetch", "allow");
      const listed = await dispatch({
        method: "twetchList",
        params: { outpoint: `${N1}.0`, priceSats: 5000 },
        id: 6,
      });
      assert.equal(listed.result.kind, "ordinal");
      assert.equal(listed.result.version, 2);
      const res = await dispatch({
        method: "twetchBuy",
        params: {
          outpoint: `${N1}.0`, priceSats: 5000, sellerAddress: addr,
          offer: listed.result,
        },
        id: 7,
      });
      assert.equal(res.result.atomic, true);
      assert.match(res.result.txid, /^[0-9a-f]{64}$/);
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

it("twetchList signs only our carriers", async () => {
  const { db } = await backend();
  try {
    await createWallet();
    const { fetchFn } = makeNet(selfAddress());
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await setPolicy(db, "twetch", "allow");
      const foreign = await dispatch({
        method: "twetchList",
        params: { outpoint: `${X1}.0`, priceSats: 5000 },
        id: 8,
      });
      assert.equal(foreign.error.code, "NOT_OURS");
      const bad = await dispatch({
        method: "twetchList", params: { outpoint: "nope", priceSats: 5 }, id: 9,
      });
      assert.equal(bad.error.code, "BAD_PARAM");
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
