import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridgeHandler } from "../src/bridge.ts";

const DOMAIN = "demo.example";
const TOKEN = "t".repeat(32);

function req(method, url, origin, body) {
  return { method, url, headers: { origin } };
}

async function call(handler, { method = "POST", url = "/invoke", origin = "https://demo.example", body = {} } = {}) {
  return handler(req(method, url, origin), typeof body === "string" ? body : JSON.stringify(body));
}

test("happy path forwards to appInvoke and returns the envelope", async () => {
  const seen = [];
  const handler = createBridgeHandler({
    token: TOKEN,
    domain: DOMAIN,
    invoke: async (method, params) => {
      seen.push([method, params]);
      return { result: { ok: method } };
    },
  });
  const out = await call(handler, { body: { token: TOKEN, method: "getStatus", params: {} } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { result: { ok: "getStatus" } });
  assert.deepEqual(seen, [["getStatus", {}]]);
  assert.equal(out.headers["access-control-allow-private-network"], "true");
  assert.equal(out.headers["access-control-allow-origin"], "https://demo.example");
});

test("bad token is 403 without touching the daemon", async () => {
  let called = 0;
  const handler = createBridgeHandler({
    token: TOKEN,
    domain: DOMAIN,
    invoke: async () => {
      called++;
      return { result: null };
    },
  });
  for (const bad of ["wrong", "short", "t".repeat(31), "t".repeat(33), undefined]) {
    const out = await call(handler, { body: { token: bad, method: "getStatus" } });
    assert.equal(out.status, 403);
  }
  assert.equal(called, 0);
});

test("foreign or missing Origin is 403, including preflight", async () => {
  const handler = createBridgeHandler({
    token: TOKEN,
    domain: DOMAIN,
    invoke: async () => ({ result: 1 }),
  });
  assert.equal((await call(handler, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(handler, { origin: undefined })).status, 403);
  assert.equal((await call(handler, { method: "OPTIONS", origin: "https://evil.example" })).status, 403);
  const pre = await call(handler, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
});

test("malformed calls are 400/404 and method allowlisting stays server-side", async () => {
  const handler = createBridgeHandler({
    token: TOKEN,
    domain: DOMAIN,
    invoke: async (method) => ({ error: { code: "BAD_METHOD", message: `unknown app method ${method}` } }),
  });
  assert.equal((await call(handler, { body: "not-json{" })).status, 400);
  assert.equal((await call(handler, { body: { token: TOKEN } })).status, 400);
  assert.equal((await call(handler, { url: "/nope" })).status, 404);
  assert.equal((await call(handler, { method: "GET" })).status, 404);
  // the bridge relays any method string; the daemon allowlists
  const out = await call(handler, { body: { token: TOKEN, method: "spendAll" } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { error: { code: "BAD_METHOD", message: "unknown app method spendAll" } });
});
