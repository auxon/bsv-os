import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { setPolicy } from "../src/policy.ts";
import { migrate } from "../src/storage.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

test("getVersion answers", async () => {
  const r = await dispatch({ method: "getVersion", id: 1 });
  assert.equal(r.id, 1);
  assert.match(String(r.result.version), /^\d+\.\d+\.\d+$/);
  assert.equal(r.result.brc100, true);
});

test("isAuthenticated shape", async () => {
  const r = await dispatch({ method: "isAuthenticated", id: 2 });
  assert.equal(typeof r.result.authenticated, "boolean");
  assert.equal(typeof r.result.locked, "boolean");
  assert.equal(typeof r.result.hasWallet, "boolean");
});

test("unknown method is a clean error, not a crash", async () => {
  const r = await dispatch({ method: "createAction", id: 3 });
  assert.equal(r.id, 3);
  assert.equal(r.error.code, "METHOD_NOT_FOUND");
});

test("lock is idempotent", async () => {
  assert.deepEqual((await dispatch({ method: "lock", id: 4 })).result, { locked: true });
});

test("policyProbe dry-runs the gate over dispatch", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await migrate(db);
    setBackend({ db, chain: new MockChainProvider() });
    await setPolicy(db, "probe.example", "allow", 500);
    const bad = await dispatch({ method: "policyProbe", id: 5, params: { origin: "probe.example" } });
    assert.equal(bad.error.code, "BAD_PARAM");
    const r = await dispatch({
      method: "policyProbe", id: 6,
      params: { origin: "probe.example", action: "app-spend", amountSats: 100, label: "TEST" },
    });
    assert.equal(r.id, 6);
    assert.equal(r.result.verdict, "allow");
    assert.equal(r.result.mode, "allow");
    assert.equal(r.result.capSats, 500);
  } finally {
    setBackend(null);
    await db.destroy();
  }
});

test("re-mint after revoke clears the paired policy deny", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await migrate(db);
    setBackend({ db, chain: new MockChainProvider() });
    const minted = await dispatch({ method: "agentMint", id: 7, params: { name: "agent-x", budgetSats: 5000 } });
    assert.equal(minted.result.active, true);
    await dispatch({ method: "agentRevoke", id: 8, params: { name: "agent-x" } });
    assert.equal((await dispatch({ method: "policyList", id: 9 })).result.policies.find((p) => p.origin === "agent-x").mode, "deny");
    const again = await dispatch({ method: "agentMint", id: 10, params: { name: "agent-x", budgetSats: 9000 } });
    assert.equal(again.result.remaining, 9000);
    const row = (await dispatch({ method: "policyList", id: 11 })).result.policies.find((p) => p.origin === "agent-x");
    assert.equal(row.mode, "ask");
  } finally {
    setBackend(null);
    await db.destroy();
  }
});
