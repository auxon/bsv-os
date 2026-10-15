import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BSV_WALLETD_KEYSTORE = "file";
process.env.BSV_WALLETD_KEYSTORE_PASSWORD = "test-password-123";
process.env.BSV_WALLETD_KEYSTORE_FILE = join(
  mkdtempSync(join(tmpdir(), "keystore-test-")),
  "keystore.enc",
);

const { FileKeystore, getKeystore, KeystoreError } = await import("../src/keystore.ts");

test("file backend round-trips set/get/delete", async () => {
  const ks = new FileKeystore();
  assert.equal(await ks.getPassword("svc", "acct"), null);
  await ks.setPassword("svc", "acct", "s3cret");
  assert.equal(await ks.getPassword("svc", "acct"), "s3cret");
  await ks.setPassword("svc", "other", "x");
  assert.equal(await ks.getPassword("svc", "other"), "x");
  assert.equal(await ks.deletePassword("svc", "acct"), true);
  assert.equal(await ks.getPassword("svc", "acct"), null);
  assert.equal(await ks.deletePassword("svc", "acct"), false);
});

test("file backend writes 0600", async () => {
  const ks = new FileKeystore();
  await ks.setPassword("svc", "acct", "s3cret");
  const mode = statSync(process.env.BSV_WALLETD_KEYSTORE_FILE).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("wrong password fails closed", async () => {
  const ks = new FileKeystore();
  await ks.setPassword("svc", "acct", "s3cret");
  const evil = new FileKeystore(process.env.BSV_WALLETD_KEYSTORE_FILE, "wrong-password");
  await assert.rejects(() => evil.getPassword("svc", "acct"), (e) => {
    assert.ok(e instanceof KeystoreError);
    assert.equal(e.code, "DECRYPT_FAILED");
    return true;
  });
});

test("missing password fails fast", () => {
  const saved = process.env.BSV_WALLETD_KEYSTORE_PASSWORD;
  delete process.env.BSV_WALLETD_KEYSTORE_PASSWORD;
  assert.throws(() => new FileKeystore(), (e) => {
    assert.ok(e instanceof KeystoreError);
    assert.equal(e.code, "NO_PASSWORD");
    return true;
  });
  process.env.BSV_WALLETD_KEYSTORE_PASSWORD = saved;
});

test("getKeystore honors BSV_WALLETD_KEYSTORE", () => {
  assert.ok(getKeystore() instanceof FileKeystore);
  process.env.BSV_WALLETD_KEYSTORE = "bogus";
  assert.throws(() => getKeystore(), (e) => e.code === "BAD_BACKEND");
  process.env.BSV_WALLETD_KEYSTORE = "file";
});
