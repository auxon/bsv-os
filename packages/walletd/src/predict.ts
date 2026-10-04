/**
 * Prediction markets: parimutuel pools with Jev resolution.
 *
 * A market asks a question with 2-8 outcomes. Bettors stake sats on an
 * outcome before the close; winners split the pool proportionally
 * (minus a fee, default 2%). At resolve time Jev grades the evidence
 * with a choice question; below-confidence or ambiguous verdicts void
 * the market (full refunds, no fee). One dispute round re-grades with
 * the disputant's evidence before settlement.
 *
 * Money movement is on-chain and uses existing rails, nothing bespoke:
 * bets are policy-gated sends into the hot wallet attributed to a
 * per-market basket (predict-<id>); settlement is one multi-output
 * spendTo gated on the caller, with full context. The SQLite ledger is
 * the source of truth for positions; basket balances cross-check it.
 * Trust assumption is the daemon's own custody (same as every send) —
 * stated plainly, no novel cryptography.
 */
import type { Knex } from "knex";

export const PREDICT_FEE_BPS_DEFAULT = 200;
export const PREDICT_MIN_BET_SATS = 1000;
export const PREDICT_MIN_OUTCOMES = 2;
export const PREDICT_MAX_OUTCOMES = 8;
export const PREDICT_CONF_THRESHOLD = 0.6;
export const PREDICT_DISPUTE_HOURS_DEFAULT = 24;
/** Settlement fee budget: base + per-output, deducted before the split. */
export const PREDICT_SETTLE_BASE_SATS = 200;
export const PREDICT_SETTLE_PER_OUTPUT_SATS = 60;

export type MarketStatus =
  | "open"
  | "locked"
  | "resolving"
  | "disputed"
  | "settled"
  | "void";

export interface Market {
  id: string;
  question: string;
  outcomes: string[];
  closes_at: number;
  evidence: string;
  status: MarketStatus;
  fee_bps: number;
  dispute_hours: number;
  creator_origin: string;
  created_at: number;
  winning_outcome: string | null;
  verdict_confidence: number | null;
  resolved_at: number | null;  dispute_by: string | null;
  dispute_why: string | null;
  settle_txid: string | null;
}

export interface Bet {
  id: number;
  market_id: string;
  origin: string;
  payout_address: string;
  outcome: string;
  sats: number;
  txid: string;
  created_at: number;
}

export function marketBasket(marketId: string): string {
  return `predict-${marketId}`;
}

export async function migratePredict(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("predict_markets"))) {
    await db.schema.createTable("predict_markets", (t) => {
      t.string("id", 24).primary();
      t.text("question").notNullable();
      t.text("outcomes").notNullable(); // JSON string[]
      t.integer("closes_at").notNullable();
      t.text("evidence").notNullable().defaultTo("");
      t.string("status", 12).notNullable().defaultTo("open");
      t.integer("fee_bps").notNullable().defaultTo(PREDICT_FEE_BPS_DEFAULT);
      t.integer("dispute_hours").notNullable().defaultTo(PREDICT_DISPUTE_HOURS_DEFAULT);
      t.string("creator_origin", 128).notNullable().defaultTo("");
      t.integer("created_at").notNullable();
      t.string("winning_outcome", 128).nullable();
      t.float("verdict_confidence").nullable();
      t.integer("resolved_at").nullable();
      t.string("dispute_by", 128).nullable();
      t.text("dispute_why").nullable();
      t.string("settle_txid", 64).nullable();
    });
  }
  if (!(await db.schema.hasTable("predict_bets"))) {
    await db.schema.createTable("predict_bets", (t) => {
      t.increments("id");
      t.string("market_id", 24).notNullable().index();
      t.string("origin", 128).notNullable();
      t.string("payout_address", 64).notNullable();
      t.string("outcome", 128).notNullable();
      t.integer("sats").notNullable();
      t.string("txid", 64).notNullable();
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("predict_remote"))) {
    await db.schema.createTable("predict_remote", (t) => {
      t.string("market_id", 24).primary();
      t.string("role", 16).notNullable(); // creator | bettor
      t.string("board", 64).notNullable().defaultTo("predict");
      t.string("post_id", 128).nullable(); // announcement post (creator) or source post (bettor)
      t.text("descriptor").notNullable().defaultTo("{}");
      t.string("status", 16).notNullable().defaultTo("open");
      t.string("settle_txid", 64).nullable();
      t.integer("created_at").notNullable();
    });
  }
}

