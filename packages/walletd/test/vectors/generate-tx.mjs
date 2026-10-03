// Transaction vectors for the Swift port (S2).
//
// Builds real transactions with the daemon's own cash — `buildTx` from tx.ts and
// `@bsv/sdk` for signing, the same pair custody.ts uses — and records the bytes.
// The Swift must reproduce the unsigned serialization exactly, and produce a
// signed transaction the daemon's own interpreter accepts. Byte equality on the
// unsigned form is the strict test of fee arithmetic, input ordering and output
// layout; the signed form is checked by verification, because two correct
// RFC6979 implementations can still differ in low-S normalization.
import { Mnemonic, HD, P2PKH, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { buildTx, signTx, p2pkhScript } from "../../src/tx.ts";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TO = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"; // a known-good mainnet address

const key = HD.fromSeed(new Mnemonic(PHRASE).toSeed()).derive("m/0/0").privKey;
const self = key.toPublicKey().toAddress();
const selfScript = p2pkhScript(self).toHex();

/** A UTXO whose parent tx we do not have: we only need its script for signing. */
function utxo(txid, vout, value, scriptHex) {
  return { txid, vout, value, scriptHex };
}

const cases = [
  {
    name: "one input, one payment, change to self",
    utxos: [utxo("11".repeat(32), 0, 100_000, selfScript)],
    payments: [{ address: TO, sats: 1_000 }],
  },
  {
    name: "two inputs, one payment, change to self",
    utxos: [
      utxo("22".repeat(32), 1, 5_000, selfScript),
      utxo("33".repeat(32), 0, 3_000, selfScript),
    ],
    payments: [{ address: TO, sats: 7_000 }],
  },
  {
    // The branch where the remainder is too small to be worth an output:
    // buildTx folds it into the fee and emits no change. Worth a vector
    // because the fee ends up larger than the formula alone would say, and a
    // port that missed this would strand a few sats per spend.
    name: "change below dust is folded into the fee",
    utxos: [utxo("55".repeat(32), 0, 1_237, selfScript)],
    payments: [{ address: TO, sats: 1_000 }],
  },
  {
    name: "OP_RETURN with a payment, so output ordering and the varint are exercised",
    utxos: [utxo("44".repeat(32), 3, 50_000, selfScript)],
    payments: [{ address: TO, sats: 2_500 }],
    opReturn: ["bsvos", "vector"],
  },
  {
    name: "many inputs, forcing the fee to grow with the input count",
    utxos: Array.from({ length: 12 }, (_, i) =>
      utxo(String(i + 1).padStart(2, "0").repeat(32), i, 2_000 + i * 137, selfScript)
    ),
    payments: [{ address: TO, sats: 20_000 }],
  },
];

const out = [];
for (const testCase of cases) {
  const built = buildTx({
    utxos: testCase.utxos,
    unlockFor: (u) =>
      (() => {
        const template = new P2PKH().unlock(key, "all", false, u.value, Script.fromHex(u.scriptHex));
        return { sign: (tx, i) => template.sign(tx, i) };
      })(),
    payments: testCase.payments,
    ...(testCase.opReturn ? { opReturn: testCase.opReturn } : {}),
    changeScriptHex: selfScript,
  });

  // The unsigned form, serialized by the SDK itself with explicitly empty
  // unlocking scripts. (`tx.toHex()` refuses an input with no unlocking script,
  // so this rebuilds the same transaction with the scripts made explicit rather
  // than hand-serializing and testing my own understanding twice.)
  const unsignedTx = new Transaction(2, [], [], 0);
  for (const input of built.tx.inputs) {
    unsignedTx.addInput({
      sourceTXID: input.sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sequence: input.sequence,
      unlockingScript: new UnlockingScript([]),
    });
  }
  for (const output of built.tx.outputs) {
    unsignedTx.addOutput({ lockingScript: output.lockingScript, satoshis: output.satoshis ?? 0 });
  }
  const unsignedHex = unsignedTx.toHex();
  const signed = await signTx(built.tx);

  out.push({
    name: testCase.name,
    self,
    selfScriptHex: selfScript,
    utxos: testCase.utxos,
    payments: testCase.payments,
    opReturn: testCase.opReturn ?? null,
    fee: built.fee,
    changeSats: built.changeSats,
    changeVout: built.changeVout,
    unsignedHex,
    signedHex: signed.hex,
    txid: signed.txid,
  });
}

console.log(JSON.stringify(out, null, 2));
