import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-baskets";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { anchorTip } from "../src/engine.ts";
import { setPolicy } from "../src/policy.ts";
import {
  assignUtxo,
  basketBalances,
  createBasket,
  DEFAULT_BASKET,
  labelOutputs,
  removeBasket,
  resolveBasketForOrigin,
} from "../src/baskets.ts";

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

test("baskets validate names and guard the default pot", async () => {
  const db = await memdb();
  try {
    await rejectsCode(createBasket(db, "bad name!"), "BAD_PARAM");
    await createBasket(db, "savings", "rainy day fund");
    await rejectsCode(createBasket(db, "savings"), "EXISTS");
    await rejectsCode(removeBasket(db, "default"), "BAD_PARAM");
    await rejectsCode(removeBasket(db, "ghost"), "NOT_FOUND");
  } finally {
    await db.destroy();
  }
});

test("balances join live UTXOs to labels; unlabeled is default", async () => {
  const db = await memdb();
  try {
    const chain = new MockChainProvider();
    const addr = "bcrt1qtestaddress000000000000000000000000";
    chain.credit(addr, { txid: "a".repeat(64), vout: 0, value: 1000, height: 100 });
    chain.credit(addr, { txid: "b".repeat(64), vout: 1, value: 2500, height: 0 });
    chain.credit(addr, { txid: "c".repeat(64), vout: 0, value: 500, height: 100 });
    await createBasket(db, "savings");
    await assignUtxo(db, "a".repeat(64), 0, "savings");
    await assignUtxo(db, "c".repeat(64), 0, "savings");

    const views = Object.fromEntries((await basketBalances(db, chain, addr)).map((v) => [v.name, v]));
    assert.equal(views.savings.balance, 1500);
    assert.equal(views.savings.memberCount, 2);
    assert.equal(views.default.balance, 2500); // unlabeled unconfirmed output
    assert.equal(views.default.memberCount, 1);

    // relabel moves the funds; removing the basket releases to default
    await assignUtxo(db, "a".repeat(64), 0, "default");
    const rel = await removeBasket(db, "savings");
    assert.equal(rel.released, 1);
    const after = Object.fromEntries((await basketBalances(db, chain, addr)).map((v) => [v.name, v]));
    assert.equal(after.default.balance, 4000);
    assert.ok(!("savings" in after));
    await rejectsCode(assignUtxo(db, "a".repeat(64), 0, "savings"), "NOT_FOUND");
    await rejectsCode(assignUtxo(db, "zzz", 0, "default"), "BAD_PARAM");
  } finally {
    await db.destroy();
  }
});

test("origin resolves to its same-named basket, else default", async () => {
  const db = await memdb();
  try {
    assert.equal(await resolveBasketForOrigin(db, "nightshift"), DEFAULT_BASKET);
    await createBasket(db, "nightshift");
    assert.equal(await resolveBasketForOrigin(db, "nightshift"), "nightshift");
  } finally {
    await db.destroy();
  }
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("anchor change auto-labels to the origin basket", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const addr = selfAddress();
    chain.credit(addr, { txid: "f".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    await createBasket(db, "runbot");
    await setPolicy(db, "runbot", "allow");
    await setPolicy(db, "cli", "allow");
    const sha = "b".repeat(64);

    const r1 = await anchorTip({ db, chain, origin: "runbot", sha256: sha });
    const labels = await db("basket_members").where({ txid: r1.txid });
    assert.ok(labels.length >= 1);
    assert.ok(labels.every((l) => l.basket === "runbot"));

    const r2 = await anchorTip({ db, chain, origin: "cli", sha256: "c".repeat(64) });
    const plain = await db("basket_members").where({ txid: r2.txid });
    assert.ok(plain.length >= 1);
    assert.ok(plain.every((l) => l.basket === DEFAULT_BASKET)); // no "cli" basket: falls back
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("chain-lag ghosts are excluded until the spend fails", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const addr = selfAddress();
    const funding = { txid: "d".repeat(64), vout: 0, value: 5_000_000, height: 900 };
    chain.credit(addr, funding);
    await setPolicy(db, "cli", "allow");
    const r = await anchorTip({ db, chain, origin: "cli", sha256: "d".repeat(64) });
    // stale index: still lists the consumed funding output as live
    const staleChain = {
      utxos: async () => ({
        confirmed: 0, unconfirmed: 0,
        utxos: [{ txid: funding.txid, vout: funding.vout, value: funding.value, height: 100 }],
      }),
    };
    const ghosted = Object.fromEntries((await basketBalances(db, staleChain, addr)).map((v) => [v.name, v]));
    assert.equal(ghosted.default.balance, 0, "spent-by-us output excluded while seen");
    // loser of a double-spend race: nothing moved, the output counts again
    await db("pending_txs").where({ txid: r.txid }).update({ status: "failed" });
    const restored = Object.fromEntries((await basketBalances(db, staleChain, addr)).map((v) => [v.name, v]));
    assert.equal(restored.default.balance, 5_000_000);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