export const PREDICT_BOARD = "predict";
/** OP_RETURN memo convention for cross-wallet bets. */
export const PREDICT_BET_TAG = "PREDICTBET";
export const PREDICT_MARKET_TAG = "PREDICT-MARKET";
export const PREDICT_SETTLE_TAG = "PREDICT-SETTLE";

export interface RemoteDescriptor {
  id: string;
  question: string;
  outcomes: string[];
  closes_at: number;
  evidence: string;
  fee_bps: number;
  dispute_hours: number;
  pool_address: string;
  creator: string; // identity key or origin label
}

export function descriptorFor(m: Market, poolAddress: string, creator: string): RemoteDescriptor {
  return {
    id: m.id,
    question: m.question,
    outcomes: m.outcomes,
    closes_at: m.closes_at,
    evidence: m.evidence,
    fee_bps: m.fee_bps,
    dispute_hours: m.dispute_hours,
    pool_address: poolAddress,
    creator,
  };
}

/** Parse a PREDICT-MARKET board post. Null when not a descriptor. */
export function parseDescriptor(text: string): RemoteDescriptor | null {
  const m = String(text ?? "").match(/PREDICT-MARKET\s+(\{.*\})/s);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]) as Record<string, unknown>;
    if (typeof d.id !== "string" || typeof d.question !== "string" || !Array.isArray(d.outcomes)) return null;
    if (typeof d.pool_address !== "string" || typeof d.creator !== "string") return null;
    return d as unknown as RemoteDescriptor;
  } catch {
    return null;
  }
}

/** Build the bet memo lines. Outcome/payout/identity ride as separate ≤80ch lines. */
export function betMemo(marketId: string, outcome: string, payoutAddress: string, identityKey?: string): string[] {
  const lines = [`${PREDICT_BET_TAG} ${marketId} ${outcome}`, payoutAddress];
  if (identityKey) lines.push(identityKey);
  for (const l of lines) {
    if (l.length > 80) fail("BAD_PARAM", "bet memo line too long (outcome > ~50 chars unsupported remote)");
  }
  return lines;
}

