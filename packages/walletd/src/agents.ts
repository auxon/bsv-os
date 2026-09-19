/**
 * F9 agent sub-wallets: allowances with lifetime budgets.
 *
 * Per-agent caps are single-action ceilings; sub-wallets add the missing
 * dimensions for long-running agents: a cumulative lifetime budget, an
 * optional rolling-24h daily allowance, and an optional expiry — all keyed
 * to the agent's origin name (the `--agent` flag stamps every MCP call).
 * Minting IS the approval ceremony: an origin with a live sub-wallet may
 * spend within budget without a separate policy row. An explicit policy
 * `deny` always wins; revocation flips the flag and is paired with a
 * policy deny by the `agentRevoke` RPC so one command fully cuts access.
 *
 * Accounting rule (double-spend races cost nothing): budgets are debited
 * only after a broadcast is accepted, never on check and never on failure.
 * Read-only over keys: this module touches the DB, never custody.
 */
import type { Knex } from "knex";
import { logEvent } from "./events.ts";

export const DAY_MS = 86_400_000;

export interface AgentRow {
  name: string;
  budget_sats: number;
  daily_sats: number;
  spent_total: number;
  spent_window: number;
  window_start: number;
  expiry_at: number;
  revoked: number;
  created_at: number;
}

export interface AgentView extends AgentRow {
  remaining: number;
  window_remaining: number;
  window_reset_in: number;
  expired: boolean;
  active: boolean;
}

export function validateAgentName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw Object.assign(new Error("agent name must match [A-Za-z0-9._-]{1,64}"), { code: "BAD_PARAM" });
  }
  return name;
}

export async function migrateAgents(db: Knex): Promise<void> {
  if (await db.schema.hasTable("agent_wallets")) return;
  await db.schema.createTable("agent_wallets", (t) => {
    t.string("name", 64).primary();
    t.integer("budget_sats").notNullable(); // lifetime budget, > 0
    t.integer("daily_sats").notNullable().defaultTo(0); // 0 = no daily limit
    t.integer("spent_total").notNullable().defaultTo(0);
    t.integer("spent_window").notNullable().defaultTo(0);
    t.integer("window_start").notNullable();
    t.integer("expiry_at").notNullable().defaultTo(0); // 0 = never expires
    t.integer("revoked").notNullable().defaultTo(0);
    t.integer("created_at").notNullable();
  });
}

function view(row: AgentRow, now = Date.now()): AgentView {
  const reset = now - row.window_start >= DAY_MS;
  const spentWindow = reset ? 0 : row.spent_window;
  const expired = row.expiry_at > 0 && now >= row.expiry_at;
  return {
    ...row,
    spent_window: spentWindow,
    remaining: Math.max(0, row.budget_sats - row.spent_total),
    window_remaining: row.daily_sats > 0 ? Math.max(0, row.daily_sats - spentWindow) : -1,
    window_reset_in: reset ? 0 : row.window_start + DAY_MS - now,
    expired,
    active: row.revoked === 0 && !expired,
  };
}

export async function mintAgent(
  db: Knex,
  opts: { name: string; budgetSats: number; dailySats?: number; expiryAt?: number },
): Promise<AgentView> {
  const name = validateAgentName(opts.name);
  const budgetSats = Math.floor(Number(opts.budgetSats) || 0);
  const dailySats = Math.max(0, Math.floor(Number(opts.dailySats) || 0));
  const expiryAt = Math.floor(Number(opts.expiryAt) || 0);
  if (!(budgetSats > 0)) throw Object.assign(new Error("--budget must be a positive sat amount"), { code: "BAD_PARAM" });
  if (expiryAt !== 0 && expiryAt <= Date.now()) {
    throw Object.assign(new Error("expiry must be in the future"), { code: "BAD_PARAM" });
  }
  const dupe = await db("agent_wallets").where({ name }).first();
  if (dupe) throw Object.assign(new Error(`agent wallet exists: ${name} (revoke first to re-mint)`), { code: "EXISTS" });
  const now = Date.now();
  const row: AgentRow = {
    name, budget_sats: budgetSats, daily_sats: dailySats,
    spent_total: 0, spent_window: 0, window_start: now,
    expiry_at: expiryAt, revoked: 0, created_at: now,
  };
  await db("agent_wallets").insert(row);
  await logEvent(db, "budget.minted", {
    origin: name, amountSats: budgetSats,
    detail: `budget ${budgetSats}${dailySats > 0 ? ` daily ${dailySats}` : ""}${expiryAt > 0 ? ` expiry ${new Date(expiryAt).toISOString()}` : ""}`,
  });
  return view(row, now);
}

