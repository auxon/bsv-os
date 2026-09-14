import { test } from "node:test";
import assert from "node:assert/strict";
import { MockChainStorage, MockMiner } from "@bsv/wallet-toolbox";
import knex from "knex";

function memknex() {
  return knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
}

test("mockchain: migrate, insert, mine, tip advances", async () => {
  const db = memknex();
  try {
    const storage = new MockChainStorage(db);
    await storage.migrate();
    const miner = new MockMiner();
    const h1 = await miner.mineBlock(storage);
    assert.ok(h1, "first header");
    const tip1 = await storage.getChainTip();
    assert.equal(tip1.height, 0);
    // insert an unmined tx, mine again, tip advances and tx is included
    await storage.insertTransaction("ab".repeat(32), [1, 2, 3]);
    const unmined = await storage.getUnminedTransactions();
    assert.equal(unmined.length, 1);
    await miner.mineBlock(storage);
    const tip2 = await storage.getChainTip();
    assert.equal(tip2.height, 1);
    assert.equal((await storage.getUnminedTransactions()).length, 0);
  } finally {
    await db.destroy();
  }
});
