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

test("lockingScriptOf backs off on 429 and succeeds", async () => {
  const { lockingScriptOf } = await import("../src/engine.ts");
  const { Transaction, UnlockingScript } = await import("@bsv/sdk");
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "f".repeat(64), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) });
  tx.addOutput({ lockingScript: new (await import("@bsv/sdk")).P2PKH().lock("1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm"), satoshis: 42 });
  const hex = tx.toHex();
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n < 3) return new Response("slow down", { status: 429 });
    return new Response(hex, { status: 200 });
  };
  const out = await lockingScriptOf("a".repeat(64), 0, flaky);
  assert.equal(n, 3);
  assert.equal(out.value, 42);
  // a hard 404 fails fast (no retry)
  let m = 0;
  const notFound = async () => {
    m += 1;
    return new Response("nope", { status: 404 });
  };
  await assert.rejects(lockingScriptOf("a".repeat(64), 0, notFound), /404/);
  assert.equal(m, 1);
});
