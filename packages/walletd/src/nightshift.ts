/**
 * F13 NightShift: standing orders for recurring agent work.
 *
 * Recurring jobs (due cycles, cron-spawned agents) get an OS home instead
 * of fragile external schedules: a standing order names the agent, the
 * cadence, and the per-cycle budget. The daemon ticks every minute,
 * opening a `due` run per elapsed period (idempotent, no backfill spam).
 * Each run walks claim → submit → approve with the cycle amount gated
 * against the agent's F9 sub-wallet at claim AND approve time; approval
 * debits the budget. The daemon never runs agent work itself — it owns
 * the schedule, the escrow states, and the audit.
 *
 * Schedules are intervals (`30s 15m 6h 2d 1w`), not cron expressions:
 * readable, auditable, and sufficient for standing orders.
 */
import type { Knex } from "knex";
import { randomBytes } from "node:crypto";
import { checkBudget, recordSpend } from "./agents.ts";

export type OrderStatus = "active" | "paused";
export type RunStatus = "due" | "claimed" | "submitted" | "approved" | "failed";

export interface StandingOrder {
  id: string;
  name: string;
  agent: string;
  everySecs: number;
  cycleSats: number;
  bountyId: string | null;
  status: OrderStatus;
  nextDue: number;
  createdAt: number;
}

export interface OrderRun {
  id: number;
  orderId: string;
  agent: string;
  cycleSats: number;
  status: RunStatus;
  proof: string | null;
  createdAt: number;
  updatedAt: number;
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse "60s 15m 6h 2d 1w" (also bare seconds) to milliseconds. */
export function parseEvery(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw <= 0) throw Object.assign(new Error("interval must be positive"), { code: "BAD_PARAM" });
    return Math.floor(raw * 1000);
  }
  const m = /^(\d+)\s*([smhdw])$/i.exec(String(raw ?? "").trim());
  if (!m) throw Object.assign(new Error("interval like 30s, 15m, 6h, 2d, 1w"), { code: "BAD_PARAM" });
  const ms = Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
  if (!(ms >= 60_000)) throw Object.assign(new Error("minimum interval is 60s"), { code: "BAD_PARAM" });
  if (ms > 365 * 86_400_000) throw Object.assign(new Error("maximum interval is 365d"), { code: "BAD_PARAM" });
  return ms;
}

export function validateAgentName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw Object.assign(new Error("agent name must match [A-Za-z0-9._-]{1,64}"), { code: "BAD_PARAM" });
  }
  return name;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function newOrderId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "ord_";
  for (const b of randomBytes(9)) id += chars[b % chars.length];
  return id;
}

export async function migrateNightshift(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("standing_orders"))) {
    await db.schema.createTable("standing_orders", (t) => {
      t.string("id", 16).primary();
      t.string("name", 80).notNullable();
      t.string("agent", 64).notNullable();
      t.integer("every_secs").notNullable();
      t.integer("cycle_sats").notNullable();
      t.string("bounty_id", 128).nullable();
      t.string("status").notNullable().defaultTo("active");
      t.integer("next_due").notNullable();
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("order_runs"))) {
    await db.schema.createTable("order_runs", (t) => {
      t.increments("id");
      t.string("order_id", 16).notNullable();
      t.string("agent", 64).notNullable();
      t.integer("cycle_sats").notNullable();
      t.string("status").notNullable().defaultTo("due");
      t.text("proof").nullable();
      t.integer("created_at").notNullable();
      t.integer("updated_at").notNullable();
    });
  }
}

interface OrderRow {
  id: string; name: string; agent: string; every_secs: number;
  cycle_sats: number; bounty_id: string | null; status: string;
  next_due: number; created_at: number;
}

function toOrder(r: OrderRow): StandingOrder {
  return {
    id: r.id, name: r.name, agent: r.agent, everySecs: r.every_secs,
    cycleSats: r.cycle_sats, bountyId: r.bounty_id,
    status: r.status === "paused" ? "paused" : "active",
    nextDue: r.next_due, createdAt: r.created_at,
  };
}

export async function createOrder(
  db: Knex,
  opts: { name: string; agent: string; every: unknown; cycleSats: number; bountyId?: string },
): Promise<StandingOrder> {
  const name = typeof opts.name === "string" && opts.name.trim() ? opts.name.trim().slice(0, 80) : fail("BAD_PARAM", "name required");
  const agent = validateAgentName(opts.agent);
  const everySecs = Math.floor(parseEvery(opts.every) / 1000);
  const cycleSats = Math.floor(Number(opts.cycleSats) || 0);
  if (!(cycleSats > 0)) fail("BAD_PARAM", "cycle budget must be positive sats");
  const bountyId = typeof opts.bountyId === "string" && opts.bountyId ? opts.bountyId.slice(0, 128) : null;
  const now = Date.now();
  const row: OrderRow = {
    id: newOrderId(), name, agent, every_secs: everySecs, cycle_sats: cycleSats,
    bounty_id: bountyId, status: "active", next_due: now + everySecs * 1000, created_at: now,
  };
  await db("standing_orders").insert(row);
  return toOrder(row);
}

export async function listOrders(db: Knex): Promise<StandingOrder[]> {
  const rows = (await db("standing_orders").select().orderBy("created_at", "desc").limit(100)) as OrderRow[];
  return rows.map(toOrder);
}

