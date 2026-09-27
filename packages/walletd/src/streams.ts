/**
 * Sats-streaming for agent compute: pay per minute, not per promise.
 *
 * A stream pays a worker address a fixed rate while fresh heartbeat proofs
 * land on a board. The daemon ticks every minute (same loop style as
 * nightshift): when a tick comes due and the latest `stream:<id>` beat is
 * within grace, it pays rate × elapsed since the last payment. Stale beats
 * pause payment automatically — no escrow to reclaim, the money simply
 * stops. Either side ends it at any time.
 *
 * Fee honesty: every tick is one on-chain tx (~200-300 sats fee, dust
 * floor). Ticks below MIN_TICK_SATS are not paid — they accrue until the
 * owed amount clears the floor. Streaming 50 sats/min on L1 is theater;
 * the start response says the fee share out loud.
 */
import type { Knex } from "knex";
import { advanceDue, dueCommitment, graceMsFor } from "./commitment.ts";
import { randomBytes } from "node:crypto";

export type StreamStatus = "active" | "paused" | "done";

export interface PayStream {
  id: string;
  name: string;
  payee: string;
  ratePerMin: number;
  tickSecs: number;
  maxTotal: number;
  board: string;
  status: StreamStatus;
  paidTotal: number;
  lastPaidAt: number;
  nextDue: number;
  createdAt: number;
}

export interface StreamTick {
  id: number;
  streamId: string;
  beatId: string | null;
  amount: number;
  txid: string | null;
  status: "paid" | "skipped" | "stale" | "closed";
  detail: string;
  createdAt: number;
}

/** Below this, a tick accrues instead of paying (fee + dust math). */
export const MIN_TICK_SATS = 1000;
/** Rough fee assumption used for the fee-share warning. */
export const ASSUMED_FEE_SATS = 250;

const TICK_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** Parse "90s 5m 1h" (also bare seconds) to milliseconds, 60s..24h. */
export function parseTick(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw <= 0) throw Object.assign(new Error("interval must be positive"), { code: "BAD_PARAM" });
    return Math.floor(raw * 1000);
  }
  const m = /^(\d+)\s*([smh])$/i.exec(String(raw ?? "").trim());
  if (!m) throw Object.assign(new Error("interval like 90s, 5m, 1h"), { code: "BAD_PARAM" });
  const ms = Number(m[1]) * TICK_UNITS[m[2]!.toLowerCase()]!;
  if (!(ms >= 60_000)) throw Object.assign(new Error("minimum tick is 60s"), { code: "BAD_PARAM" });
  if (ms > 86_400_000) throw Object.assign(new Error("maximum tick is 24h"), { code: "BAD_PARAM" });
  return ms;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function newStreamId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "stm_";
  for (const b of randomBytes(9)) id += chars[b % chars.length];
  return id;
}

export async function migrateStreams(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("streams"))) {
    await db.schema.createTable("streams", (t) => {
      t.string("id", 16).primary();
      t.string("name", 80).notNullable();
      t.string("payee", 64).notNullable();
      t.integer("rate_per_min").notNullable();
      t.integer("tick_secs").notNullable();
      t.integer("max_total").notNullable();
      t.string("board", 32).notNullable();
      t.string("status").notNullable().defaultTo("active");
      t.integer("paid_total").notNullable().defaultTo(0);
      t.integer("last_paid_at").notNullable().defaultTo(0);
      t.integer("next_due").notNullable();
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("stream_ticks"))) {
    await db.schema.createTable("stream_ticks", (t) => {
      t.increments("id");
      t.string("stream_id", 16).notNullable();
      t.string("beat_id", 64).nullable();
      t.integer("amount").notNullable().defaultTo(0);
      t.string("txid", 64).nullable();
      t.string("status").notNullable().defaultTo("paid");
      t.text("detail").notNullable().defaultTo("");
      t.integer("created_at").notNullable();
    });
  }
}

interface StreamRow {
  id: string; name: string; payee: string; rate_per_min: number;
  tick_secs: number; max_total: number; board: string; status: string;
  paid_total: number; last_paid_at: number; next_due: number; created_at: number;
}

function toStream(r: StreamRow): PayStream {
  return {
    id: r.id, name: r.name, payee: r.payee, ratePerMin: r.rate_per_min,
    tickSecs: r.tick_secs, maxTotal: r.max_total, board: r.board,
    status: r.status === "paused" ? "paused" : r.status === "done" ? "done" : "active",
    paidTotal: r.paid_total, lastPaidAt: r.last_paid_at,
    nextDue: r.next_due, createdAt: r.created_at,
  };
}

