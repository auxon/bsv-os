import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverlayTx } from "../src/apply.ts";
import { lookupLicense, lookupListings, MemoryListingStore } from "../src/lookup.ts";
import { storeConfig } from "../src/protocol.ts";
import { installTx, listingTx, publisher, signedDelist, signedListing } from "./helpers.mjs";

const cfg = storeConfig({
  storeAddress: "1StoreFeeAddressXXXXXXXXXXXXXXXXX",
  publishingFeeSats: 1000,
  storeCutBps: 1000,
});

test("lookup returns the latest live version per domain", async () => {
  const store = new MemoryListingStore();
  const { priv, address } = publisher();
  const v1 = signedListing(priv, { version: "1.0.0", name: "Cast" });
  const first = listingTx(v1, {
    txid: "11".repeat(32),
    publisherAddress: address,
    storeAddress: cfg.storeAddress,
  });
  assert.equal((await applyOverlayTx(store, first, cfg)).ok, true);

  const v2 = signedListing(priv, { version: "1.2.0", name: "Cast", prevOutpoint: `${first.txid}.0` });
  const second = listingTx(v2, {
    txid: "22".repeat(32),
    publisherAddress: address,
    storeAddress: cfg.storeAddress,
    inputs: [{ txid: first.txid, vout: 0 }],
  });
  assert.equal((await applyOverlayTx(store, second, cfg)).ok, true);

  const latest = await lookupListings(store, { latest: true, name: "cast" });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].version, "1.2.0");
  assert.equal((await store.get(`${first.txid}.0`)).spent, true);

  const byPub = await lookupListings(store, { publisher: v1.publisherKey, latest: true });
  assert.equal(byPub[0].domain, "cast.localhost");
  const byCat = await lookupListings(store, { category: "media", latest: true });
  assert.equal(byCat.length, 1);
});

test("search by publisher ignores another author's listing", async () => {
  const store = new MemoryListingStore();
  const a = publisher();
  const b = publisher();
  const ta = signedListing(a.priv, { name: "Cast", domain: "cast.localhost", url: "https://cast.localhost:2121/" });
  const tb = signedListing(b.priv, {
    name: "Twetch",
    domain: "twetch.localhost",
    url: "https://twetch.localhost:2121/",
    category: "social",
  });
  await applyOverlayTx(store, listingTx(ta, { txid: "aa".repeat(32), publisherAddress: a.address, storeAddress: cfg.storeAddress }), cfg);
  await applyOverlayTx(store, listingTx(tb, { txid: "bb".repeat(32), publisherAddress: b.address, storeAddress: cfg.storeAddress }), cfg);
  const rows = await lookupListings(store, { publisher: b.publisherKey, latest: true });
  assert.deepEqual(rows.map((r) => r.name), ["Twetch"]);
});

test("delist drops the listing from latest results", async () => {
  const store = new MemoryListingStore();
  const { priv, address, publisherKey } = publisher();
  const token = signedListing(priv);
  const first = listingTx(token, { txid: "11".repeat(32), publisherAddress: address, storeAddress: cfg.storeAddress });
  await applyOverlayTx(store, first, cfg);
  const delist = signedDelist(priv, `${first.txid}.0`);
  const tx = {
    txid: "99".repeat(32),
    inputs: [{ txid: first.txid, vout: 0 }],
    outputs: [{ satoshis: 0, opReturn: ["bsvos.app", JSON.stringify(delist)] }],
  };
  assert.equal((await applyOverlayTx(store, tx, cfg)).ok, true);
  assert.equal((await lookupListings(store, { publisher: publisherKey, latest: true })).length, 0);
});

test("lookup marks licensed only after a store-cut payment is admitted", async () => {
  const store = new MemoryListingStore();
  const { priv, address, publisherKey } = publisher();
  const token = signedListing(priv, { priceSats: 1000 });
  const listed = listingTx(token, { txid: "11".repeat(32), publisherAddress: address, storeAddress: cfg.storeAddress });
  await applyOverlayTx(store, listed, cfg);
  const outpoint = `${listed.txid}.0`;

  const receipt = { v: 1, type: "install", listingOutpoint: outpoint, bundleHash: token.bundleHash };
  const skim = installTx(receipt, {
    txid: "cc".repeat(32),
    publisherAddress: address,
    storeAddress: cfg.storeAddress,
    publisherSats: 1000,
    storeSats: 0,
  });
  const refused = await applyOverlayTx(store, skim, cfg);
  assert.equal(refused.ok, false);
  assert.equal((await lookupLicense(store, { listingOutpoint: outpoint })).licensed, false);

  const paid = installTx(receipt, {
    txid: "dd".repeat(32),
    publisherAddress: address,
    storeAddress: cfg.storeAddress,
    publisherSats: 900,
    storeSats: 100,
  });
  const ok = await applyOverlayTx(store, paid, cfg);
  assert.equal(ok.ok, true);
  const lic = await lookupLicense(store, { paymentTxid: paid.txid });
  assert.equal(lic.licensed, true);
  assert.equal(lic.license.storeSats, 100);
  assert.equal(lic.license.publisherSats, 900);
  void publisherKey;
});
