import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPublishingFee, installSplit, verifyInstallPayment } from "../src/payment.ts";
import { storeConfig } from "../src/protocol.ts";

const cfg = storeConfig({
  storeAddress: "1StoreAddressXXXXXXXXXXXXXXXXXXXX",
  storePubkey: "02" + "ab".repeat(32),
  publishingFeeSats: 1000,
  storeCutBps: 1000,
});

test("installSplit is 10% to the store, 90% to the publisher", () => {
  assert.deepEqual(installSplit(1000, 1000), { priceSats: 1000, publisherSats: 900, storeSats: 100 });
  assert.deepEqual(installSplit(0, 1000), { priceSats: 0, publisherSats: 0, storeSats: 0 });
  assert.deepEqual(installSplit(1, 1000), { priceSats: 1, publisherSats: 0, storeSats: 1 });
  assert.deepEqual(installSplit(15, 1000), { priceSats: 15, publisherSats: 14, storeSats: 1 });
});

test("publishing fee must hit the store address", () => {
  const ok = hasPublishingFee(
    [{ satoshis: 1000, address: cfg.storeAddress }, { satoshis: 1, address: "1Publisher" }],
    cfg,
  );
  assert.equal(ok.ok, true);
  const short = hasPublishingFee([{ satoshis: 999, address: cfg.storeAddress }], cfg);
  assert.equal(short.ok, false);
  const missing = hasPublishingFee([{ satoshis: 1000, address: "1Publisher" }], cfg);
  assert.equal(missing.ok, false);
});

test("install payment without the store cut is not licensed", () => {
  const publisher = "1PublisherXXXXXXXXXXXXXXXXXXXXXXX";
  const onlyPub = verifyInstallPayment(
    [{ satoshis: 1000, address: publisher }],
    { priceSats: 1000, publisherAddress: publisher, cfg },
  );
  assert.equal(onlyPub.ok, false);
  assert.match(onlyPub.reason, /store cut/);

  const split = verifyInstallPayment(
    [
      { satoshis: 900, address: publisher },
      { satoshis: 100, address: cfg.storeAddress },
    ],
    { priceSats: 1000, publisherAddress: publisher, cfg },
  );
  assert.equal(split.ok, true);
  assert.equal(split.split.storeSats, 100);
});

test("store cut bps is configurable", () => {
  const half = storeConfig({ ...cfg, storeCutBps: 5000 });
  const r = verifyInstallPayment(
    [
      { satoshis: 500, address: "1PublisherXXXXXXXXXXXXXXXXXXXXXXX" },
      { satoshis: 500, address: half.storeAddress },
    ],
    { priceSats: 1000, publisherAddress: "1PublisherXXXXXXXXXXXXXXXXXXXXXXX", cfg: half },
  );
  assert.equal(r.ok, true);
  assert.equal(r.split.storeSats, 500);
});
