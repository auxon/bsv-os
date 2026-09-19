import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { runDoctor, checkPanelSync } from "../src/doctor.ts";
import { seedRequest, setPolicy } from "../src/policy.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

// Hermetic: the advisor must stay off unless a test opts in.
delete process.env.OPENROUTER_API_KEY;

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const unlocked = async () => ({ locked: false, hasWallet: true, identityKey: null });

function statusOf(report, id) {
  return report.checks.find((c) => c.id === id);
}

test("clean machine: ok, wallet/lock state reported", async () => {
  const db = await memdb();
  try {
    const ok = await runDoctor(db, { status: unlocked });
    assert.equal(ok.ok, true);
    assert.equal(statusOf(ok, "wallet").status, "ok");
    assert.equal(statusOf(ok, "sign-rounds").status, "ok");
    assert.equal(statusOf(ok, "caps").status, "ok");
    assert.equal(statusOf(ok, "requests").status, "ok");
    assert.equal(statusOf(ok, "broadcasts").status, "ok");
    // advisor off with no auto policies: advisory warn, not a failure
    assert.equal(statusOf(ok, "jev").status, "warn");
    // plugin check always present; its verdict depends on the machine
    assert.ok(statusOf(ok, "plugin"));

    const none = await runDoctor(db, { status: async () => ({ locked: true, hasWallet: false, identityKey: null }) });
    assert.equal(none.ok, false);
    assert.equal(statusOf(none, "wallet").status, "fail");

    const locked = await runDoctor(db, { status: async () => ({ locked: true, hasWallet: true, identityKey: null }) });
    assert.equal(locked.ok, true);
    assert.equal(statusOf(locked, "wallet").status, "warn");
  } finally {
    await db.destroy();
  }
});

test("dangling sign rounds fail", async () => {
  const db = await memdb();
  try {
    await db("brc100_pending").insert({
      reference: "deadbeef", tx_hex: "00", context: "{}",
      originator: "shop.example", created_at: Date.now() - 3_600_000,
    });
    const r = await runDoctor(db, { status: unlocked });
    assert.equal(r.ok, false);
    const c = statusOf(r, "sign-rounds");
    assert.equal(c.status, "fail");
    assert.match(c.detail, /1 dangling sign round/);
    assert.match(c.detail, /CANNOT_SIGN/);
  } finally {
    await db.destroy();
  }
});

test("uncapped allow/auto origins warn (cli exempt)", async () => {
  const db = await memdb();
  try {
    await setPolicy(db, "shop.example", "allow", 0);
    await setPolicy(db, "cli", "allow", 0);
    await setPolicy(db, "capped.example", "allow", 500);
    const r = await runDoctor(db, { status: unlocked });
    const c = statusOf(r, "caps");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /shop\.example/);
    assert.doesNotMatch(c.detail, /cli/);
  } finally {
    await db.destroy();
  }
});

test("open approvals and failed broadcasts warn", async () => {
  const db = await memdb();
  try {
    await seedRequest(db, "shop.example", 100, "send");
    await db("pending_txs").insert({ txid: "f".repeat(64), status: "failed", created_at: Date.now(), detail: "double spend attempted" });
    const r = await runDoctor(db, { status: unlocked });
    assert.match(statusOf(r, "requests").detail, /1 open approval/);
    assert.match(statusOf(r, "broadcasts").detail, /1 failed broadcast/);
    assert.match(statusOf(r, "broadcasts").detail, /funds never moved/);
  } finally {
    await db.destroy();
  }
});

test("auto mode without Jev fails; with Jev passes", async () => {
  const db = await memdb();
  const saved = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    await setPolicy(db, "bot", "auto", 500);
    const r = await runDoctor(db, { status: unlocked });
    assert.equal(r.ok, false);
    assert.equal(statusOf(r, "jev").status, "fail");
    process.env.OPENROUTER_API_KEY = "test-key";
    const r2 = await runDoctor(db, { status: unlocked });
    assert.equal(statusOf(r2, "jev").status, "ok");
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
    await db.destroy();
  }
});

test("checkPanelSync compares installed against sources", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
  try {
    const installed = path.join(dir, "Panel.qml");
    const same = path.join(dir, "same.qml");
    const different = path.join(dir, "different.qml");
    fs.writeFileSync(installed, "Panel { }");
    fs.writeFileSync(same, "Panel { }");
    fs.writeFileSync(different, "Panel { changed }");
    assert.equal(checkPanelSync(installed, [same]).status, "ok");
    const drift = checkPanelSync(installed, [different]);
    assert.equal(drift.status, "warn");
    assert.match(drift.detail, /differs/);
    const missing = checkPanelSync(path.join(dir, "nope.qml"), [same]);
    assert.equal(missing.status, "warn");
    assert.match(missing.detail, /not installed/);
    const nosrc = checkPanelSync(installed, [path.join(dir, "nope.qml")]);
    assert.equal(nosrc.status, "warn");
    assert.match(nosrc.detail, /no plugin source/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor answers over dispatch", async () => {
  const db = await memdb();
  try {
    setBackend({ db, chain: new MockChainProvider() });
    const r = await dispatch({ method: "doctor", id: 1 });
    assert.equal(r.id, 1);
    assert.equal(typeof r.result.ok, "boolean");
    assert.deepEqual(
      r.result.checks.map((c) => c.id).sort(),
      ["broadcasts", "caps", "jev", "plugin", "requests", "sign-rounds", "wallet"],
    );
    for (const c of r.result.checks) {
      assert.ok(["ok", "warn", "fail"].includes(c.status));
      assert.equal(typeof c.detail, "string");
    }
  } finally {
    setBackend(null);
    await db.destroy();
  }
});
