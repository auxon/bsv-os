import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { MockChainProvider } from "../src/chain.ts";
import {
  canonicalStatement,
  proveFundsUtxo,
  createFundsAttestation,
  fundsLeaf,
  listFundsAttestations,
  merklePath,
  merkleRoot,
  migrateFunds,
  recordFundsAttestation,
  sha256hex,
  spendableUtxos,
  verifyFundsAttestation,
  verifyMerklePath,
} from "../src/attest.ts";
import { BSM, PrivateKey } from "@bsv/sdk";

delete process.env.OPENROUTER_API_KEY;

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

// A real key pair, so the signature checks are real ECDSA, not a stub.
const PRIV = PrivateKey.fromRandom();
const KEY = PRIV.toPublicKey().toString();
const sign = (message) => BSM.sign(Array.from(Buffer.from(message, "utf8")), PRIV, "base64");

function utxos(chain, list) {
  chain.utxos = async () => ({
    confirmed: list.reduce((s, u) => s + u.value, 0),
    unconfirmed: 0,
    utxos: list.map((u, i) => ({ txid: String(i).padStart(64, "0"), vout: 0, value: u.value, height: 800_000 })),
  });
  return chain;
}

test("merkle root and inclusion paths verify; a changed leaf does not", () => {
  const leaves = [fundsLeaf("aa_0", 1000), fundsLeaf("bb_1", 2000), fundsLeaf("cc_2", 3000), fundsLeaf("dd_3", 4000), fundsLeaf("ee_4", 5000)];
  const root = merkleRoot(leaves);
  assert.equal(root.toString("hex").length, 64);
  // Every leaf in the set has a path that verifies against the root.
  for (const leaf of leaves) {
    const path = merklePath(leaves, leaf);
    assert.equal(verifyMerklePath(leaf, path, root), true, `${leaf.toString("hex").slice(0, 8)} should verify`);
  }
  // Order of the input array does not change the commitment.
  assert.equal(merkleRoot([...leaves].reverse()).toString("hex"), root.toString("hex"));
  // A leaf that is not in the set, or a tampered value, fails.
  const stranger = fundsLeaf("ff_9", 1000);
  assert.throws(() => merklePath(leaves, stranger), /not present/);
  assert.equal(verifyMerklePath(fundsLeaf("aa_0", 1001), merklePath(leaves, leaves[0]), root), false);
  // Single-leaf and empty sets are defined, not crashes.
  const one = fundsLeaf("aa_0", 1000);
  assert.equal(merkleRoot([one]).toString("hex"), one.toString("hex"));
  assert.equal(merkleRoot([]).toString("hex"), "0".repeat(64));
});

test("a leaf commits to outpoint AND value", () => {
  assert.notEqual(fundsLeaf("aa_0", 1000).toString("hex"), fundsLeaf("aa_0", 1001).toString("hex"));
  assert.notEqual(fundsLeaf("aa_0", 1000).toString("hex"), fundsLeaf("aa_1", 1000).toString("hex"));
  // Stable: same inputs, same leaf.
  assert.equal(fundsLeaf("aa_0", 1000).toString("hex"), fundsLeaf("aa_0", 1000).toString("hex"));
});

test("the published statement carries no balance and no UTXO count", async () => {
  const db = await memdb();
  try {
    const chain = utxos(new MockChainProvider(), [{ value: 60_000 }, { value: 40_000 }]);
    const att = await createFundsAttestation(
      { db, chain, now: () => 1_700_000_000_000, sign, key: () => KEY, address: () => "1test" },
      { minSats: 50_000 },
    );
    // Local knowledge, never published.
    assert.equal(att.totalSats, 100_000);
    assert.equal(att.utxoCount, 2);
    const wire = JSON.stringify(att.statement);
    assert.doesNotMatch(wire, /100000/, "the exact total must not appear in the claim");
    assert.doesNotMatch(wire, /utxoCount|totalSats/);
    for (const field of ["v", "kind", "key", "address", "minSats", "root", "createdAt", "validUntil", "nonce"]) {
      assert.ok(field in att.statement, `statement must carry ${field}`);
    }
    // Canonical form is stable regardless of key insertion order.
    const shuffled = Object.fromEntries(Object.entries(att.statement).reverse());
    assert.equal(canonicalStatement(shuffled), canonicalStatement(att.statement));
  } finally {
    await db.destroy();
  }
});

