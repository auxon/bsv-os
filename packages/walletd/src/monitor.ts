/**
 * Monitor: every broadcast tx is watched to a terminal state.
 *
 * Transitions:
 *   seen    -> mined   (confirmed; stop watching)
 *   seen    -> failed  (rejected; funds never moved — safe to retry/rebuild)
 *   mined   -> seen    (reorg: chain no longer has it; watch + rebroadcast)
 *   seen    -> seen    (still in mempool; rebroadcast every N polls so it
 *                       doesn't fall out)
 *
 * Rebroadcasts are capped; failures record the competing tx when known
 * (double-spend races resolve to exactly one winner).
 */
import type { Knex } from "knex";
import type { ChainProvider } from "./chain.ts";

export interface PendingTx {
  txid: string;
  label: string;
  status: "seen" | "mined" | "failed";
  attempts: number;
  last_check: number;
  created_at: number;
  detail: string | null;
}

export const REBROADCAST_EVERY = 5; // polls
export const MAX_ATTEMPTS = 60;

export async function track(db: Knex, txid: string, label = "", txHex: string | null = null): Promise<void> {
  const now = Date.now();
  const existing = await db("pending_txs").where({ txid }).first();
  if (existing) {
    // refresh hex if we now have it (lets older rows become rebroadcastable)
    if (txHex && !existing.tx_hex) {
      await db("pending_txs").where({ txid }).update({ tx_hex: txHex });
    }
    return;
  }
  await db("pending_txs").insert({ txid, label, status: "seen", attempts: 0, last_check: 0, created_at: now, detail: null, tx_hex: txHex });
}

export async function list(db: Knex): Promise<PendingTx[]> {
  return (await db("pending_txs").select().orderBy("created_at", "desc")) as PendingTx[];
}

export interface TickResult {
  txid: string;
  from: string;
  to: string;
  rebroadcast: boolean;
  detail: string | null;
}

/** One watch pass over everything not yet terminal. Pure-ish: effects are the status check + optional rebroadcast. */
export async function tick(
  db: Knex,
  chain: ChainProvider,
  rebroadcast: (txHex: string) => Promise<unknown>,
  getHex: (txid: string) => Promise<string | null>,
): Promise<TickResult[]> {
  const now = Date.now();
  // Seen rows always; mined rows get re-verified when their last check is
  // stale (reorg watch), at most once a minute per row.
  const rows = (await db("pending_txs")
    .where("status", "seen")
    .orWhere(function () {
      this.where("status", "mined")
        .andWhere("last_check", "<", now - 60 * 1000)
        .andWhere("last_check", ">", now - 24 * 3600 * 1000);
    })) as PendingTx[];
  const out: TickResult[] = [];
  for (const row of rows) {
    let st: { status: string; detail?: string | null };
    try {
      st = await chain.status(row.txid);
    } catch {
      continue; // indexer hiccup — try next poll
    }
    if (st.status === "MINED") {
      await db("pending_txs").where({ txid: row.txid }).update({ status: "mined", last_check: now, detail: null });
      out.push({ txid: row.txid, from: row.status, to: "mined", rebroadcast: false, detail: null });
      continue;
    }
    if (st.status === "REJECTED") {
      const detail = st.detail ?? "rejected by network";
      await db("pending_txs").where({ txid: row.txid }).update({ status: "failed", last_check: now, detail });
      out.push({ txid: row.txid, from: row.status, to: "failed", rebroadcast: false, detail });
      continue;
    }
    // Still unseen (or reorged back out): rebroadcast periodically, cap attempts.
    const attempts = row.attempts + 1;
    let did = false;
    if (attempts % REBROADCAST_EVERY === 0 && attempts <= MAX_ATTEMPTS) {
      const hex = await getHex(row.txid);
      if (hex) {
        try {
          await rebroadcast(hex);
          did = true;
        } catch {
          /* keep watching */
        }
      }
    }
    const to = row.status === "mined" ? "seen" : row.status; // reorg path
    await db("pending_txs").where({ txid: row.txid }).update({ status: to, attempts, last_check: now });
    out.push({ txid: row.txid, from: row.status, to, rebroadcast: did, detail: null });
  }
  return out;
}
