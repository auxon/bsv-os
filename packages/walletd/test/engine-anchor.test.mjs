import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-engine";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { anchorTip, getBalance } from "../src/engine.ts";
import { setPolicy } from "../src/policy.ts";

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

it("anchor flow: policy gate, then spend, broadcast, track", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const addr = selfAddress();
    chain.credit(addr, { txid: "f".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    const sha = "d".repeat(64);

    // first attempt: unknown origin -> denied + pending request
    await assert.rejects(anchorTip({ db, chain, origin: "cli", sha256: sha }), /first-run approval/);
    await setPolicy(db, "cli", "allow");

    const r = await anchorTip({ db, chain, origin: "cli", sha256: sha });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.ok(r.fee >= 100);

    const bal = await getBalance(chain);
    assert.equal(bal.address, addr);

    const rows = await db("pending_txs").where({ txid: r.txid });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "seen");

    chain.mine();
    const st = await chain.status(r.txid);
    assert.equal(st.status, "MINED");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
