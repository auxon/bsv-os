/**
 * Tier job (P3): status, distillation, and the promotion shortlist.
 * Pure coordination — RPC owns board writes, custody owns keys.
 */
import type { Knex } from "knex";
import { promotionScore } from "./memoryTiers.ts";

export interface TiersStatus {
  l2: { items: number; byVisibility: Record<string, number>; vectors: number; tombstones: number; pins: number };
  devices: { total: number; unrevoked: number };
  promotions: { pending: number; top: Array<{ hash: string; score: number; pin: number }> };
  sync: Record<string, string>;
}

export async function tiersStatus(db: Knex, hotSize: number): Promise<TiersStatus & { l1: { size: number } }> {
  const items = (await db("memory_items").select("visibility", "pin")) as Array<{ visibility: string; pin: number }>;
  const byVisibility: Record<string, number> = {};
  let pins = 0;
  for (const r of items) {
    byVisibility[r.visibility] = (byVisibility[r.visibility] ?? 0) + 1;
    if (r.pin) pins++;
  }
  const vectors = Number(((await db("memory_vectors").count("* as n").first()) as { n?: number } | undefined)?.n ?? 0);
  const tombstones = Number(((await db("memory_tombstones").count("* as n").first()) as { n?: number } | undefined)?.n ?? 0);
  const devices = (await db("memory_devices").select("revoked_at")) as Array<{ revoked_at: number | null }>;
  const pending = (await db("memory_promotions").where({ status: "pending" }).select("hash")) as Array<{ hash: string }>;
  const syncRows = (await db("memory_sync_state").select()) as Array<{ key: string; value: string }>;
  const sync: Record<string, string> = {};
  for (const r of syncRows) sync[r.key] = r.value;

  const scored = (
    await db("memory_items").select("hash", "pin", "importance", "ts").orderBy("ts", "desc").limit(200)
  ) as Array<{ hash: string; pin: number; importance: number; ts: number }>;
  const now = Date.now();
  const top = scored
    .map((r) => ({ hash: r.hash, pin: r.pin ? 1 : 0, score: Math.round(promotionScore({ pin: r.pin ? 1 : 0, importance: r.importance, ts: r.ts }, now) * 10) / 10 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return {
    l1: { size: hotSize },
    l2: { items: items.length, byVisibility, vectors, tombstones, pins },
    devices: { total: devices.length, unrevoked: devices.filter((d) => d.revoked_at === null).length },
    promotions: { pending: pending.length, top },
    sync,
  };
}

export interface DistillInput {
  tag: string;
  maxItems?: number;
  minItems?: number;
  maxChars?: number;
}

export interface Distilled {
  title: string;
  summary: string;
  hashes: string[];
  count: number;
}

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

/**
 * Summarize one tag cluster into a single artifact. Never destroys: sources
 * stay, the summary links them. Plaintext sources only (public payloads or
 * caller-decrypted text) — ciphertext never reaches the model.
 */
export async function distillTag(
  db: Knex,
  input: DistillInput,
  read: (row: { hash: string; visibility: string; payload: string }) => Promise<string | null>,
  chat: (system: string, user: string) => Promise<{ title: string; summary: string }>,
): Promise<Distilled> {
  const tag = String(input.tag ?? "").trim().toLowerCase().slice(0, 32);
  if (!tag) fail("BAD_PARAM", "tag is required");
  const maxItems = Math.min(Math.max(1, Math.floor(Number(input.maxItems) || 20)), 50);
  const minItems = Math.min(Math.max(2, Math.floor(Number(input.minItems) || 3)), 10);
  const maxChars = Math.min(Math.max(1000, Math.floor(Number(input.maxChars) || 12000)), 30000);
  const rows = (await db("memory_items").where({ tag }).orderBy("ts", "desc").limit(maxItems)) as Array<{
    hash: string; visibility: string; payload: string; ts: number;
  }>;
  const texts: string[] = [];
  const hashes: string[] = [];
  let chars = 0;
  for (const r of rows) {
    const text = await read(r);
    if (!text || !text.trim()) continue;
    if (chars + text.length > maxChars) break;
    chars += text.length;
    texts.push(`[${r.hash.slice(0, 12)}] ${text.trim().slice(0, 2000)}`);
    hashes.push(r.hash);
  }
  if (hashes.length < minItems) {
    fail("TOO_FEW", `tag "${tag}" has ${hashes.length} readable memories (need ${minItems}) — nothing to distill`, 400);
  }
  const { title, summary } = await chat(
    "You condense related memories into one durable summary. Return ONLY JSON: {\"title\": \"short label\", \"summary\": \"plain-text synthesis, no markdown\"}. Never invent facts absent from the inputs.",
    `TAG: ${tag}\n\nMEMORIES:\n${texts.join("\n\n")}`,
  );
  if (!title?.trim() || !summary || summary.trim().length < 20) {
    fail("JUDGE_FAILED", "the summarizer returned an unusable summary", 502);
  }
  return { title: title.trim().slice(0, 120), summary: summary.trim().slice(0, 8000), hashes, count: hashes.length };
}

/** OpenRouter chat completions (JSON mode) for distillation. Key stays server-side. */
export async function openRouterChat(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<{ title: string; summary: string }> {
  if (!apiKey.trim()) fail("AI_NOT_CONFIGURED", "OPENROUTER_API_KEY is not set", 503);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey.trim()}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://localhost:2121/",
      "X-Title": "bsvOS memory distillation",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
    }),
  });
  const text = await res.text();
  if (!res.ok) fail("JUDGE_FAILED", `summarizer ${res.status}: ${text.slice(0, 160)}`, 502);
  try {
    const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "") as { title?: string; summary?: string };
    if (typeof parsed.title !== "string" || typeof parsed.summary !== "string") throw new Error("bad shape");
    return { title: parsed.title, summary: parsed.summary };
  } catch {
    fail("JUDGE_FAILED", "summarizer returned unparseable output", 502);
    throw new Error("unreachable");
  }
}
