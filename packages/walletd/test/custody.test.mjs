import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-custody";
import {
  __resetCache, createWallet, destroyWallet, getStatus, hasWallet, importWallet, lock, unlock,
} from "../src/custody.ts";
// These tests enroll a REAL keyring entry. They refuse to run when a wallet
// already exists so a test run can never destroy user state.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("create -> lock -> unlock round-trips the same identity", async () => {
  const created = await createWallet();
  assert.match(created.identityKey, /^0[23][0-9a-f]{64}$/);
  assert.equal(created.backup.trim().split(/\s+/).length, 12);
  assert.equal((await getStatus()).locked, false);

  lock();
  assert.equal((await getStatus()).locked, true);

  const un = await unlock();
  assert.equal(un.identityKey, created.identityKey);
  const st = await getStatus();
  assert.equal(st.locked, false);
  assert.equal(st.identityKey, created.identityKey);
  await destroyWallet();
  __resetCache();
  assert.equal(await hasWallet(), false);
});

it("duplicate create is refused without force", async () => {
  await createWallet();
  await assert.rejects(createWallet(), /already exists/);
  const forced = await createWallet(true);
  assert.match(forced.identityKey, /^0[23][0-9a-f]{64}$/);
  await destroyWallet();
  __resetCache();
});

it("auto-lock fires after the idle timeout", async () => {
  process.env.BSV_WALLETD_LOCK_MS = "60";
  await createWallet();
  assert.equal((await getStatus()).locked, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await getStatus()).locked, true);
  delete process.env.BSV_WALLETD_LOCK_MS;
  await destroyWallet();
  __resetCache();
});

it("unlock with no wallet is a clean NO_WALLET error", async () => {
  await assert.rejects(unlock(), /no wallet enrolled/);
});

const VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

it("import restores the same identity deterministically", async () => {
  const first = await importWallet(VECTOR);
  assert.match(first.identityKey, /^0[23][0-9a-f]{64}$/);
  lock();
  const second = await unlock();
  assert.equal(second.identityKey, first.identityKey);
  await destroyWallet();
  __resetCache();
  // same phrase, fresh import -> identical identity (new-machine restore)
  const again = await importWallet(`  ${VECTOR.toUpperCase()}  `);
  assert.equal(again.identityKey, first.identityKey);
  await destroyWallet();
  __resetCache();
});

it("import rejects garbage and refuses to clobber", async () => {
  await assert.rejects(importWallet("hello world"), /valid 12-word/);
  await assert.rejects(importWallet("abandon ".repeat(12).trim()), /valid 12-word/);
  await createWallet();
  await assert.rejects(importWallet(VECTOR), /already exists/);
  const forced = await importWallet(VECTOR, true);
  assert.match(forced.identityKey, /^0[23][0-9a-f]{64}$/);
  await destroyWallet();
  __resetCache();
});
