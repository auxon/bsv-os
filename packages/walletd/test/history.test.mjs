import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { emptyHistory, getHistory } from "../src/history.ts";
import { check, setPolicy } from "../src/policy.ts";
import { mintAgent, recordSpend } from "../src/agents.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("empty wallet: history is empty sections with a zero summary", async () => {
  const db = await memdb();
  try {
    assert.deepEqual(await getHistory(db), emptyHistory());
  } finally {
    await db.destroy();
  }
});

test("history merges txs, requests, and policies with action commands", async () => {
  const db = await memdb();
  try {
    const now = Date.now();
    await db("pending_txs").insert([
      { txid: "a".repeat(64), label: "anchor deadbeef", status: "mined", attempts: 1, last_check: now, created_at: now - 2 },
      { txid: "b".repeat(64), label: "anchor cafe", status: "seen", attempts: 0, last_check: 0, created_at: now - 1 },
      { txid: "c".repeat(64), label: "anchor lost-race", status: "failed", attempts: 3, last_check: now, detail: "double-spend lost", created_at: now },
    ]);
    await check(db, "research-agent", 250, "anchor", {
      jev: async () => ({
        model: "fake",
        answers: {
          verdict: { type: "choice", choice: "allow", probabilities: { allow: 0.9, ask: 0.05, deny: 0.05 }, confidence: 0.85 },
          risk: { type: "score", score: 0.2, legend: { 0: "routine", 1: "unverified", 2: "harmful" }, probabilities: { 0: 0.9 }, confidence: 0.8 },
        },
        elapsedMs: 1,
      }),
    });
    await setPolicy(db, "cli", "allow", 50000);
    await setPolicy(db, "evil.example", "deny");
    await mintAgent(db, { name: "nightshift", budgetSats: 1000 });
    await recordSpend(db, "nightshift", 300);

    const h = await getHistory(db);
    assert.equal(h.transactions.length, 3);
    assert.equal(h.transactions[0].txid, "c".repeat(64)); // newest first
    assert.match(h.transactions[0].hint, /nothing moved/);
    assert.equal(h.transactions[1].hint, "in mempool — the daemon rebroadcasts automatically; check again later");
    assert.equal(h.transactions[2].hint, "confirmed on-chain");

    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0].commands, { allow: "bsv allow research-agent", deny: "bsv deny research-agent" });
    assert.deepEqual(h.requests[0].jev, { verdict: "allow", prob: 0.9, risk: 0.2, riskLevel: "routine", confidence: 0.8 });

    assert.equal(h.policies.length, 2);
    const cli = h.policies.find((p) => p.origin === "cli");
    assert.deepEqual(cli.commands, { revoke: "bsv deny cli" });
    const evil = h.policies.find((p) => p.origin === "evil.example");
    assert.deepEqual(evil.commands, { approve: "bsv allow evil.example" });

    assert.deepEqual(h.summary, {
      inFlight: 1, mined: 1, failed: 1,
      pendingRequests: 1, allowedOrigins: 1, deniedOrigins: 1,
    });

    assert.equal(h.agents.length, 1);
    assert.equal(h.agents[0].name, "nightshift");
    assert.equal(h.agents[0].remaining, 700);
    assert.deepEqual(h.agents[0].commands, { revoke: "bsv agent revoke nightshift" });
  } finally {
    await db.destroy();
  }
});

test("history RPC degrades to empty without a backend", async () => {
  setBackend(null);
  try {
    const r = await dispatch({ method: "history", id: 9 });
    assert.deepEqual(r.result, emptyHistory());
  } finally {
    setBackend(null);
  }
});
