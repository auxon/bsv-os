/**
 * Timed commitments — the one primitive behind sats streams, cast
 * pay-per-minute sessions, and time capsules.
 *
 * A commitment is money with a due time and a release condition:
 *
 *   - **stream**   cadence-based accrual, released while a liveness signal
 *                  (a board heartbeat) stays fresh, capped, paid as it goes.
 *   - **cast**     the same thing driven by playback telemetry — it is a
 *                  stream underneath (see `cast.ts` → `createStream`), so
 *                  this is a view, not a second engine.
 *   - **capsule**  a single release at maturity, funded and reserved up
 *                  front. Bare CLTV is dead on BSV (post-Genesis UTXOs fail
 *                  it — 1,500 sats were burned proving it), so maturity is
 *                  enforced here, by the daemon, against the chain tip.
 *
 * The scheduling math is pure and lives in this file so the decision ladder
 * can be tested without a database, a chain, or real sats. Callers supply
 * liveness; this module never spends anything.
 */
import type { Knex } from "knex";

/** A commitment's terms, normalized from whichever feature created it. */
export interface CommitmentTerms {
  /** Payment cadence in seconds; 0 means "one release at maturity". */
  cadenceSecs: number;
  /** Accrual rate in sats/min; 0 means "pay `fixedSats` once". */
  ratePerMin: number;
  fixedSats: number;
  /** Hard ceiling across the commitment's life. */
  capSats: number;
  paidSats: number;
  minPaymentSats: number;
  lastPaidAt: number;
  nextDueAt: number;
}

export interface CommitmentLiveness {
  /** False when the release condition is not currently satisfied. */
  fresh: boolean;
  ageMs: number;
  /** Optional human explanation for a stale verdict. */
  reason?: string;
}

export type CommitmentDecision =
  | { kind: "wait"; nextDueAt: number }
  | { kind: "exhausted"; remaining: number }
  | { kind: "stale"; graceMs: number; reason: string }
  | { kind: "accruing"; amount: number }
  | { kind: "release"; amount: number; remaining: number };

/** Liveness grace: two missed cadences, never less than three minutes. */
export function graceMsFor(cadenceSecs: number): number {
  return Math.max(cadenceSecs * 2 * 1000, 180_000);
}

/**
 * Next due time, skipping missed periods. Deliberately never backfills:
 * a daemon that was down for an hour does not owe an hour of payments, and
 * the commitment resumes from now.
 */
export function advanceDue(nextDueAt: number, cadenceSecs: number, now: number): number {
  if (cadenceSecs <= 0) return nextDueAt;
  const periods = Math.floor((now - nextDueAt) / (cadenceSecs * 1000)) + 1;
  return nextDueAt + periods * cadenceSecs * 1000;
}

/** Sats accrued since the last payment, clamped to what is left. */
export function accruedSats(terms: CommitmentTerms, now: number): number {
  const remaining = Math.max(0, terms.capSats - terms.paidSats);
  let amount: number;
  if (terms.ratePerMin > 0) {
    const elapsedMin = Math.max(0, now - terms.lastPaidAt) / 60_000;
    amount = Math.floor(terms.ratePerMin * elapsedMin);
  } else {
    amount = terms.fixedSats;
  }
  return Math.min(amount, remaining);
}

/**
 * The decision ladder, in order: not due → nothing left → condition not met
 * → too small to send (accrue) → release. One function, so every
 * cadence-based commitment pays the same way.
 */
export function dueCommitment(
  terms: CommitmentTerms,
  liveness: CommitmentLiveness,
  now: number,
): CommitmentDecision {
  if (terms.nextDueAt > now) return { kind: "wait", nextDueAt: terms.nextDueAt };
  const remaining = Math.max(0, terms.capSats - terms.paidSats);
  if (remaining < terms.minPaymentSats) return { kind: "exhausted", remaining };
  if (!liveness.fresh) {
    const graceMs = graceMsFor(terms.cadenceSecs);
    return {
      kind: "stale",
      graceMs,
      reason: liveness.reason ?? `no liveness signal for ${Math.round(liveness.ageMs / 1000)}s`,
    };
  }
  const amount = accruedSats(terms, now);
  if (amount < terms.minPaymentSats) return { kind: "accruing", amount };
  return { kind: "release", amount, remaining };
}

/* ------------------------------------------------------------------ *
 * The unified view: what is this wallet on the hook for?
 * ------------------------------------------------------------------ */

