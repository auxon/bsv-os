import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-appinvoke";
import knex from "knex";
import { Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { installApp } from "../src/apps.ts";
import { seedRequest, setPolicy } from "../src/policy.ts";
import { spendTo } from "../src/engine.ts";
import { dispatch, setBackend } from "../src/rpc.ts";
import { p2pkhScript } from "../src/tx.ts";

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

/** Deterministic stand-in for a Jev decision call (mirrors policy.test.mjs). */
function fakeJev({ verdict = "allow", prob = 0.9, risk = 0.1, conf = 0.8 } = {}) {
  const probabilities = { allow: 0.05, ask: 0.05, deny: 0.05 };
  probabilities[verdict] = prob;
  return async () => ({
    model: "fake",
    answers: {
      verdict: { type: "choice", choice: verdict, probabilities, confidence: conf },
      risk: { type: "score", score: risk, legend: { 0: "routine", 1: "unverified", 2: "harmful" }, probabilities: { 0: 0.9 }, confidence: conf },
    },
    elapsedMs: 1,
  });
}

async function backend() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  const chain = new MockChainProvider();
  setBackend({ db, chain });
  return { db, chain };
}

const MANIFEST = {
  name: "Invoke Demo",
  start_url: "/app",
  metanet: { groupPermissions: { spendingAuthorization: { amount: 1000 } } },
};

async function installed(db) {
  await installApp(db, "invoke.example", {
    seedPolicyRequest: (origin, amountSats, action) => seedRequest(db, origin, amountSats, action),
  }, { fetchManifest: async () => MANIFEST });
}

it("appInvoke rejects unknown apps and methods", async () => {
  const { db } = await backend();
  try {
    await createWallet();
    const ghost = await dispatch({ method: "appInvoke", params: { domain: "ghost.example", method: "getStatus" }, id: 1 });
    assert.equal(ghost.error.code, "NOT_FOUND");
    await installed(db);
    const bad = await dispatch({ method: "appInvoke", params: { domain: "invoke.example", method: "spendAll" }, id: 2 });
    assert.equal(bad.error.code, "BAD_METHOD");
    const nosha = await dispatch({ method: "appInvoke", params: { domain: "invoke.example", method: "timestamp", callParams: {} }, id: 3 });
    assert.equal(nosha.error.code, "BAD_PARAM");
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("appInvoke serves status/identity and stamps spends with the app origin", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    await installed(db);
    chain.credit(selfAddress(), { txid: "a".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    const st = await dispatch({ method: "appInvoke", params: { domain: "invoke.example", method: "getStatus" }, id: 4 });
    assert.equal(st.result.authenticated, true);
    const id = await dispatch({ method: "appInvoke", params: { domain: "invoke.example", method: "getIdentity" }, id: 5 });
    assert.match(String(id.result.identityKey), /^[0-9a-f]{66}$/);

    // first spend from the app origin: denied + recorded under the domain
    const sha = "e".repeat(64);
    const denied = await dispatch({
      method: "appInvoke", params: { domain: "invoke.example", method: "timestamp", callParams: { sha256: sha } }, id: 6,
    });
    assert.equal(denied.error.code, "POLICY_DENY");
    const reqs = await dispatch({ method: "policyPending", id: 7 });
    assert.ok(reqs.result.requests.some((r) => r.origin === "invoke.example"));

    const { setPolicy } = await import("../src/policy.ts");
    await setPolicy(db, "invoke.example", "allow");
    const ok = await dispatch({
      method: "appInvoke", params: { domain: "invoke.example", method: "timestamp", callParams: { sha256: sha } }, id: 8,
    });
    assert.match(ok.result.txid, /^[0-9a-f]{64}$/);
    const rows = await db("pending_txs").where({ txid: ok.result.txid });
    assert.equal(rows.length, 1);
    void chain;
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("app spend memo becomes the tracked label", async () => {
  const { db, chain } = await backend();
  const FUND = "d".repeat(64);
  try {
    await createWallet();
    await installed(db);
    const addr = selfAddress();
    chain.credit(addr, { txid: FUND, vout: 0, value: 5_000_000, height: 900 });
    // spendTo verifies funding scripts over HTTP: serve the parent tx.
    const parent = new Transaction();
    parent.addInput({
      sourceTXID: "f".repeat(64), sourceOutputIndex: 0,
      sequence: 0xffffffff, unlockingScript: new UnlockingScript([]),
    });
    parent.addOutput({ lockingScript: Script.fromHex(p2pkhScript(addr).toHex()), satoshis: 5_000_000 });
    const parentHex = parent.toHex();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
      if (m && m[1] === FUND) return new Response(parentHex, { status: 200 });
      return new Response("nope", { status: 404 });
    };
    try {
      await setPolicy(db, "invoke.example", "allow");
      const res = await dispatch({
        method: "appInvoke",
        params: {
          domain: "invoke.example",
          method: "spend",
          callParams: {
            payments: [{ to: addr, sats: 100 }],
            memo: ["POCKETPETS-PULL", "pet-1"],
          },
        },
        id: 9,
      });
      assert.match(res.result.txid, /^[0-9a-f]{64}$/);
      const rows = await db("pending_txs").where({ txid: res.result.txid });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, "POCKETPETS-PULL");
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("app spend label + description reach the Jev decision state", async () => {
  const { db, chain } = await backend();
  const FUND = "e".repeat(64);
  try {
    await createWallet();
    await installed(db);
    const addr = selfAddress();
    chain.credit(addr, { txid: FUND, vout: 0, value: 5_000_000, height: 900 });
    const parent = new Transaction();
    parent.addInput({
      sourceTXID: "f".repeat(64), sourceOutputIndex: 0,
      sequence: 0xffffffff, unlockingScript: new UnlockingScript([]),
    });
    parent.addOutput({ lockingScript: Script.fromHex(p2pkhScript(addr).toHex()), satoshis: 5_000_000 });
    const parentHex = parent.toHex();
    const fetchFn = async (url) => {
      const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(String(url));
      if (m && m[1] === FUND) return new Response(parentHex, { status: 200 });
      return new Response("nope", { status: 404 });
    };
    await setPolicy(db, "invoke.example", "auto");
    let seen = null;
    const spy = async (state) => {
      seen = state;
      return fakeJev()();
    };
    const r = await spendTo({
      db, chain, origin: "invoke.example",
      payments: [{ to: addr, sats: 100 }],
      memo: ["POCKETPETS-PULL", "pet-1"],
      label: "POCKETPETS-PULL",
      description: "pet-1",
      fetchFn,
      jev: spy,
    });
    assert.match(r.txid, /^[0-9a-f]{64}$/);
    assert.equal(seen.origin, "invoke.example");
    assert.equal(seen.action, "app-spend");
    assert.equal(seen.label, "POCKETPETS-PULL");
    assert.equal(seen.description, "pet-1");
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
