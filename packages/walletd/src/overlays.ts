/**
 * F11 overlay explorer v1: see and tag, submit later over the wire.
 *
 * Live-overlay reality (probed 2026-09): the SDK's SHIP/lookup/submit
 * routes are undeployed on every public host — only the BSV21
 * token-scoped REST on api.1sat.app answers. So v1 is honest about what
 * exists:
 * - registry: known overlays with live health checks (degraded ones say so),
 * - topics: BSV21 per-token topics (tm_<tokenId>) resolved live,
 * - lookup: per-topic unspent/history reads (no keys),
 * - submit: policy-scoped TAGGING of our own tracked transactions
 *   (ownership = the policy: only txs we broadcast). When overlay submit
 *   endpoints deploy, tagged rows are exactly the push queue.
 */
import type { Knex } from "knex";

export const ONESAT = "https://api.1sat.app";

export interface OverlayInfo {
  id: string;
  name: string;
  base: string;
  kind: string;
  description: string;
  live: boolean;
  latencyMs: number;
}

export interface TopicInfo {
  topic: string;
  tokenId: string | null;
  symbol: string | null;
}

export interface LookupResult {
  topic: string;
  address: string | null;
  what: string;
  rows: Array<Record<string, unknown>>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

async function aget(fetchFn: FetchFn, url: string, timeoutMs = 20000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
  } finally {
    clearTimeout(t);
  }
}

export const KNOWN_OVERLAYS: Array<Omit<OverlayInfo, "live" | "latencyMs">> = [
  {
    id: "bsv21",
    name: "BSV21 Tokens",
    base: "https://api.1sat.app",
    kind: "token-overlay",
    description: "Fungible token index: registry, balances, unspent, history per token.",
  },
  {
    id: "ordfs",
    name: "OrdFS",
    base: "https://api.1sat.app",
    kind: "content-overlay",
    description: "Inscription content + metadata (ORDFS).",
  },
  {
    id: "sigma",
    name: "Sigma BAP",
    base: "https://sigma.1sat.app",
    kind: "identity-overlay",
    description: "BAP identity/social index (currently unresponsive).",
  },
];

/** Liveness probe per overlay (timeout counts as down, never throws). */
export async function overlayHealth(
  opts: { fetchFn?: FetchFn } = {},
): Promise<OverlayInfo[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const probes: Array<{ info: (typeof KNOWN_OVERLAYS)[number]; url: string }> = [
    { info: KNOWN_OVERLAYS[0]!, url: `${KNOWN_OVERLAYS[0]!.base}/1sat/chaintracks/height` },
    { info: KNOWN_OVERLAYS[1]!, url: `${KNOWN_OVERLAYS[1]!.base}/1sat/chaintracks/height` },
    { info: KNOWN_OVERLAYS[2]!, url: `${KNOWN_OVERLAYS[2]!.base}/` },
  ];
  return Promise.all(
    probes.map(async ({ info, url }) => {
      const start = Date.now();
      try {
        const res = await aget(fetchFn, url, 12000);
        const body = await res.text().catch(() => "");
        const live = res.ok && body.trim().length > 0;
        return { ...info, live, latencyMs: live ? Date.now() - start : -1 };
      } catch {
        return { ...info, live: false, latencyMs: -1 };
      }
    }),
  );
}

/** BSV21 token registry (for tm_<tokenId> topic discovery). */
export async function tokenRegistry(
  opts: { fetchFn?: FetchFn; base?: string; limit?: number } = {},
): Promise<Array<{ tokenId: string; symbol: string; decimals: number }>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? ONESAT;
  const res = await aget(fetchFn, `${base}/1sat/bsv21/tokens`);
  if (!res.ok) fail("RAILS", `token registry failed (${res.status})`);
  const list = (await res.json()) as Array<{ token_id?: unknown; symbol?: unknown; decimals?: unknown }>;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (typeof t.token_id !== "string" || !t.token_id) continue;
    out.push({
      tokenId: t.token_id,
      symbol: typeof t.symbol === "string" && t.symbol ? t.symbol : t.token_id.slice(0, 12),
      decimals: Math.floor(Number(t.decimals) || 0),
    });
    if (out.length >= (opts.limit ?? 200)) break;
  }
  return out;
}

