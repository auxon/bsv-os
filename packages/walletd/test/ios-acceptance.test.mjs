// Cross-implementation acceptance (S6).
//
// S2 proves the Swift reproduces these signed transactions byte for byte.
// This side proves the thing those bytes are for: the daemon's own script
// interpreter accepts every input. Together they say the phone's wallet
// produces transactions the daemon's wallet would have produced and the
// network accepts — without either test reaching the network.
//
// The Spend construction is copied from the SDK's own verify path
// (Transaction.js, verifyUnminedTransaction) rather than invented: same
// fields, same interpreter entry point (validateJavaScript, so an optional
// native backend cannot quietly change what "accepted" means here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Transaction, Spend, Script, PublicKey } from "@bsv/sdk";

const vectors = JSON.parse(readFileSync(new URL("./vectors/tx-vectors.json", import.meta.url), "utf8"));

test("the daemon's interpreter accepts every transaction the Swift reproduces", () => {
  assert.ok(vectors.length >= 5, "the vector set is present");

  for (const vector of vectors) {
    const tx = Transaction.fromHex(vector.signedHex);

    // The SDK derives the same txid the vector records — so the Swift's txid
    // arithmetic and the daemon's agree on the signed bytes.
    assert.equal(tx.id("hex"), vector.txid, `txid: ${vector.name}`);

    // Find the source output for each input: the candidates the builder chose
    // from are in the vector.
    const utxos = new Map(vector.utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
    assert.equal(tx.inputs.length > 0, true);

    for (let index = 0; index < tx.inputs.length; index++) {
      const input = tx.inputs[index];
      const source = utxos.get(`${input.sourceTXID}:${input.sourceOutputIndex}`);
      assert.ok(source, `source utxo for input ${index} of ${vector.name}`);

      // The interpreter runs the real script: P2PKH, the pushed signature over
      // the BIP143 digest, and the pushed public key — or it throws.
      const valid = new Spend({
        sourceTXID: input.sourceTXID,
        sourceOutputIndex: input.sourceOutputIndex,
        lockingScript: Script.fromHex(source.scriptHex),
        sourceSatoshis: source.value,
        transactionVersion: tx.version,
        otherInputs: [],
        allInputs: tx.inputs,
        unlockingScript: input.unlockingScript,
        inputSequence: input.sequence ?? 0xffffffff,
        inputIndex: index,
        outputs: tx.outputs,
        lockTime: tx.lockTime,
      }).validateJavaScript();
      assert.equal(valid, true, `input ${index} of ${vector.name} is accepted`);

      // And the key that signed belongs to the wallet the vector names: the
      // pushed public key's address is the change address.
      const chunks = input.unlockingScript.chunks;
      const pushedKey = PublicKey.fromString(Buffer.from(chunks[1].data).toString("hex"));
      assert.equal(pushedKey.toAddress(), vector.self, `signer address: ${vector.name}`);
      assert.equal(source.scriptHex, vector.selfScriptHex, "the spent script is the wallet's own");
    }
  }
});

test("the vectors include the branches that matter", () => {
  assert.equal(vectors.length, 5);
  assert.ok(vectors.some((v) => v.changeVout === -1), "dust folded into the fee");
  assert.ok(vectors.some((v) => v.opReturn !== null), "an OP_RETURN output");
  assert.ok(vectors.some((v) => v.utxos.length >= 12), "a candidate set larger than the spend");
});

// P1's half of the same claim. The ordlock vectors compare byte for byte in
// Swift; here the daemon's interpreter runs the real scripts those bytes are
// for. Three of them are more than P2PKH: the carrier output's script is an ord
// envelope, and the cancel and purchase inputs execute the OrdLock covenant
// itself — the cancel path with a signature + OP_1, the purchase path with the
// preimage the phone built. If the preimage were wrong, the covenant would take
// a different branch or push false, and this test would fail even though the
// bytes matched some other reference.
const ordlock = JSON.parse(readFileSync(new URL("./vectors/ordlock-vectors.json", import.meta.url), "utf8"));

test("the daemon's interpreter accepts the envelope and covenant spends", () => {
  const cases = [
    {
      name: "lock",
      txHex: ordlock.lock.signedHex,
      sources: [
        { scriptHex: ordlock.lock.carrier.scriptHex, value: 1 },
        { scriptHex: ordlock.lock.funding.scriptHex, value: ordlock.lock.funding.value },
      ],
    },
    {
      name: "cancel",
      txHex: ordlock.cancel.signedHex,
      sources: [
        { scriptHex: ordlock.cancel.lockScriptHex, value: 1 },
        { scriptHex: ordlock.cancel.funding.scriptHex, value: ordlock.cancel.funding.value },
      ],
    },
    {
      name: "buy",
      txHex: ordlock.buy.signedHex,
      sources: [
        { scriptHex: ordlock.buy.lockScriptHex, value: 1 },
        { scriptHex: ordlock.buy.funding.scriptHex, value: ordlock.buy.funding.value },
      ],
    },
    {
      name: "complete",
      txHex: ordlock.complete.signedHex,
      sources: [
        { scriptHex: ordlock.offer.inputs[0].scriptHex, value: 1 },
        { scriptHex: ordlock.offer.inputs[1].scriptHex, value: 1 },
        { scriptHex: ordlock.complete.funding.scriptHex, value: ordlock.complete.funding.value },
      ],
    },
  ];

  for (const c of cases) {
    const tx = Transaction.fromHex(c.txHex);
    assert.equal(tx.inputs.length, c.sources.length, `${c.name}: every input has a source`);
    for (let index = 0; index < tx.inputs.length; index++) {
      const input = tx.inputs[index];
      const source = c.sources[index];
      const valid = new Spend({
        sourceTXID: input.sourceTXID,
        sourceOutputIndex: input.sourceOutputIndex,
        lockingScript: Script.fromHex(source.scriptHex),
        sourceSatoshis: source.value,
        transactionVersion: tx.version,
        otherInputs: [],
        allInputs: tx.inputs,
        unlockingScript: input.unlockingScript,
        inputSequence: input.sequence ?? 0xffffffff,
        inputIndex: index,
        outputs: tx.outputs,
        lockTime: tx.lockTime,
      }).validateJavaScript();
      assert.equal(valid, true, `${c.name} input ${index} is accepted`);
    }
  }

  // The carrier really is an envelope (not plain dust) and the lock cases
  // share one covenant script, so the acceptance above is about the template.
  assert.ok(ordlock.lock.carrier.scriptHex.includes("0063036f7264"), "the carrier carries an ord envelope");
  assert.equal(ordlock.lock.lockScriptHex, ordlock.cancel.lockScriptHex);
  assert.equal(ordlock.buy.lockScriptHex, ordlock.cancel.lockScriptHex);
  // The purchase input pushes no signature: it is the preimage the covenant
  // checks. A DER signature would start with 0x30.
  const buyTx = Transaction.fromHex(ordlock.buy.signedHex);
  assert.notEqual(buyTx.inputs[0].unlockingScript.chunks[0].data[0], 0x30, "purchase unlock is not a signature");
});
