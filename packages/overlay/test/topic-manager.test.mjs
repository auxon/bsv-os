import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@bsv/sdk";
import { storeConfig } from "../src/protocol.ts";
import { identifyAdmissibleOutputs } from "../src/topic-manager.ts";
import { compareVersions, parseListing } from "../src/listing.ts";
import { installTx, listingTx, publisher, signedDelist, signedListing } from "./helpers.mjs";

const cfg = storeConfig({
  storeAddress: "1StoreFeeAddressXXXXXXXXXXXXXXXXX",
  publishingFeeSats: 1000,
  storeCutBps: 1000,
});

test("a signed listing with the publishing fee is admitted", () => {
  const { priv, address } = publisher();
  const token = signedListing(priv);
  const tx = listingTx(token, { publisherAddress: address, storeAddress: cfg.storeAddress });
  const r = identifyAdmissibleOutputs(tx, { cfg });
  assert.equal(r.ok, true);
  assert.equal(r.kind, "listing");
  assert.deepEqual(r.outputsToAdmit, [0]);
});

test("missing publishing fee is refused", () => {
  const { priv, address } = publisher();
  const token = signedListing(priv);
  const tx = listingTx(token, { publisherAddress: address, storeAddress: undefined });
  const r = identifyAdmissibleOutputs(tx, { cfg });
  assert.equal(r.ok, false);
  assert.match(r.reason, /publishing fee/);
});

test("a shared localhost identity is not a real listing", () => {
  const { priv } = publisher();
  assert.throws(
    () => signedListing(priv, { domain: "localhost", url: "https://localhost:2121/cast/" }),
    /shared identity/,
  );
});

test("a bad signature is refused", () => {
  const { priv, address } = publisher();
  const token = signedListing(priv);
  token.signature = "AAAA";
  const tx = listingTx(token, { publisherAddress: address, storeAddress: cfg.storeAddress });
  const r = identifyAdmissibleOutputs(tx, { cfg });
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature/);
});

test("only the publisher can update by spending the previous listing", () => {
  const a = publisher();
  const b = publisher();
  const first = signedListing(a.priv, { version: "1.0.0" });
  const firstTx = listingTx(first, {
    txid: "11".repeat(32),
    publisherAddress: a.address,
    storeAddress: cfg.storeAddress,
  });
  const admitted = identifyAdmissibleOutputs(firstTx, { cfg });
  assert.equal(admitted.ok, true);
  const prev = {
    outpoint: `${firstTx.txid}.0`,
    publisherKey: first.publisherKey,
    domain: first.domain,
    version: first.version,
  };

  const update = signedListing(a.priv, { version: "1.1.0", prevOutpoint: prev.outpoint });
  const ok = identifyAdmissibleOutputs(
    listingTx(update, {
      txid: "22".repeat(32),
      publisherAddress: a.address,
      storeAddress: cfg.storeAddress,
      inputs: [{ txid: firstTx.txid, vout: 0 }],
    }),
    { cfg, previous: prev },
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.coinsToRetain, [prev.outpoint]);

  const stolen = signedListing(b.priv, {
    version: "1.1.0",
    prevOutpoint: prev.outpoint,
    domain: "cast.localhost",
    url: "https://cast.localhost:2121/",
  });
  const no = identifyAdmissibleOutputs(
    listingTx(stolen, {
      publisherAddress: b.address,
      storeAddress: cfg.storeAddress,
      inputs: [{ txid: firstTx.txid, vout: 0 }],
    }),
    { cfg, previous: prev },
  );
  assert.equal(no.ok, false);
  assert.match(no.reason, /only the publisher/);
});

test("delist spends the listing and must be the publisher", () => {
  const a = publisher();
  const b = publisher();
  const prev = {
    outpoint: `${"33".repeat(32)}.0`,
    publisherKey: a.publisherKey,
    domain: "cast.localhost",
    version: "1.0.0",
  };
  const delist = signedDelist(a.priv, prev.outpoint);
  const tx = {
    txid: "44".repeat(32),
    inputs: [{ txid: "33".repeat(32), vout: 0 }],
    outputs: [
      { satoshis: 0, opReturn: ["bsvos.app", JSON.stringify(delist)] },
    ],
  };
  const ok = identifyAdmissibleOutputs(tx, { cfg, previous: prev });
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, "delist");

  const other = signedDelist(b.priv, prev.outpoint);
  const no = identifyAdmissibleOutputs(
    { ...tx, outputs: [{ satoshis: 0, opReturn: ["bsvos.app", JSON.stringify(other)] }] },
    { cfg, previous: prev },
  );
  assert.equal(no.ok, false);
  assert.match(no.reason, /only the publisher/);
});

test("install receipt is admitted only with the store-cut output", () => {
  const { publisherKey, address } = publisher();
  const listing = {
    priceSats: 1000,
    publisherKey,
    bundleHash: "ab".repeat(32),
    outpoint: `${"55".repeat(32)}.0`,
  };
  const receipt = { v: 1, type: "install", listingOutpoint: listing.outpoint, bundleHash: listing.bundleHash };
  const paid = identifyAdmissibleOutputs(
    installTx(receipt, {
      publisherAddress: address,
      storeAddress: cfg.storeAddress,
      publisherSats: 900,
      storeSats: 100,
    }),
    { cfg, listingForInstall: listing },
  );
  assert.equal(paid.ok, true);
  assert.equal(paid.kind, "install");

  const skim = identifyAdmissibleOutputs(
    installTx(receipt, {
      publisherAddress: address,
      storeAddress: cfg.storeAddress,
      publisherSats: 1000,
      storeSats: 0,
    }),
    { cfg, listingForInstall: listing },
  );
  assert.equal(skim.ok, false);
  assert.match(skim.reason, /store cut/);
});

test("compareVersions is numeric", () => {
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("2.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("parseListing requires a bundle hash, not only a manifest hash", () => {
  const priv = PrivateKey.fromRandom();
  assert.throws(() => parseListing({
    v: 1, type: "listing", name: "X", version: "1", domain: "x.example",
    url: "https://x.example/", bundleHash: "nope", manifestHash: "cd".repeat(32),
    publisherKey: priv.toPublicKey().toString(), priceSats: 0,
    permissions: { spendCapSats: 0, protocols: 0, baskets: 0, certs: 0, intents: [] },
    signature: "x",
  }), /bundleHash/);
});
