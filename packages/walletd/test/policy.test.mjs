import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { check, listPolicies, pendingRequests, setPolicy } from "../src/policy.ts";

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