export function streamBeatRef(id: string): string {
  return `stream:${id}`;
}

export async function createStream(
  db: Knex,
  opts: { name: string; payee: string; ratePerMin: number; every: unknown; maxTotal: number; board: string; now?: number },
): Promise<PayStream & { tickSats: number; feeShare: number }> {
  const name = typeof opts.name === "string" && opts.name.trim() ? opts.name.trim().slice(0, 80) : fail("BAD_PARAM", "name required");
  if (typeof opts.payee !== "string" || !opts.payee) fail("BAD_PARAM", "payee address required");
  const ratePerMin = Math.floor(Number(opts.ratePerMin) || 0);
  if (!(ratePerMin > 0)) fail("BAD_PARAM", "rate must be positive sats/min");
  const tickSecs = Math.floor(parseTick(opts.every) / 1000);
  const maxTotal = Math.floor(Number(opts.maxTotal) || 0);
  if (!(maxTotal >= MIN_TICK_SATS)) fail("BAD_PARAM", `max total must be at least ${MIN_TICK_SATS} sats`);
  if (typeof opts.board !== "string" || !opts.board) fail("BAD_PARAM", "board required");
  const now = opts.now ?? Date.now();
  const row: StreamRow = {
    id: newStreamId(), name, payee: opts.payee, rate_per_min: ratePerMin,
    tick_secs: tickSecs, max_total: maxTotal, board: opts.board,
    status: "active", paid_total: 0, last_paid_at: now,
    next_due: now + tickSecs * 1000, created_at: now,
  };
  await db("streams").insert(row);
  const tickSats = Math.floor((ratePerMin * tickSecs) / 60);
  return { ...toStream(row), tickSats, feeShare: tickSats > 0 ? ASSUMED_FEE_SATS / tickSats : 1 };
}

export async function listStreams(db: Knex): Promise<PayStream[]> {
  const rows = (await db("streams").select().orderBy("created_at", "desc").limit(100)) as StreamRow[];
  return rows.map(toStream);
}

export async function getStream(db: Knex, id: string): Promise<PayStream> {
  const row = (await db("streams").where({ id }).first()) as StreamRow | undefined;
  if (!row) fail("NOT_FOUND", `no stream: ${String(id).slice(0, 16)}`);
  return toStream(row!);
}

export async function setStreamStatus(db: Knex, id: string, status: StreamStatus): Promise<PayStream> {
  const row = (await db("streams").where({ id }).first()) as StreamRow | undefined;
  if (!row) fail("NOT_FOUND", `no stream: ${String(id).slice(0, 16)}`);
  if (row.status === "done" && status !== "done") fail("BAD_STATE", "closed streams stay closed");
  await db("streams").where({ id }).update({ status });
  return toStream({ ...row, status });
}

export async function listTicks(db: Knex, streamId: string, limit = 50): Promise<StreamTick[]> {
  const rows = (await db("stream_ticks").where({ stream_id: streamId }).orderBy("created_at", "desc").limit(Math.min(Math.max(limit, 1), 200))) as Array<{
    id: number; stream_id: string; beat_id: string | null; amount: number;
    txid: string | null; status: string; detail: string; created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id, streamId: r.stream_id, beatId: r.beat_id, amount: r.amount,
    txid: r.txid, status: (r.status === "paid" ? "paid" : r.status === "skipped" ? "skipped" : r.status === "closed" ? "closed" : "stale") as StreamTick["status"],
    detail: r.detail, createdAt: r.created_at,
  }));
}

export interface BeatInfo {
  id: string;
  ts: number;
}

export interface TickDeps {
  latestBeat: (stream: PayStream) => Promise<BeatInfo | null>;
  pay: (stream: PayStream, amount: number, beatId: string) => Promise<{ txid: string; fee: number }>;
}

/**
 * Minutely ticker. For each due active stream: fresh beat → pay accrued
 * (or accrue when below the floor); stale beat → record and auto-pause;
 * budget exhausted → close. Never backfills after downtime — one tick per
 * stream per pass, nextDue advances past now.
 */