/** Parse a bet memo back. Null when not a PREDICTBET memo. */
export function parseBetMemo(lines: string[]): { marketId: string; outcome: string; payout: string; identityKey: string | null } | null {
  if (!Array.isArray(lines) || lines.length < 2) return null;
  const m = String(lines[0] ?? "").match(/^PREDICTBET\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  const payout = String(lines[1] ?? "");
  if (!/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(payout)) return null;
  return { marketId: m[1], outcome: m[2].trim(), payout, identityKey: typeof lines[2] === "string" && lines[2] ? lines[2] : null };
}

/** Decode OP_RETURN pushdata to utf8 strings. Empty when not OP_RETURN. */
export function decodeOpReturnStrings(scriptHex: string): string[] {
  let hex = String(scriptHex ?? "").replace(/^0x/, "");
  if (!/^(6a)/i.test(hex)) return [];
  const bytes: number[] = [];
  for (let i = 0; i + 2 <= hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  if (bytes[0] !== 0x6a) return [];
  const out: string[] = [];
  let i = 1;
  const take = (n: number): number[] | null => {
    if (i + n > bytes.length) return null;
    const d = bytes.slice(i, i + n);
    i += n;
    return d;
  };
  while (i < bytes.length) {
    const op = bytes[i++];
    let len = -1;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) {
      const b = take(1);
      if (!b) break;
      len = b[0];
    } else if (op === 0x4d) {
      const b = take(2);
      if (!b) break;
      len = b[0] | (b[1] << 8);
    } else if (op === 0x4e) {
      const b = take(4);
      if (!b) break;
      len = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
    } else break;
    const d = take(len);
    if (!d) break;
    try {
      const s = Buffer.from(d).toString("utf8");
      if (s && /^[\x20-\x7e]+$/.test(s)) out.push(s);
    } catch { /* skip binary push */ }
  }
  return out;
}

export interface ScannedOutput { scriptHex: string; sats: number }

/**
 * Credit one on-chain tx to a market: finds a PREDICTBET memo, checks a
 * pool payment ≥ min bet, guards double-credit. Returns the bet or null
 * with a reason. Pure ledger logic; fetching is the caller's job.
 */
export async function creditScannedBet(
  db: Knex,
  market: Market,
  txid: string,
  outputs: ScannedOutput[],
  poolScriptHex: string,
  now = Date.now(),
): Promise<{ bet: Bet | null; reason?: string }> {
  if (market.status !== "open" || now > market.closes_at) {
    return { bet: null, reason: "market not open" };
  }
  let memo: ReturnType<typeof parseBetMemo> = null;
  for (const o of outputs) {
    const m = parseBetMemo(decodeOpReturnStrings(o.scriptHex));
    if (m && m.marketId === market.id) {
      memo = m;
      break;
    }
  }
  if (!memo) return { bet: null, reason: "no PREDICTBET memo for this market" };
  if (!market.outcomes.includes(memo.outcome)) return { bet: null, reason: "unknown outcome" };
  const paid = outputs
    .filter((o) => o.scriptHex.toLowerCase() === poolScriptHex.toLowerCase())
    .reduce((s, o) => s + o.sats, 0);
  if (paid < PREDICT_MIN_BET_SATS) return { bet: null, reason: `pool payment ${paid} below min ${PREDICT_MIN_BET_SATS}` };
  const dup = await db("predict_bets").where({ txid: txid.toLowerCase() }).first();
  if (dup) return { bet: null, reason: "already credited" };
  const bet = await recordBet(db, {
    market_id: market.id,
    origin: `remote:${memo.payout.slice(0, 12)}`,
    payout_address: memo.payout,
    outcome: memo.outcome,
    sats: paid,
    txid: txid.toLowerCase(),
  }, now);
  return { bet };
}

export function newMarketId(): string {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "pm_";
  for (let i = 0; i < 10; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

export function validateMarket(raw: {
  question?: unknown; outcomes?: unknown; closesIn?: unknown; closesAt?: unknown;
  evidence?: unknown; feeBps?: unknown; disputeHours?: unknown;
}, now = Date.now()): { question: string; outcomes: string[]; closes_at: number; evidence: string; fee_bps: number; dispute_hours: number } {
  const question = String(raw.question ?? "").trim().slice(0, 280);
  if (question.length < 10) fail("BAD_PARAM", "question needs at least 10 characters");
  const outcomes = (Array.isArray(raw.outcomes) ? raw.outcomes : [])
    .map((o) => String(o ?? "").trim().slice(0, 80))
    .filter(Boolean);
  if (outcomes.length < PREDICT_MIN_OUTCOMES || outcomes.length > PREDICT_MAX_OUTCOMES) {
    fail("BAD_PARAM", `need ${PREDICT_MIN_OUTCOMES}-${PREDICT_MAX_OUTCOMES} outcomes`);
  }
  if (new Set(outcomes).size !== outcomes.length) fail("BAD_PARAM", "outcomes must be unique");
  let closes_at = 0;
  if (raw.closesAt !== undefined) {
    closes_at = Math.floor(Number(raw.closesAt) || 0);
  } else if (raw.closesIn !== undefined) {
    closes_at = now + parseDurationMs(String(raw.closesIn));
  }
  if (!(closes_at > now + 60_000)) fail("BAD_PARAM", "close must be at least a minute out");
  if (closes_at > now + 400 * 864e5) fail("BAD_PARAM", "close too far out (max ~400d)");
  const evidence = String(raw.evidence ?? "").trim().slice(0, 500);
  if (!evidence) fail("BAD_PARAM", "resolution evidence rule required (what decides this?)");
  const fee_bps = raw.feeBps === undefined ? PREDICT_FEE_BPS_DEFAULT : Math.floor(Number(raw.feeBps));
  if (!(fee_bps >= 0 && fee_bps <= 1000)) fail("BAD_PARAM", "feeBps 0-1000");
  const dispute_hours = raw.disputeHours === undefined
    ? PREDICT_DISPUTE_HOURS_DEFAULT
    : Math.floor(Number(raw.disputeHours));
  if (!(dispute_hours >= 1 && dispute_hours <= 168)) fail("BAD_PARAM", "disputeHours 1-168");
  return { question, outcomes, closes_at, evidence, fee_bps, dispute_hours };
}

export function parseDurationMs(s: string): number {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w|s)?$/i);
  if (!m) fail("BAD_PARAM", `bad duration ${JSON.stringify(s)} (e.g. 30m, 6h, 7d)`);
  const n = parseFloat(m[1]);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]?.toLowerCase() ?? "m"] ?? 60_000;
  return Math.floor(n * mult);
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export interface Payout { payout_address: string; sats: number; origin: string; outcome: string; bet_sats: number }

