/**
 * F8 spend dashboard (ledger + policy audit).
 *
 * One JSON shape merging everything a user needs to answer "what did
 * what spend, and why": in-flight/confirmed transactions (pending_txs),
 * open spend requests (policy_requests), and approvals/caps/denials
 * (policies). Each row carries the exact CLI command(s) that act on it,
 * so the shell panel and `bsv history` render retry/revoke affordances
 * without duplicating policy logic.
 *
 * Read-only over the DB: no key material, no custody surface.
 */
import type { Knex } from "knex";

export interface HistoryTransaction {
  txid: string;
  label: string;
  status: string;
  attempts: number;
  last_check: number;
  detail: string | null;
  created_at: number;
  /** Human-readable next step for this status. */
  hint: string;
}

export interface HistoryRequest {
  id: number;
  origin: string;
  amount_sats: number;
  action: string;
  created_at: number;
  commands: { allow: string; deny: string };
}

export interface HistoryPolicy {
  origin: string;
  mode: string;
  spend_cap_sats: number;
  updated_at: number;
  commands: { revoke?: string; approve?: string };
}

export interface HistorySummary {
  inFlight: number;
  mined: number;
  failed: number;
  pendingRequests: number;
  allowedOrigins: number;
  deniedOrigins: number;
}

export interface History {
  transactions: HistoryTransaction[];
  requests: HistoryRequest[];
  policies: HistoryPolicy[];
  summary: HistorySummary;
}

function txHint(status: string): string {
  if (status === "mined") return "confirmed on-chain";
  if (status === "failed")
    return "network dropped it (usually a lost double-spend race) — nothing moved; just re-run the action";
  return "in mempool — the daemon rebroadcasts automatically; check again later";
}

export function emptyHistory(): History {
  return {
    transactions: [],
    requests: [],
    policies: [],
    summary: { inFlight: 0, mined: 0, failed: 0, pendingRequests: 0, allowedOrigins: 0, deniedOrigins: 0 },
  };
}

export async function getHistory(db: Knex): Promise<History> {
  const txRows = (await db("pending_txs")
    .select("txid", "label", "status", "attempts", "last_check", "detail", "created_at")
    .orderBy("created_at", "desc")
    .limit(100)) as Array<{
    txid: string; label: string; status: string; attempts: number;
    last_check: number; detail: string | null; created_at: number;
  }>;
  const reqRows = (await db("policy_requests")
    .select("id", "origin", "amount_sats", "action", "created_at")
    .orderBy("created_at", "desc")
    .limit(100)) as Array<{
    id: number; origin: string; amount_sats: number; action: string; created_at: number;
  }>;
  const polRows = (await db("policies")
    .select("origin", "mode", "spend_cap_sats", "updated_at")
    .orderBy("origin")) as Array<{
    origin: string; mode: string; spend_cap_sats: number; updated_at: number;
  }>;

  const transactions: HistoryTransaction[] = txRows.map((t) => ({ ...t, hint: txHint(t.status) }));
  const requests: HistoryRequest[] = reqRows.map((r) => ({
    ...r,
    commands: { allow: `bsv allow ${r.origin}`, deny: `bsv deny ${r.origin}` },
  }));
  const policies: HistoryPolicy[] = polRows.map((row) => ({
    ...row,
    commands:
      row.mode === "allow"
        ? { revoke: `bsv deny ${row.origin}` }
        : row.mode === "deny"
          ? { approve: `bsv allow ${row.origin}` }
          : { approve: `bsv allow ${row.origin}`, revoke: `bsv deny ${row.origin}` },
  }));

  return {
    transactions,
    requests,
    policies,
    summary: {
      inFlight: txRows.filter((t) => t.status === "seen").length,
      mined: txRows.filter((t) => t.status === "mined").length,
      failed: txRows.filter((t) => t.status === "failed").length,
      pendingRequests: reqRows.length,
      allowedOrigins: polRows.filter((row) => row.mode === "allow").length,
      deniedOrigins: polRows.filter((row) => row.mode === "deny").length,
    },
  };
}
