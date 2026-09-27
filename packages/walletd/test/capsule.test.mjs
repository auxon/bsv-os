import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-capsule";
delete process.env.OPENROUTER_API_KEY;
import knex from "knex";
import { P2PKH, Transaction } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { __resetCache, createWallet, destroyWallet, selfAddress } from "../src/custody.ts";
import { setPolicy } from "../src/policy.ts";
import { unavailableUtxos } from "../src/baskets.ts";
import {
  cancelCapsule, claimCapsule, getCapsule, lockCapsule, parseUnlockAt,
  remaining, tickCapsules,
} from "../src/capsule.ts";

const TIP = { blocks: 1000, mediantime: 1700000000 };
const LATER = { blocks: 1010, mediantime: 1700001000 };

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

/** Parent tx hex paying `sats` to addr at vout 0 (for lockingScriptOf). */
function parentHex(addr, sats) {
  const tx = new Transaction(2, [], [], 0);
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats });
  return tx.toHex();
}

/** Stub fetch serving parent hexes for lockingScriptOf; records calls. */
function stubFetch(parents) {
  return async (url) => {
    const m = /\/tx\/([0-9a-fA-F]{64})\/hex$/.exec(String(url));
    const hex = m ? parents[m[1].toLowerCase()] : null;
    if (!hex) return new Response("no", { status: 404 });
    return new Response(hex, { status: 200 });
  };
}

test("parseUnlockAt: heights, dates, relative blocks", () => {
  assert.deepEqual(parseUnlockAt("1050", TIP), { locktime: 1050, kind: "height" });
  assert.deepEqual(parseUnlockAt("+100", TIP), { locktime: 1100, kind: "height" });
  assert.deepEqual(parseUnlockAt("2027-01-01", TIP), { locktime: Date.parse("2027-01-01") / 1000, kind: "time" });
  assert.throws(() => parseUnlockAt("1000", TIP), /future/);
  assert.throws(() => parseUnlockAt("900", TIP), /future/);
  assert.throws(() => parseUnlockAt("2020-01-01", TIP), /future/);
  assert.throws(() => parseUnlockAt("soon", TIP), /height, ISO date/);
  assert.throws(() => parseUnlockAt("", TIP), /required/);
});

test("remaining counts down to payable", () => {
  assert.equal(remaining({ locktime: 1062, kind: "height" }, TIP), 62);
  assert.equal(remaining({ locktime: 1000, kind: "height" }, TIP), 0);
  assert.equal(remaining({ locktime: 1700003600, kind: "time" }, TIP), 3600);
});

async function setup() {
  const db = await memdb();
  await createWallet();
  await setPolicy(db, "capsule", "allow");
  const addr = selfAddress();
  const chain = new MockChainProvider();
  const fundTxid = "f".repeat(64);
  const fundTxid2 = "e".repeat(64);
  chain.credit(addr, { txid: fundTxid, vout: 0, value: 50_000, height: 900 });
  chain.credit(addr, { txid: fundTxid2, vout: 0, value: 50_000, height: 900 });
  const fetchFn = stubFetch({ [fundTxid]: parentHex(addr, 50_000), [fundTxid2]: parentHex(addr, 50_000) });
  return { db, chain, addr, fetchFn, fundTxid };
}

test("lock reserves coins; claim pays at maturity; cancel releases", async () => {
  const { db, chain, addr, fetchFn } = await setup();
  try {
    const c = await lockCapsule({ db, chain, fetchFn }, {
      amount: 5000, unlockAt: "+2", message: "birthday", tip: TIP,
    });
    assert.equal(c.locktime, 1002);
    assert.equal(c.status, "locked");
    assert.equal(c.message, "birthday");
    assert.ok(c.reserved.length > 0);

    // reserved coins are excluded from selection everywhere
    const un = await unavailableUtxos(db);
    for (const o of c.reserved) assert.ok(un.has(o), o);

    // early claim refuses with countdown
    await assert.rejects(claimCapsule({ db, chain, fetchFn }, c.id, TIP), /~2 blocks/);

    // maturity pays to self with the note; reservation released
    const res = await claimCapsule({ db, chain, fetchFn }, c.id, LATER);
    assert.equal(res.amount, 5000);
    assert.match(res.txid, /^[0-9a-f]{64}$/);
    assert.equal((await getCapsule(db, c.id)).status, "claimed");
    // reservation rows gone; the consumed outpoint stays excluded as spent
    assert.equal((await db("reserved_utxos").select()).length, 0);

    // second claim refused
    await assert.rejects(claimCapsule({ db, chain, fetchFn }, c.id, LATER), /claimed/);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("ticker auto-pays matured capsules and skips the rest", async () => {
  const { db, chain, addr, fetchFn } = await setup();
  try {
    const due = await lockCapsule({ db, chain, fetchFn }, { amount: 2000, unlockAt: "+1", tip: TIP });
    const later = await lockCapsule({ db, chain, fetchFn }, { amount: 2000, unlockAt: "+50", tip: TIP });
    void addr;
    const res = await tickCapsules({ db, chain, fetchFn }, { blocks: 1001, mediantime: 1700000100 });
    assert.deepEqual(res.map((r) => [r.capsule, r.outcome]), [[due.id, "paid"]]);
    assert.equal((await getCapsule(db, due.id)).status, "claimed");
    assert.equal((await getCapsule(db, later.id)).status, "locked");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("cancel is the escape hatch", async () => {
  const { db, chain, fetchFn } = await setup();
  try {
    const c = await lockCapsule({ db, chain, fetchFn }, { amount: 3000, unlockAt: "+100", tip: TIP });
    const out = await cancelCapsule(db, c.id);
    assert.equal(out.status, "cancelled");
    assert.equal((await unavailableUtxos(db)).size, 0);
    await assert.rejects(claimCapsule({ db, chain, fetchFn }, c.id, LATER), /cancelled/);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