export async function tickStreams(
  db: Knex,
  deps: TickDeps,
  now = Date.now(),
): Promise<Array<{ stream: string; outcome: string; txid?: string; amount?: number }>> {
  const active = (await db("streams").where({ status: "active" }).select()) as StreamRow[];
  const out: Array<{ stream: string; outcome: string; txid?: string; amount?: number }> = [];
  for (const r of active) {
    const s = toStream(r);
    if (s.nextDue > now || s.tickSecs <= 0) continue;
    // No backfill after downtime: missed periods are skipped, not paid later.
    const advance = () => advanceDue(s.nextDue, s.tickSecs, now);
    const note = async (status: StreamTick["status"], detail: string, extra: Partial<{ beatId: string | null; amount: number; txid: string | null }> = {}) => {
      await db("stream_ticks").insert({
        stream_id: s.id, beat_id: extra.beatId ?? null, amount: extra.amount ?? 0,
        txid: extra.txid ?? null, status, detail, created_at: now,
      });
    };
    const remaining = s.maxTotal - s.paidTotal;
    // Cheap pre-check so an exhausted stream never touches the board; the
    // shared ladder in commitment.ts re-checks the same condition.
    if (remaining < MIN_TICK_SATS) {
      await db("streams").where({ id: s.id }).update({ status: "done", next_due: advance() });
      await note("closed", `budget exhausted (remainder ${remaining} sats below pay floor — left unpaid)`);
      out.push({ stream: s.id, outcome: "closed" });
      continue;
    }
    // Liveness: a heartbeat on the board, fresh within grace.
    let beat: BeatInfo | null = null;
    try {
      beat = await deps.latestBeat(s);
    } catch {
      beat = null;
    }
    const graceMs = graceMsFor(s.tickSecs);
    const ageMs = beat ? now - beat.ts : Number.MAX_SAFE_INTEGER;
    const decision = dueCommitment(
      {
        cadenceSecs: s.tickSecs,
        ratePerMin: s.ratePerMin,
        fixedSats: 0,
        capSats: s.maxTotal,
        paidSats: s.paidTotal,
        minPaymentSats: MIN_TICK_SATS,
        lastPaidAt: s.lastPaidAt,
        nextDueAt: s.nextDue,
      },
      {
        fresh: !!beat && ageMs <= graceMs,
        ageMs,
        reason: beat
          ? `last beat ${beat.id.slice(0, 8)} is ${Math.round(ageMs / 1000)}s old (grace ${Math.round(graceMs / 1000)}s) — auto-paused, resume when beats return`
          : "no heartbeat on the board yet — auto-paused",
      },
      now,
    );
    if (decision.kind === "wait") continue;
    if (decision.kind === "exhausted") {
      await db("streams").where({ id: s.id }).update({ status: "done", next_due: advance() });
      await note("closed", `budget exhausted (remainder ${decision.remaining} sats below pay floor — left unpaid)`);
      out.push({ stream: s.id, outcome: "closed" });
      continue;
    }
    if (decision.kind === "stale") {
      await db("streams").where({ id: s.id }).update({ status: "paused", next_due: advance() });
      await note("stale", decision.reason);
      out.push({ stream: s.id, outcome: "paused" });
      continue;
    }
    if (decision.kind === "accruing") {
      await db("streams").where({ id: s.id }).update({ next_due: advance() });
      await note("skipped", `accrued ${decision.amount} sats below ${MIN_TICK_SATS} floor — carrying to next tick`, { beatId: beat?.id ?? null, amount: decision.amount });
      out.push({ stream: s.id, outcome: "accruing", amount: decision.amount });
      continue;
    }
    const amount = decision.amount;
    if (!beat) continue; // unreachable: a release requires a fresh beat
    try {
      const { txid } = await deps.pay(s, amount, beat.id);
      await db("streams").where({ id: s.id }).update({
        paid_total: s.paidTotal + amount, last_paid_at: now, next_due: advance(),
        ...(s.paidTotal + amount >= s.maxTotal ? { status: "done" } : {}),
      });
      await note("paid", `beat ${beat.id.slice(0, 8)}`, { beatId: beat.id, amount, txid });
      out.push({ stream: s.id, outcome: s.paidTotal + amount >= s.maxTotal ? "paid-closed" : "paid", txid, amount });
    } catch (e) {
      await db("streams").where({ id: s.id }).update({ next_due: advance() });
      await note("skipped", `payment failed: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200), { beatId: beat.id, amount });
      out.push({ stream: s.id, outcome: "pay-failed", amount });
    }
  }
  return out;
}
