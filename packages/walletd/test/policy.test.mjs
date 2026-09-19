import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { check, listPolicies, pendingRequests, probe, setPolicy } from "../src/policy.ts";
import { mintAgent } from "../src/agents.ts";

// Hermetic: existing tests must never reach a real decision endpoint.
delete process.env.OPENROUTER_API_KEY;

/** Deterministic stand-in for a Jev decision call. */
function fakeJev({ verdict = "allow", prob = 0.9, risk = 0.1, conf = 0.8 } = {}) {
  const probabilities = { allow: 0.05, ask: 0.05, deny: 0.05 };
  probabilities[verdict] = prob;
  return async () => ({
    model: "fake",
    answers: {
      verdict: { type: "choice", choice: verdict, probabilities, confidence: conf },
      risk: { type: "score", score: risk, legend: { 0: "routine", 1: "unverified", 2: "harmful" }, probabilities: { 0: 0.9 }, confidence: conf },
    },
    elapsedMs: 1,
  });
}

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("unknown origin: deny + record once", async () => {
  const db = await memdb();
  try {
    const r1 = await check(db, "app.example", 100, "anchor");
    assert.equal(r1.verdict, "deny");
    assert.equal(r1.pending, true);
    assert.match(r1.reason, /bsv allow app.example/);
    const r2 = await check(db, "app.example", 100, "anchor");
    assert.equal(r2.pending, true);
    assert.equal((await pendingRequests(db)).length, 1);
  } finally {
    await db.destroy();
  }
});

test("approve then allow; cap enforced", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "app.example", "allow", 500);
    assert.equal((await check(db, "app.example", 100, "x")).verdict, "allow");
    const over = await check(db, "app.example", 501, "x");
    assert.equal(over.verdict, "deny");
    assert.match(over.reason, /cap/);
    assert.deepEqual(await listPolicies(db), [{ origin: "app.example", mode: "allow", spend_cap_sats: 500 }]);
  } finally {
    await db.destroy();
  }
});

test("deny sticks and clears the request", async () => {
  const db = await memdb();
  try {
    await check(db, "evil.example", 0, "anchor");
    await setPolicy(db, "evil.example", "deny");
    assert.equal((await check(db, "evil.example", 0, "anchor")).pending, false);
    assert.equal((await pendingRequests(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("advisor attaches a Jev score to the pending request", async () => {
  const db = await memdb();
  try {
    const r = await check(db, "app.example", 100, "send", { jev: fakeJev() });
    assert.equal(r.verdict, "deny");
    assert.equal(r.pending, true);
    assert.equal(r.jev.verdict, "allow");
    assert.match(r.reason, /Jev allow/);
    const rows = await pendingRequests(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jev_verdict, "allow");
    assert.equal(rows[0].jev_risk_level, "routine");
    assert.equal(rows[0].jev_confidence, 0.8);
    // repeat attempts reuse the stored score (one decision per request)
    let calls = 0;
    const counting = async (...args) => {
      calls += 1;
      return fakeJev()(...args);
    };
    await check(db, "app.example", 100, "send", { jev: counting });
    assert.equal(calls, 0);
  } finally {
    await db.destroy();
  }
});

test("auto mode allows a routine, confident spend within cap", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "bot", "auto", 500);
    const r = await check(db, "bot", 100, "send", { jev: fakeJev() });
    assert.equal(r.verdict, "allow");
    assert.match(r.reason, /allowed by Jev/);
    assert.equal(r.pending, false);
    assert.equal((await pendingRequests(db)).length, 0);
    assert.deepEqual(await listPolicies(db), [{ origin: "bot", mode: "auto", spend_cap_sats: 500 }]);
  } finally {
    await db.destroy();
  }
});

test("auto mode denies + records anything short of a confident allow", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "bot", "auto", 500);
    const r = await check(db, "bot", 100, "send", { jev: fakeJev({ verdict: "ask", prob: 0.6, risk: 1.2, conf: 0.5 }) });
    assert.equal(r.verdict, "deny");
    assert.equal(r.pending, true);
    assert.match(r.reason, /Jev ask/);
    const rows = await pendingRequests(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jev_verdict, "ask");
    assert.equal(rows[0].jev_risk_level, "unverified");
  } finally {
    await db.destroy();
  }
});

