import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  accruedSats,
  advanceDue,
  castStreamIds,
  commitmentExposure,
  dueCommitment,
  graceMsFor,
  listCommitments,
} from "../src/commitment.ts";

delete process.env.OPENROUTER_API_KEY;

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const MIN = 1000; // the stream engine's pay floor
const terms = (over = {}) => ({
  cadenceSecs: 300,
  ratePerMin: 120,
  fixedSats: 0,
  capSats: 100_000,
  paidSats: 0,
  minPaymentSats: MIN,
  lastPaidAt: 0,
  nextDueAt: 0,
  ...over,
});
const fresh = { fresh: true, ageMs: 1000 };

test("grace is two cadences, never under three minutes", () => {
  assert.equal(graceMsFor(300), 600_000); // 5m cadence → two periods
  assert.equal(graceMsFor(30), 180_000); // 30s cadence → the 3m floor wins
  assert.equal(graceMsFor(600), 1_200_000); // 10m cadence → two periods
});

test("the ladder: not due → nothing left → stale → accruing → release", () => {
  const now = 10_000_000;
  // 1. not due yet
  assert.deepEqual(dueCommitment(terms({ nextDueAt: now + 1000 }), fresh, now), { kind: "wait", nextDueAt: now + 1000 });
  // 2. nothing left worth sending
  const spent = terms({ capSats: 10_000, paidSats: 9_500, lastPaidAt: now - 600_000 });
  assert.deepEqual(dueCommitment(spent, fresh, now), { kind: "exhausted", remaining: 500 });
  // 3. condition not met: no heartbeat
  const stale = dueCommitment(terms(), { fresh: false, ageMs: 400_000, reason: "no heartbeat yet" }, now);
  assert.equal(stale.kind, "stale");
  assert.equal(stale.graceMs, 600_000); // two 5-minute cadences
  assert.equal(stale.reason, "no heartbeat yet");
  // 4. too small to send — accrue, do not pay
  const tiny = dueCommitment(terms({ ratePerMin: 10, lastPaidAt: now - 60_000 }), fresh, now);
  assert.deepEqual(tiny, { kind: "accruing", amount: 10 });
  // 5. release — 10 minutes at 120/min clears the 1,000-sat floor
  const good = terms({ lastPaidAt: now - 600_000 });
  assert.deepEqual(dueCommitment(good, fresh, now), { kind: "release", amount: 1200, remaining: 100_000 });
  // Just under the floor still only accrues, even though the money is real.
  const underFloor = terms({ lastPaidAt: now - 300_000 }); // 5 min → 600 sats
  assert.deepEqual(dueCommitment(underFloor, fresh, now), { kind: "accruing", amount: 600 });
});

test("a release never exceeds the cap", () => {
  const now = 10_000_000;
  // 20 minutes of downtime on a 5,000-sat cap: pay what is left, no more.
  const t = terms({ capSats: 5000, paidSats: 4800, lastPaidAt: now - 20 * 60_000 });
  assert.equal(accruedSats(t, now), 200); // clamped to remaining
  const d = dueCommitment(t, fresh, now);
  assert.equal(d.kind, "exhausted"); // 200 sats is under the pay floor
  const t2 = terms({ capSats: 5000, paidSats: 3000, lastPaidAt: now - 20 * 60_000 });
  assert.deepEqual(dueCommitment(t2, fresh, now), { kind: "release", amount: 2000, remaining: 2000 });
});

test("downtime skips missed periods instead of backfilling", () => {
  // Due 10:00, cadence 5m, ticker wakes at 13:07: next due is 13:10, and only
  // one tick is owed — the daemon does not pay for the two hours it was asleep.
  const due = new Date("2026-09-27T10:00:00Z").getTime();
  const now = new Date("2026-09-27T13:07:00Z").getTime();
  assert.equal(advanceDue(due, 300, now), new Date("2026-09-27T13:10:00Z").getTime());
  // A zero-cadence commitment (capsule) never advances.
  assert.equal(advanceDue(due, 0, now), due);
  // Landing exactly on a boundary still moves forward, so it cannot spin.
  assert.equal(advanceDue(due, 300, due), due + 300_000);
});

