import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { list, tick, track } from "../src/monitor.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("seen -> mined on confirmation", async () => {
  const db = await memdb();
  try {
    const chain = new MockChainProvider();
    const { txid } = await chain.broadcast("aa".repeat(100));
    await track(db, txid, "test");
    let rows = await list(db);
    assert.equal(rows[0].status, "seen");
    chain.mine();
    const res = await tick(db, chain, async () => undefined, async () => null);
    assert.deepEqual(res.map((r) => [r.txid, r.from, r.to]), [[txid, "seen", "mined"]]);
    rows = await list(db);
    assert.equal(rows[0].status, "mined");
  } finally {
    await db.destroy();
  }
});

test("double-spend race: loser marked failed, winner mined, funds safe", async () => {
  // PocketPets Torto incident, replayed: two txs, same funding coin.
  const db = await memdb();
  try {
    const chain = new MockChainProvider();
    const a = await chain.broadcast("a1".repeat(100));
    const b = await chain.broadcast("b2".repeat(100));
    await track(db, a.txid, "pull");
    await track(db, b.txid, "mint");
    chain.mine(); // network confirms A first...
    chain.reject(b.txid, [a.txid], "double spend attempted"); // ...and rejects B
    const res = await tick(db, chain, async () => undefined, async () => null);
    const byId = Object.fromEntries(res.map((r) => [r.txid, r]));
    assert.equal(byId[a.txid].to, "mined");
    assert.equal(byId[b.txid].to, "failed");
    assert.match(byId[b.txid].detail ?? "", /double spend/);
    const rows = await list(db);
    assert.equal(rows.find((r) => r.txid === b.txid)?.status, "failed");
    // loser's money never moved: no debit is recorded anywhere — the failed
    // row is the entire accounting. Re-tick is a no-op (terminal).
    const again = await tick(db, chain, async () => undefined, async () => null);
    assert.deepEqual(again, []);
  } finally {
    await db.destroy();
  }
});

test("unseen txs are rebroadcast periodically, then left alone", async () => {
  const db = await memdb();
  try {
    const chain = new MockChainProvider();
    const { txid } = await chain.broadcast("cc".repeat(100));
    await track(db, txid, "slow");
    let relays = 0;
    const rebroadcast = async () => {
      relays++;
    };
    for (let i = 0; i < 4; i++) await tick(db, chain, rebroadcast, async () => "cc".repeat(100));
    assert.equal(relays, 0);
    await tick(db, chain, rebroadcast, async () => "cc".repeat(100)); // 5th
    assert.equal(relays, 1);
    const rows = await list(db);
    assert.equal(rows[0].status, "seen");
    assert.equal(rows[0].attempts, 5);
  } finally {
    await db.destroy();
  }
});

test("reorg: mined tx that vanishes goes back to seen", async () => {
  const db = await memdb();
  try {
    const chain = new MockChainProvider();
    const { txid } = await chain.broadcast("dd".repeat(100));
    await track(db, txid, "reorg-me");
    chain.mine();
    await tick(db, chain, async () => undefined, async () => null);
    assert.equal((await list(db))[0].status, "mined");
    assert.equal(chain.reorg(txid), true);
    // age the check so the reorg watch picks it up (daemon re-verifies mined rows ~minutely)
    await db("pending_txs").where({ txid }).update({ last_check: Date.now() - 61 * 1000 });
    const res = await tick(db, chain, async () => undefined, async () => null);
    assert.deepEqual(res.map((r) => [r.from, r.to]), [["mined", "seen"]]);
    assert.equal((await list(db))[0].status, "seen");
  } finally {
    await db.destroy();
  }
});
