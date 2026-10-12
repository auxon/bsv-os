/**
 * Hybrid recall (P2): L1 hot cache + L2 tier rows + legacy board, ranked by
 * keyword + cosine, then the usenet group when depth asks for it.
 *
 * Visibility rules (load-bearing):
 * - Public tier rows: plaintext, full ranking, stored vectors when present.
 * - Private/shared rows: decrypted only via the injected `decrypt` (owner
 *   path wires pgpDecryptSelf). Locked or undecryptable rows are SKIPPED and
 *   counted (lockedSkipped) — never served, never leaked into scores.
 * - Seller scope (`scope: "seller"`, the x402 path) serves PUBLIC tier rows
 *   only. Private tiers are structurally unsellable; legacy board behavior
 *   is unchanged.
 * - Tombstones strike tier rows by content hash (forget posts carry
 *   sha256: refs), same as the board path strikes by post id.
 * - Every served hit backfills L1. Vectors are never fabricated: cosine runs
 *   only over stored vectors (public) or freshly embedded text (decrypted
 *   candidates when semantic is on and an embedder resolves).
 */
import type { Knex } from "knex";
import {
  MEMORY_BOARD, USENET_BASE, USENET_GROUP, cleanTag, isForgetRefs, isMemoryRefs, keywordScore,
  mergeUsenetHits, recallFromPosts, refHash,
  type MemoryHit,
} from "./memory.ts";
import { cosine } from "./memoryTiers.ts";
import { hotList, hotPut } from "./memoryWrite.ts";
import { getBoard, getPosts } from "./boards.ts";
import { lazyLocalEmbedder, workersAiEmbedder, type Embedder } from "./embed.ts";
import { dataDir } from "./storage.ts";
import fs from "node:fs";
import path from "node:path";

export type RecallDepth = "hot" | "local" | "all";
export type RecallScope = "owner" | "seller";

export interface HybridOpts {
  query?: string;
  tag?: string;
  limit?: number;
  includePublic?: boolean;
  depth?: RecallDepth | string;
  semantic?: boolean;
  scope?: RecallScope;
}

export interface HybridDeps {
  fetchFn: typeof fetch;
  embedder?: Embedder | null | "auto";
  decrypt?: (armored: string) => Promise<string | null>;
}

export interface HybridResult {
  board: string;
  hits: MemoryHit[];
  usenet: boolean;
  depth: RecallDepth;
  semantic: boolean;
  lockedSkipped: number;
  degraded?: boolean;
  note?: string;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function parseDepth(raw: unknown): RecallDepth {
  if (raw === undefined || raw === null || raw === "") return "local";
  if (raw === "hot" || raw === "local" || raw === "all") return raw;
  fail("BAD_PARAM", "depth must be hot, local, or all (cold/chain land in P3/P4)");
  throw new Error("unreachable");
}

function localModelCached(): boolean {
  try {
    return fs.existsSync(path.join(dataDir(), "models", "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx"));
  } catch {
    return false;
  }
}

/** Resolve an embedder: explicit > Workers AI (env) > cached local model. */
export function resolveEmbedder(explicit?: Embedder | null | "auto"): Embedder | null {
  if (explicit && explicit !== "auto") return explicit;
  if (explicit === null) return null;
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (accountId && token) return workersAiEmbedder({ accountId, token });
  if (localModelCached()) return lazyLocalEmbedder({});
  return null;
}

interface Candidate {
  hash: string;
  text: string;
  tag: string;
  ts: number;
  from: string;
  ref: string;
  backend: MemoryHit["backend"];
  id: string;
  visibility: "public" | "private" | "shared";
  storedVec: Float32Array | null;
}

export async function hybridRecall(db: Knex, deps: HybridDeps, rawOpts: HybridOpts = {}): Promise<HybridResult> {
  const depth = parseDepth(rawOpts.depth);
  const limit = Math.max(1, Math.min(100, Math.floor(Number(rawOpts.limit) || 20)));
  const tag = cleanTag(rawOpts.tag ?? "");
  const query = typeof rawOpts.query === "string" ? rawOpts.query.trim().slice(0, 500) : "";
  const scope: RecallScope = rawOpts.scope === "seller" ? "seller" : "owner";
  const wantUsenet = depth === "all" || rawOpts.includePublic === true;

  let semantic = false;
  let note: string | undefined;
  let queryVec: Float32Array | null = null;
  if (rawOpts.semantic === true || (rawOpts.semantic !== false && query)) {
    const embedder = resolveEmbedder(deps.embedder);
    if (embedder && query) {
      try {
        [queryVec] = await embedder.embed([query]);
        semantic = true;
      } catch (e) {
        note = `semantic recall unavailable (${e instanceof Error ? e.message.slice(0, 120) : "embedder failed"}) — keyword only`;
      }
    } else if (rawOpts.semantic === true) {
      note = "semantic recall unavailable (no embedder: set CLOUDFLARE_* env or run one semantic recall to fetch the local model) — keyword only";
    }
  }

  // L1 hot cache (plaintext by construction — only served hits are cached).
  const now = Date.now();
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const h of hotList(now)) {
    if (tag && h.tag !== tag) continue;
    seen.add(h.hash);
    candidates.push({ hash: h.hash, text: h.text, tag: h.tag, ts: h.at, from: "", ref: `hot:${h.hash}`, backend: "tiers", id: h.hash, visibility: h.visibility, storedVec: null });
  }

