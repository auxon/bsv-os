// Commitment vectors for the Swift port.
//
// The stream/cast tick engine is shared between the daemon and the phone, so
// the grace, skip-ahead, accrual and decision-ladder cases are pinned from the
// daemon's own `commitment.ts`.
import { graceMsFor, advanceDue, accruedSats, dueCommitment } from "../../src/commitment.ts";

const terms = (o = {}) => ({
  cadenceSecs: 60,
  ratePerMin: 0,
  fixedSats: 0,
  capSats: 100_000,
  paidSats: 0,
  minPaymentSats: 1000,
  lastPaidAt: 0,
  nextDueAt: 0,
  ...o,
});

const grace = [60, 90, 300, 3600].map((cadenceSecs) => ({ cadenceSecs, graceMs: graceMsFor(cadenceSecs) }));

const advance = [
  { nextDueAt: 1_000, cadenceSecs: 60, now: 1_000 },
  { nextDueAt: 1_000, cadenceSecs: 60, now: 61_000 },
  { nextDueAt: 1_000, cadenceSecs: 60, now: 185_000 },
  { nextDueAt: 5_000, cadenceSecs: 300, now: 300_000 },
  { nextDueAt: 1_000, cadenceSecs: 0, now: 999 },
].map((c) => ({ ...c, next: advanceDue(c.nextDueAt, c.cadenceSecs, c.now) }));

const accrued = [
  { terms: terms({ ratePerMin: 1200, lastPaidAt: 0 }), now: 60_000 },
  { terms: terms({ ratePerMin: 1200, lastPaidAt: 0 }), now: 60_500 },
  { terms: terms({ ratePerMin: 1200, lastPaidAt: 0, capSats: 1500 }), now: 600_000 },
  { terms: terms({ ratePerMin: 0, fixedSats: 700, lastPaidAt: 0 }), now: 60_000 },
  { terms: terms({ ratePerMin: 10, lastPaidAt: 120_000 }), now: 60_000 },
].map((c) => ({ terms: c.terms, now: c.now, amount: accruedSats(c.terms, c.now) }));

const due = [
  { name: "not due", terms: terms({ nextDueAt: 120_000, ratePerMin: 1200, lastPaidAt: 0 }), liveness: { fresh: true, ageMs: 0 }, now: 60_000 },
  { name: "exhausted below floor", terms: terms({ capSats: 500, paidSats: 0, ratePerMin: 1200, lastPaidAt: 0 }), liveness: { fresh: true, ageMs: 0 }, now: 60_000 },
  { name: "stale with reason", terms: terms({ ratePerMin: 1200, lastPaidAt: 0 }), liveness: { fresh: false, ageMs: 400_000, reason: "last beat deadbee is 400s old (grace 180s) — auto-paused, resume when beats return" }, now: 60_000 },
  { name: "stale without reason", terms: terms({ ratePerMin: 1200, lastPaidAt: 0 }), liveness: { fresh: false, ageMs: 61_400 }, now: 60_000 },
  { name: "accruing", terms: terms({ ratePerMin: 1200, lastPaidAt: 0 }), liveness: { fresh: true, ageMs: 1_000 }, now: 60_000 },
  { name: "accruing (fixed)", terms: terms({ fixedSats: 400, lastPaidAt: 0 }), liveness: { fresh: true, ageMs: 1_000 }, now: 60_000 },
  { name: "release", terms: terms({ ratePerMin: 1200, lastPaidAt: 0 }), liveness: { fresh: true, ageMs: 1_000 }, now: 120_000 },
  { name: "release capped by remaining", terms: terms({ ratePerMin: 1200, lastPaidAt: 0, capSats: 2500 }), liveness: { fresh: true, ageMs: 1_000 }, now: 300_000 },
].map((c) => ({ ...c, decision: dueCommitment(c.terms, c.liveness, c.now) }));

console.log(JSON.stringify({ grace, advance, accrued, due }, null, 2));
