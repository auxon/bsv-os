import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  disputeWindowOpen,
  gradeEvidence,
  impliedOdds,
  marketBasket,
  migratePredict,
  newMarketId,
  parseDurationMs,
  splitPool,
  splitVoid,
  validateMarket,
  winnerFromChoice,
} from "../src/predict.ts";

test("validateMarket accepts a sane market and rejects junk", () => {
  const v = validateMarket({
    question: "Will the rocket launch before Friday?",
    outcomes: ["yes", "no"],
    closesIn: "7d",
    evidence: "SpaceX stream or official confirmation",
  }, 1000);
  assert.equal(v.outcomes.length, 2);
  assert.ok(v.closes_at > 1000);
  assert.throws(() => validateMarket({ question: "Is this a long enough question?", outcomes: ["a"] }, 0), /outcomes/);
  assert.throws(() => validateMarket({ question: "Will this work at all?", outcomes: ["a", "a"], closesIn: "1h", evidence: "x" }, 0), /unique/);
  assert.throws(() => validateMarket({ question: "Will this work at all?", outcomes: ["a", "b"], closesIn: "1h", evidence: "" }, 0), /evidence/);
  assert.equal(parseDurationMs("30m"), 1_800_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.ok(newMarketId().startsWith("pm_"));
  assert.equal(marketBasket("pm_x"), "predict-pm_x");
});

test("splitPool pays winners proportionally with every sat accounted", () => {
  const bets = [
    { payout_address: "A", outcome: "yes", sats: 7000, origin: "a" },
    { payout_address: "B", outcome: "yes", sats: 3000, origin: "b" },
    { payout_address: "C", outcome: "no", sats: 5000, origin: "c" },
  ];
  const { payouts, fee, total } = splitPool(bets, "yes", 200);
  assert.equal(total, 15000);
  assert.equal(fee, 300);
  const paid = payouts.reduce((s, p) => s + p.sats, 0);
  // distributable = total - fee - settleBudget(2 winners)
  assert.equal(paid, total - fee - (200 + 60 * 2));
  const a = payouts.find((p) => p.payout_address === "A");
  const b = payouts.find((p) => p.payout_address === "B");
  assert.ok(a.sats > b.sats);
  // A staked 70% of the winning pool: within a sat of 70% of distributable
  assert.ok(Math.abs(a.sats / paid - 0.7) < 0.001);
  assert.ok(!payouts.some((p) => p.payout_address === "C"));
});

test("splitPool with no winners pays nobody; void refunds all", () => {
  const bets = [{ payout_address: "A", outcome: "no", sats: 1000, origin: "a" }];
  const r = splitPool(bets, "yes", 200);
  assert.deepEqual(r.payouts, []);
  assert.equal(r.fee, 20);
  const v = splitVoid(bets);
  assert.deepEqual(v, [{ payout_address: "A", sats: 1000 }]);
});

test("single bettor takes the pool minus fee and settle budget", () => {
  const bets = [{ payout_address: "A", outcome: "yes", sats: 10_000, origin: "a" }];
  const { payouts, fee } = splitPool(bets, "yes", 200);
  assert.equal(fee, 200);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].sats, 10_000 - 200 - (200 + 60));
});

test("impliedOdds splits empty pools evenly", () => {
  assert.deepEqual(impliedOdds([], ["yes", "no"]), { yes: 0.5, no: 0.5 });
  const o = impliedOdds(
    [{ outcome: "yes", sats: 3000 }, { outcome: "no", sats: 1000 }],
    ["yes", "no"],
  );
  assert.equal(o.yes, 0.75);
  assert.equal(winnerFromChoice("yes", ["yes", "no"]), "yes");
  assert.equal(winnerFromChoice("maybe", ["yes", "no"]), null);
});

test("disputeWindowOpen honors the clock", () => {
  assert.equal(disputeWindowOpen(1000, 24, 1000 + 23 * 3_600_000), true);
  assert.equal(disputeWindowOpen(1000, 24, 1000 + 25 * 3_600_000), false);
});

test("gradeEvidence voids below-confidence verdicts", async () => {
  const market = { question: "Q?", outcomes: ["yes", "no"], evidence: "rule" };
  const high = await gradeEvidence(async () => ({ answers: { outcome: { choice: "yes", confidence: 0.9 } } }), market);
  assert.deepEqual(high, { winner: "yes", confidence: 0.9 });
  const low = await gradeEvidence(async () => ({ answers: { outcome: { choice: "yes", confidence: 0.4 } } }), market);
  assert.deepEqual(low, { winner: null, confidence: 0.4 });
  const bad = await gradeEvidence(async () => ({ answers: { outcome: { choice: "maybe", confidence: 0.9 } } }), market);
  assert.deepEqual(bad, { winner: null, confidence: 0.9 });
});

test("migratePredict creates tables round-trip", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await migratePredict(db);
    await migratePredict(db); // idempotent
    const tables = await db("sqlite_master").where({ type: "table" }).select("name");
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("predict_markets"));
    assert.ok(names.includes("predict_bets"));
  } finally {
    await db.destroy();
  }
});
