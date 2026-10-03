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
