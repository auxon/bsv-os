import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { logEvent, readEvents } from "../src/events.ts";
import { check, setPolicy } from "../src/policy.ts";
import { mintAgent, revokeAgent } from "../src/agents.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

// Hermetic: the advisor must stay off (scores are irrelevant here).
delete process.env.OPENROUTER_API_KEY;

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

async function types(db, origin) {
  const rows = await readEvents(db, origin ? { origin } : {});
  return rows.map((e) => e.type);
}

test("empty feed reads clean", async () => {
  const db = await memdb();
  try {
    assert.deepEqual(await readEvents(db), []);
    assert.deepEqual(await readEvents(db, { since: 99, limit: 10, origin: "nobody" }), []);
  } finally {
    await db.destroy();
  }
});

test("ask-deny logs request.created once; probe logs nothing", async () => {
  const db = await memdb();
  try {
    const { probe } = await import("../src/policy.ts");
    await probe(db, "app.example", 100, "send");
    assert.deepEqual(await types(db), []);
    const r1 = await check(db, "app.example", 100, "send");
    assert.equal(r1.verdict, "deny");
    assert.deepEqual(await types(db), ["request.created"]);
    await check(db, "app.example", 100, "send");
    assert.deepEqual(await types(db), ["request.created"]);
    const [ev] = await readEvents(db);
    assert.equal(ev.origin, "app.example");
    assert.equal(ev.amount_sats, 100);
    assert.equal(ev.action, "send");
    assert.ok(ev.id > 0 && ev.created_at > 0);
  } finally {
    await db.destroy();
  }
});

test("approve/deny transitions log", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "shop.example", "allow", 500);
    await setPolicy(db, "evil.example", "deny");
    assert.deepEqual(await types(db), ["request.approved", "request.denied"]);
    const [approved] = await readEvents(db, { origin: "shop.example" });
    assert.equal(approved.amount_sats, 500);
    assert.match(approved.detail, /mode allow/);
  } finally {
    await db.destroy();
  }
});

test("budget mint/revoke log", async () => {
  const db = await memdb();
  try {
    await mintAgent(db, { name: "worker", budgetSats: 10_000, dailySats: 1000 });
    await revokeAgent(db, "worker");
    assert.deepEqual(await types(db), ["budget.minted", "budget.revoked"]);
    const [minted] = await readEvents(db, { origin: "worker" });
    assert.match(minted.detail, /budget 10000 daily 1000/);
  } finally {
    await db.destroy();
  }
});

test("readEvents pages by id and filters by origin", async () => {
  const db = await memdb();
  try {
    await logEvent(db, "request.created", { origin: "a.example" });
    await logEvent(db, "request.created", { origin: "b.example" });
    await logEvent(db, "request.approved", { origin: "a.example" });
    const all = await readEvents(db);
    assert.deepEqual(all.map((e) => e.id), [1, 2, 3]);
    assert.deepEqual((await readEvents(db, { since: 1 })).map((e) => e.id), [2, 3]);
    assert.deepEqual((await readEvents(db, { limit: 2 })).map((e) => e.id), [1, 2]);
    assert.deepEqual(await types(db, "a.example"), ["request.created", "request.approved"]);
    assert.deepEqual(await types(db, "b.example"), ["request.created"]);
  } finally {
    await db.destroy();
  }
});

test("eventsPoll answers over dispatch, immediate and filtered", async () => {
  const db = await memdb();
  try {
    setBackend({ db, chain: new MockChainProvider() });
    const empty = await dispatch({ method: "eventsPoll", id: 1, params: { waitMs: 0 } });
    assert.deepEqual(empty.result.events, []);
    await logEvent(db, "request.created", { origin: "a.example", amountSats: 5, action: "send" });
    const one = await dispatch({ method: "eventsPoll", id: 2, params: { since: 0 } });
    assert.equal(one.result.events.length, 1);
    assert.equal(one.result.events[0].type, "request.created");
    const filtered = await dispatch({ method: "eventsPoll", id: 3, params: { origin: "b.example" } });
    assert.deepEqual(filtered.result.events, []);
    const bad = await dispatch({ method: "eventsPoll", id: 4, params: { waitMs: 999_999 } });
    assert.equal(bad.error, undefined);
  } finally {
    setBackend(null);
    await db.destroy();
  }
});

test("eventsPoll long-poll returns early when an event lands", async () => {
  const db = await memdb();
  try {
    setBackend({ db, chain: new MockChainProvider() });
    const pending = dispatch({ method: "eventsPoll", id: 5, params: { waitMs: 5000 } });
    await new Promise((r) => setTimeout(r, 300));
    await logEvent(db, "request.denied", { origin: "late.example" });
    const r = await pending;
    assert.equal(r.result.events.length, 1);
    assert.equal(r.result.events[0].origin, "late.example");
  } finally {
    setBackend(null);
    await db.destroy();
  }
});