test("the daemon refuses to sign a claim above what it can see", async () => {
  const db = await memdb();
  try {
    const chain = utxos(new MockChainProvider(), [{ value: 5_000 }]);
    const deps = { db, chain, now: () => 1_700_000_000_000, sign, key: () => KEY, address: () => "1test" };
    await assert.rejects(() => createFundsAttestation(deps, { minSats: 6_000 }), /cannot attest 6000 sats: only 5000/);
    await assert.rejects(() => createFundsAttestation(deps, { minSats: 0 }), /minSats must be a positive/);
    const empty = utxos(new MockChainProvider(), []);
    await assert.rejects(
      () => createFundsAttestation({ ...deps, chain: empty }, { minSats: 1 }),
      /no spendable UTXOs/,
    );
  } finally {
    await db.destroy();
  }
});

test("reserved coins (capsule funding) are not counted as spendable", async () => {
  const db = await memdb();
  try {
    const chain = utxos(new MockChainProvider(), [{ value: 10_000 }, { value: 10_000 }]);
    // The first outpoint (all-zero txid, vout 0) is reserved for a capsule.
    await db("reserved_utxos").insert({
      outpoint: "0".repeat(64) + "_0", capsule_id: 1, txid: "0".repeat(64), vout: 0,
      value: 10_000, created_at: Date.now(),
    });
    const hold = await spendableUtxos(db, chain, "1test");
    assert.equal(hold.length, 1);
    assert.equal(hold[0].valueSats, 10_000);
    // And a claim above the unreserved total is refused.
    await assert.rejects(
      () => createFundsAttestation(
        { db, chain, now: () => 1_700_000_000_000, sign, key: () => KEY, address: () => "1test" },
        { minSats: 15_000 },
      ),
      /only 10000 spendable/,
    );
  } finally {
    await db.destroy();
  }
});

test("verification names every check and refuses a bad or expired claim", async () => {
  const db = await memdb();
  try {
    const chain = utxos(new MockChainProvider(), [{ value: 60_000 }, { value: 40_000 }]);
    const now = 1_700_000_000_000;
    const att = await createFundsAttestation(
      { db, chain, now: () => now, sign, key: () => KEY, address: () => "1test" },
      { minSats: 50_000 },
    );
    const good = verifyFundsAttestation(att, now + 60_000);
    assert.equal(good.ok, true);
    assert.deepEqual(good.checks.map((c) => c.name), ["shape", "version", "key", "minSats", "root", "window", "signature", "unexpired", "clock"]);
    assert.ok(good.checks.every((c) => c.ok));
    assert.match(good.disclosure.doesNotReveal.join(" "), /balance/);

    // Expired.
    const expired = verifyFundsAttestation(att, now + 3_600_001);
    assert.equal(expired.ok, false);
    assert.equal(expired.checks.find((c) => c.name === "unexpired").ok, false);
    // Every other check still passes: expiry alone is the reason.
    assert.ok(expired.checks.filter((c) => c.name !== "unexpired").every((c) => c.ok));

    // Tampered claim: more sats, same signature.
    const tampered = { statement: { ...att.statement, minSats: 5_000_000 }, signature: att.signature };
    const t = verifyFundsAttestation(tampered, now);
    assert.equal(t.ok, false);
    assert.equal(t.checks.find((c) => c.name === "signature").ok, false);

    // Wrong version, junk key, missing root: each named, none crashing.
    for (const [mutate, expect] of [
      [(a) => ({ ...a, statement: { ...a.statement, v: 2 } }), "version"],
      [(a) => ({ ...a, statement: { ...a.statement, key: "nope" } }), "key"],
      [(a) => ({ ...a, statement: { ...a.statement, root: "zz" } }), "root"],
      // An empty object is a fine shape — it just fails every field check.
      [() => ({ statement: {}, signature: "x" }), "version"],
      [() => null, "shape"],
      // Hostile shapes must produce failed checks, never an exception.
      [() => ({ statement: { ...att.statement, createdAt: "soon", validUntil: null }, signature: att.signature }), "window"],
      [() => ({ statement: { ...att.statement, minSats: -5 }, signature: att.signature }), "minSats"],
      [() => "a string", "shape"],
      [() => [], "shape"],
    ]) {
      const r = verifyFundsAttestation(mutate(att), now);
      assert.equal(r.ok, false);
      assert.equal(r.checks.find((c) => c.name === expect).ok, false, `expected ${expect} to fail`);
      assert.ok(r.checks.every((c) => typeof c.detail === "string" && c.detail.length > 0));
    }

    // Created in the future: a clock-skew alarm, not a pass.
    const future = verifyFundsAttestation(att, now - 3_600_000);
    assert.equal(future.ok, false);
    assert.equal(future.checks.find((c) => c.name === "clock").ok, false);
  } finally {
    await db.destroy();
  }
});

