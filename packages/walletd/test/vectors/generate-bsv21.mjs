// BSV21 swap vectors for the Swift port.
//
// The token envelope and its transfer script come from `tokens.ts`; the v3
// offer and its completion are built with the same `buildTx` + `@bsv/sdk`
// signing the daemon uses. The offer is a single input signed
// SINGLE|ANYONECANPAY; the completion attaches that unlock verbatim, funds the
// miner fee, and writes the payment first, the fresh transfer envelope second —
// a different output order from the ordinal swaps.
import { Mnemonic, HD, P2PKH, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { buildTx, signTx, p2pkhScript } from "../../src/tx.ts";
import { inscriptionScript } from "../../src/tokens.ts";
import {
  bsv21TransferScript,
  parseBsv21Envelope,
  normalizeTokenId,
  parseTokenAmount,
} from "../../src/tokens.ts";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const key = HD.fromSeed(new Mnemonic(PHRASE).toSeed()).derive("m/0/0").privKey;
const self = key.toPublicKey().toAddress();
const selfScript = p2pkhScript(self).toHex();

const TOKEN_ID = "aa".repeat(32) + "_0";

async function unsignedOf(built) {
  const tx = new Transaction(2, [], [], 0);
  for (const input of built.tx.inputs) {
    tx.addInput({
      sourceTXID: input.sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sequence: input.sequence,
      unlockingScript: new UnlockingScript([]),
    });
  }
  for (const output of built.tx.outputs) {
    tx.addOutput({ lockingScript: output.lockingScript, satoshis: output.satoshis ?? 0 });
  }
  return tx.toHex();
}

function hook(u) {
  return {
    sign: (tx, i) => new P2PKH().unlock(key, "all", false, u.value, Script.fromHex(u.scriptHex)).sign(tx, i),
  };
}

// ── transfer envelopes ────────────��───��───────────────────────────────
const transfers = [
  { name: "transfer 1000", owner: self, tokenId: TOKEN_ID, amt: "1000" },
  { name: "transfer uint64 max", owner: self, tokenId: TOKEN_ID, amt: "18446744073709551615" },
].map((c) => {
  const scriptHex = bsv21TransferScript(c.owner, c.tokenId, c.amt);
  return { ...c, scriptHex, envelope: parseBsv21Envelope(scriptHex) };
});

// ── parse must refuse these ───────────────────────────────────────────
const malformed = [
  { name: "plain p2pkh", scriptHex: selfScript },
  { name: "ord envelope, not bsv21", scriptHex: inscriptionScript(self, "text/plain", "6869") },
  {
    name: "envelope, json without p/op",
    scriptHex: inscriptionScript(self, "application/bsv-20", Buffer.from('{"id":"x"}').toString("hex")),
  },
  {
    name: "envelope, no OP_ENDIF",
    scriptHex: inscriptionScript(self, "application/bsv-20", "7b7d").slice(0, -2),
  },
];

// ── id and amount gates ───────────────────────────────────────────────
const tokenIds = [
  "AA".repeat(32) + "_007",
  "aa".repeat(32) + ".3",
  `\u0020${"aa".repeat(32)}_1\u0020`,
  "nope",
  "aa".repeat(32),
  "zz".repeat(32) + "_0",
  "aa".repeat(32) + "_-1",
].map((raw) => ({ raw, normalized: normalizeTokenId(raw) }));

const amounts = ["1000", "007", "0", "00", "-1", "1.5", "18446744073709551615", "18446744073709551616"]
  .map((raw) => ({ raw, canonical: parseTokenAmount(raw) }));

// ── v3 offer: one carrier, SINGLE|ANYONECANPAY ────────────────────────
const carrier = { txid: "dd".repeat(32), vout: 1, value: 1, scriptHex: transfers[0].scriptHex };
const price = 25_000;
const offerTx = new Transaction(2, [], [], 0);
offerTx.addInput({
  unlockingScriptTemplate: {
    sign: (tx, i) => new P2PKH().unlock(key, "single", true, 1, Script.fromHex(carrier.scriptHex)).sign(tx, i),
    estimateLength: async () => 108,
  },
  sourceTXID: carrier.txid,
  sourceOutputIndex: carrier.vout,
  sequence: 0xffffffff,
});
await offerTx.addOutput({ lockingScript: p2pkhScript(self), satoshis: price });
await offerTx.sign();
const unlockHex = offerTx.inputs[0]?.unlockingScript?.toHex() ?? "";
if (!unlockHex) throw new Error("offer signing produced no unlock");
const offer = {
  version: 3,
  kind: "bsv21",
  payScriptHex: p2pkhScript(self).toHex(),
  priceSats: price,
  lockTime: 0,
  input: { txid: carrier.txid, vout: carrier.vout, scriptHex: carrier.scriptHex, sequence: 0xffffffff },
  unlockHex,
  tokenId: TOKEN_ID,
  tokenAmount: "1000",
};

// ── completion: payment first, fresh token envelope second ────────────
const funding = { txid: "bb".repeat(32), vout: 1, value: 100_000, scriptHex: selfScript };
const tokenOutput = bsv21TransferScript(self, TOKEN_ID, "1000");
const completeBuilt = buildTx({
  utxos: [carrier, funding],
  unlockFor: (u) => (u.txid === carrier.txid ? { sign: async () => Script.fromHex(unlockHex) } : hook(u)),
  payments: [
    { sats: price, scriptHex: offer.payScriptHex },
    { sats: 1, scriptHex: tokenOutput },
  ],
  changeScriptHex: selfScript,
  keepOrder: true,
});
const completeSigned = await signTx(completeBuilt.tx);

const out = {
  phrase: PHRASE,
  self,
  selfScriptHex: selfScript,
  transfers,
  malformed,
  tokenIds,
  amounts,
  offer,
  complete: {
    funding,
    tokenOutput,
    unsignedHex: await unsignedOf(completeBuilt),
    signedHex: completeSigned.hex,
    txid: completeSigned.txid,
    fee: completeBuilt.fee,
    changeSats: completeBuilt.changeSats,
    changeVout: completeBuilt.changeVout,
    unlockHexes: completeBuilt.tx.inputs.map((i) => i.unlockingScript?.toHex() ?? ""),
  },
};

console.log(JSON.stringify(out, null, 2));
