import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-qr";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { qrAscii, qrDataUrl } from "../src/qr.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

const ADDR = "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm";

test("qrDataUrl returns a PNG data URL", async () => {
  const url = await qrDataUrl(ADDR);
  assert.match(url, /^data:image\/png;base64,/);
  const buf = Buffer.from(url.split(",")[1], "base64");
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
});

test("qrAscii returns multi-line terminal art", async () => {
  const art = await qrAscii(ADDR);
  assert.ok(art.trim().split("\n").length > 10);
});

it("addressQr answers over dispatch", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await migrate(db);
    setBackend({ db, chain: new MockChainProvider() });
    await createWallet();
    const r = await dispatch({ method: "addressQr", id: 1 });
    assert.equal(r.result.address, selfAddress());
    assert.match(r.result.dataUrl, /^data:image\/png;base64,/);
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
