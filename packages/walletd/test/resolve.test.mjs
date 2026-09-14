import { test } from "node:test";
import assert from "node:assert/strict";
import { MockChainProvider, resolveOutpoint } from "../src/chain.ts";

const ADDR = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";
const TX = "c".repeat(64);

test("indexed outpoint resolves directly", async () => {
  const chain = new MockChainProvider([
    { address: ADDR, utxos: [{ txid: TX, vout: 0, value: 1, height: 900 }] },
  ]);
  const r = await resolveOutpoint(chain, ADDR, TX, 0);
  assert.deepEqual(r, { txid: TX, vout: 0, value: 1, unconfirmed: false, indexed: true });
});

test("phantom envelope: absent from address index, parent unconfirmed -> chainable", async () => {
  // the PocketPets Torto case: inscription outputs map to no address, so the
  // address index can never contain them. Parent 0-conf => build behind it.
  const chain = new MockChainProvider();
  chain.seedParent(TX, 0);
  const r = await resolveOutpoint(chain, ADDR, TX, 0);
  assert.equal(r.unconfirmed, true);
  assert.equal(r.indexed, false);
  assert.equal(r.txid, TX);
});

test("confirmed parent resolves (only the key holder can move it)", async () => {
  const chain = new MockChainProvider();
  chain.seedParent(TX, 6);
  const r = await resolveOutpoint(chain, ADDR, TX, 0);
  assert.equal(r.unconfirmed, false);
  assert.equal(r.indexed, false);
});

test("missing parent asks to wait", async () => {
  const chain = new MockChainProvider();
  await assert.rejects(resolveOutpoint(chain, ADDR, TX, 0), /NOT_FOUND/);
});
