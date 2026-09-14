import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/rpc.ts";

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
