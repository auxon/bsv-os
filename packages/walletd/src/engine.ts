/**
 * Wallet engine: policy-gated spends built on custody + chain + monitor.
 * First migrated flow: timestamp anchoring (PocketPets `timestamp` tool) —
 * hash in, OP_RETURN out, tracked to confirmation.
 */
import type { Knex } from "knex";
import { p2pkhUnlockHook, selfAddress } from "./custody.ts";
import { Script } from "@bsv/sdk";
import { buildTx, p2pkhScript, signTx, type SpendableUtxo } from "./tx.ts";
import { check } from "./policy.ts";
import { recordSpend } from "./agents.ts";
import { labelOutputs, resolveBasketForOrigin } from "./baskets.ts";
import { splitOutpoint } from "./tokens.ts";
import { track } from "./monitor.ts";
import type { ChainProvider } from "./chain.ts";

export async function getBalance(chain: ChainProvider): Promise<{
  address: string; confirmed: number; unconfirmed: number; utxos: number;
}> {
  const address = selfAddress();
  const u = await chain.utxos(address);
  return { address, confirmed: u.confirmed, unconfirmed: u.unconfirmed, utxos: u.utxos.length };
}

/** Block-explorer link for a txid (mainnet). */
export function explorerTxUrl(txid: string): string {
  return `https://whatsonchain.com/tx/${txid}`;
}

/** Basename-only, single-line label fragment for file anchors. */
export function safeLabel(name: unknown, fallback: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\r\n\t]/g, " ").trim().slice(0, 80);
  return clean || fallback;
}

export async function anchorTip(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  sha256: string;
  label?: string;
}): Promise<{ txid: string; fee: number }> {
  if (!/^[0-9a-fA-F]{64}$/.test(opts.sha256)) {
    throw new Error("sha256 must be 64 hex chars");
  }
  // Build first so the policy gate (per-action caps, F9 agent budgets)
  // sees the real fee, not a zero estimate.
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const utxos: SpendableUtxo[] = u.utxos.map((x) => ({ ...x, scriptHex: lock.toHex() }));
  const built = buildTx({
    utxos,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [],
    opReturn: ["BSVOS-ANCHOR", opts.sha256],
    changeScriptHex: lock.toHex(),
  });
  const gate = await check(opts.db, opts.origin, built.fee, "anchor");
  if (gate.verdict !== "allow") {
    const err = new Error(`denied: ${gate.reason}`) as Error & { code: string };
    err.code = "POLICY_DENY";
    throw err;
  }
  const { hex, txid } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, opts.label ?? `anchor ${opts.sha256.slice(0, 12)}`, hex);
  // F9: debit the agent budget only now — accepted broadcasts only.
  await recordSpend(opts.db, opts.origin, built.fee);
  // F4: attribute P2PKH-to-self change to the origin's basket (else default).
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const changeHex = lock.toHex();
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee };
}

/**
 * F5 ordinal send: move one inscribed sat to a P2PKH address. FIFO is
 * structural — the ordinal UTXO is inputs[0] and the 1-sat recipient
 * output is outputs[0], so the inscribed sat provably lands with the
 * recipient (no other 1-sat input is allowed in funding). Policy-gated
 * on the real fee like anchors; budgets debit on accept only.
 *
 * BSV21 transfers need protocol-aware construction and are deferred.
 */
export async function sendOrdinal(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  txid: string;
  vout: number;
  to: string;
}): Promise<{ txid: string; fee: number }> {
  const parts = splitOutpoint(`${opts.txid}_${opts.vout}`);
  if (!parts) throw Object.assign(new Error("outpoint must be 64-hex txid + vout"), { code: "BAD_PARAM" });
  let toScript: string;
  try {
    toScript = p2pkhScript(opts.to).toHex();
  } catch {
    throw Object.assign(new Error("recipient must be a valid P2PKH address"), { code: "BAD_PARAM" });
  }
  void toScript; // validated here; buildTx re-derives the script for the output
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const ordinal = u.utxos.find((x) => x.txid === parts.txid && x.vout === parts.vout);
  if (!ordinal) {
    throw Object.assign(new Error("ordinal not in wallet (unknown or already spent)"), { code: "NOT_FOUND" });
  }
  if (ordinal.value !== 1) {
    throw Object.assign(new Error(`ordinal carrier must be exactly 1 sat (found ${ordinal.value})`), { code: "BAD_PARAM" });
  }
  const funding = u.utxos.filter(
    (x) => !(x.txid === parts.txid && x.vout === parts.vout) && x.value > 1,
  );
  const utxos: SpendableUtxo[] = [
    { ...ordinal, scriptHex: lock.toHex() },
    ...funding.map((x) => ({ ...x, scriptHex: lock.toHex() })),
  ];
  const built = buildTx({
    utxos,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [{ address: opts.to, sats: 1 }],
    changeScriptHex: lock.toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, built.fee, "ordinal-send");
  if (gate.verdict !== "allow") {
    const err = new Error(`denied: ${gate.reason}`) as Error & { code: string };
    err.code = "POLICY_DENY";
    throw err;
  }
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, `send ${parts.txid.slice(0, 8)} to ${opts.to.slice(0, 8)}`, hex);
  await recordSpend(opts.db, opts.origin, built.fee);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const changeHex = lock.toHex();
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee };
}