  let lockedSkipped = 0;
  if (depth !== "hot") {
    // Board posts: legacy hits + tombstone hashes for tier rows. Tier rows
    // enumerate first so shared content collapses to the richer tier hit.
    const row = await getBoard(db, MEMORY_BOARD);
    const known = row ? await getPosts(db, MEMORY_BOARD, { limit: 500, markRead: false }) : { posts: [] };
    const struckHashes = new Set<string>();
    for (const post of known.posts) {
      if (isForgetRefs(post.refs)) {
        const h = refHash(post.refs);
        if (h) struckHashes.add(h);
      }
    }

    // L2 tier rows.
    let q = db("memory_items").select();
    if (tag) q = q.where({ tag });
    const rows = (await q.orderBy("ts", "desc").limit(500)) as Array<{
      hash: string; visibility: string; tag: string; ts: number; from_fp: string;
      author: string; payload: string; pin: number;
    }>;
    const decrypt = deps.decrypt;
    for (const r of rows) {
      if (seen.has(r.hash) || struckHashes.has(r.hash)) continue;
      if (scope === "seller" && r.visibility !== "public") {
        lockedSkipped++;
        continue;
      }
      let text: string | null = null;
      if (r.visibility === "public") {
        text = r.payload;
      } else if (decrypt) {
        try {
          text = await decrypt(r.payload);
        } catch {
          text = null;
        }
        if (!text) {
          lockedSkipped++;
          continue;
        }
      } else {
        lockedSkipped++;
        continue;
      }
      seen.add(r.hash);
      let storedVec: Float32Array | null = null;
      if (semantic && r.visibility === "public") {
        const vrow = (await db("memory_vectors").where({ hash: r.hash }).first()) as
          | { vec: Uint8Array; dims: number }
          | undefined;
        if (vrow && vrow.dims > 0) {
          const buf = Buffer.from(vrow.vec.buffer, vrow.vec.byteOffset, vrow.dims * 4);
          storedVec = new Float32Array(vrow.dims);
          for (let i = 0; i < vrow.dims; i++) storedVec[i] = buf.readFloatLE(i * 4);
        }
      }
      candidates.push({
        hash: r.hash, text, tag: r.tag, ts: r.ts, from: r.author || r.from_fp,
        ref: `tiers:${r.hash}`, backend: "tiers", id: r.hash,
        visibility: r.visibility === "public" ? "public" : r.visibility === "shared" ? "shared" : "private",
        storedVec,
      });
    }

    // Legacy board last: shared content already collapsed to tier hits above.
    const legacy = recallFromPosts(
      known.posts.map((x) => ({ id: x.id, text: x.text, refs: x.refs, replyTo: x.replyTo, ts: x.ts, from: x.from, locked: x.locked })),
      { ...(query ? { query } : {}), ...(tag ? { tag } : {}), limit: 500 },
    );
    for (const hit of legacy) {
      if (seen.has(hit.hash)) continue;
      seen.add(hit.hash);
      candidates.push({
        hash: hit.hash, text: hit.text, tag: hit.tag, ts: hit.ts, from: hit.from,
        ref: hit.ref, backend: "board", id: hit.id, visibility: "private", storedVec: null,
      });
    }
  }