test("history is recorded with the local balance, newest first", async () => {
  const db = await memdb();
  try {
    const chain = utxos(new MockChainProvider(), [{ value: 60_000 }, { value: 40_000 }]);
    const deps = { db, chain, sign, key: () => KEY, address: () => "1test" };
    await recordFundsAttestation(db, await createFundsAttestation({ ...deps, now: () => 1_000 }, { minSats: 10_000 }));
    await recordFundsAttestation(db, await createFundsAttestation({ ...deps, now: () => 2_000 }, { minSats: 90_000 }));
    const rows = await listFundsAttestations(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].minSats, 90_000);
    assert.deepEqual(rows.map((r) => r.id), [2, 1]);
    assert.equal(rows[0].totalSats, 100_000); // local audit trail keeps the truth
    assert.equal(rows[0].anchorTxid, null);
    // The stored statement is canonical text, ready to re-verify verbatim.
    assert.equal(JSON.parse(rows[0].statement).minSats, 90_000);
  } finally {
    await db.destroy();
  }
});

test("selective disclosure: one UTXO proven against the root, rest hidden", async () => {
  const db = await memdb();
  try {
    const list = [{ value: 60_000 }, { value: 40_000 }, { value: 12_345 }];
    const chain = utxos(new MockChainProvider(), list);
    const deps = { db, chain, sign, key: () => KEY, address: () => "1test" };
    const att = await createFundsAttestation({ ...deps, now: () => 1_700_000_000_000 }, { minSats: 50_000 });
    const root = merkleRoot(list.map((u, i) => fundsLeaf(String(i).padStart(64, "0") + "_0", u.value)));

    // The second coin: leaf plus path, and nothing about the others.
    const outpoint = "1".padStart(64, "0") + "_0";
    const proof = await proveFundsUtxo(deps, att.statement, outpoint);
    assert.equal(proof.outpoint, outpoint);
    assert.equal(proof.valueSats, 40_000);
    assert.equal(proof.ok, true);
    assert.equal(proof.root, root.toString("hex"));
    // A third party can check it with nothing but the attestation and the proof.
    const leaf = Buffer.from(proof.leaf, "hex");
    assert.equal(verifyMerklePath(leaf, proof.path.map((h) => Buffer.from(h, "hex")), Buffer.from(proof.root, "hex")), true);
    // The disclosure mentions one outpoint; it leaks neither the others nor the total.
    const wire = JSON.stringify(proof);
    assert.ok(!wire.includes("2".padStart(64, "0")));
    assert.doesNotMatch(wire, /112345/);

    // A UTXO we do not hold, and one held but reserved, fail differently.
    await assert.rejects(
      () => proveFundsUtxo(deps, att.statement, "f".repeat(64) + "_0"),
      /is not a UTXO of 1test/,
    );
    await db("reserved_utxos").insert({
      outpoint: "0".repeat(64) + "_0", capsule_id: 1, txid: "0".repeat(64), vout: 0,
      value: 60_000, created_at: Date.now(),
    });
    await assert.rejects(
      () => proveFundsUtxo(deps, att.statement, "0".repeat(64) + "_0"),
      /held but not spendable \(reserved by a capsule/,
    );
  } finally {
    await db.destroy();
  }
});

test("migrate is idempotent on an existing database", async () => {
  const db = await memdb();
  try {
    await migrateFunds(db);
    await migrateFunds(db);
    const has = await db.schema.hasTable("funds_attestations");
    assert.equal(has, true);
  } finally {
    await db.destroy();
  }
});
