import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  DAY_MS,
  checkBudget,
  getAgent,
  listAgents,
  mintAgent,
  recordSpend,
  revokeAgent,
} from "../src/agents.ts";
import { check, setPolicy } from "../src/policy.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    return true;
  });
}

test("mint validates and lists budget views", async () => {
  const db = await memdb();
  try {
    const a = await mintAgent(db, { name: "research-agent", budgetSats: 100_000, dailySats: 10_000 });
    assert.equal(a.remaining, 100_000);
    assert.equal(a.window_remaining, 10_000);
    assert.equal(a.active, true);
    assert.equal(a.expiry_at, 0);
    assert.equal((await listAgents(db)).length, 1);
    await rejectsCode(mintAgent(db, { name: "research-agent", budgetSats: 5 }), "EXISTS");
    await rejectsCode(mintAgent(db, { name: "no budget", budgetSats: 5 }), "BAD_PARAM");
    await rejectsCode(mintAgent(db, { name: "x", budgetSats: 0 }), "BAD_PARAM");
    await rejectsCode(mintAgent(db, { name: "x", budgetSats: 5, expiryAt: Date.now() - 1000 }), "BAD_PARAM");
  } finally {
    await db.destroy();
  }
});

test("checkBudget gates lifetime, daily, expiry, revocation", async () => {
  const db = await memdb();
  try {
    await mintAgent(db, { name: "nightshift", budgetSats: 1000, dailySats: 400, expiryAt: Date.now() + DAY_MS });
    assert.deepEqual(await checkBudget(db, "nightshift", 300), { ok: true, reason: "", covered: true });
    assert.deepEqual(await checkBudget(db, "stranger", 999_999), { ok: true, reason: "", covered: false }); // no wallet: passthrough

    await recordSpend(db, "nightshift", 300);
    let v = await getAgent(db, "nightshift");
    assert.equal(v.spent_total, 300);
    assert.equal(v.remaining, 700);

    const overDay = await checkBudget(db, "nightshift", 200); // 300 + 200 > 400
    assert.equal(overDay.ok, false);
    assert.match(overDay.reason, /daily allowance/);

    const overLife = await checkBudget(db, "nightshift", 701);
    assert.equal(overLife.ok, false);
    assert.match(overLife.reason, /lifetime budget/);

    await revokeAgent(db, "nightshift");
    const revoked = await checkBudget(db, "nightshift", 0);
    assert.equal(revoked.ok, false);
    assert.match(revoked.reason, /revoked/);
    await rejectsCode(revokeAgent(db, "ghost"), "NOT_FOUND");
  } finally {
    await db.destroy();
  }
});

test("daily window resets after 24h", async () => {
  const db = await memdb();
  try {
    const now = Date.now();
    await db("agent_wallets").insert({
      name: "cron", budget_sats: 10_000, daily_sats: 100,
      spent_total: 500, spent_window: 100, window_start: now - DAY_MS - 1,
      expiry_at: 0, revoked: 0, created_at: now - DAY_MS - 1,
    });
    const v = await getAgent(db, "cron");
    assert.equal(v.spent_window, 0); // effective view resets
    assert.deepEqual(await checkBudget(db, "cron", 100), { ok: true, reason: "", covered: true });
    await recordSpend(db, "cron", 60);
    const after = await getAgent(db, "cron");
    assert.equal(after.spent_total, 560);
    assert.equal(after.spent_window, 60);
  } finally {
    await db.destroy();
  }
});

test("expired wallets deny", async () => {
  const db = await memdb();
  try {
    const now = Date.now();
    await db("agent_wallets").insert({
      name: "old", budget_sats: 10_000, daily_sats: 0,
      spent_total: 0, spent_window: 0, window_start: now,
      expiry_at: now + 50, revoked: 0, created_at: now,
    });
    assert.equal((await getAgent(db, "old")).active, true);
    await new Promise((r) => setTimeout(r, 60));
    const v = await getAgent(db, "old");
    assert.equal(v.expired, true);
    assert.equal(v.active, false);
    const g = await checkBudget(db, "old", 0);
    assert.equal(g.ok, false);
    assert.match(g.reason, /expired/);
  } finally {
    await db.destroy();
  }
});

test("policy: mint is the approval; deny wins; caps still bind", async () => {
  const db = await memdb();
  try {
    await mintAgent(db, { name: "scout", budgetSats: 50_000 });
    // ask-mode origin with a live budget: allowed, nothing recorded
    const first = await check(db, "scout", 300, "anchor");
    assert.equal(first.verdict, "allow");
    const { pendingRequests } = await import("../src/policy.ts");
    assert.equal((await pendingRequests(db)).length, 0);

    // per-action cap still binds alongside the budget
    await setPolicy(db, "scout", "allow", 100);
    const over = await check(db, "scout", 101, "anchor");
    assert.equal(over.verdict, "deny");
    assert.match(over.reason, /cap/);
    assert.equal((await check(db, "scout", 100, "anchor")).verdict, "allow");

    // explicit deny beats the budget
    await setPolicy(db, "scout", "deny");
    const denied = await check(db, "scout", 10, "anchor");
    assert.equal(denied.verdict, "deny");
    assert.equal(denied.pending, false);

    // exhausted budget denies without recording
    await setPolicy(db, "scout", "allow");
    await recordSpend(db, "scout", 50_000);
    const broke = await check(db, "scout", 1, "anchor");
    assert.equal(broke.verdict, "deny");
    assert.match(broke.reason, /lifetime budget/);
    assert.equal(broke.pending, false);
    assert.equal((await pendingRequests(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("recordSpend is a no-op without a wallet and never runs on failure paths", async () => {
  const db = await memdb();
  try {
    await recordSpend(db, "nobody", 500); // must not throw
    await mintAgent(db, { name: "frugal", budgetSats: 1000 });
    await check(db, "frugal", 900, "anchor"); // check alone debits nothing
    assert.equal((await getAgent(db, "frugal")).spent_total, 0);
  } finally {
    await db.destroy();
  }
});

test("revoke then re-mint replaces the sub-wallet", async () => {
  const db = await memdb();
  try {
    await mintAgent(db, { name: "worker", budgetSats: 1000 });
    await rejectsCode(mintAgent(db, { name: "worker", budgetSats: 2000 }), "EXISTS");
    await revokeAgent(db, "worker");
    const fresh = await mintAgent(db, { name: "worker", budgetSats: 2000 });
    assert.equal(fresh.budget_sats, 2000);
    assert.equal(fresh.revoked, 0);
    assert.equal(fresh.spent_total, 0);
    assert.equal((await listAgents(db)).length, 1);
  } finally {
    await db.destroy();
  }
});
