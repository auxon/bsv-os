import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { mintAgent, getAgent } from "../src/agents.ts";
import {
  approveRun,
  claimRun,
  createOrder,
  failRun,
  listOrders,
  listRuns,
  parseEvery,
  removeOrder,
  setOrderStatus,
  submitRun,
  tickOrders,
} from "../src/nightshift.ts";

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

test("parseEvery accepts intervals, rejects cron-ish and extremes", () => {
  assert.equal(parseEvery("60s"), 60_000);
  assert.equal(parseEvery("15m"), 900_000);
  assert.equal(parseEvery("6h"), 21_600_000);
  assert.equal(parseEvery("2d"), 172_800_000);
  assert.equal(parseEvery("1w"), 604_800_000);
  assert.equal(parseEvery(90), 90_000);
  for (const bad of ["", "hourly", "* * * * *", "0", "-5m", "30s", "59s", "400d", "abc", null]) {
    assert.throws(() => parseEvery(bad), (e) => e.code === "BAD_PARAM");
  }
});

test("orders validate and manage", async () => {
  const db = await memdb();
  try {
    await rejectsCode(createOrder(db, { name: "", agent: "a", every: "1h", cycleSats: 10 }), "BAD_PARAM");
    await rejectsCode(createOrder(db, { name: "x", agent: "bad name!", every: "1h", cycleSats: 10 }), "BAD_PARAM");
    await rejectsCode(createOrder(db, { name: "x", agent: "a", every: "1h", cycleSats: 0 }), "BAD_PARAM");
    const o = await createOrder(db, { name: "due check", agent: "scout", every: "1h", cycleSats: 500 });
    assert.match(o.id, /^ord_/);
    assert.equal(o.status, "active");
    assert.ok(o.nextDue > Date.now());
    assert.equal((await listOrders(db)).length, 1);
    assert.equal((await setOrderStatus(db, o.id, "paused")).status, "paused");
    assert.equal((await setOrderStatus(db, o.id, "active")).status, "active");
    await rejectsCode(setOrderStatus(db, "ord_nope", "paused"), "NOT_FOUND");
    assert.deepEqual(await removeOrder(db, o.id), { id: o.id, removed: true });
    assert.equal((await listOrders(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("ticker opens one run per elapsed period, never backfills", async () => {
  const db = await memdb();
  try {
    const now = Date.now();
    await createOrder(db, { name: "hourly", agent: "a", every: "1h", cycleSats: 10 });
    assert.deepEqual(await tickOrders(db, now), { opened: 0, orderIds: [] });
    // force massive lateness: exactly one run, nextDue jumps past now
    const [o] = await listOrders(db);
    await db("standing_orders").where({ id: o.id }).update({ next_due: now - 72 * 3_600_000 });
    const t = await tickOrders(db, now);
    assert.equal(t.opened, 1);
    assert.deepEqual(t.orderIds, [o.id]);
    const after = (await listOrders(db))[0];
    assert.ok(after.nextDue > now);
    const runs = await listRuns(db, o.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "due");
    // paused orders never tick
    await setOrderStatus(db, o.id, "paused");
    await db("standing_orders").where({ id: o.id }).update({ next_due: now - 1000 });
    assert.deepEqual(await tickOrders(db, now), { opened: 0, orderIds: [] });
  } finally {
    await db.destroy();
  }
});

test("cycle escrow binds the agent budget at claim and approve", async () => {
  const db = await memdb();
  try {
    await mintAgent(db, { name: "nightowl", budgetSats: 5000 });
    const o = await createOrder(db, { name: "nightly", agent: "nightowl", every: "1h", cycleSats: 3000 });
    await db("standing_orders").where({ id: o.id }).update({ next_due: Date.now() - 1000 });
    await tickOrders(db);
    const [run] = await listRuns(db, o.id);

    await rejectsCode(submitRun(db, run.id, "proof"), "BAD_STATE");
    const claimed = await claimRun(db, run.id);
    assert.equal(claimed.status, "claimed");
    await rejectsCode(claimRun(db, run.id), "BAD_STATE");
    await rejectsCode(submitRun(db, run.id, ""), "BAD_PARAM");
    const sub = await submitRun(db, run.id, "did the thing: tx abc");
    assert.equal(sub.status, "submitted");
    assert.equal(sub.proof, "did the thing: tx abc");
    const ok = await approveRun(db, run.id);
    assert.equal(ok.status, "approved");
    assert.equal((await getAgent(db, "nightowl")).spent_total, 3000);
    await rejectsCode(approveRun(db, run.id), "BAD_STATE");

    // next cycle exceeds the remaining 2000 → claim denied, nothing spent
    await db("standing_orders").where({ id: o.id }).update({ next_due: Date.now() - 1000 });
    await tickOrders(db);
    const [run2] = (await listRuns(db, o.id)).filter((r) => r.status === "due");
    await rejectsCode(claimRun(db, run2.id), "BUDGET");
    assert.equal((await getAgent(db, "nightowl")).spent_total, 3000);

    // failed runs exit without debit
    const f = await failRun(db, run2.id);
    assert.equal(f.status, "failed");
    assert.equal((await getAgent(db, "nightowl")).spent_total, 3000);
    await rejectsCode(claimRun(db, 999999), "NOT_FOUND");
  } finally {
    await db.destroy();
  }
});
