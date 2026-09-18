/**
 * Spending policy (BRC-116-shaped): per-origin allow/deny/ask/auto + spend caps.
 * Headless daemon semantics: unknown origins are denied AND recorded as
 * pending requests; the local CLI is the policy console that approves them.
 *
 * F9: agent sub-wallets layer lifetime budgets / daily allowances / expiry
 * on top. Minting is the approval ceremony for agents: an origin with a
 * live sub-wallet spends within budget with no separate policy row. An
 * explicit `deny` always wins; budget states deny without recording (the
 * human re-mints, there is nothing to approve).
 *
 * Jev layer: when OPENROUTER_API_KEY is configured, pending requests carry
 * a calibrated verdict/risk score from Jev (advisory — the human still
 * approves), and mode `auto` lets a routine, confident allow verdict spend
 * within caps without waking the human. Everything Jev-related fails
 * closed: no answer means a pending request, never a silent spend.
 */
import type { Knex } from "knex";
import { checkBudget } from "./agents.ts";
import {
  autoApprove,
  describeScore,
  jevEnabled,
  scoreSpend,
  type JevDecide,
  type SpendContext,
  type SpendScore,
} from "./jev.ts";

export type PolicyMode = "allow" | "deny" | "ask" | "auto";
export type Verdict = "allow" | "deny";

export interface PolicyCheck {
  verdict: Verdict;
  reason: string;
  pending: boolean;
  jev?: SpendScore | null;
}

export interface CheckOpts {
  /** Facts about the spend for the decision state (label, payee, host…). */
  context?: Partial<Omit<SpendContext, "origin" | "action" | "amountSats">>;
  /** Test/embedding override; default is the Jev client in jev.ts. */
  jev?: JevDecide;
}

interface RequestRow {
  id: number;
  jev_verdict: string | null;
  jev_prob: number | null;
  jev_risk: number | null;
  jev_risk_level: string | null;
  jev_confidence: number | null;
  jev_model: string | null;
  jev_checked_at: number | null;
}

export interface PendingRequest {
  id: number;
  origin: string;
  amount_sats: number;
  action: string;
  created_at: number;
  jev_verdict: string | null;
  jev_prob: number | null;
  jev_risk: number | null;
  jev_risk_level: string | null;
  jev_confidence: number | null;
  jev_model: string | null;
  jev_checked_at: number | null;
}

const JEV_COLUMNS: Array<[string, "string" | "float" | "integer"]> = [
  ["jev_verdict", "string"],
  ["jev_prob", "float"],
  ["jev_risk", "float"],
  ["jev_risk_level", "string"],
  ["jev_confidence", "float"],
  ["jev_model", "string"],
  ["jev_checked_at", "integer"],
];