/**
 * Parimutuel split, integer sats, every sat accounted. Winners share
 * (total - fee - settleBudget) proportional to stake; the largest winner
 * absorbs the floor remainder. Losers get nothing (use settleVoid for
 * refunds).
 */
export function splitPool(bets: Pick<Bet, "payout_address" | "outcome" | "sats" | "origin">[], winningOutcome: string, feeBps: number): { payouts: Payout[]; fee: number; total: number } {
  const total = bets.reduce((s, b) => s + b.sats, 0);
  const fee = Math.floor((total * feeBps) / 10000);
  const winners = bets.filter((b) => b.outcome === winningOutcome);
  const winPool = winners.reduce((s, b) => s + b.sats, 0);
  if (winners.length === 0 || winPool <= 0) return { payouts: [], fee, total };
  const perWinner = new Map<string, { sats: number; bet: number; origin: string; outcome: string }>();
  for (const w of winners) {
    const k = `${w.payout_address}`;
    const cur = perWinner.get(k) ?? { sats: 0, bet: 0, origin: w.origin, outcome: w.outcome };
    cur.sats += 0;
    cur.bet += w.sats;
    perWinner.set(k, cur);
  }
  const distributable = total - fee - settleBudget(perWinner.size);
  const payouts: Payout[] = [];
  let assigned = 0;
  for (const [addr, v] of perWinner) {
    const share = Math.floor((v.bet * distributable) / winPool);
    payouts.push({ payout_address: addr, sats: share, origin: v.origin, outcome: v.outcome, bet_sats: v.bet });
    assigned += share;
  }
  // Largest-remainder: biggest winner absorbs the floor dust.
  payouts.sort((a, b) => b.bet_sats - a.bet_sats);
  if (payouts.length > 0) payouts[0].sats += distributable - assigned;
  return { payouts, fee, total };
}

/** Fee budget reserved from the pool for the settlement tx itself. */
export function settleBudget(nOutputs: number): number {
  return PREDICT_SETTLE_BASE_SATS + PREDICT_SETTLE_PER_OUTPUT_SATS * Math.max(0, nOutputs);
}

/** Full refunds, no fee. One entry per bet (caller may merge). */
export function splitVoid(bets: Pick<Bet, "payout_address" | "sats">[]): { payout_address: string; sats: number }[] {
  return bets.map((b) => ({ payout_address: b.payout_address, sats: b.sats }));
}

/** Implied probability per outcome = pool share. Empty pools = evenly split. */
export function impliedOdds(bets: Pick<Bet, "outcome" | "sats">[], outcomes: string[]): Record<string, number> {
  const total = bets.reduce((s, b) => s + b.sats, 0);
  const out: Record<string, number> = {};
  for (const o of outcomes) {
    const pool = bets.filter((b) => b.outcome === o).reduce((s, b) => s + b.sats, 0);
    out[o] = total > 0 ? pool / total : 1 / outcomes.length;
  }
  return out;
}

export function winnerFromChoice(choice: string | undefined | null, outcomes: string[]): string | null {
  if (!choice) return null;
  return outcomes.includes(choice) ? choice : null;
}

/** True while a resolved market still accepts its one dispute round. */
export function disputeWindowOpen(resolvedAtMs: number, disputeHours: number, now = Date.now()): boolean {
  return now < resolvedAtMs + disputeHours * 3_600_000;
}

export interface MarketView extends Market {
  pools: Record<string, number>;
  total: number;
  bettors: number;
  odds: Record<string, number>;
  state: MarketStatus | "closed-awaiting-resolve";
}

