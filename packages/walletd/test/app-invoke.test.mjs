import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-appinvoke";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { installApp } from "../src/apps.ts";
import { seedRequest } from "../src/policy.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

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
