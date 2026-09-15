import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-ordsend";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { sendOrdinal } from "../src/engine.ts";
import { setPolicy } from "../src/policy.ts";
import { buildTx, p2pkhScript } from "../src/tx.ts";

// Our own mainnet address (valid P2PKH, deterministic) doubles as the
// recipient in these offline tests — nothing is broadcast.
const SELF = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("keepOrder pins the ordinal input first and pays it first", () => {
  const lock = p2pkhScript(SELF).toHex();
  const ordinal = { txid: "a".repeat(64), vout: 0, value: 1, scriptHex: lock };
  const funding = { txid: "b".repeat(64), vout: 3, value: 50_000, scriptHex: lock };
  const hook = () => ({ sign: async () => ({}) });
  const built = buildTx({
    utxos: [ordinal, funding], unlockFor: hook,
    payments: [{ address: SELF, sats: 1 }], changeScriptHex: lock, keepOrder: true,
  });
  assert.equal(built.tx.inputs[0].sourceTXID, ordinal.txid);
  assert.equal(built.tx.outputs[0].satoshis, 1);
  assert.equal(built.tx.outputs[0].lockingScript.toHex(), p2pkhScript(SELF).toHex());
  // default path still sorts value-desc
  const sorted = buildTx({
    utxos: [ordinal, funding], unlockFor: hook,
    payments: [{ address: SELF, sats: 1 }], changeScriptHex: lock,
  });
  assert.equal(sorted.tx.inputs[0].sourceTXID, funding.txid);
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("ordinal send is policy-gated, tracked, and debited", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const addr = selfAddress();
    chain.credit(addr, { txid: "c".repeat(64), vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: "d".repeat(64), vout: 0, value: 5_000_000, height: 900 });

    await assert.rejects(
      sendOrdinal({ db, chain, origin: "cli", txid: "c".repeat(64), vout: 0, to: SELF }),
      /first-run approval/,
    );
    await setPolicy(db, "cli", "allow");
    const r = await sendOrdinal({ db, chain, origin: "cli", txid: "c".repeat(64), vout: 0, to: SELF });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.ok(r.fee >= 100);
    const rows = await db("pending_txs").where({ txid: r.txid });
    assert.equal(rows.length, 1);
    assert.match(rows[0].label, /^send c{8}/);
    const labels = await db("basket_members").where({ txid: r.txid });
    assert.ok(labels.length >= 1); // change attributed
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("ordinal send refuses unknown, non-1-sat, and bad-address inputs", async () => {
  const db = await memdb();
  try {
    await createWallet();
    const chain = new MockChainProvider();
    const addr = selfAddress();
    chain.credit(addr, { txid: "e".repeat(64), vout: 0, value: 500, height: 900 });
    await setPolicy(db, "cli", "allow");
    await assert.rejects(
      sendOrdinal({ db, chain, origin: "cli", txid: "f".repeat(64), vout: 0, to: SELF }),
      /not in wallet/,
    );
    await assert.rejects(
      sendOrdinal({ db, chain, origin: "cli", txid: "e".repeat(64), vout: 0, to: SELF }),
      /exactly 1 sat/,
    );
    await assert.rejects(
      sendOrdinal({ db, chain, origin: "cli", txid: "e".repeat(64), vout: 0, to: "not-an-address" }),
      /valid P2PKH/,
    );
    await assert.rejects(
      sendOrdinal({ db, chain, origin: "cli", txid: "zzz", vout: 0, to: SELF }),
      /outpoint/,
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
