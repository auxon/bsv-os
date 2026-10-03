// OrdLock and v4 swap vectors for the Swift port (P1).
//
// Everything here comes from the daemon's own builders — `ordlock.ts` for the
// covenant scripts and the purchase unlock, `tx.ts` + `@bsv/sdk` for the full
// transactions, exactly the pair the daemon runs. The Swift must reproduce the
// lock script, the purchase preimage and every signed transaction byte for
// byte; signatures are deterministic (RFC6979) over the same BIP143 digest, so
// byte equality is the strongest check available and it holds for ALL|FORKID.
//
// The v4 offer is signed with NONE|ANYONECANPAY and SINGLE|ANYONECANPAY, which
// no earlier vector exercised. The full completion attaches those unlocks to a
// buyer-funded transaction.
import { Mnemonic, HD, P2PKH, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { buildTx, signTx, p2pkhScript } from "../../src/tx.ts";
import { inscriptionScript } from "../../src/tokens.ts";
import { ordlockLockScript, decodeOrdLock, ordlockPurchaseUnlock } from "../../src/ordlock.ts";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TO = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"; // a known-good mainnet address

const key = HD.fromSeed(new Mnemonic(PHRASE).toSeed()).derive("m/0/0").privKey;
const self = key.toPublicKey().toAddress();
const selfScript = p2pkhScript(self).toHex();

const hook = (u) => ({
  sign: (tx, i) => new P2PKH().unlock(key, "all", false, u.value, Script.fromHex(u.scriptHex)).sign(tx, i),
});

/** Unsigned serialization via the SDK, with explicit empty unlocking scripts. */
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

async function record(built, signed) {
  return {
    unsignedHex: await unsignedOf(built),
    signedHex: signed.hex,
    txid: signed.txid,
    fee: built.fee,
    changeSats: built.changeSats,
    changeVout: built.changeVout,
    unlockHexes: built.tx.inputs.map((i) => i.unlockingScript?.toHex() ?? ""),
  };
}

// ── lock scripts ──────────────────────────────────────────────────────
const lockCases = [
  { name: "self-cancel, self-pay, 25k", cancel: self, pay: self, price: 25_000 },
  { name: "self-cancel, external pay, 1 sat", cancel: self, pay: TO, price: 1 },
].map((c) => {
  const scriptHex = ordlockLockScript(c.cancel, c.pay, c.price).toHex();
  return { ...c, scriptHex, decoded: decodeOrdLock(scriptHex) };
});

const lockScript = lockCases[0];
const lockScriptObj = Script.fromHex(lockScript.scriptHex);

// ── shared fixtures ───────────────────────────────────────────────────
const carrier = {
  txid: "aa".repeat(32),
  vout: 0,
  value: 1,
  scriptHex: inscriptionScript(self, "text/plain", Buffer.from("ordlock vector").toString("hex")),
};
const funding = { txid: "bb".repeat(32), vout: 1, value: 100_000, scriptHex: selfScript };
const lockOutpoint = { txid: "ee".repeat(32), vout: 0 };

// ── lock: carrier into the covenant ───────────────────────────────────
const lockBuilt = buildTx({
  utxos: [carrier, funding],
  unlockFor: hook,
  payments: [{ sats: 1, scriptHex: lockScript.scriptHex }],
  changeScriptHex: selfScript,
  keepOrder: true,
});
const lockSigned = await signTx(lockBuilt.tx);
const lockVector = { carrier, funding, lockScriptHex: lockScript.scriptHex, ...(await record(lockBuilt, lockSigned)) };

// ── cancel: signature + OP_1 ──────────────────────────────────────────
const cancelBuilt = buildTx({
  utxos: [
    { txid: lockOutpoint.txid, vout: lockOutpoint.vout, value: 1, scriptHex: lockScript.scriptHex },
    funding,
  ],
  unlockFor: (u) =>
    u.txid === lockOutpoint.txid
      ? {
          sign: async (tx, i) =>
            (await new P2PKH().unlock(key, "all", false, 1, lockScriptObj).sign(tx, i)).writeOpCode(0x51),
        }
      : hook(u),
  payments: [{ address: self, sats: 1 }],
  changeScriptHex: selfScript,
  keepOrder: true,
});
const cancelSigned = await signTx(cancelBuilt.tx);
const cancelVector = { lockOutpoint, funding, lockScriptHex: lockScript.scriptHex, ...(await record(cancelBuilt, cancelSigned)) };

// ── buy: the covenant purchase unlock, plus a fee payment ─────────────
const price = lockScript.price;
const feePayment = { to: TO, sats: 500 };
const buyBuilt = buildTx({
  utxos: [
    { txid: lockOutpoint.txid, vout: lockOutpoint.vout, value: 1, scriptHex: lockScript.scriptHex },
    funding,
  ],
  unlockFor: (u) =>
    u.txid === lockOutpoint.txid
      ? { sign: async (tx, i) => ordlockPurchaseUnlock(tx, i, 1, lockScriptObj) }
      : hook(u),
  payments: [
    { address: self, sats: 1 },
    { sats: price, scriptHex: lockScript.decoded.payoutScriptHex },
    { address: feePayment.to, sats: feePayment.sats },
  ],
  opReturn: ["MARKET-BUY", `${lockOutpoint.txid}.${lockOutpoint.vout}`],
  changeScriptHex: selfScript,
  keepOrder: true,
});
const buySigned = await signTx(buyBuilt.tx);
const buyVector = {
  lockOutpoint,
  funding,
  lockScriptHex: lockScript.scriptHex,
  memo: ["MARKET-BUY", `${lockOutpoint.txid}.${lockOutpoint.vout}`],
  priceSats: price,
  feePayment,
  payoutScriptHex: lockScript.decoded.payoutScriptHex,
  purchaseUnlockHex: buyBuilt.tx.inputs[0].unlockingScript.toHex(),
  ...(await record(buyBuilt, buySigned)),
};

// ── v4 offer: prefix NONE|ACP, carrier SINGLE|ACP ─────────────────────
const dust = { txid: "cc".repeat(32), vout: 0, value: 1, scriptHex: selfScript };
const offerTx = new Transaction(2, [], [], 0);
offerTx.addInput({
  unlockingScriptTemplate: {
    sign: (tx, i) => new P2PKH().unlock(key, "none", true, 1, Script.fromHex(dust.scriptHex)).sign(tx, i),
    estimateLength: async () => 108,
  },
  sourceTXID: dust.txid,
  sourceOutputIndex: dust.vout,
  sequence: 0xffffffff,
});
offerTx.addInput({
  unlockingScriptTemplate: {
    sign: (tx, i) => new P2PKH().unlock(key, "single", true, 1, Script.fromHex(carrier.scriptHex)).sign(tx, i),
    estimateLength: async () => 108,
  },
  sourceTXID: carrier.txid,
  sourceOutputIndex: carrier.vout,
  sequence: 0xffffffff,
});
offerTx.addOutput({ lockingScript: new Script([{ op: 0x00 }, { op: 0x6a }]), satoshis: 0 });
offerTx.addOutput({ lockingScript: p2pkhScript(self), satoshis: price });
await offerTx.sign();
const dustUnlock = offerTx.inputs[0]?.unlockingScript?.toHex() ?? "";
const carrierUnlock = offerTx.inputs[1]?.unlockingScript?.toHex() ?? "";
if (!dustUnlock || !carrierUnlock) throw new Error("offer signing produced no unlock");
const offerVector = {
  version: 4,
  kind: "ordinal",
  payScriptHex: p2pkhScript(self).toHex(),
  priceSats: price,
  lockTime: 0,
  inputs: [
    { txid: dust.txid, vout: dust.vout, scriptHex: dust.scriptHex, sequence: 0xffffffff, unlockHex: dustUnlock },
    { txid: carrier.txid, vout: carrier.vout, scriptHex: carrier.scriptHex, sequence: 0xffffffff, unlockHex: carrierUnlock },
  ],
};

// ── completion: buyer funds, attaches the offer unlocks verbatim ──────
const completeBuilt = buildTx({
  utxos: [
    { txid: dust.txid, vout: dust.vout, value: 1, scriptHex: dust.scriptHex },
    { txid: carrier.txid, vout: carrier.vout, value: 1, scriptHex: carrier.scriptHex },
    funding,
  ],
  unlockFor: (u) => {
    if (u.txid === dust.txid) return { sign: async () => Script.fromHex(dustUnlock) };
    if (u.txid === carrier.txid) return { sign: async () => Script.fromHex(carrierUnlock) };
    return hook(u);
  },
  payments: [
    { address: self, sats: 1 },
    { sats: price, scriptHex: offerVector.payScriptHex },
  ],
  changeScriptHex: selfScript,
  keepOrder: true,
});
const completeSigned = await signTx(completeBuilt.tx);
const completeVector = { funding, ...(await record(completeBuilt, completeSigned)) };

const out = {
  phrase: PHRASE,
  self,
  selfScriptHex: selfScript,
  lockCases,
  lock: lockVector,
  cancel: cancelVector,
  buy: buyVector,
  offer: offerVector,
  complete: completeVector,
};

console.log(JSON.stringify(out, null, 2));
