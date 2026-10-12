/**
 * Agent memory: private recall on a shared board, public recall on UsenetBSV.
 *
 * One shared board (`memory`, members mode, local truth) holds signed +
 * encrypted memory posts (kind `artifact`, refs `#memory` + content hash +
 * optional tag). Public memories are x402-paid UsenetBSV articles in the
 * `bsvos.memory` group, idempotent per content hash. Recall merges both
 * backends by hash. Forget is a tombstone post — boards are append-only, so
 * the mistake and the correction stay in the audit trail.
 *
 * No new tables: board posts live in `board_posts`, x402 settlements in
 * `x402_receipts`. This module is pure logic + view filtering; the RPC
 * layer owns boardPublish / x402Pay wiring.
 */
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { getBoard, getPosts } from "./boards.ts";

export const MEMORY_BOARD = "memory";
export const USENET_BASE = "https://entangleit.com/usenetbsv";
export const USENET_GROUP = "bsvos.memory";

export const MEMORY_TAG = "#memory";
export const MEMORY_FORGET_TAG = "#memory-forget";

const MAX_TEXT = 8 * 1024;

export interface MemoryHit {
  id: string;
  text: string;
  tag: string;
  hash: string;
  backend: "board" | "usenet" | "tiers";
  ts: number;
  from: string;
  ref: string;
}

interface MemoryPostView {
  id: string;
  text: string;
  refs: string[];
  replyTo: string;
  ts: number;
  from: string;
  locked: boolean;
}

/** Same cleaning as boards: strip controls, trim, cap at board max. */
export function normalizeMemoryText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\x00-]/g, " ").trim().slice(0, MAX_TEXT);
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function cleanTag(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const t = raw.trim().toLowerCase().slice(0, 32);
  return /^[a-z0-9][a-z0-9-]*$/.test(t) ? t : "";
}

/** Refs for a memory post: marker + content hash + optional tag. */
export function memoryRefs(hash: string, tag: string): string[] {
  const refs = [MEMORY_TAG, `sha256:${hash}`];
  if (tag) refs.push(`tag:${tag}`);
  return refs;
}

export function forgetRefs(hash: string): string[] {
  return [MEMORY_FORGET_TAG, `sha256:${hash}`];
}

export function refHash(refs: string[]): string {
  for (const r of refs) {
    const m = /^sha256:([0-9a-f]{64})$/.exec(r);
    if (m) return m[1]!;
  }
  return "";
}

export function refTag(refs: string[]): string {
  for (const r of refs) {
    const m = /^tag:([a-z0-9][a-z0-9-]*)$/.exec(r);
    if (m) return m[1]!;
  }
  return "";
}

export function isMemoryRefs(refs: string[]): boolean {
  return refs.includes(MEMORY_TAG);
}

export function isForgetRefs(refs: string[]): boolean {
  return refs.includes(MEMORY_FORGET_TAG);
}

/** Ids this view's tombstones strike (replyTo targets of forget posts). */
export function forgottenIds(posts: MemoryPostView[]): Set<string> {
  const out = new Set<string>();
  for (const p of posts) {
    if (isForgetRefs(p.refs) && p.replyTo) out.add(p.replyTo);
  }
  return out;
}

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

/** Keyword relevance exported for the tiered hybrid ranker (P2). */
export function keywordScore(text: string, query: string): number {
  return scoreText(text, tokens(query.trim()));
}

function scoreText(text: string, toks: string[]): number {
  if (!toks.length) return 1;
  const hay = text.toLowerCase();
  let score = 0;
  for (const t of toks) {
    if (hay.includes(t)) score += t.length >= 5 ? 2 : 1;
  }
  return score;
}

/**
 * Filter board views to live memories and rank by query. Locked posts
 * (ciphertext without the key) are skipped — they cannot be searched.
 */