export async function setOrderStatus(db: Knex, id: string, status: OrderStatus): Promise<StandingOrder> {
  const row = (await db("standing_orders").where({ id }).first()) as OrderRow | undefined;
  if (!row) fail("NOT_FOUND", `no order: ${String(id).slice(0, 16)}`);
  await db("standing_orders").where({ id }).update({ status });
  return toOrder({ ...(row as OrderRow), status });
}

export async function removeOrder(db: Knex, id: string): Promise<{ id: string; removed: boolean }> {
  const n = await db("standing_orders").where({ id }).delete();
  if (!n) fail("NOT_FOUND", `no order: ${String(id).slice(0, 16)}`);
  await db("order_runs").where({ order_id: id }).delete();
  return { id, removed: true };
}

function toRun(r: {
  id: number; order_id: string; agent: string; cycle_sats: number;
  status: string; proof: string | null; created_at: number; updated_at: number;
}): OrderRun {
  return {
    id: r.id, orderId: r.order_id, agent: r.agent, cycleSats: r.cycle_sats,
    status: r.status as RunStatus, proof: r.proof,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listRuns(db: Knex, orderId?: string, limit = 50): Promise<OrderRun[]> {
  let q = db("order_runs").select();
  if (orderId) q = q.where({ order_id: orderId });
  const rows = (await q.orderBy("created_at", "desc").limit(Math.min(Math.max(limit, 1), 200))) as Array<{
    id: number; order_id: string; agent: string; cycle_sats: number;
    status: string; proof: string | null; created_at: number; updated_at: number;
  }>;
  return rows.map(toRun);
}

/**
 * Ticker: open one `due` run per elapsed period per active order, then
 * advance nextDue past now (no backfill spam after downtime).
 */
export async function tickOrders(db: Knex, now = Date.now()): Promise<{ opened: number; orderIds: string[] }> {
  const active = (await db("standing_orders").where({ status: "active" }).select()) as OrderRow[];
  let opened = 0;
  const orderIds: string[] = [];
  for (const o of active) {
    if (o.next_due > now || o.every_secs <= 0) continue;
    await db("order_runs").insert({
      order_id: o.id, agent: o.agent, cycle_sats: o.cycle_sats,
      status: "due", proof: null, created_at: now, updated_at: now,
    });
    opened++;
    orderIds.push(o.id);
    const periods = Math.floor((now - o.next_due) / (o.every_secs * 1000)) + 1;
    await db("standing_orders").where({ id: o.id }).update({ next_due: o.next_due + periods * o.every_secs * 1000 });
  }
  return { opened, orderIds };
}

/** Claim a due run: the agent's budget must cover this cycle. */
export async function claimRun(db: Knex, runId: number): Promise<OrderRun> {
  const row = await runRow(db, runId);
  if (row.status !== "due") fail("BAD_STATE", `run is ${row.status}, not due`);
  const gate = await checkBudget(db, row.agent, row.cycle_sats);
  if (!gate.ok) fail("BUDGET", gate.reason);
  return setRunStatus(db, runId, "claimed");
}

/** Submit proof for a claimed run. */
export async function submitRun(db: Knex, runId: number, proof: string): Promise<OrderRun> {
  const row = await runRow(db, runId);
  if (row.status !== "claimed") fail("BAD_STATE", `run is ${row.status}, not claimed`);
  if (typeof proof !== "string" || !proof.trim() || proof.length > 2000) {
    fail("BAD_PARAM", "proof must be 1..2000 chars");
  }
  await db("order_runs").where({ id: runId }).update({ proof: proof.trim(), status: "submitted", updated_at: Date.now() });
  return toRun({ ...row, proof: proof.trim(), status: "submitted", updated_at: Date.now() });
}

/** Human approval: re-check the budget, then debit the cycle. */
export async function approveRun(db: Knex, runId: number): Promise<OrderRun> {
  const row = await runRow(db, runId);
  if (row.status !== "submitted") fail("BAD_STATE", `run is ${row.status}, not submitted`);
  const gate = await checkBudget(db, row.agent, row.cycle_sats);
  if (!gate.ok) fail("BUDGET", gate.reason);
  await recordSpend(db, row.agent, row.cycle_sats);
  return setRunStatus(db, runId, "approved");
}

export async function failRun(db: Knex, runId: number): Promise<OrderRun> {
  const row = await runRow(db, runId);
  if (row.status === "approved") fail("BAD_STATE", "approved runs are final");
  return setRunStatus(db, runId, "failed");
}

async function runRow(db: Knex, runId: number) {
  const id = Math.floor(Number(runId));
  const row = (await db("order_runs").where({ id }).first()) as {
    id: number; order_id: string; agent: string; cycle_sats: number;
    status: string; proof: string | null; created_at: number; updated_at: number;
  } | undefined;
  if (!row) fail("NOT_FOUND", `no run: ${String(runId).slice(0, 16)}`);
  return row as {
    id: number; order_id: string; agent: string; cycle_sats: number;
    status: string; proof: string | null; created_at: number; updated_at: number;
  };
}

async function setRunStatus(db: Knex, runId: number, status: RunStatus): Promise<OrderRun> {
  await db("order_runs").where({ id: runId }).update({ status, updated_at: Date.now() });
  return toRun(await runRow(db, runId));
}