export interface CommitmentView {
  kind: "stream" | "cast" | "capsule";
  id: string;
  label: string;
  payee: string;
  capSats: number;
  paidSats: number;
  remainingSats: number;
  cadenceSecs: number;
  nextDueAt: number;
  status: string;
  /** Human-readable release condition. */
  condition: string;
  streams: string[];
}

interface StreamRow {
  id: string; name: string; payee: string; rate_per_min: number; tick_secs: number;
  max_total: number; paid_total: number; next_due: number; status: string; board: string;
}

interface CastRow {
  id: string; episode: string; title: string; rate_per_min: number; every_secs: number;
  max_total: number; status: string; stream_ids: string; started_at: number; stopped_at: number | null;
}

interface CapsuleRow {
  id: number; locktime: number; kind: string; to_address: string; amount: number;
  message: string; status: string; claim_txid: string | null; created_at: number;
}

/** Streams a cast session pays through (cast reuses the stream engine). */
export function castStreamIds(row: CastRow): string[] {
  try {
    const parsed = JSON.parse(row.stream_ids || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function streamView(r: StreamRow): CommitmentView {
  return {
    kind: "stream",
    id: r.id,
    label: r.name,
    payee: r.payee,
    capSats: r.max_total,
    paidSats: r.paid_total,
    remainingSats: Math.max(0, r.max_total - r.paid_total),
    cadenceSecs: r.tick_secs,
    nextDueAt: r.next_due,
    status: r.status,
    condition: `heartbeat on board ${r.board} within ${Math.round(graceMsFor(r.tick_secs) / 1000)}s`,
    streams: [r.id],
  };
}

function castView(r: CastRow): CommitmentView {
  const ids = castStreamIds(r);
  return {
    kind: "cast",
    id: r.id,
    label: r.title || r.episode,
    payee: ids.length ? `via ${ids.length} stream${ids.length === 1 ? "" : "s"}` : "no streams",
    capSats: r.max_total,
    // Cast totals live on the underlying streams; report the ceiling here.
    paidSats: 0,
    remainingSats: r.max_total,
    cadenceSecs: r.every_secs,
    nextDueAt: 0,
    status: r.status,
    condition: `playback beats from session ${r.id}`,
    streams: ids,
  };
}

function capsuleView(r: CapsuleRow): CommitmentView {
  return {
    kind: "capsule",
    id: String(r.id),
    label: r.message,
    payee: r.to_address,
    capSats: r.amount,
    paidSats: r.status === "claimed" ? r.amount : 0,
    remainingSats: r.status === "claimed" ? 0 : r.amount,
    cadenceSecs: 0,
    nextDueAt: 0,
    status: r.status,
    // Capsules are maturity-gated: the daemon compares the locktime against
    // the chain tip (height) or mediantime, because bare CLTV does not work
    // on post-Genesis UTXOs.
    condition: r.kind === "time"
      ? `daemon-enforced at ${new Date(r.locktime).toISOString()} (mediantime)`
      : `daemon-enforced at height ${r.locktime} (bare CLTV fails post-Genesis UTXOs)`,
    streams: [],
  };
}

/** Every commitment, newest first within kind. Read-only. */
export async function listCommitments(db: Knex, now = Date.now()): Promise<CommitmentView[]> {
  const [streams, casts, capsules] = await Promise.all([
    db("streams").select() as Promise<StreamRow[]>,
    db("cast_sessions").select() as Promise<CastRow[]>,
    db("capsules").select() as Promise<CapsuleRow[]>,
  ]);
  const out: CommitmentView[] = [
    ...streams.map((r) => streamView(r)),
    ...casts.map((r) => castView(r)),
    ...capsules.map((r) => capsuleView(r)),
  ];
  void now;
  return out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
}

/** Commitments that can still move money, and what they are worth. */
export function commitmentExposure(views: CommitmentView[]): { open: number; cappedSats: number; nextDueAt: number } {
  const live = views.filter((v) => v.status === "active" || v.status === "playing" || v.status === "locked");
  return {
    open: live.length,
    cappedSats: live.reduce((sum, v) => sum + v.remainingSats, 0),
    nextDueAt: live.reduce((min, v) => (v.nextDueAt > 0 && (min === 0 || v.nextDueAt < min) ? v.nextDueAt : min), 0),
  };
}