test("capsule shape: one release at maturity, no cadence", () => {
  const now = 10_000_000;
  const t = terms({ cadenceSecs: 0, ratePerMin: 0, fixedSats: 50_000, capSats: 50_000, minPaymentSats: 50_000, nextDueAt: now });
  assert.deepEqual(dueCommitment(t, { fresh: true, ageMs: 0 }, now), { kind: "release", amount: 50_000, remaining: 50_000 });
  const early = { ...t, nextDueAt: now + 60_000 };
  assert.equal(dueCommitment(early, { fresh: true, ageMs: 0 }, now).kind, "wait");
  // Liveness for a capsule is maturity, not a heartbeat: a stale verdict here
  // would mean "not yet unlocked", which the capsule ticker decides by height.
  const notYet = dueCommitment(t, { fresh: false, ageMs: 0, reason: "height 900 < 1000" }, now);
  assert.equal(notYet.kind, "stale");
  assert.equal(notYet.reason, "height 900 < 1000");
});

test("one list for streams, cast sessions, and capsules", async () => {
  const db = await memdb();
  try {
    const now = Date.now();
    await db("streams").insert({
      id: "stm_1", name: "JEVES-tips", payee: "1payee", rate_per_min: 120, tick_secs: 300,
      max_total: 60_000, paid_total: 12_000, next_due: now + 60_000, board: "bsvos.stream",
      status: "active", last_paid_at: now, created_at: now - 600_000,
    });
    await db("cast_sessions").insert({
      id: "cs_1", episode: "ep_1", title: "Sunday set", rate_per_min: 600, every_secs: 60,
      max_total: 30_000, stream_ids: JSON.stringify(["stm_a", "stm_b"]), status: "playing",
      started_at: now, stopped_at: null,
    });
    await db("capsules").insert([
      {
        locktime: now + 86_400_000, kind: "time", to_address: "1friend", amount: 5000,
        message: "rent", status: "locked", reserved: "[]", claim_txid: null, created_at: now,
      },
      {
        locktime: 968_544, kind: "height", to_address: "1other", amount: 1200,
        message: "post-dated", status: "locked", reserved: "[]", claim_txid: null, created_at: now,
      },
    ]);

    const views = await listCommitments(db, now);
    assert.deepEqual(views.map((v) => v.kind), ["capsule", "capsule", "cast", "stream"]); // sorted by kind

    const stream = views.find((v) => v.id === "stm_1");
    assert.equal(stream.capSats, 60_000);
    assert.equal(stream.paidSats, 12_000);
    assert.equal(stream.remainingSats, 48_000);
    assert.equal(stream.cadenceSecs, 300);
    assert.match(stream.condition, /heartbeat on board bsvos\.stream within 600s/);

    const cast = views.find((v) => v.id === "cs_1");
    assert.deepEqual(cast.streams, ["stm_a", "stm_b"]);
    assert.equal(cast.label, "Sunday set");
    assert.match(cast.payee, /via 2 streams/);

    const capsule = views.find((v) => v.kind === "capsule");
    assert.equal(capsule.capSats, 5000);
    assert.equal(capsule.remainingSats, 5000);
    assert.match(capsule.condition, /daemon-enforced at/);

    // A height-gated capsule reports its height, never a bogus 1970 date.
    const byHeight = views.find((v) => v.label === "post-dated");
    assert.match(byHeight.condition, /height 968544/);
    assert.doesNotMatch(byHeight.condition, /1970/);

    const ex = commitmentExposure(views);
    assert.equal(ex.open, 4); // active + playing + locked + locked
    assert.equal(ex.cappedSats, 48_000 + 30_000 + 5_000 + 1_200);
    assert.equal(ex.nextDueAt, now + 60_000);

    // A spent capsule is no longer exposure.
    await db("capsules").update({ status: "claimed" });
    const after = commitmentExposure(await listCommitments(db, now));
    assert.equal(after.open, 2);
    assert.equal(after.cappedSats, 78_000);
    const claimed = (await listCommitments(db, now)).find((v) => v.kind === "capsule");
    assert.equal(claimed.remainingSats, 0); // a claimed capsule is no exposure
  } finally {
    await db.destroy();
  }
});

test("cast stream ids survive a corrupt column", () => {
  assert.deepEqual(castStreamIds({ stream_ids: '["a","b"]' }), ["a", "b"]);
  assert.deepEqual(castStreamIds({ stream_ids: "not json" }), []);
  assert.deepEqual(castStreamIds({ stream_ids: '{"a":1}' }), []);
});
