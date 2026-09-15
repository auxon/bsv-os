/**
 * F12 bounty board: paid micro-work as OS citizens (GigsFeed reference).
 *
 * Daemon model: the agentpay board is read keyless; the local gig row is
 * the source of truth for OUR side (tracked → claimed → submitted →
 * paid). Rails calls (claim/submit) need an agentpay agent key
 * (`AGENTPAY_KEY`, agp_…); without one the daemon records nothing and
 * returns the exact human step instead of pretending — same honesty as
 * policy denials. Paid earnings land in the `earnings` basket (F4) via
 * explicit outpoint labeling.
 *
 * No custody surface: payouts arrive at the wallet address on-chain; the
 * daemon never holds bounty keys.
 */
import type { Knex } from "knex";
import { assignUtxo, createBasket } from "./baskets.ts";

export const BOUNTY_BASE = "https://entangleit.com/api/agentpay";
export const EARNINGS_BASKET = "earnings";

export type GigStatus = "tracked" | "claimed" | "submitted" | "paid";

export interface BoardItem {
  id: string;
  title: string;
  description: string;
  category: string;
  amountSats: number;
  status: string;
  escrow: { state: number; workerPubKey: string; deadline: number } | null;
  acceptance: { kind: string; expectedHash: string; notes: string } | null;
}

export interface GigRow extends BoardItem {
  lifecycle: GigStatus;
  payoutTxid: string | null;
  payoutVout: number | null;
  updatedAt: number;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

async function jget(fetchFn: FetchFn, url: string, key?: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchFn(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      fail("RAILS", `bounty rails ${res.status}: ${detail}`);
    }
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(t);
  }
}