function rowToMarket(r: Record<string, unknown>): Market {
  return {
    id: String(r.id),
    question: String(r.question),
    outcomes: JSON.parse(String(r.outcomes)) as string[],
    closes_at: Number(r.closes_at),
    evidence: String(r.evidence ?? ""),
    status: String(r.status) as MarketStatus,
    fee_bps: Number(r.fee_bps),
    dispute_hours: Number(r.dispute_hours),
    creator_origin: String(r.creator_origin ?? ""),
    created_at: Number(r.created_at),
    winning_outcome: (r.winning_outcome as string | null) ?? null,
    verdict_confidence: (r.verdict_confidence as number | null) ?? null,
    dispute_by: (r.dispute_by as string | null) ?? null,
    dispute_why: (r.dispute_why as string | null) ?? null,
    settle_txid: (r.settle_txid as string | null) ?? null,
    resolved_at: (r.resolved_at as number | null) ?? null,
  };
}

export async function createMarket(
  db: Knex,
  createBasket: (db: Knex, name: string, description?: string) => Promise<unknown>,
  input: {
    question: string; outcomes: string[]; closes_at: number; evidence: string;
    fee_bps: number; dispute_hours: number; creator_origin: string;
  },
  now = Date.now(),
): Promise<Market> {
  const id = newMarketId();
  await db("predict_markets").insert({
    id,
    question: input.question,
    outcomes: JSON.stringify(input.outcomes),
    closes_at: input.closes_at,
    evidence: input.evidence,
    status: "open",
    fee_bps: input.fee_bps,
    dispute_hours: input.dispute_hours,
    creator_origin: input.creator_origin,
    created_at: now,
  });
  await createBasket(db, marketBasket(id), `prediction market: ${input.question.slice(0, 60)}`);
  const row = await db("predict_markets").where({ id }).first();
  return rowToMarket(row as Record<string, unknown>);
}

export async function getMarket(db: Knex, id: string): Promise<Market | null> {
  const row = await db("predict_markets").where({ id }).first();
  return row ? rowToMarket(row as Record<string, unknown>) : null;
}

export async function getBets(db: Knex, marketId: string): Promise<Bet[]> {
  return (await db("predict_bets").where({ market_id: marketId }).orderBy("id")) as Bet[];
}

export async function marketView(db: Knex, id: string): Promise<MarketView | null> {
  const m = await getMarket(db, id);
  if (!m) return null;
  const bets = await getBets(db, id);
  const pools: Record<string, number> = {};
  for (const o of m.outcomes) pools[o] = 0;
  const bettors = new Set<string>();
  for (const b of bets) {
    pools[b.outcome] = (pools[b.outcome] ?? 0) + b.sats;
    bettors.add(b.origin);
  }
  const total = Object.values(pools).reduce((s, v) => s + v, 0);
  return {
    ...m,
    pools,
    total,
    bettors: bettors.size,
    odds: impliedOdds(bets, m.outcomes),
    state: m.status === "open" && Date.now() > m.closes_at ? "closed-awaiting-resolve" : m.status,
  };
}

export async function listMarkets(db: Knex, status?: string): Promise<MarketView[]> {
  const rows = await db("predict_markets").orderBy("created_at", "desc").limit(50);
  const out: MarketView[] = [];
  for (const r of rows) {
    const v = await marketView(db, String((r as Record<string, unknown>).id));
    if (v && (!status || v.status === status)) out.push(v);
  }
  return out;
}

/** Close past-due opens. Returns true if it flipped. */
export async function lockIfPastClose(db: Knex, m: Market, now = Date.now()): Promise<Market> {
  if (m.status === "open" && now > m.closes_at) {
    await db("predict_markets").where({ id: m.id }).update({ status: "locked" });
    return { ...m, status: "locked" };
  }
  return m;
}

export async function recordBet(
  db: Knex,
  input: { market_id: string; origin: string; payout_address: string; outcome: string; sats: number; txid: string },
  now = Date.now(),
): Promise<Bet> {
  const [id] = await db("predict_bets").insert({
    market_id: input.market_id,
    origin: input.origin,
    payout_address: input.payout_address,
    outcome: input.outcome,
    sats: input.sats,
    txid: input.txid,
    created_at: now,
  });
  const row = await db("predict_bets").where({ id }).first();
  return row as Bet;
}