export function recallFromPosts(
  posts: MemoryPostView[],
  opts: { query?: string; tag?: string; limit?: number } = {},
): MemoryHit[] {
  const tag = cleanTag(opts.tag ?? "");
  const toks = tokens((opts.query ?? "").trim());
  const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 20)));
  const struck = forgottenIds(posts);
  const hits: Array<MemoryHit & { score: number }> = [];
  for (const p of posts) {
    if (!isMemoryRefs(p.refs) || isForgetRefs(p.refs)) continue;
    if (p.locked || !p.text) continue;
    if (struck.has(p.id)) continue;
    const hash = refHash(p.refs);
    if (!hash) continue;
    const ptag = refTag(p.refs);
    if (tag && ptag !== tag) continue;
    const score = scoreText(`${p.text} ${ptag}`, toks);
    if (toks.length && score <= 0) continue;
    hits.push({
      id: p.id, text: p.text, tag: ptag, hash,
      backend: "board", ts: p.ts, from: p.from,
      ref: `board:${MEMORY_BOARD}:${p.id}`,
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return hits.slice(0, limit).map(({ score: _s, ...h }) => h);
}

/** Usenet article payload for a public memory (hash footer = idempotency key). */
export function usenetPayload(text: string, tag: string, hash: string): { subject: string; body: string } {
  const firstLine = text.split("\n")[0]!.trim().slice(0, 60) || "memory";
  const subject = tag ? `[memory:${tag}] ${firstLine}` : `[memory] ${firstLine}`;
  const footer = `\n\n— bsvOS memory sha256:${hash}${tag ? ` tag:${tag}` : ""}`;
  return { subject: subject.slice(0, 120), body: `${text}${footer}` };
}

export function parseUsenetBody(body: unknown): { hash: string; tag: string } {
  const text = typeof body === "string" ? body : "";
  const h = /sha256:([0-9a-f]{64})/.exec(text)?.[1] ?? "";
  const t = /tag:([a-z0-9][a-z0-9-]*)/.exec(text)?.[1] ?? "";
  return { hash: h, tag: cleanTag(t) };
}

/** Merge usenet articles into board hits, deduped by content hash. */export function mergeUsenetHits(
  board: MemoryHit[],
  articles: Array<{ id: string; body: string; subject: string; from: string; createdAt: number }>,
  opts: { query?: string; tag?: string; limit?: number } = {},
): MemoryHit[] {
  const tag = cleanTag(opts.tag ?? "");
  const toks = tokens((opts.query ?? "").trim());
  const seen = new Set(board.map((h) => h.hash));
  const extra: Array<MemoryHit & { score: number }> = [];
  for (const a of articles) {
    const { hash, tag: atag } = parseUsenetBody(a.body);
    if (!hash || seen.has(hash)) continue;
    if (tag && atag !== tag) continue;
    const text = String(a.body ?? "").replace(/\n\n— bsvOS memory sha256:[0-9a-f]{64}.*$/s, "").trim();
    if (!text) continue;
    const score = scoreText(`${text} ${atag} ${a.subject ?? ""}`, toks);
    if (toks.length && score <= 0) continue;
    seen.add(hash);
    extra.push({
      id: a.id, text, tag: atag, hash, backend: "usenet",
      ts: Math.floor(Number(a.createdAt) || 0), from: String(a.from ?? ""),
      ref: `usenet:${USENET_GROUP}:${a.id}`,
      score,
    });
  }
  extra.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 20)));
  return [...board, ...extra].slice(0, limit);
}

export interface RecallOpts {
  query?: string;
  tag?: string;
  limit?: number;
  includePublic?: boolean;
}

/**
 * Full recall: board fetch + optional usenet fetch + merge. Shared by the
 * owner RPC and the paid x402 seller path so buyers get exactly what the
 * owner gets (minus nothing — the price list, not the data, differs).
 */
export async function recallMemories(
  db: Knex,
  fetchFn: typeof fetch,
  opts: RecallOpts = {},
): Promise<{ board: string; hits: MemoryHit[]; usenet: boolean; degraded?: boolean }> {
  const row = await getBoard(db, MEMORY_BOARD);
  const known = row ? await getPosts(db, MEMORY_BOARD, { limit: 500, markRead: false }) : { posts: [] };
  const board = recallFromPosts(
    known.posts.map((x) => ({ id: x.id, text: x.text, refs: x.refs, replyTo: x.replyTo, ts: x.ts, from: x.from, locked: x.locked })),
    {
      ...(typeof opts.query === "string" ? { query: opts.query } : {}),
      ...(typeof opts.tag === "string" ? { tag: opts.tag } : {}),
      ...(Number.isFinite(Number(opts.limit)) ? { limit: Number(opts.limit) } : {}),
    },
  );
  if (opts.includePublic !== true) return { board: MEMORY_BOARD, hits: board, usenet: false };
  let articles: Array<{ id: string; body: string; subject: string; from: string; createdAt: number }> = [];
  let degraded = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetchFn(`${USENET_BASE}/api/groups/${USENET_GROUP}/feed`, {
        headers: { accept: "application/json" }, signal: ctrl.signal,
      });
      if (res.ok) {
        const feed = (await res.json().catch(() => null)) as { articles?: Array<Record<string, unknown>> } | null;
        for (const a of feed?.articles ?? []) {
          if (typeof a.id !== "string") continue;
          let body = typeof a.body === "string" ? a.body : "";
          if (!body) {
            const full = await fetchFn(`${USENET_BASE}/api/article/${a.id}`, {
              headers: { accept: "application/json" }, signal: ctrl.signal,
            }).then((r) => (r.ok ? r.json().catch(() => null) : null)).catch(() => null) as { body?: unknown } | null;
            if (typeof full?.body === "string") body = full.body;
          }
          if (!body) continue;
          articles.push({
            id: a.id, body,
            subject: typeof a.subject === "string" ? a.subject : "",
            from: typeof a.from === "string" ? a.from : "",
            createdAt: Math.floor(Number(a.createdAt) || 0),
          });
        }
      } else {
        degraded = true;
      }
    } finally {
      clearTimeout(t);
    }
  } catch {
    degraded = true;
  }
  const hits = mergeUsenetHits(board, articles, {
    ...(typeof opts.query === "string" ? { query: opts.query } : {}),
    ...(typeof opts.tag === "string" ? { tag: opts.tag } : {}),
    ...(Number.isFinite(Number(opts.limit)) ? { limit: Number(opts.limit) } : {}),
  });
  return { board: MEMORY_BOARD, hits, usenet: true, ...(degraded ? { degraded: true } : {}) };
}