async function jpost(fetchFn: FetchFn, url: string, body: unknown, key?: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
    if (!res.ok) {
      fail("RAILS", `bounty rails ${res.status}: ${String(data.error ?? data.message ?? "").slice(0, 200)}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function cleanBoardItem(raw: unknown): BoardItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.title !== "string") return null;
  const esc = (r.escrow ?? {}) as Record<string, unknown>;
  const acc = (r.acceptance ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    title: String(r.title).slice(0, 120),
    description: typeof r.description === "string" ? r.description.slice(0, 2000) : "",
    category: typeof r.category === "string" ? r.category : "",
    amountSats: Math.floor(Number(r.amountSats) || 0),
    status: typeof r.status === "string" ? r.status : "?",
    escrow: {
      state: Math.floor(Number(esc.state) || 0),
      workerPubKey: typeof esc.workerPubKey === "string" ? esc.workerPubKey : "",
      deadline: Math.floor(Number(esc.deadline) || 0),
    },
    acceptance: {
      kind: typeof acc.kind === "string" ? acc.kind : "",
      expectedHash: typeof acc.expectedHash === "string" ? acc.expectedHash : "",
      notes: typeof acc.notes === "string" ? acc.notes.slice(0, 500) : "",
    },
  };
}

/** Live board (keyless). */
export async function boardList(
  opts: { fetchFn?: FetchFn; base?: string; category?: string; limit?: number } = {},
): Promise<BoardItem[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? BOUNTY_BASE;
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 25), 1), 50);
  const qs = new URLSearchParams({ status: "open", limit: String(limit) });
  if (opts.category) qs.set("category", opts.category);
  const data = (await jget(fetchFn, `${base}/bounties?${qs}`)) as { items?: unknown };
  const items = Array.isArray(data.items) ? data.items : [];
  return items.flatMap((raw) => {
    const b = cleanBoardItem(raw);
    return b ? [b] : [];
  });
}

export async function boardGet(
  id: string,
  opts: { fetchFn?: FetchFn; base?: string } = {},
): Promise<BoardItem> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? BOUNTY_BASE;
  if (!/^[\w-]{8,128}$/.test(id)) fail("BAD_PARAM", "bad bounty id");
  const b = cleanBoardItem(await jget(fetchFn, `${base}/bounties/${encodeURIComponent(id)}`));
  if (!b) fail("NOT_FOUND", `no bounty: ${id.slice(0, 16)}`);
  return b as BoardItem;
}

export async function migrateGigs(db: Knex): Promise<void> {
  if (await db.schema.hasTable("gigs")) return;
  await db.schema.createTable("gigs", (t) => {
    t.string("id", 128).primary();
    t.string("title", 120).notNullable().defaultTo("");
    t.integer("amount_sats").notNullable().defaultTo(0);
    t.string("status", 16).notNullable().defaultTo("tracked");
    t.text("escrow").nullable();
    t.string("payout_txid", 64).nullable();
    t.integer("payout_vout").nullable();
    t.integer("updated_at").notNullable();
  });
}

async function getGig(db: Knex, id: string) {
  return (await db("gigs").where({ id }).first()) as {
    id: string; title: string; amount_sats: number; status: string;
    escrow: string | null; payout_txid: string | null; payout_vout: number | null;
    updated_at: number;
  } | undefined;
}

export async function trackGig(
  db: Knex,
  item: BoardItem,
): Promise<{ id: string; lifecycle: GigStatus }> {
  const existing = await getGig(db, item.id);
  const now = Date.now();
  if (!existing) {
    await db("gigs").insert({
      id: item.id, title: item.title, amount_sats: item.amountSats,
      status: "tracked", escrow: JSON.stringify(item.escrow), updated_at: now,
    });
    return { id: item.id, lifecycle: "tracked" };
  }
  await db("gigs").where({ id: item.id }).update({
    title: item.title, amount_sats: item.amountSats,
    escrow: JSON.stringify(item.escrow), updated_at: now,
  });
  return { id: item.id, lifecycle: existing.status as GigStatus };
}

export async function listGigs(db: Knex): Promise<Array<{ id: string; title: string; amountSats: number; lifecycle: GigStatus; updatedAt: number }>> {
  const rows = (await db("gigs").select().orderBy("updated_at", "desc").limit(100)) as Array<{
    id: string; title: string; amount_sats: number; status: string; updated_at: number;
  }>;
  return rows.map((r) => ({ id: r.id, title: r.title, amountSats: r.amount_sats, lifecycle: r.status as GigStatus, updatedAt: r.updated_at }));
}

export async function untrackGig(db: Knex, id: string): Promise<{ id: string; removed: boolean }> {
  const n = await db("gigs").where({ id }).delete();
  if (!n) fail("NOT_FOUND", `not tracked: ${id.slice(0, 16)}`);
  return { id, removed: true };
}

export interface RailsOpts {
  fetchFn?: FetchFn;
  base?: string;
  key?: string;
  payoutAddress?: string;
  workerPubKey?: string;
}

function needKey(key?: string): string {
  if (typeof key === "string" && key.startsWith("agp_") && key.length > 8) return key;
  fail(
    "NO_KEY",
    "claiming runs through agentpay: export AGENTPAY_KEY=agp_… (or pass --key), then retry. The gig stays tracked meanwhile.",
  );
}

/** Claim on the rails (or a guided no-op when keyless). */
export async function claimGig(
  db: Knex,
  id: string,
  opts: RailsOpts = {},
): Promise<{ id: string; lifecycle: GigStatus; remote: unknown; guided?: string }> {
  const row = await getGig(db, id);
  if (!row) fail("NOT_FOUND", `track it first: bsv gig track ${id.slice(0, 16)}`);
  if ((row as { status: string }).status !== "tracked") {
    return { id, lifecycle: (row as { status: string }).status as GigStatus, remote: null };
  }
  const key = opts.key ?? process.env.AGENTPAY_KEY;
  if (!key) {
    return {
      id, lifecycle: "tracked", remote: null,
      guided: "export AGENTPAY_KEY=agp_… (agent key from your agentpay wallet), then: bsv gig claim " + id.slice(0, 16),
    };
  }
  needKey(key);
  const base = opts.base ?? BOUNTY_BASE;
  const fetchFn = opts.fetchFn ?? fetch;
  const body: Record<string, unknown> = {};
  if (opts.payoutAddress) body.payoutAddress = opts.payoutAddress;
  if (opts.workerPubKey) body.workerPubKey = opts.workerPubKey;
  const remote = await jpost(fetchFn, `${base}/bounties/${encodeURIComponent(id)}/claim`, body, key);
  await db("gigs").where({ id }).update({ status: "claimed", updated_at: Date.now() });
  return { id, lifecycle: "claimed", remote };
}

/** Submit work (requires a local claim first; keyless → guided). */
export async function submitGig(
  db: Knex,
  id: string,
  proof: { workHash?: string; workUri?: string; notes?: string },
  opts: RailsOpts = {},
): Promise<{ id: string; lifecycle: GigStatus; remote: unknown; guided?: string }> {
  const row = await getGig(db, id);
  if (!row) fail("NOT_FOUND", `track it first: bsv gig track ${id.slice(0, 16)}`);
  const st = (row as { status: string }).status;
  if (st !== "claimed") {
    if (st === "submitted" || st === "paid") return { id, lifecycle: st as GigStatus, remote: null };
    fail("BAD_STATE", `claim it first: bsv gig claim ${id.slice(0, 16)}`);
  }
  const key = opts.key ?? process.env.AGENTPAY_KEY;
  if (!key) {
    return {
      id, lifecycle: "claimed", remote: null,
      guided: "export AGENTPAY_KEY=agp_… then submit with --hash/--uri/--notes",
    };
  }
  needKey(key);
  const base = opts.base ?? BOUNTY_BASE;
  const fetchFn = opts.fetchFn ?? fetch;
  const remote = await jpost(fetchFn, `${base}/bounties/${encodeURIComponent(id)}/submit`, proof, key);
  await db("gigs").where({ id }).update({ status: "submitted", updated_at: Date.now() });
  return { id, lifecycle: "submitted", remote };
}

/**
 * Mark paid + label the payout UTXO into the `earnings` basket (F4).
 * The chain truth stays on-chain; this attributes it.
 */
export async function paidGig(
  db: Knex,
  id: string,
  txid: string,
  vout: number,
): Promise<{ id: string; lifecycle: GigStatus; basket: string }> {
  const row = await getGig(db, id);
  if (!row) fail("NOT_FOUND", `track it first: bsv gig track ${id.slice(0, 16)}`);
  if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) fail("BAD_PARAM", "txid must be 64 hex chars");
  const v = Math.floor(Number(vout));
  if (!Number.isInteger(v) || v < 0) fail("BAD_PARAM", "vout must be a non-negative integer");
  try {
    await createBasket(db, EARNINGS_BASKET, "Bounty and gig earnings");
  } catch (e) {
    if ((e as { code?: string }).code !== "EXISTS") throw e;
  }
  await assignUtxo(db, txid, v, EARNINGS_BASKET);
  await db("gigs").where({ id }).update({
    status: "paid", payout_txid: txid.toLowerCase(), payout_vout: v, updated_at: Date.now(),
  });
  return { id, lifecycle: "paid", basket: EARNINGS_BASKET };
}
