/**
 * Approval-lifecycle event feed: the wake-up channel for agents.
 *
 * Polling `requests`/`pending` means diffing state; the feed records the
 * transitions instead — request created/approved/denied, budget
 * minted/revoked — with monotonic ids. `eventsPoll --wait` long-polls so
 * an agent sleeps until something it cares about happens. Only genuine
 * transitions are logged (never per-attempt noise), and probes never log.
 */
import type { Knex } from "knex";

export type PolicyEventType =
  | "request.created"
  | "request.approved"
  | "request.denied"
  | "budget.minted"
  | "budget.revoked";

export interface PolicyEvent {
  id: number;
  created_at: number;
  type: PolicyEventType;
  origin: string;
  amount_sats: number;
  action: string;
  detail: string;
}

export async function migrateEvents(db: Knex): Promise<void> {
  if (await db.schema.hasTable("policy_events")) return;
  await db.schema.createTable("policy_events", (t) => {
    t.increments("id");
    t.integer("created_at").notNullable();
    t.string("type", 32).notNullable();
    t.string("origin", 200).notNullable().defaultTo("");
    t.integer("amount_sats").notNullable().defaultTo(0);
    t.string("action", 100).notNullable().defaultTo("");
    t.text("detail").notNullable().defaultTo("");
  });
}

export async function logEvent(
  db: Knex,
  type: PolicyEventType,
  fields: { origin?: string; amountSats?: number; action?: string; detail?: string } = {},
): Promise<number> {
  const [id] = await db("policy_events").insert({
    created_at: Date.now(),
    type,
    origin: fields.origin ?? "",
    amount_sats: Math.max(0, Math.floor(Number(fields.amountSats) || 0)),
    action: fields.action ?? "",
    detail: fields.detail ?? "",
  });
  return Number(id);
}

export async function readEvents(
  db: Knex,
  opts: { since?: number; limit?: number; origin?: string } = {},
): Promise<PolicyEvent[]> {
  const since = Math.max(0, Math.floor(Number(opts.since) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)));
  let q = db("policy_events")
    .select("id", "created_at", "type", "origin", "amount_sats", "action", "detail")
    .where("id", ">", since)
    .orderBy("id");
  if (opts.origin) q = q.andWhere({ origin: opts.origin });
  return (await q.limit(limit)) as PolicyEvent[];
}
