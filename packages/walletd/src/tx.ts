/**
 * Minimal transaction builder for daemon flows (P2PKH spends + OP_RETURN).
 * Same shape as the PocketPets builder this migrates: fixed fee 1 sat/vB,
 * change back to self, dust folded into the fee. Keys never leave custody —
 * callers pass an `unlockFor` hook that signs without exposing material.
 */
import { OP, P2PKH, Script, Transaction, type UnlockingScript } from "@bsv/sdk";

export const FEE_SATS_PER_KB = 1000;
export const MIN_MINER_FEE = 100;
const DUST = 20;

export interface SpendableUtxo {
  txid: string;
  vout: number;
  value: number;
  scriptHex: string;
  unlockingScriptLength?: number;
}

export interface UnlockHook {
  /** Sign input i of tx (key stays inside the hook); resolves the unlocking script. */
  sign(tx: Transaction, inputIndex: number): Promise<UnlockingScript>;
}

function push(data: Uint8Array): { op: number; data?: number[] } {
  const bytes = Array.from(data);
  if (bytes.length <= 75) return { op: bytes.length, data: bytes };
  if (bytes.length <= 255) return { op: 0x4c, data: [bytes.length, ...bytes] };
  return { op: 0x4d, data: [bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...bytes] };
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function opReturnScript(parts: string[]): Script {
  const chunks: { op: number; data?: number[] }[] = [{ op: OP.OP_0 }, { op: OP.OP_RETURN }];
  for (const p of parts) chunks.push(push(utf8(p)));
  return new Script(chunks);
}

export function p2pkhScript(address: string): Script {
  return new P2PKH().lock(address);
}

export interface BuiltTx {
  tx: Transaction;
  fee: number;
  changeSats: number;
  changeVout: number;
}

export function buildTx(opts: {
  utxos: SpendableUtxo[];
  unlockFor: (u: SpendableUtxo) => UnlockHook;
  /**
   * F5 BSV21: token outputs carry a transfer inscription appended to the
   * owner's P2PKH script. Pass the full script hex and it is used verbatim
   * (and measured for the fee estimate); address-only payments keep the
   * plain P2PKH behavior.
   */
  payments: Array<{ address?: string; sats: number; scriptHex?: string }>;
  opReturn?: string[];
  changeScriptHex: string;
  /**
   * F5 ordinal safety: skip the value-desc sort and spend inputs in the
   * given order. Ordinal transfers rely on first-in-first-out sat flow —
   * inputs[0] (the inscribed sat) must land in outputs[0] (the recipient).
   * Callers pin the ordinal UTXO first and keep 1-sat outputs out of
   * funding, so no other sat can take its place.
   */
  keepOrder?: boolean;
  requiredInputs?: number;
}): BuiltTx {
  const required = opts.requiredInputs ?? 0;
  if (!Number.isInteger(required) || required < 0 || required > Math.min(30, opts.utxos.length) || (required > 0 && !opts.keepOrder)) {
    throw new Error("requiredInputs must be an ordered prefix of at most 30 inputs");
  }
  const varIntSize = (n: number): number => n < 253 ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
  const unlockLength = (u: SpendableUtxo): number => {
    const n = u.unlockingScriptLength ?? 108;
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("invalid unlockingScriptLength");
    return n;
  };
  const need = opts.payments.reduce((a, p) => a + p.sats, 0);
  const ordered = opts.keepOrder ? [...opts.utxos] : [...opts.utxos].sort((a, b) => b.value - a.value);
  const sorted = ordered.slice(0, 30);
  const picked: SpendableUtxo[] = [];
  let total = 0;

  const outLens: number[] = opts.payments.map((p) => {
    const scriptLen = p.scriptHex
      ? p.scriptHex.length / 2
      : p.address
        ? p2pkhScript(p.address).toHex().length / 2
        : 0;
    if (!scriptLen) throw new Error("payment needs address or scriptHex");
    return 8 + varIntSize(scriptLen) + scriptLen;
  });
  if (opts.opReturn?.length) {
    const len = opReturnScript(opts.opReturn).toHex().length / 2;
    outLens.push(8 + varIntSize(len) + len);
  }
  const changeLen = opts.changeScriptHex.length / 2;
  const baseSize = 8 + varIntSize(outLens.length + 1) + outLens.reduce((a, b) => a + b, 0)
    + 8 + varIntSize(changeLen) + changeLen;
  let inputSize = 0;
  let fee = MIN_MINER_FEE;
  for (const u of sorted) {
    picked.push(u);
    total += u.value;
    const len = unlockLength(u);
    inputSize += 40 + varIntSize(len) + len;
    fee = Math.max(MIN_MINER_FEE, Math.ceil(((baseSize + varIntSize(picked.length) + inputSize) / 1000) * FEE_SATS_PER_KB));
    if (picked.length >= required && total >= need + fee) break;
  }
  if (total < need) throw new Error(`insufficient funds (have ${total}, need ${need} + fee)`);
  const change = total - need - fee;
  if (change < 0) throw new Error(`insufficient funds for fee (short ${-change} sats)`);
  const useChange = change >= DUST;
  if (!useChange) fee += change;

  const tx = new Transaction(2, [], [], 0);
  for (const u of picked) {
    tx.addInput({
      unlockingScriptTemplate: {
        sign: (t: Transaction, i: number) => opts.unlockFor(u).sign(t, i),
        estimateLength: async () => unlockLength(u),
      },
      sourceTXID: u.txid,
      sourceOutputIndex: u.vout,
      sequence: 0xffffffff,
    });
  }
  for (const p of opts.payments) {
    const scriptHex = p.scriptHex ?? (p.address ? p2pkhScript(p.address).toHex() : "");
    if (!scriptHex) throw new Error("payment needs address or scriptHex");
    tx.addOutput({ lockingScript: Script.fromHex(scriptHex), satoshis: p.sats });
  }
  if (opts.opReturn?.length) tx.addOutput({ lockingScript: opReturnScript(opts.opReturn), satoshis: 0 });
  const changeVout = useChange ? tx.outputs.length : -1;
  if (useChange) tx.addOutput({ lockingScript: Script.fromHex(opts.changeScriptHex), satoshis: change });
  return { tx, fee, changeSats: useChange ? change : 0, changeVout };
}

export async function signTx(tx: Transaction): Promise<{ hex: string; txid: string }> {
  await tx.sign();
  return { hex: tx.toHex(), txid: tx.id("hex") };
}
