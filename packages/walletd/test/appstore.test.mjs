import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import knex from "knex";
import { installApp, manifestSha256, stableStringify } from "../src/apps.ts";
import { hashAppDirectory, quoteInstall, verifyListingHashes, verifyPaidInstall } from "../src/appstore.ts";
import { migrate } from "../src/storage.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

test("quoteInstall is 10% store / 90% publisher", () => {
  assert.deepEqual(quoteInstall(1000, 1000), { priceSats: 1000, publisherSats: 900, storeSats: 100 });
});

test("verifyPaidInstall refuses a publisher-only payment", () => {
  assert.throws(
    () => verifyPaidInstall({
      outputs: [{ address: "1PublisherXXXXXXXXXXXXXXXXXXXXXXX", satoshis: 1000 }],
      priceSats: 1000,
      publisherAddress: "1PublisherXXXXXXXXXXXXXXXXXXXXXXX",
      storeAddr: "1StoreXXXXXXXXXXXXXXXXXXXXXXXXXX",
      cutBps: 1000,
    }),
    /store cut/,
  );
  const ok = verifyPaidInstall({
    outputs: [
      { address: "1PublisherXXXXXXXXXXXXXXXXXXXXXXX", satoshis: 900 },
      { address: "1StoreXXXXXXXXXXXXXXXXXXXXXXXXXX", satoshis: 100 },
    ],
    priceSats: 1000,
    publisherAddress: "1PublisherXXXXXXXXXXXXXXXXXXXXXXX",
    storeAddr: "1StoreXXXXXXXXXXXXXXXXXXXXXXXXXX",
    cutBps: 1000,
  });
  assert.deepEqual(ok, { publisherSats: 900, storeSats: 100 });
});

test("installApp refuses an overlay listing whose bundle hash does not match", async () => {
  const db = await memdb();
  try {
    const manifest = { name: "Hashed", start_url: "https://app.example/", metanet: { groupPermissions: { spendingAuthorization: { amount: 0 } } } };
    const listing = {
      outpoint: `${"ab".repeat(32)}.0`,
      name: "Hashed",
      version: "1.0.0",
      domain: "app.example",
      url: "https://app.example/",
      category: "",
      blurb: "",
      bundleHash: "ab".repeat(32),
      manifestHash: manifestSha256(manifest),
      publisherKey: "02" + "ab".repeat(32),
      priceSats: 0,
      permissions: { spendCapSats: 0, protocols: 0, baskets: 0, certs: 0, intents: [] },
      source: "overlay",
    };
    await assert.rejects(
      () => installApp(db, "app.example", { seedPolicyRequest: async () => {} }, {
        manifestJson: manifest,
        listing,
        bundle: { hash: "cd".repeat(32) },
      }),
      /bundle hash mismatch/,
    );
    const { app } = await installApp(db, "app.example", { seedPolicyRequest: async () => {} }, {
      manifestJson: manifest,
      listing,
      bundle: { hash: listing.bundleHash },
    });
    assert.equal(app.domain, "app.example");
    assert.equal(app.manifestSha256, listing.manifestHash);
  } finally {
    await db.destroy();
  }
});

test("hashAppDirectory moves when any file changes", async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner/apps/explorer");
  const a = await hashAppDirectory(dir);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.ok(a.files.some((f) => f.path === "manifest.json"));
  const root = createHash("sha256").update(stableStringify({ n: a.files.length }), "utf8").digest("hex");
  assert.notEqual(a.hash, root);
});

test("verifyListingHashes requires both hashes", async () => {
  const manifest = { name: "X", start_url: "/" };
  const listing = {
    outpoint: `${"11".repeat(32)}.0`,
    name: "X",
    version: "1",
    domain: "x.example",
    url: "https://x.example/",
    category: "",
    blurb: "",
    bundleHash: "ab".repeat(32),
    manifestHash: manifestSha256(manifest),
    publisherKey: "02" + "ab".repeat(32),
    priceSats: 0,
    permissions: { spendCapSats: 0, protocols: 0, baskets: 0, certs: 0, intents: [] },
    source: "overlay",
  };
  await verifyListingHashes({ listing, manifest, bundle: { hash: listing.bundleHash } });
  await assert.rejects(
    () => verifyListingHashes({ listing, manifest: { ...manifest, name: "Y" }, bundle: { hash: listing.bundleHash } }),
    /manifest hash/,
  );
});