export async function revokeAgent(db: Knex, name: string): Promise<{ name: string; revoked: boolean }> {
  const clean = validateAgentName(name);
  const n = await db("agent_wallets").where({ name: clean }).update({ revoked: 1 });
  if (n === 0) throw Object.assign(new Error(`no agent wallet: ${clean}`), { code: "NOT_FOUND" });
  await logEvent(db, "budget.revoked", { origin: clean });
  return { name: clean, revoked: true };
}

export async function getAgent(db: Knex, name: string): Promise<AgentView | null> {
  const row = (await db("agent_wallets").where({ name }).first()) as AgentRow | undefined;
  return row ? view(row) : null;
}

export async function listAgents(db: Knex): Promise<AgentView[]> {
  const rows = (await db("agent_wallets").select().orderBy("name")) as AgentRow[];
  const now = Date.now();
  return rows.map((r) => view(r, now));
}

/** Budget gate for policy.ts: origins without a sub-wallet pass through.
 * `covered` is true only when a live sub-wallet backs the spend — the
 * policy layer treats that as the approval (minting is the ceremony). */
export async function checkBudget(
  db: Knex,
  origin: string,
  amountSats: number,
): Promise<{ ok: boolean; reason: string; covered: boolean }> {
  const agent = await getAgent(db, origin);
  if (!agent) return { ok: true, reason: "", covered: false };
  if (agent.revoked === 1) {
    return { ok: false, reason: `sub-wallet revoked — mint a new allowance with: bsv agent mint ${origin} --budget <sats>`, covered: false };
  }
  if (agent.expired) {
    return { ok: false, reason: `sub-wallet expired — mint a new allowance with: bsv agent mint ${origin} --budget <sats>`, covered: false };
  }
  const cost = Math.max(0, Math.floor(Number(amountSats) || 0));
  if (agent.spent_total + cost > agent.budget_sats) {
    return {
      ok: false,
      reason: `over lifetime budget (${agent.remaining} of ${agent.budget_sats} sats left) — ask your human to re-mint with a bigger --budget`,
      covered: false,
    };
  }
  if (agent.daily_sats > 0 && agent.spent_window + cost > agent.daily_sats) {
    return {
      ok: false,
      reason: `over daily allowance (${agent.window_remaining} of ${agent.daily_sats} sats left today) — retry after the window resets`,
      covered: false,
    };
  }
  return { ok: true, reason: "", covered: true };
}

/**
 * Debit after a broadcast is accepted. No-ops for origins without a
 * sub-wallet. Never call on check or on failure — losers of
 * double-spend races cost nothing.
 */
export async function recordSpend(db: Knex, origin: string, amountSats: number): Promise<void> {
  const row = (await db("agent_wallets").where({ name: origin }).first()) as AgentRow | undefined;
  if (!row || row.revoked === 1) return;
  const cost = Math.max(0, Math.floor(Number(amountSats) || 0));
  if (cost === 0) return;
  const now = Date.now();
  const reset = now - row.window_start >= DAY_MS;
  await db("agent_wallets").where({ name: origin }).update({
    spent_total: row.spent_total + cost,
    spent_window: (reset ? 0 : row.spent_window) + cost,
    window_start: reset ? now : row.window_start,
  });
}
