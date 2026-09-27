import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-serve";
process.env.OPENROUTER_API_KEY = "test-key";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { __resetCache, createWallet, destroyWallet, selfAddress } from "../src/custody.ts";
import {
  b64json, parseProof, serveCall, serveMenu, servePrice, serveRequirement,
  serveSales, serveSetPrice,
} from "../src/serve.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

/** Payment tx paying `sats` to addr (inputs unchecked — the seller verifies outputs, miners verify inputs). */
import { P2PKH, Script, Transaction } from "@bsv/sdk";

function payTxHex(addr, sats) {
  const tx = new Transaction(2, [], [], 0);
  tx.addInput({
    unlockingScript: Script.fromHex(""),
    sourceTXID: "a".repeat(64), sourceOutputIndex: 0, sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats });
  return tx.toHex();
}

function jevFetch(score, confidence = 0.8) {
  return async () => new Response(JSON.stringify({
    model: "test", answers: { quality: { type: "score", score, confidence } },
    usage: { cost: 0.00002 },
  }), { status: 200 });
}

test("menu, pricing, quotes", async () => {
  const db = await memdb();
  await createWallet();
  try {
    const menu = await serveMenu(db);
    assert.deepEqual(menu.map((m) => [m.method, m.priceSats]), [["jevDecide", 50], ["memoryRecall", 20]]);
    assert.ok(menu.every((m) => m.payTo.length > 20));
    await serveSetPrice(db, "jevDecide", 75);
    assert.equal((await servePrice(db, "jevDecide")).priceSats, 75);
    await serveSetPrice(db, "jevDecide", 50);
    await assert.rejects(serveSetPrice(db, "nope", 10), /not sellable/);
    await assert.rejects(servePrice(db, "nope"), /not for sale/);
    const req = serveRequirement("jevDecide", 50, menu[0].payTo, "https://wallet/v1/serve/jevDecide");
    assert.equal(req.network, "bsv:mainnet");
    assert.equal(JSON.parse(Buffer.from(b64json(req), "base64").toString("utf8")).amount, "50");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("pay → execute → replay refused → underpay refused", async () => {
  const db = await memdb();
  await createWallet();
  try {
    const chain = new MockChainProvider();
    const addr = selfAddress();
    const deps = { db, chain, jevFetch: jevFetch(3, 0.7) };
    const params = { state: "pick the better output", questions: { quality: { type: "score", instructions: "rate", criteria: ["bad", "ok", "good", "great", "best"] } } };

    // unknown method has no price
    await assert.rejects(
      serveCall(deps, "walletDrain", {}, payTxHex(addr, 1000)),
      /not for sale/,
    );
    // underpayment: proof parses, output too small
    await assert.rejects(serveCall(deps, "jevDecide", params, payTxHex(addr, 10)), /no output paying/);
    // exact payment executes the method
    const out = await serveCall(deps, "jevDecide", params, payTxHex(addr, 50));
    assert.equal(out.receipt.method, "jevDecide");
    assert.equal(out.receipt.amountSats, 50);
    assert.match(out.receipt.txid, /^[0-9a-f]{64}$/);
    assert.equal(out.data.answers.quality.score, 3);
    // same txid never buys twice
    await assert.rejects(serveCall(deps, "jevDecide", params, payTxHex(addr, 50)), /already bought/);
    // garbage proof
    await assert.rejects(serveCall(deps, "jevDecide", params, "zz"), /no txHex|does not parse/);
    // sales ledger
    const sales = await serveSales(db);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].method, "jevDecide");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("memoryRecall serves through the same turnstile", async () => {
  const db = await memdb();
  await createWallet();
  try {
    const chain = new MockChainProvider();
    const out = await serveCall({ db, chain }, "memoryRecall", { query: "nothing here" }, payTxHex(selfAddress(), 20));
    assert.equal(out.data.board, "memory");
    assert.deepEqual(out.data.hits, []);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("unlisted method refuses even with payment", async () => {
  const db = await memdb();
  await createWallet();
  try {
    await serveSetPrice(db, "memoryRecall", 0);
    await assert.rejects(
      serveCall({ db, chain: new MockChainProvider() }, "memoryRecall", {}, payTxHex(selfAddress(), 999)),
      /not priced for sale/,
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("parseProof accepts the standard envelope", () => {
  const hex = payTxHex("1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4", 5);
  const env = b64json({ x402Version: 2, scheme: "exact", network: "bsv:mainnet", txHex: hex, encoding: "raw-hex" });
  assert.equal(parseProof(env), hex);
  assert.throws(() => parseProof("!!!"), /base64/);
});