  // Rank: keyword always; cosine when semantic. Empty query = recency.
  let maxKw = 0;
  const scored = candidates.map((c) => {
    const kw = query ? keywordScore(`${c.text} ${c.tag}`, query) : 1;
    if (kw > maxKw) maxKw = kw;
    return { c, kw, cos: 0 };
  });
  if (semantic && queryVec) {
    // Embed-at-recall over plaintext (public text or decrypted candidates):
    // vectors are used for this ranking only, never stored (P2 rule).
    const emb = resolveEmbedder(deps.embedder);
    for (const s of scored) {
      if (s.c.storedVec) {
        s.cos = cosine(queryVec, s.c.storedVec);
      } else if (emb) {
        try {
          const [v] = await emb.embed([s.c.text]);
          if (v) s.cos = cosine(queryVec, v);
        } catch {
          /* per-candidate failure degrades to keyword */
        }
      }
    }
  }
  scored.sort((a, b) => {
    const sa = semantic ? 0.5 * (maxKw ? a.kw / maxKw : 0) + 0.5 * ((a.cos + 1) / 2) : a.kw;
    const sb = semantic ? 0.5 * (maxKw ? b.kw / maxKw : 0) + 0.5 * ((b.cos + 1) / 2) : b.kw;
    return sb - sa || b.c.ts - a.c.ts;
  });
  // A query with no keyword AND no cosine signal anywhere is noise, not
  // recall. The 0.5 rescue bar is a tunable: bge paraphrases land ~0.7,
  // unrelated pairs near zero — junk must clear it to surface on vectors.
  const ranked = scored.filter((s) => !query || s.kw > 0 || (semantic && s.cos > 0.5));
  const hits: MemoryHit[] = ranked.slice(0, limit).map((s) => ({
    id: s.c.id, text: s.c.text, tag: s.c.tag, hash: s.c.hash,
    backend: s.c.backend, ts: s.c.ts, from: s.c.from, ref: s.c.ref,
  }));
  for (const h of hits) {
    const cand = candidates.find((c) => c.hash === h.hash);
    hotPut({ hash: h.hash, text: h.text, tag: h.tag, visibility: cand?.visibility ?? "private", at: now });
  }

  // Usenet merge for depth all / includePublic (existing behavior + shape).
  if (wantUsenet) {
    const { mergeUsenetHits } = await import("./memory.ts");
    let articles: Array<{ id: string; body: string; subject: string; from: string; createdAt: number }> = [];
    let degraded = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await deps.fetchFn(`${USENET_BASE}/api/groups/${USENET_GROUP}/feed`, {
          headers: { accept: "application/json" }, signal: ctrl.signal,
        });
        if (res.ok) {
          const feed = (await res.json().catch(() => null)) as { articles?: Array<Record<string, unknown>> } | null;
          for (const a of feed?.articles ?? []) {
            if (typeof a.id !== "string") continue;
            let body = typeof a.body === "string" ? a.body : "";
            if (!body) {
              const full = await deps.fetchFn(`${USENET_BASE}/api/article/${a.id}`, {
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
    const merged = mergeUsenetHits(hits, articles, {
      ...(query ? { query } : {}), ...(tag ? { tag } : {}), limit,
    });
    for (const h of merged) {
      const cand = candidates.find((c) => c.hash === h.hash);
      hotPut({ hash: h.hash, text: h.text, tag: h.tag, visibility: cand?.visibility ?? "public", at: now });
    }
    return {
      board: MEMORY_BOARD, hits: merged, usenet: true, depth, semantic, lockedSkipped,
      ...(degraded ? { degraded: true } : {}), ...(note ? { note } : {}),
    };
  }
  return { board: MEMORY_BOARD, hits, usenet: false, depth, semantic, lockedSkipped, ...(note ? { note } : {}) };
}
