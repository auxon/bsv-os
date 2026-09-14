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