/** Topics: tm_<tokenId> per listed token (+ the two meta topics). */
export async function overlayTopics(opts: { fetchFn?: FetchFn; base?: string } = {}): Promise<TopicInfo[]> {
  const tokens = await tokenRegistry(opts).catch(() => []);
  return [
    { topic: "bsv21 tokens", tokenId: null, symbol: null },
    { topic: "ordfs content", tokenId: null, symbol: null },
    ...tokens.map((t) => ({ topic: `tm_${t.tokenId}`, tokenId: t.tokenId, symbol: t.symbol })),
  ];
}

function lockTypeFor(): string {
  return "ordlock";
}

/**
 * Topic lookup. tm_<tokenId> reads unspent/history for an address (or the
 * token's global unspent set); anything else is rejected with the topic
 * list hint instead of an empty lie.
 */
export async function overlayLookup(
  topic: string,
  opts: { fetchFn?: FetchFn; base?: string; address?: string; what?: string } = {},
): Promise<LookupResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? ONESAT;
  const what = opts.what === "history" ? "history" : "unspent";
  const m = /^tm_([0-9a-fA-F]{64}_\d+)$/.exec((topic ?? "").trim());
  if (!m) fail("BAD_TOPIC", "topics look like tm_<tokenId> — see `bsv overlay topics`");
  const tokenId = m[1]!;
  let url: string;
  if (opts.address) {
    url = `${base}/1sat/bsv21/${encodeURIComponent(tokenId)}/${lockTypeFor()}/${encodeURIComponent(opts.address)}/${what}`;
  } else {
    fail("BAD_PARAM", "address required for topic lookup (global unspent is unindexed)");
  }
  const res = await aget(fetchFn, url);
  if (!res.ok) fail("RAILS", `topic lookup failed (${res.status})`);
  const data = await res.json().catch(() => null);
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  return { topic, address: opts.address ?? null, what, rows: rows as Array<Record<string, unknown>> };
}

export async function migrateOverlays(db: Knex): Promise<void> {
  if (await db.schema.hasTable("overlay_tags")) return;
  await db.schema.createTable("overlay_tags", (t) => {
    t.increments("id");
    t.string("txid", 64).notNullable();
    t.string("topic", 200).notNullable();
    t.integer("created_at").notNullable();
    t.unique(["txid", "topic"]);
  });
}

/**
 * Tag one of OUR tracked transactions with overlay topics. Ownership is
 * the policy: unknown txids refuse (nothing to tag, nothing to leak).
 */
export async function tagTransaction(
  db: Knex,
  txid: string,
  topics: string[],
): Promise<{ txid: string; topics: string[] }> {
  if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) fail("BAD_PARAM", "txid must be 64 hex chars");
  const clean = [...new Set(
    topics.filter((t): t is string => typeof t === "string" && t.trim().length > 0 && t.length <= 200)
      .map((t) => t.trim()),
  )];
  if (clean.length === 0) fail("BAD_PARAM", "at least one topic required");
  if (clean.length > 10) fail("BAD_PARAM", "at most 10 topics per tx");
  const known = await db("pending_txs").where({ txid: txid.toLowerCase() }).first();
  if (!known) fail("NOT_OURS", "only tracked (ours) transactions can be tagged");
  const now = Date.now();
  for (const topic of clean) {
    await db("overlay_tags")
      .insert({ txid: txid.toLowerCase(), topic, created_at: now })
      .onConflict(["txid", "topic"])
      .ignore();
  }
  return { txid: txid.toLowerCase(), topics: clean };
}

export async function tagsFor(db: Knex, txid: string): Promise<string[]> {
  const rows = (await db("overlay_tags").select("topic").where({ txid: txid.toLowerCase() }).orderBy("topic")) as Array<{
    topic: string;
  }>;
  return rows.map((r) => r.topic);
}
