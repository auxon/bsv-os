import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-streams";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  MIN_TICK_SATS, createStream, getStream, listStreams, listTicks,
  parseTick, setStreamStatus, streamBeatRef, tickStreams,
} from "../src/streams.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("parseTick bounds", () => {
  assert.equal(parseTick("5m"), 300_000);
  assert.equal(parseTick(90), 90_000);
  assert.throws(() => parseTick("30s"), /minimum tick/);
  assert.throws(() => parseTick("25h"), /maximum tick/);
  assert.throws(() => parseTick("soon"), /interval like/);
});

test("createStream validates and reports fee share", async () => {
  const db = await memdb();
  try {
    const s = await createStream(db, {
      name: "coach", payee: "1abc", ratePerMin: 500, every: "5m", maxTotal: 50_000, board: "memory",
    });
    assert.match(s.id, /^stm_/);
    assert.equal(s.tickSats, 2500);
    assert.ok(s.feeShare < 0.2);
    assert.equal(s.status, "active");
    await assert.rejects(
      createStream(db, { name: "x", payee: "1abc", ratePerMin: 0, every: "5m", maxTotal: 50_000, board: "memory" }),
      /rate must be positive/,
    );
    await assert.rejects(
      createStream(db, { name: "x", payee: "1abc", ratePerMin: 10, every: "5m", maxTotal: 10, board: "memory" }),
      /at least/,
    );
  } finally {
    await db.destroy();
  }
});

async function seedStream(db, over = {}) {
  return createStream(db, {
    name: "work", payee: "1WorkerAddressXYZ", ratePerMin: 600, every: "60s",
    maxTotal: 100_000, board: "memory", now: 1_000_000, ...over,
  });
}

function deps(beat, paid = []) {
  return {
    latestBeat: async () => beat,
    pay: async (_s, amount, beatId) => {
      paid.push({ amount, beatId });
      return { txid: "t".repeat(64), fee: 200 };
    },
  };
}

test("fresh beat pays rate x elapsed", async () => {
  const db = await memdb();
  try {
    const s = await seedStream(db);
    const paid = [];
    // due at 1_060_000; run at 1_120_000: 2 min elapsed x 600 = 1200 (clears floor); beat 30s old
    const res = await tickStreams(db, deps({ id: "beat1", ts: 1_120_000 - 30_000 }, paid), 1_120_000);
    assert.equal(res[0].outcome, "paid");
    assert.equal(paid[0].amount, 1200);
    const after = await getStream(db, s.id);
    assert.equal(after.paidTotal, 1200);
    const ticks = await listTicks(db, s.id);
    assert.equal(ticks[0].status, "paid");
    assert.equal(ticks[0].beatId, "beat1");
  } finally {
    await db.destroy();
  }
});

test("stale beat auto-pauses, no payment", async () => {
  const db = await memdb();
  try {
    const s = await seedStream(db);
    const paid = [];
    const res = await tickStreams(db, deps({ id: "old", ts: 1_060_000 - 600_000 }, paid), 1_060_000);
    assert.equal(res[0].outcome, "paused");
    assert.equal(paid.length, 0);
    assert.equal((await getStream(db, s.id)).status, "paused");
    assert.equal(streamBeatRef(s.id), `stream:${s.id}`);
  } finally {
    await db.destroy();
  }
});

test("below-floor ticks accrue instead of paying", async () => {
  const db = await memdb();
  try {
    const s = await seedStream(db, { ratePerMin: 10 });
    const paid = [];
    const res = await tickStreams(db, deps({ id: "b1", ts: 1_060_000 - 10_000 }, paid), 1_060_000);
    assert.equal(res[0].outcome, "accruing");
    assert.equal(paid.length, 0);
    const after = await getStream(db, s.id);
    assert.equal(after.paidTotal, 0);
    assert.equal(after.lastPaidAt, 1_000_000); // unchanged — next tick pays more
    // much later, the accrued amount clears the floor in one payment
    const paid2 = [];
    const res2 = await tickStreams(db, deps({ id: "b9", ts: 10_000_000 - 10_000 }, paid2), 10_000_000);
    assert.equal(res2[0].outcome, "paid");
    assert.ok(paid2[0].amount >= MIN_TICK_SATS);
  } finally {
    await db.destroy();
  }
});

test("budget exhaustion closes the stream", async () => {
  const db = await memdb();
  try {
    const s = await seedStream(db, { maxTotal: 1500, ratePerMin: 1500 });
    const paid = [];
    const res = await tickStreams(db, deps({ id: "b1", ts: 1_060_000 - 5_000 }, paid), 1_060_000);
    assert.equal(res[0].outcome, "paid-closed");
    assert.equal((await getStream(db, s.id)).status, "done");
    assert.equal((await listStreams(db)).length, 1);
    await setStreamStatus(db, s.id, "done");
  } finally {
    await db.destroy();
  }
});

test("no backfill after downtime: one tick, nextDue jumps past now", async () => {
  const db = await memdb();
  try {
    const s = await seedStream(db);
    const paid = [];
    const res = await tickStreams(db, deps({ id: "b1", ts: 100_000_000 - 5_000 }, paid), 100_000_000);
    assert.equal(paid.length, 1);
    const after = await getStream(db, s.id);
    assert.ok(after.nextDue > 100_000_000);
  } finally {
    await db.destroy();
  }
});
