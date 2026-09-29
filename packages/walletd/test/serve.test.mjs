import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-serve";
process.env.OPENROUTER_API_KEY = "test-key";
import knex from "knex";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { __resetCache, createWallet, destroyWallet, selfAddress } from "../src/custody.ts";
import {
  b64json, checkSellerSurface, getServeMeta, parseProof, parseTunnelUrl, payToAddress,
  serveCall, serveMenu, servePrice, serveRequirement, serveSales, serveSetPrice,
  serveStatus,
} from "../src/serve.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

/** Payment tx paying `sats` to addr (inputs unchecked — the seller verifies outputs, miners verify inputs). */
import { P2PKH, Script, Transaction } from "@bsv/sdk";

function payTxHex(addr, sats) {
  const tx = new Transaction(2, [], [], 0);
  tx.addInput({
    unlockingScript: Script.fromHex(""),
    sourceTXID: "a".repeat(64), sourceOutputIndex: 0, sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats });
  return tx.toHex();
}

function jevFetch(score, confidence = 0.8) {
  return async () => new Response(JSON.stringify({
    model: "test", answers: { quality: { type: "score", score, confidence } },
    usage: { cost: 0.00002 },
  }), { status: 200 });
}

test("menu, pricing, quotes", async () => {
  const db = await memdb();
  await createWallet();
  try {
    const menu = await serveMenu(db);
    assert.deepEqual(menu.map((m) => [m.method, m.priceSats]), [["jevDecide", 50], ["memoryRecall", 20]]);
    assert.ok(menu.every((m) => m.payTo.length > 20));
    await serveSetPrice(db, "jevDecide", 75);
    assert.equal((await servePrice(db, "jevDecide")).priceSats, 75);
    await serveSetPrice(db, "jevDecide", 50);
    await assert.rejects(serveSetPrice(db, "nope", 10), /not sellable/);
    await assert.rejects(servePrice(db, "nope"), /not for sale/);
    const req = serveRequirement("jevDecide", 50, menu[0].payTo, "https://wallet/v1/serve/jevDecide");
    assert.equal(req.network, "bsv:mainnet");
    assert.equal(JSON.parse(Buffer.from(b64json(req), "base64").toString("utf8")).amount, "50");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("pay → execute → replay refused → underpay refused", async () => {
  const db = await memdb();
  await createWallet();
  try {
    const chain = new MockChainProvider();
    const addr = selfAddress();
    const deps = { db, chain, jevFetch: jevFetch(3, 0.7) };
    const params = { state: "pick the better output", questions: { quality: { type: "score", instructions: "rate", criteria: ["bad", "ok", "good", "great", "best"] } } };

    // unknown method has no price
    await assert.rejects(
      serveCall(deps, "walletDrain", {}, payTxHex(addr, 1000)),
      /not for sale/,
    );
    // underpayment: proof parses, output too small
    await assert.rejects(serveCall(deps, "jevDecide", params, payTxHex(addr, 10)), /no output paying/);
    // exact payment executes the method
    const out = await serveCall(deps, "jevDecide", params, payTxHex(addr, 50));
    assert.equal(out.receipt.method, "jevDecide");
    assert.equal(out.receipt.amountSats, 50);
    assert.match(out.receipt.txid, /^[0-9a-f]{64}$/);
    assert.equal(out.data.answers.quality.score, 3);
    // same txid never buys twice
    await assert.rejects(serveCall(deps, "jevDecide", params, payTxHex(addr, 50)), /already bought/);
    // garbage proof
    await assert.rejects(serveCall(deps, "jevDecide", params, "zz"), /no txHex|does not parse/);
    // sales ledger
    const sales = await serveSales(db);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].method, "jevDecide");
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("memoryRecall serves through the same turnstile", async () => {
  const db = await memdb();
  await createWallet();
  try {
    const chain = new MockChainProvider();
    const out = await serveCall({ db, chain }, "memoryRecall", { query: "nothing here" }, payTxHex(selfAddress(), 20));
    assert.equal(out.data.board, "memory");
    assert.deepEqual(out.data.hits, []);
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("unlisted method refuses even with payment", async () => {
  const db = await memdb();
  await createWallet();
  try {
    await serveSetPrice(db, "memoryRecall", 0);
    await assert.rejects(
      serveCall({ db, chain: new MockChainProvider() }, "memoryRecall", {}, payTxHex(selfAddress(), 999)),
      /not priced for sale/,
    );
  } finally {
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

test("parseProof accepts the standard envelope", () => {
  const hex = payTxHex("1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4", 5);
  const env = b64json({ x402Version: 2, scheme: "exact", network: "bsv:mainnet", txHex: hex, encoding: "raw-hex" });
  assert.equal(parseProof(env), hex);
  assert.throws(() => parseProof("!!!"), /base64/);
});

test("payToAddress caches on unlock and serves the manifest while locked", async () => {
  const db = await memdb();
  await destroyWallet();
  try {
    await createWallet();
    const live = selfAddress();
    // Unlocked: live address, and cached as a side effect.
    assert.equal(await payToAddress(db), live);
    assert.equal(await getServeMeta(db, "payto"), live);
    // Locked with cache: serves from cache (the manifest path).
    await destroyWallet();
    assert.equal(await payToAddress(db), live);
    // Locked without cache: the old fail-closed behavior.
    await db("x402_server_meta").where({ key: "payto" }).delete();
    await assert.rejects(payToAddress(db), /locked/i);
  } finally {
    await db.destroy();
    await destroyWallet().catch(() => {});
    __resetCache();
  }
});

test("serveMenu works locked once the payTo address is cached", async () => {
  const db = await memdb();
  await destroyWallet();
  try {
    await createWallet();
    const live = selfAddress();
    await payToAddress(db); // cache
    await destroyWallet();
    const menu = await serveMenu(db);
    assert.ok(menu.length > 0);
    for (const m of menu) assert.equal(m.payTo, live);
  } finally {
    await db.destroy();
    await destroyWallet().catch(() => {});
    __resetCache();
  }
});

test("parseTunnelUrl takes the last URL (restarts append)", () => {
  assert.equal(
    parseTunnelUrl("2026-09-28T18:40:40Z INF | https://old-one.trycloudflare.com\n2026-09-28T19:00:00Z INF | https://new-two.trycloudflare.com\n"),
    "https://new-two.trycloudflare.com",
  );
  assert.equal(parseTunnelUrl("no url here"), null);
  assert.equal(parseTunnelUrl(""), null);
});

test("checkSellerSurface re-registers on URL change, silent otherwise", async () => {
  const db = await memdb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seller-"));
  const log = path.join(dir, "cf-tunnel.log");
  const savedLog = process.env.BSV_TUNNEL_LOG;
  const savedMarket = process.env.X402_MARKET_URL;
  process.env.BSV_TUNNEL_LOG = log;
  process.env.X402_MARKET_URL = "https://market.test";
  const posts = [];
  const fetchFn = async (url, init) => {
    posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ service: { id: "s_new" } }), { status: 200 });
  };
  try {
    // No log file: unconfigured, no network.
    let r = await checkSellerSurface(db, { fetchFn });
    assert.equal(r.configured, false);
    assert.equal(r.relisted, false);
    assert.equal(posts.length, 0);
    // New URL appears: one re-register.
    fs.writeFileSync(log, "2026-09-28T19:00:00Z INF | https://aaa.trycloudflare.com\n");
    r = await checkSellerSurface(db, { fetchFn });
    assert.equal(r.relisted, true);
    assert.equal(r.publicUrl, "https://aaa.trycloudflare.com");
    assert.equal(r.listingId, "s_new");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://market.test/services", "posts to the submit endpoint, no doubled path");
    assert.equal(
      posts[0].body.manifestUrl,
      "https://aaa.trycloudflare.com/v1/serve/manifest",
    );
    // Same URL again: quiet.
    r = await checkSellerSurface(db, { fetchFn });
    assert.equal(r.relisted, false);
    assert.equal(posts.length, 1);
    // Rotation: re-registers once more.
    fs.appendFileSync(log, "2026-09-28T20:00:00Z INF | https://bbb.trycloudflare.com\n");
    r = await checkSellerSurface(db, { fetchFn });
    assert.equal(r.relisted, true);
    assert.equal(posts.length, 2);
    // Market down: recorded, never thrown.
    const down = async () => {
      throw new Error("network down");
    };
    fs.appendFileSync(log, "2026-09-28T21:00:00Z INF | https://ccc.trycloudflare.com\n");
    r = await checkSellerSurface(db, { fetchFn: down });
    assert.equal(r.relisted, false);
    assert.match(r.lastError, /network down/);
    const status = await serveStatus(db);
    assert.equal(status.publicUrl, "https://ccc.trycloudflare.com");
    assert.equal(status.listedUrl, "https://bbb.trycloudflare.com", "failed re-list keeps the old URL");
    assert.match(status.lastError, /network down/);
  } finally {
    if (savedLog === undefined) delete process.env.BSV_TUNNEL_LOG;
    else process.env.BSV_TUNNEL_LOG = savedLog;
    if (savedMarket === undefined) delete process.env.X402_MARKET_URL;
    else process.env.X402_MARKET_URL = savedMarket;
    fs.rmSync(dir, { recursive: true, force: true });
    await db.destroy();
  }
});
