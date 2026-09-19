import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-twetchbuy";
import knex from "knex";
import { Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { MockChainProvider } from "../src/chain.ts";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache, selfAddress } from "../src/custody.ts";
import { setPolicy } from "../src/policy.ts";
import { dispatch, setBackend } from "../src/rpc.ts";
import { signSwapOffer } from "../src/swaps.ts";
import { inscriptionScript } from "../src/tokens.ts";
import { p2pkhScript } from "../src/tx.ts";

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

const N1 = "b".repeat(64);
const N5 = "ab".repeat(32);
const N6 = "cd".repeat(32);
const N7 = "ef".repeat(32);
const F1 = "d".repeat(64);
const F2 = "c".repeat(64);
const F3 = "0".repeat(64);
const X1 = "e".repeat(64);
const TO = "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU";
const OUT = `${"a".repeat(64)}.0`;

function parentHex(outputs) {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: "f".repeat(64),
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: new UnlockingScript([]),
  });
  for (const o of outputs) {
    tx.addOutput({ lockingScript: Script.fromHex(o.scriptHex), satoshis: o.sats });
  }
  return tx.toHex();
}

function makeNet(selfAddr) {
  const hexes = {
    [N1]: () => parentHex([{ scriptHex: inscriptionScript(selfAddr, "image/png", "0102"), sats: 1 }]),
    [N5]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 1 }]), // v4 prefix dust
    [N6]: () => parentHex([{ scriptHex: inscriptionScript(selfAddr, "image/png", "beef"), sats: 1 }]), // second carrier
    [N7]: () => parentHex([{ scriptHex: inscriptionScript(selfAddr, "image/png", "cafe"), sats: 1 }]), // third carrier
    [F1]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 100_000 }]),
    [F2]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 50_000 }]),
    [F3]: () => parentHex([{ scriptHex: p2pkhScript(selfAddr).toHex(), sats: 80_000 }]),
    [X1]: () => parentHex([{ scriptHex: inscriptionScript(TO, "image/png", "0102"), sats: 1 }]),
  };
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/1sat/ordfs/metadata")) {
      // no inscriptions among the fixtures: every candidate is plain dust
      return new Response("{}", { status: 200 });
    }
    const m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(u);
    if (m && hexes[m[1]]) return new Response(hexes[m[1]](), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  return { fetchFn, hexes };
}

async function backend() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  const chain = new MockChainProvider();
  setBackend({ db, chain });
  return { db, chain };
}

