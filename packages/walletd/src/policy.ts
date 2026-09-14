/**
 * Spending policy (BRC-116-shaped): per-origin allow/deny/ask + spend caps.
 * Headless daemon semantics: unknown origins are denied AND recorded as
 * pending requests; the local CLI is the policy console that approves them.
 */
import type { Knex } from "knex";

export type Verdict = "allow" | "deny";
export interface PolicyCheck {
  verdict: Verdict;
  reason: string;
  pending: boolean;
}

export async function migratePolicy(db: Knex): Promise<void> {
  if (await db.schema.hasTable("policies")) return;
  await db.schema.createTable("policies", (t) => {
    t.string("origin", 200).primary();
    t.string("mode").notNullable().defaultTo("ask"); // allow|deny|ask
    t.integer("spend_cap_sats").notNullable().defaultTo(0); // 0 = uncapped
    t.integer("updated_at").notNullable();
  });
  await db.schema.createTable("policy_requests", (t) => {
    t.increments("id");
    t.string("origin", 200).notNullable();
    t.integer("amount_sats").notNullable().defaultTo(0);
    t.string("action", 100).notNullable().defaultTo("");
    t.integer("created_at").notNullable();
  });
}

export async function check(
  db: Knex,
  origin: string,
  amountSats: number,
  action: string,
): Promise<PolicyCheck> {
  const row = (await db("policies").where({ origin }).first()) as
    | { mode: string; spend_cap_sats: number }
    | undefined;
  const mode = row?.mode ?? "ask";
  if (mode === "deny") return { verdict: "deny", reason: "denied by policy", pending: false };
  if (mode === "allow") {
    if ((row?.spend_cap_sats ?? 0) > 0 && amountSats > (row?.spend_cap_sats ?? 0)) {
      return { verdict: "deny", reason: `over spend cap (${row?.spend_cap_sats} sats)`, pending: false };
    }
    return { verdict: "allow", reason: "allowed by policy", pending: false };
  }
  // ask (and unknown): record once per origin+action, deny this attempt
  const seen = await db("policy_requests").where({ origin, action }).first();
  if (!seen) {
    await db("policy_requests").insert({ origin, amount_sats: amountSats, action, created_at: Date.now() });
  }
  return { verdict: "deny", reason: "first-run approval required — approve with: bsv allow " + origin, pending: true };
}

export async function setPolicy(db: Knex, origin: string, mode: "allow" | "deny" | "ask", capSats = 0): Promise<void> {
  await db("policies")
    .insert({ origin, mode, spend_cap_sats: capSats, updated_at: Date.now() })
    .onConflict("origin")
    .merge({ mode, spend_cap_sats: capSats, updated_at: Date.now() });
  if (mode !== "ask") {
    await db("policy_requests").where({ origin }).delete();
  }
}

export async function seedRequest(db: Knex, origin: string, amountSats: number, action: string): Promise<void> {
  const seen = await db("policy_requests").where({ origin, action }).first();
  if (!seen) {
    await db("policy_requests").insert({ origin, amount_sats: amountSats, action, created_at: Date.now() });
  }
}

export async function pendingRequests(db: Knex): Promise<Array<{ id: number; origin: string; amount_sats: number; action: string; created_at: number }>> {  return (await db("policy_requests").select().orderBy("created_at", "desc").limit(100)) as Array<{
    id: number; origin: string; amount_sats: number; action: string; created_at: number;
  }>;
}

export async function listPolicies(db: Knex): Promise<Array<{ origin: string; mode: string; spend_cap_sats: number }>> {
  return (await db("policies").select("origin", "mode", "spend_cap_sats").orderBy("origin")) as Array<{
    origin: string; mode: string; spend_cap_sats: number;
  }>;
}
