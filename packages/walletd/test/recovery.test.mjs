import { test } from "node:test";
import assert from "node:assert/strict";

// partitioned keyring namespace (see custody.ts svc())
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-recovery";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { createWallet, destroyWallet, hasWallet, __resetCache } from "../src/custody.ts";
import {
  combineCards,
  fingerprintOf,
  listSets,
  parseCard,
  splitFor,
} from "../src/recovery.ts";
import { dispatch, setBackend } from "../src/rpc.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    return true;
  });
}

function throwsCode(fn, code) {
  return assert.throws(fn, (e) => {
    assert.equal(e.code, code);
    return true;
  });
}

const ENT = new Uint8Array(16).map((_, i) => i + 1);
const GUARDS = [{ name: "alice" }, { name: "bob" }, { name: "carol", identityKey: "02".padEnd(66, "ab") }];

test("cards pack/parse round-trip; hostile cards rejected", () => {
  const out = splitFor(ENT, 2, GUARDS);
  assert.equal(out.cards.length, 3);
  assert.equal(out.fingerprint, fingerprintOf(ENT));
  const p = parseCard(out.cards[0].card);
  assert.equal(p.setId, out.setId);
  assert.equal(p.need, 2);
  assert.ok(out.cards[0].card.startsWith("BSV1-"));
  assert.ok(!out.cards[0].card.includes(" "));
  for (const bad of ["", "mnemonic words here", "BSV1-x", out.cards[0].card.replace("BSV1", "BSV2")]) {
    throwsCode(() => parseCard(bad), "BAD_CARD");
  }
  throwsCode(() => splitFor(ENT, 2, [{ name: "alice" }, { name: "ALICE" }]), "BAD_PARAM");
  throwsCode(() => splitFor(ENT, 4, GUARDS), "BAD_PARAM");
  throwsCode(() => splitFor(ENT, 2, [{ name: "bad name!" }]), "BAD_PARAM");
  throwsCode(() => splitFor(new Uint8Array(15), 1, [{ name: "a" }]), "BAD_PARAM");
});

test("quorum enforced; mixed sets and foreign cards refused", () => {
  const a = splitFor(ENT, 2, GUARDS);
  const cards = a.cards.map((c) => c.card);
  throwsCode(() => combineCards([cards[0]]), "BAD_CARD");
  const other = splitFor(ENT, 2, GUARDS);
  throwsCode(() => combineCards([cards[0], other.cards[0]]), "BAD_CARD");
  // corrupt one card's data: parses, but reconstruction fails the fingerprint
  const tampered = cards.slice(0, 2);
  const parts = tampered[0].split("-");
  parts[4] = "00".repeat(16);
  tampered[0] = parts.join("-");
  throwsCode(() => combineCards(tampered), "BAD_CARD");
  // happy path through the helper too
  const back = combineCards(cards.slice(0, 2));
  assert.deepEqual(Buffer.from(back.entropy), Buffer.from(ENT));
  assert.equal(back.setId, a.setId);
});

test("fingerprint binds the secret, not the cards", () => {
  const a = splitFor(ENT, 2, GUARDS);
  const other = new Uint8Array(16).map((_, i) => 16 - i);
  assert.notEqual(splitFor(other, 2, GUARDS).fingerprint, a.fingerprint);
  assert.equal(a.fingerprint, fingerprintOf(ENT));
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
});

// Guarded like custody tests: never touch a real enrolled wallet.
const enrolled = await hasWallet();
const it = enrolled ? test.skip : test;

it("setup -> status -> rotate -> restore refuses the dead set", async () => {
  const db = await memdb();
  setBackend({ db, chain: null });
  try {
    await createWallet();
    const setup = await dispatch({
      method: "recoverySetup",
      params: { need: 2, guardians: [{ name: "alice" }, { name: "bob" }, { name: "carol" }] },
      id: 1,
    });
    assert.equal(setup.result.total, 3);
    assert.equal(setup.result.cards.length, 3);
    assert.match(setup.result.warning, /once/);
    const cards = setup.result.cards.map((c) => c.card);

    const status = await dispatch({ method: "recoveryStatus", id: 2 });
    assert.equal(status.result.protected, true);
    assert.equal(status.result.sets.length, 1);
    assert.equal(status.result.sets[0].guardians.length, 3);

    // restore from quorum works (force: wallet exists in this harness)
    const restored = await dispatch({ method: "recoveryRestore", params: { cards: cards.slice(0, 2), force: true }, id: 3 });
    assert.equal(restored.result.setId, setup.result.setId);

    // rotate kills the old cards
    const rotated = await dispatch({
      method: "recoveryRotate",
      params: { need: 2, guardians: [{ name: "alice" }, { name: "dave" }] },
      id: 4,
    });
    assert.notEqual(rotated.result.setId, setup.result.setId);
    assert.equal(rotated.result.cards.length, 2);
    const dead = await dispatch({ method: "recoveryRestore", params: { cards: cards.slice(0, 2), force: true }, id: 5 });
    assert.equal(dead.error.code, "BAD_CARD");

    const sets = await listSets(db);
    assert.equal(sets.filter((s) => s.superseded === 0).length, 1);
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});

it("locked wallets cannot start ceremonies", async () => {
  const db = await memdb();
  setBackend({ db, chain: null });
  try {
    await createWallet();
    const { lock } = await import("../src/custody.ts");
    lock();
    const r = await dispatch({
      method: "recoverySetup", params: { need: 1, guardians: [{ name: "a" }] }, id: 6,
    });
    assert.equal(r.error.code, "WALLET_LOCKED");
  } finally {
    setBackend(null);
    await db.destroy();
    await destroyWallet();
    __resetCache();
  }
});