export interface Verdict { winner: string | null; confidence: number; forced?: boolean }

export type JevChoiceFn = (
  state: unknown,
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>,
) => Promise<{ answers: { outcome?: { choice?: string; confidence?: number } } }>;

/** Grade the evidence with a Jev choice question. Null winner = void. */
export async function gradeEvidence(
  jevChoice: JevChoiceFn,
  market: Pick<Market, "question" | "outcomes" | "evidence">,
  extraEvidence?: string,
): Promise<Verdict> {
  const criteria: Record<string, string> = {};
  for (const o of market.outcomes) criteria[o] = o;
  const state = [
    `Prediction market question: ${market.question}`,
    `Resolution rule: ${market.evidence}`,
    extraEvidence ? `Additional evidence: ${extraEvidence}` : "",
  ].filter(Boolean).join("\n");
  const r = await jevChoice(state, {
    outcome: { type: "choice", instructions: "Given the resolution rule and evidence, which outcome occurred?", criteria },
  });
  const choice = r.answers?.outcome?.choice ?? null;
  const confidence = Number(r.answers?.outcome?.confidence ?? 0);
  const winner = choice && market.outcomes.includes(choice) && confidence >= PREDICT_CONF_THRESHOLD ? choice : null;
  return { winner, confidence };
}

export async function recordVerdict(
  db: Knex,
  marketId: string,
  verdict: Verdict,
  now = Date.now(),
): Promise<Market> {
  await db("predict_markets").where({ id: marketId }).update({
    status: verdict.winner ? "resolving" : "void",
    winning_outcome: verdict.winner,
    verdict_confidence: verdict.confidence,
    resolved_at: now,
  });
  const m = await getMarket(db, marketId);
  if (!m) fail("NOT_FOUND", "market vanished");
  return m as Market;
}

export async function recordDispute(  db: Knex,
  marketId: string,
  input: { by: string; winningOutcome: string; why: string },
  now = Date.now(),
): Promise<Market> {
  const m = await getMarket(db, marketId);
  if (!m) fail("NOT_FOUND", `no market ${marketId}`);
  const market = m as Market;
  if (market.status !== "resolving" || !market.winning_outcome || !market.resolved_at) {
    fail("BAD_STATE", "market is not awaiting settlement (no open verdict to dispute)");
  }
  if (!disputeWindowOpen(market.resolved_at, market.dispute_hours, now)) {
    fail("BAD_STATE", "dispute window closed");
  }
  if (market.dispute_by) fail("BAD_STATE", "dispute round already used");
  if (!market.outcomes.includes(input.winningOutcome)) fail("BAD_PARAM", "unknown outcome");
  if (input.winningOutcome === market.winning_outcome) fail("BAD_PARAM", "dispute must name a different winner");
  if (input.why.trim().length < 10) fail("BAD_PARAM", "dispute needs evidence (10+ chars)");
  await db("predict_markets").where({ id: marketId }).update({
    status: "disputed",
    dispute_by: input.by,
    dispute_why: input.why.slice(0, 500),
  });
  return (await getMarket(db, marketId)) as Market;
}

export async function recordSettlement(db: Knex, marketId: string, txid: string | null, status: "settled" | "void"): Promise<void> {
  await db("predict_markets").where({ id: marketId }).update({ status, settle_txid: txid });
}

export async function positionsFor(db: Knex, origin: string): Promise<{ market: MarketView; staked: number; on: Record<string, number> }[]> {
  const bets = (await db("predict_bets").where({ origin }).orderBy("created_at", "desc").limit(200)) as Bet[];
  const byMarket = new Map<string, Bet[]>();
  for (const b of bets) {
    const arr = byMarket.get(b.market_id) ?? [];
    arr.push(b);
    byMarket.set(b.market_id, arr);
  }
  const out = [];
  for (const [mid, ms] of byMarket) {
    const v = await marketView(db, mid);
    if (!v) continue;
    const on: Record<string, number> = {};
    for (const b of ms) on[b.outcome] = (on[b.outcome] ?? 0) + b.sats;
    out.push({ market: v, staked: ms.reduce((s, b) => s + b.sats, 0), on });
  }
  return out;
}
