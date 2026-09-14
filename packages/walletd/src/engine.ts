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
import { track } from "./monitor.ts";
import type { ChainProvider } from "./chain.ts";

export async function getBalance(chain: ChainProvider): Promise<{
  address: string; confirmed: number; unconfirmed: number; utxos: number;
}> {
  const address = selfAddress();
  const u = await chain.utxos(address);
  return { address, confirmed: u.confirmed, unconfirmed: u.unconfirmed, utxos: u.utxos.length };
}

export async function anchorTip(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  sha256: string;
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
  await track(opts.db, res.txid, `anchor ${opts.sha256.slice(0, 12)}`, hex);
  // F9: debit the agent budget only now — accepted broadcasts only.
  await recordSpend(opts.db, opts.origin, built.fee);
  return { txid: res.txid, fee: built.fee };
}
