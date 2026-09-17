import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTx, opReturnScript, p2pkhScript, signTx } from "../src/tx.ts";

async function localHook(ns) {
  const { PrivateKey, P2PKH } = await import("@bsv/sdk");
  const priv = PrivateKey.fromRandom();
  return {
    priv,
    address: priv.toPublicKey().toAddress(),
    hookFor: (value, script) => ({ sign: (tx, i) => new P2PKH().unlock(priv, "all", false, value, script).sign(tx, i) }),
    ns,
  };
}

const FAKE = { txid: "a".repeat(64), vout: 0, value: 1_000_000, height: 900 };

test("anchor-shaped tx: opreturn + change balance exactly", async () => {
  const { address, hookFor } = await localHook();
  const lock = p2pkhScript(address);
  const built = buildTx({
    utxos: [{ ...FAKE, scriptHex: lock.toHex() }],
    unlockFor: (u) => hookFor(u.value, lock),
    payments: [],
    opReturn: ["BSVOS-ANCHOR", "b".repeat(64)],
    changeScriptHex: lock.toHex(),
  });
  const { hex, txid } = await signTx(built.tx);
  assert.match(txid, /^[0-9a-f]{64}$/);
  assert.ok(hex.length / 2 >= 100, "non-trivial size");
  assert.ok(built.fee >= hex.length / 2, `fee ${built.fee} covers ${hex.length / 2} vB`);
});

test("opreturn script round-trips", async () => {
  const s = opReturnScript(["BSVOS-ANCHOR", "c".repeat(64)]);
  assert.ok(s.toASM().startsWith("OP_0 OP_RETURN"));
});

test("insufficient funds is a clean error", async () => {
  const { address, hookFor } = await localHook();
  const lock = p2pkhScript(address);
  assert.throws(
    () =>
      buildTx({
        utxos: [{ ...FAKE, value: 50, scriptHex: lock.toHex() }],
        unlockFor: (u) => hookFor(u.value, lock),
        payments: [{ address, sats: 49 }],
        changeScriptHex: lock.toHex(),
      }),
    /insufficient funds/,
  );
});

test("change output size, input varints, and declared unlock lengths drive the fee", async () => {
  const { address, hookFor } = await localHook();
  const lock = p2pkhScript(address);
  const build = (utxos) => buildTx({
    utxos,
    unlockFor: (u) => hookFor(u.value, lock),
    payments: [{ sats: 1, scriptHex: lock.toHex() }],
    changeScriptHex: "00".repeat(600),
  });
  const varIntSize = (n) => (n < 253 ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  const outLen = (scriptHex) => 8 + varIntSize(scriptHex.length / 2) + scriptHex.length / 2;
  const inLen = (len) => 40 + varIntSize(len) + len;
  const expectedFee = (unlockLen) =>
    8 + varIntSize(2) + outLen(lock.toHex()) + outLen("00".repeat(600)) + 1 + inLen(unlockLen);
  const plain = build([{ ...FAKE, scriptHex: lock.toHex() }]);
  const tiny = build([{ ...FAKE, unlockingScriptLength: 1, scriptHex: lock.toHex() }]);
  assert.equal(plain.fee, expectedFee(108));
  assert.equal(tiny.fee, expectedFee(1));
  assert.equal(plain.fee - tiny.fee, 107);
  const huge = build([{ ...FAKE, unlockingScriptLength: 100_000, scriptHex: lock.toHex() }]);
  assert.equal(huge.fee, expectedFee(100_000));
  assert.ok(huge.fee > plain.fee + 99_000);
  const valueIn = FAKE.value;
  for (const built of [plain, tiny, huge]) {
    assert.equal(built.tx.outputs.reduce((a, o) => a + o.satoshis, 0) + built.fee, valueIn);
  }
});

test("requiredInputs pins explicit inputs, order, and exact funding count", async () => {
  const { address, hookFor } = await localHook();
  const lock = p2pkhScript(address);
  const utxos = [
    { txid: "a".repeat(64), vout: 0, value: 5, scriptHex: lock.toHex() },
    { txid: "b".repeat(64), vout: 0, value: 500, scriptHex: lock.toHex() },
    { txid: "c".repeat(64), vout: 0, value: 600, scriptHex: lock.toHex() },
    { txid: "d".repeat(64), vout: 0, value: 700, scriptHex: lock.toHex() },
  ];
  const built = buildTx({
    utxos,
    unlockFor: (u) => hookFor(u.value, lock),
    payments: [{ sats: 1, scriptHex: lock.toHex() }],
    changeScriptHex: lock.toHex(),
    keepOrder: true,
    requiredInputs: 1,
  });
  assert.deepEqual(built.tx.inputs.map((i) => i.sourceTXID), [utxos[0].txid, utxos[1].txid]);
  assert.throws(
    () => buildTx({ utxos, unlockFor: (u) => hookFor(u.value, lock), payments: [], changeScriptHex: lock.toHex(), requiredInputs: 3 }),
    /requiredInputs/,
  );
});