export async function migratePolicy(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("policies"))) {
    await db.schema.createTable("policies", (t) => {
      t.string("origin", 200).primary();
      t.string("mode").notNullable().defaultTo("ask"); // allow|deny|ask|auto
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
  // Jev columns on an existing table (upgrades from pre-Jev daemons).
  for (const [name, kind] of JEV_COLUMNS) {
    if (await db.schema.hasColumn("policy_requests", name)) continue;
    await db.schema.alterTable("policy_requests", (t) => {
      if (kind === "string") t.string(name, 64).nullable();
      else if (kind === "float") t.float(name).nullable();
      else t.integer(name).nullable();
    });
  }
}

function scoreFields(score: SpendScore): Record<string, unknown> {
  return {
    jev_verdict: score.verdict,
    jev_prob: score.verdictProb,
    jev_risk: score.risk,
    jev_risk_level: score.riskLevel,
    jev_confidence: score.confidence,
    jev_model: score.model,
    jev_checked_at: Date.now(),
  };
}

function scoreFromRow(row: RequestRow | undefined): SpendScore | null {
  if (!row?.jev_verdict || row.jev_checked_at == null) return null;
  return {
    verdict: row.jev_verdict as SpendScore["verdict"],
    verdictProb: Number(row.jev_prob ?? 0),
    risk: Number(row.jev_risk ?? 0),
    riskLevel: (row.jev_risk_level ?? "routine") as SpendScore["riskLevel"],
    confidence: Number(row.jev_confidence ?? 0),
    model: row.jev_model ?? "cached",
    cost: 0,
    elapsedMs: 0,
  };
}

/** Advisor call; null on any failure (policy then behaves as if Jev were absent). */
async function maybeScore(
  origin: string,
  amountSats: number,
  action: string,
  opts: CheckOpts,
): Promise<SpendScore | null> {
  if (amountSats <= 0) return null;
  if (!opts.jev && !jevEnabled()) return null;
  try {
    return await scoreSpend(
      { origin, action, amountSats, ...opts.context },
      opts.jev ? { decide: opts.jev } : {},
    );
  } catch {
    return null;
  }
}

async function upsertRequest(
  db: Knex,
  origin: string,
  amountSats: number,
  action: string,
  score: SpendScore | null,
  seen: RequestRow | undefined,
): Promise<void> {
  if (!seen) {
    await db("policy_requests").insert({
      origin,
      amount_sats: amountSats,
      action,
      created_at: Date.now(),
      ...(score ? scoreFields(score) : {}),
    });
  } else if (score) {
    await db("policy_requests").where({ id: seen.id }).update(scoreFields(score));
  }
}

export async function check(
  db: Knex,
  origin: string,
  amountSats: number,
  action: string,
  opts: CheckOpts = {},
): Promise<PolicyCheck> {
  const row = (await db("policies").where({ origin }).first()) as
    | { mode: string; spend_cap_sats: number }
    | undefined;
  const mode = (row?.mode ?? "ask") as PolicyMode;
  if (mode === "allow" || mode === "auto") {
    if ((row?.spend_cap_sats ?? 0) > 0 && amountSats > (row?.spend_cap_sats ?? 0)) {
      return { verdict: "deny", reason: `over spend cap (${row?.spend_cap_sats} sats)`, pending: false };
    }
  } else if (mode === "deny") {
    return { verdict: "deny", reason: "denied by policy", pending: false };
  }
  // F9: sub-wallet budgets bind allow-mode survivors and ask-mode origins
  // alike. A spend covered by a live budget is approved even in ask mode —
  // minting was the approval ceremony.
  const purse = await checkBudget(db, origin, amountSats);
  if (!purse.ok) return { verdict: "deny", reason: purse.reason, pending: false };
  if (mode === "allow" || purse.covered) {
    return { verdict: "allow", reason: purse.covered ? "allowed by agent budget" : "allowed by policy", pending: false };
  }
  // ask / auto (and unknown): the advisor scores a spend once per request;
  // auto mode always re-scores because the score is the decision.
  const seen = (await db("policy_requests").where({ origin, action }).first()) as RequestRow | undefined;
  const score =
    mode === "auto" || !seen?.jev_checked_at
      ? await maybeScore(origin, amountSats, action, opts)
      : scoreFromRow(seen);
  if (mode === "auto") {
    if (score && autoApprove(score)) {
      return { verdict: "allow", reason: `allowed by Jev: ${describeScore(score)}`, pending: false, jev: score };
    }
    await upsertRequest(db, origin, amountSats, action, score, seen);
    const why = score ? describeScore(score) : "Jev unavailable (no answer)";
    return {
      verdict: "deny",
      reason: `${why} — human approval required: bsv allow ${origin}`,
      pending: true,
      jev: score,
    };
  }
  // ask (and unknown): record once per origin+action, deny this attempt
  await upsertRequest(db, origin, amountSats, action, score, seen);
  const reason = score
    ? `first-run approval required — ${describeScore(score)}; approve with: bsv allow ${origin}`
    : `first-run approval required — approve with: bsv allow ${origin}`;
  return { verdict: "deny", reason, pending: true, jev: score };
}

export async function setPolicy(db: Knex, origin: string, mode: PolicyMode, capSats = 0): Promise<void> {
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

export async function pendingRequests(db: Knex): Promise<PendingRequest[]> {
  return (await db("policy_requests")
    .select(
      "id", "origin", "amount_sats", "action", "created_at",
      "jev_verdict", "jev_prob", "jev_risk", "jev_risk_level", "jev_confidence", "jev_model", "jev_checked_at",
    )
    .orderBy("created_at", "desc")
    .limit(100)) as PendingRequest[];
}

export async function listPolicies(db: Knex): Promise<Array<{ origin: string; mode: string; spend_cap_sats: number }>> {
  return (await db("policies").select("origin", "mode", "spend_cap_sats").orderBy("origin")) as Array<{
    origin: string; mode: string; spend_cap_sats: number;
  }>;
}
