import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-share";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { explorerTxUrl, safeLabel } from "../src/engine.ts";
import { setPolicy } from "../src/policy.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

test("safeLabel keeps basenames, drops traversal and newlines", () => {
  assert.equal(safeLabel("/etc/passwd", "fb"), "passwd");
  assert.equal(safeLabel("..\\..\\x.txt", "fb"), "x.txt");
  assert.equal(safeLabel("a\nb\rc\td", "fb"), "a b c d");
  assert.equal(safeLabel("", "fb"), "fb");
  assert.equal(safeLabel("x".repeat(200), "fb").length, 80);
});

test("explorer links point at WhatsOnChain mainnet", () => {
  assert.equal(explorerTxUrl("a".repeat(64)), `https://whatsonchain.com/tx/${"a".repeat(64)}`);
});

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

it("anchorFile labels by filename, echoes size, links the explorer", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    chain.credit(selfAddress(), { txid: "d".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    await setPolicy(db, "cli", "allow");
    const sha = "f".repeat(64);
    const r = await dispatch({
      method: "anchorFile",
      params: { sha256: sha, filename: "report.pdf", size: 12345, origin: "cli" },
      id: 1,
    });
    assert.match(r.result.txid, /^[0-9a-f]{64}$/);
    assert.equal(r.result.explorer, `https://whatsonchain.com/tx/${r.result.txid}`);
    assert.equal(r.result.filename, "report.pdf");
    assert.equal(r.result.size, 12345);
    const rows = await db("pending_txs").where({ txid: r.result.txid });
    assert.equal(rows[0].label, "file report.pdf");
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("anchorFile goes through the same policy gate", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    chain.credit(selfAddress(), { txid: "e".repeat(64), vout: 0, value: 5_000_000, height: 900 });
    const denied = await dispatch({
      method: "anchorFile", params: { sha256: "f".repeat(64), filename: "x" }, id: 2,
    });
    assert.equal(denied.error.code, "POLICY_DENY");
    const nosha = await dispatch({ method: "anchorFile", params: { filename: "x" }, id: 3 });
    assert.equal(nosha.error.code, "BAD_PARAM");
    const badsha = await dispatch({
      method: "anchorFile", params: { sha256: "zzz", filename: "x", origin: "cli" }, id: 4,
    });
    assert.equal(badsha.error.code, "INTERNAL");
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