test("auto mode fails closed when Jev cannot answer", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "bot", "auto", 500);
    const down = async () => {
      throw Object.assign(new Error("endpoint down"), { code: "JEV_UNAVAILABLE" });
    };
    const r = await check(db, "bot", 100, "send", { jev: down });
    assert.equal(r.verdict, "deny");
    assert.equal(r.pending, true);
    assert.match(r.reason, /Jev unavailable/);
    assert.equal((await pendingRequests(db)).length, 1);
  } finally {
    await db.destroy();
  }
});

test("auto mode still enforces the spend cap", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "bot", "auto", 50);
    const r = await check(db, "bot", 100, "send", { jev: fakeJev() });
    assert.equal(r.verdict, "deny");
    assert.match(r.reason, /cap/);
    assert.equal(r.pending, false);
  } finally {
    await db.destroy();
  }
});

test("allow mode never consults Jev", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "trusted", "allow", 500);
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return fakeJev()();
    };
    const r = await check(db, "trusted", 100, "send", { jev: counting });
    assert.equal(r.verdict, "allow");
    assert.equal(calls, 0);
  } finally {
    await db.destroy();
  }
});

test("probe: allow-mode judges the full gate without writing", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "trusted", "allow", 500);
    const r = await probe(db, "trusted", 100, "app-spend", {
      jev: fakeJev(),
      context: { label: "POCKETPETS-PULL" },
    });
    assert.equal(r.verdict, "allow");
    assert.equal(r.pending, false);
    assert.equal(r.mode, "allow");
    assert.equal(r.capSats, 500);
    assert.equal(r.budgetCovered, false);
    assert.equal((await pendingRequests(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("probe: ask-mode denies + scores without recording", async () => {
  const db = await memdb();
  try {
    let calls = 0;
    const counting = async (...args) => {
      calls += 1;
      return fakeJev()(...args);
    };
    const r = await probe(db, "new.example", 100, "app-spend", { jev: counting });
    assert.equal(r.verdict, "deny");
    assert.equal(r.pending, true);
    assert.equal(r.mode, "ask");
    assert.equal(r.jev.verdict, "allow");
    assert.match(r.reason, /bsv allow new.example/);
    // dry-run writes nothing and never caches: a second probe re-scores
    await probe(db, "new.example", 100, "app-spend", { jev: counting });
    assert.equal(calls, 2);
    assert.equal((await pendingRequests(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("probe: cap exceeded + deny mode deny without recording", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "capped", "allow", 500);
    const over = await probe(db, "capped", 501, "send", { jev: fakeJev() });
    assert.equal(over.verdict, "deny");
    assert.match(over.reason, /cap/);
    assert.equal(over.pending, false);
    await setPolicy(db, "evil", "deny");
    const denied = await probe(db, "evil", 10, "send", { jev: fakeJev() });
    assert.equal(denied.verdict, "deny");
    assert.equal(denied.pending, false);
    assert.equal(denied.mode, "deny");
    assert.equal((await pendingRequests(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("probe: context reaches the Jev decision state", async () => {
  const db = await memdb();
  try {
    let seen = null;
    const spy = async (state) => {
      seen = state;
      return fakeJev()();
    };
    await probe(db, "game.example", 264, "app-spend", {
      jev: spy,
      context: { label: "POCKETPETS-PULL", to: "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm", description: "gacha pull" },
    });
    assert.equal(seen.origin, "game.example");
    assert.equal(seen.action, "app-spend");
    assert.equal(seen.amount_sats, 264);
    assert.equal(seen.label, "POCKETPETS-PULL");
    assert.equal(seen.pay_to, "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm");
    assert.equal(seen.description, "gacha pull");
  } finally {
    await db.destroy();
  }
});

test("probe: budget-covered spend reports the budget", async () => {
  const db = await memdb();
  try {
    await mintAgent(db, { name: "game.example", budgetSats: 100_000 });
    const r = await probe(db, "game.example", 5000, "app-spend", { jev: fakeJev() });
    assert.equal(r.verdict, "allow");
    assert.equal(r.budgetCovered, true);
    assert.match(r.reason, /agent budget/);
    assert.equal((await pendingRequests(db)).length, 0);
  } finally {
    await db.destroy();
  }
});