it("twetchBuy direct pays the seller through policy", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
      await setPolicy(db, "twetch", "allow");
      const res = await dispatch({
        method: "twetchBuy",
        params: { outpoint: OUT, priceSats: 5000, sellerAddress: TO },
        id: 1,
      });
      assert.match(res.result.txid, /^[0-9a-f]{64}$/);
      assert.equal(res.result.atomic, false);
      assert.ok(res.result.fee > 0);
      const rows = await db("pending_txs").where({ txid: res.result.txid });
      assert.equal(rows.length, 1);
      assert.match(rows[0].label, /^twetch buy /);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("twetchBuy denies without approval and validates input", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
      const denied = await dispatch({
        method: "twetchBuy",
        params: { outpoint: OUT, priceSats: 5000, sellerAddress: TO },
        id: 2,
      });
      assert.equal(denied.error.code, "POLICY_DENY");
      const badOut = await dispatch({
        method: "twetchBuy", params: { outpoint: "nope", priceSats: 5, sellerAddress: TO }, id: 3,
      });
      assert.equal(badOut.error.code, "BAD_PARAM");
      const badPrice = await dispatch({
        method: "twetchBuy", params: { outpoint: OUT, priceSats: 0, sellerAddress: TO }, id: 4,
      });
      assert.equal(badPrice.error.code, "BAD_PARAM");
      const badSeller = await dispatch({
        method: "twetchBuy", params: { outpoint: OUT, priceSats: 5 }, id: 5,
      });
      assert.equal(badSeller.error.code, "BAD_PARAM");
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("twetchBuy atomic completes swap offers", async () => {
  const { db, chain } = await backend();
  try {
    await createWallet();
    const addr = selfAddress();
    const { fetchFn } = makeNet(addr);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
      chain.credit(addr, { txid: N5, vout: 0, value: 1, height: 900 });
      await setPolicy(db, "twetch", "allow");
      const listed = await dispatch({
        method: "twetchList",
        params: { outpoint: `${N1}.0`, priceSats: 5000 },
        id: 6,
      });
      assert.equal(listed.result.kind, "ordinal");
      assert.equal(listed.result.version, 4);
      assert.equal(listed.result.inputs.length, 2);
      const res = await dispatch({
        method: "twetchBuy",
        params: {
          outpoint: `${N1}.0`, priceSats: 5000, sellerAddress: addr,
          offer: listed.result,
        },
        id: 7,
      });
      assert.equal(res.result.atomic, true);
      assert.match(res.result.txid, /^[0-9a-f]{64}$/);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("twetchList signs only our carriers", async () => {
  const { db } = await backend();
  try {
    await createWallet();
    const { fetchFn } = makeNet(selfAddress());
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await setPolicy(db, "twetch", "allow");
      const foreign = await dispatch({
        method: "twetchList",
        params: { outpoint: `${X1}.0`, priceSats: 5000 },
        id: 8,
      });
      assert.equal(foreign.error.code, "NOT_OURS");
      const bad = await dispatch({
        method: "twetchList", params: { outpoint: "nope", priceSats: 5 }, id: 9,
      });
      assert.equal(bad.error.code, "BAD_PARAM");
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});


/** Market worker stub: routes market URLs to fixtures, everything else to the chain stub. */
function marketStub(baseFetch, { listing = null, fee = { feeBps: 200, feeAddress: TO } } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/v1/market/fees")) return Response.json(fee);
    if (u.includes("/v1/market/listing/")) {
      return listing
        ? Response.json({ listing })
        : Response.json({ error: { code: "NOT_FOUND", message: "listing not found" } }, { status: 404 });
    }
    if (/\/v1\/market(\?|$)/.test(u)) return Response.json({ listings: listing ? [listing] : [] });
    if (/\/(buy|settle|list|cancel)$/.test(new URL(u).pathname)) {
      calls.push({ path: new URL(u).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ ok: true });
    }
    return baseFetch(url, init);
  };
  return { fetchFn, calls };
}

function marketListing(over = {}) {
  return {
    origin: `${N1}.0`, assetKind: "ordinal", title: "Test ordinal", image: null,
    priceSats: 5000, seller: TO, offer: null, sellerUnlock: null, payScript: null, inputScript: null,
    tokenId: null, tokenAmount: null, feeBps: 200, feeAddress: TO, status: "active",
    buyTxid: null, transferTxid: null,
    ...over,
  };
}

it("marketBrowse and marketFees read the configured deployment", async () => {
  const { db } = await backend();
  const realFetch = globalThis.fetch;
  try {
    const { fetchFn } = marketStub(async () => new Response("nope", { status: 404 }), { listing: marketListing() });
    globalThis.fetch = fetchFn;
    const browse = await dispatch({ method: "marketBrowse", params: {}, id: 10 });
    assert.equal(browse.result.listings.length, 1);
    assert.equal(browse.result.listings[0].origin, `${N1}.0`);
    assert.match(browse.result.market, /^https:/);
    const fees = await dispatch({ method: "marketFees", params: {}, id: 11 });
    assert.equal(fees.result.feeBps, 200);
    assert.equal(fees.result.feeAddress, TO);
    const kind = await dispatch({ method: "marketBrowse", params: { kind: "bsv21" }, id: 12 });
    assert.equal(kind.error, undefined);
  } finally {
    globalThis.fetch = realFetch;
    setBackend(null);
    await db.destroy();
  }
});

it("marketList signs and posts with the operator fee", async () => {
  const { db, chain } = await backend();
  const realFetch = globalThis.fetch;
  try {
    await createWallet();
    const addr = selfAddress();
    const net = makeNet(addr);
    const { fetchFn, calls } = marketStub(net.fetchFn);
    globalThis.fetch = fetchFn;
    await setPolicy(db, "cli", "allow");
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 }); // ordlock miner fee
    const res = await dispatch({
      method: "marketList",
      params: { outpoint: `${N1}.0`, priceSats: 2500, title: "T" },
      id: 13,
    });
    assert.equal(res.error, undefined);
    assert.equal(res.result.listed, true);
    assert.equal(res.result.origin.startsWith(""), true); // lock outpoint (broadcast txid.0)
    assert.equal(res.result.feeBps, 200);
    assert.equal(res.result.feeAddress, TO);
    assert.equal(res.result.version, 5);
    assert.equal(res.result.kind, "ordlock");
    const posted = calls.find((c) => c.path === "/v1/market/list");
    assert.ok(posted, "listing was posted");
    assert.equal(posted.body.priceSats, 2500);
    assert.equal(posted.body.title, "T");
    assert.equal(posted.body.seller, addr);
    assert.equal(posted.body.feeBps, 200);
    assert.equal(posted.body.feeAddress, TO);
    assert.equal(posted.body.offer.kind, "ordlock");
    assert.equal(posted.body.offer.version, 5);
    assert.equal(posted.body.origin, res.result.origin); // listing = the lock outpoint
    assert.match(posted.body.origin, /^[0-9a-f]{64}\.0$/);
    assert.equal(posted.body.metadata.source, "cli");
    // fee override and underscore outpoints (fresh carrier + funding for the second lock)
    chain.credit(addr, { txid: N6, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: F2, vout: 0, value: 50_000, height: 900 });
    const zero = await dispatch({
      method: "marketList",
      params: { outpoint: `${N6}_0`, priceSats: 2500, feeBps: 0 },
      id: 14,
    });
    assert.equal(zero.error, undefined);
    assert.equal(zero.result.feeBps, 0);
    const bad = await dispatch({ method: "marketList", params: { outpoint: "nope", priceSats: 5 }, id: 15 });
    assert.equal(bad.error.code, "BAD_PARAM");
    // policy-gated under the caller's origin (fresh carrier + funding so the gate is reached)
    chain.credit(addr, { txid: N7, vout: 0, value: 1, height: 900 });
    chain.credit(addr, { txid: F3, vout: 0, value: 80_000, height: 900 });
    await db("policies").where({ origin: "cli" }).delete();
    const denied = await dispatch({ method: "marketList", params: { outpoint: `${N7}.0`, priceSats: 2500 }, id: 16 });
    assert.equal(denied.error.code, "POLICY_DENY");
  } finally {
    globalThis.fetch = realFetch;
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("marketBuy atomic: fetches terms, verifies, buys, posts buy + settle", async () => {
  const { db, chain } = await backend();
  const realFetch = globalThis.fetch;
  try {
    await createWallet();
    const addr = selfAddress();
    const net = makeNet(addr);
    chain.credit(addr, { txid: N5, vout: 0, value: 1, height: 900 });
    await setPolicy(db, "cli", "allow");
    const offer = await signSwapOffer({
      db, chain, origin: "cli", txid: N1, vout: 0, priceSats: 5000, fetchFn: net.fetchFn,
    });
    const listing = marketListing({ seller: addr, offer });
    const { fetchFn, calls } = marketStub(net.fetchFn, { listing });
    globalThis.fetch = fetchFn;
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    const res = await dispatch({ method: "marketBuy", params: { listing: `${N1}.0` }, id: 20 });
    assert.equal(res.result.atomic, true);
    assert.equal(res.result.posted, true);
    assert.equal(res.result.settled, true);
    assert.equal(res.result.marketFee, 100);
    assert.equal(res.result.priceSats, 5000);
    assert.match(res.result.txid, /^[0-9a-f]{64}$/);
    assert.ok(calls.some((c) => c.path === "/v1/market/buy"));
    assert.ok(calls.some((c) => c.path === "/v1/market/settle"));
    const rows = await db("pending_txs").where({ txid: res.result.txid });
    assert.match(rows[0].label, /^market buy /);
  } finally {
    globalThis.fetch = realFetch;
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("marketBuy direct pays seller + fee; maxPrice and budgets bind", async () => {
  const { db, chain } = await backend();
  const realFetch = globalThis.fetch;
  try {
    await createWallet();
    const addr = selfAddress();
    const net = makeNet(addr);
    const { fetchFn, calls } = marketStub(net.fetchFn, { listing: marketListing() });
    globalThis.fetch = fetchFn;
    chain.credit(addr, { txid: F1, vout: 0, value: 100_000, height: 900 });
    // no approval for cli → denied
    const denied = await dispatch({ method: "marketBuy", params: { listing: `${N1}.0` }, id: 21 });
    assert.equal(denied.error.code, "POLICY_DENY");
    // a budgeted agent buys without a policy row (minting is the approval)
    const { mintAgent } = await import("../src/agents.ts");
    await mintAgent(db, { name: "buyer-agent", budgetSats: 20_000 });
    const res = await dispatch({
      method: "marketBuy",
      params: { listing: `${N1}.0`, origin: "buyer-agent" },
      id: 22,
    });
    assert.equal(res.result.atomic, false);
    assert.equal(res.result.posted, true);
    assert.equal(res.result.settled, false);
    assert.equal(res.result.marketFee, 100);
    assert.ok(calls.some((c) => c.path === "/v1/market/buy"));
    // maxPrice below the listing price: refused before signing
    const cap = await dispatch({
      method: "marketBuy",
      params: { listing: `${N1}.0`, origin: "buyer-agent", maxPrice: 1000 },
      id: 23,
    });
    assert.equal(cap.error.code, "BAD_PARAM");
    assert.match(cap.error.message, /exceeds max/);
  } finally {
    globalThis.fetch = realFetch;
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("marketCancel posts the seller cancel", async () => {
  const { db } = await backend();
  const realFetch = globalThis.fetch;
  try {
    await createWallet();
    const addr = selfAddress();
    const net = makeNet(addr);
    const { fetchFn, calls } = marketStub(net.fetchFn);
    globalThis.fetch = fetchFn;
    const res = await dispatch({ method: "marketCancel", params: { listing: `${N1}_0` }, id: 24 });
    assert.equal(res.result.cancelled, true);
    assert.equal(res.result.origin, `${N1}.0`);
    const posted = calls.find((c) => c.path === "/v1/market/cancel");
    assert.equal(posted.body.seller, addr);
    const bad = await dispatch({ method: "marketCancel", params: {}, id: 25 });
    assert.equal(bad.error.code, "BAD_PARAM");
  } finally {
    globalThis.fetch = realFetch;
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("market settlement posts retry TX_UNKNOWN with backoff", async () => {
  const { markBought } = await import("../src/market.ts");
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n < 3) return Response.json({ error: { code: "TX_UNKNOWN", message: "not yet" } }, { status: 502 });
    return Response.json({ ok: true });
  };
  await markBought("a.b", "ab".repeat(32), "x", flaky, { attempts: 5, delayMs: () => 1 });
  assert.equal(n, 3);
  let m = 0;
  const always = async () => {
    m += 1;
    return Response.json({ error: { code: "TX_UNKNOWN", message: "not yet" } }, { status: 502 });
  };
  await assert.rejects(
    markBought("a.b", "ab".repeat(32), "x", always, { attempts: 3, delayMs: () => 1 }),
    /not yet/,
  );
  assert.equal(m, 3);
  // non-retryable errors fail fast
  let k = 0;
  const bad = async () => {
    k += 1;
    return Response.json({ error: { code: "BAD_PAYMENT", message: "nope" } }, { status: 400 });
  };
  await assert.rejects(
    markBought("a.b", "ab".repeat(32), "x", bad, { attempts: 5, delayMs: () => 1 }),
    /nope/,
  );
  assert.equal(k, 1);
});

it("marketSync reconciles a lagging buy post", async () => {
  const { db } = await backend();
  const realFetch = globalThis.fetch;
  try {
    await createWallet();
    const net = makeNet(selfAddress());
    const atomic = marketListing({ offer: { version: 4, kind: "ordinal" } });
    const { fetchFn, calls } = marketStub(net.fetchFn, { listing: atomic });
    globalThis.fetch = fetchFn;
    const res = await dispatch({ method: "marketSync", params: { listing: `${N1}.0`, txid: "AB".repeat(32) }, id: 30 });
    assert.equal(res.result.posted, true);
    assert.equal(res.result.settled, true);
    assert.ok(calls.some((c) => c.path === "/v1/market/buy"));
    assert.ok(calls.some((c) => c.path === "/v1/market/settle"));
    // idempotent when the same txid is already recorded
    const again = marketStub(net.fetchFn, {
      listing: marketListing({ status: "paid", buyTxid: "ab".repeat(32), offer: { version: 4, kind: "ordinal" } }),
    });
    globalThis.fetch = again.fetchFn;
    const idem = await dispatch({ method: "marketSync", params: { listing: `${N1}.0`, txid: "AB".repeat(32) }, id: 31 });
    assert.equal(idem.result.posted, true);
    assert.equal(idem.result.settled, false);
    assert.equal(again.calls.length, 0);
    // a different tx on a non-active listing is a conflict
    const conflict = marketStub(net.fetchFn, {
      listing: marketListing({ status: "sold", transferTxid: "cd".repeat(32) }),
    });
    globalThis.fetch = conflict.fetchFn;
    const bad = await dispatch({ method: "marketSync", params: { listing: `${N1}.0`, txid: "AB".repeat(32) }, id: 32 });
    assert.equal(bad.error.code, "ALREADY_SOLD");
    const badTx = await dispatch({ method: "marketSync", params: { listing: `${N1}.0`, txid: "zz" }, id: 33 });
    assert.equal(badTx.error.code, "BAD_PARAM");
  } finally {
    globalThis.fetch = realFetch;
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
