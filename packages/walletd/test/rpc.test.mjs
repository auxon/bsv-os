import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/rpc.ts";

test("getVersion answers", () => {
  const r = dispatch({ method: "getVersion", id: 1 });
  assert.equal(r.id, 1);
  assert.match(String(r.result.version), /^\d+\.\d+\.\d+$/);
  assert.equal(r.result.brc100, true);
});

test("isAuthenticated reflects locked-by-default custody", () => {
  const r = dispatch({ method: "isAuthenticated", id: 2 });
  assert.equal(r.result.authenticated, false);
  assert.equal(r.result.locked, true);
});

test("unknown method is a clean error, not a crash", () => {
  const r = dispatch({ method: "createAction", id: 3 });
  assert.equal(r.id, 3);
  assert.equal(r.error.code, "METHOD_NOT_FOUND");
});

test("lock is idempotent", () => {
  assert.deepEqual(dispatch({ method: "lock", id: 4 }).result, { locked: true });
});
