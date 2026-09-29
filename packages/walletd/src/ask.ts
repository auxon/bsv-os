/**
 * AskAnything over wallet boards (bsvOS-wallet-only: no agentpay, no
 * escrow, no new custody). Conventions, also documented in SKILLS.md:
 *
 * - board: "askanything" (members board; the app auto-creates it empty).
 * - question: kind=request, text "<title>\n\n<details>", refs ["amount:<sats>"].
 * - answer: kind=result with replyTo=question id, refs ["payto:<address>"].
 * - accept: the asker pays amountSats to payTo through the existing
 *   spend/pay paths (human-confirmed, policy-gated). Custody never leaves
 *   the asker until they approve, which is what makes escrow unnecessary.
 *
 * Jev triage/grading is advisory and fail-open: any Jev failure returns
 * nulls and the flow proceeds without triage. One decide call per review.
 */
import type { Knex } from "knex";
import { createBoard, getBoard, getPosts } from "./boards.ts";
import type { JevDecide } from "./jev.ts";
import { validPayTo } from "./people.ts";

export const ASK_BOARD = "askanything";
/** Anti-dust floor: an accepted answer pays on-chain, so the pledge must
 *  clear fees with room to spare. */
export const MIN_AMOUNT_SATS = 5000;
export const TITLE_MAX = 120;
export const DETAILS_MAX = 2000;
export const ANSWER_MAX = 2000;
/** Cap the open questions Jev sees: small state, small bill. */
export const TRIAGE_OPEN_LIMIT = 20;

export const CLARITY_LEVELS = ["vague", "okay", "crisp"];
export const GRADE_LEVELS = ["miss", "weak", "solid", "strong", "best"];

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export interface ValidQuestion {
  title: string;
  details: string;
  amountSats: number;
}

export function validateQuestion(raw: { title?: unknown; details?: unknown; amountSats?: unknown }): ValidQuestion {
  const title = String(raw.title ?? "").trim();
  if (!title) fail("BAD_PARAM", "question title required");
  if (title.length > TITLE_MAX) fail("BAD_PARAM", `title over the ${TITLE_MAX}-char cap`);
  if (/\n/.test(title)) fail("BAD_PARAM", "title must be a single line");
  const details = String(raw.details ?? "").trim();
  if (!details) fail("BAD_PARAM", "question details required");
  if (details.length > DETAILS_MAX) fail("BAD_PARAM", `details over the ${DETAILS_MAX}-char cap`);
  const amountSats = Math.floor(Number(raw.amountSats) || 0);
  if (!(amountSats >= MIN_AMOUNT_SATS)) fail("BAD_PARAM", `amountSats must be at least ${MIN_AMOUNT_SATS} sats`);
  return { title, details, amountSats };
}

export interface ValidAnswer {
  text: string;
  payTo: string;
}

export function validateAnswer(raw: { text?: unknown; payTo?: unknown }): ValidAnswer {
  const text = String(raw.text ?? "").trim();
  if (!text) fail("BAD_PARAM", "answer text required");
  if (text.length > ANSWER_MAX) fail("BAD_PARAM", `answer over the ${ANSWER_MAX}-char cap`);
  const payTo = String(raw.payTo ?? "").trim();
  if (!validPayTo(payTo)) fail("BAD_PARAM", "payTo is not a valid BSV address");
  return { text, payTo };
}

/**
 * Canonical question encoding. Board text cannot carry structure newlines
 * (cleanText flattens control chars to spaces), so the title travels as a
 * `title:` ref and the body is the details verbatim. Refs survive publish
 * untouched (up to MAX_REF), which free text cannot promise.
 */
export function titleRef(title: string): string {
  return `title:${title.trim()}`;
}

export function titleFromRefs(refs: unknown): string | null {
  if (!Array.isArray(refs)) return null;
  for (const r of refs) {
    const m = /^title:(.+)$/.exec(String(r ?? "").trim());
    if (m && m[1]!.trim()) return m[1]!.trim().slice(0, TITLE_MAX);
  }
  return null;
}

/** Decode a stored question: structured title ref first, text fallback for
 *  foreign posts that never carried one. */
export function decodeQuestion(post: { text: string; refs: unknown }): { title: string; details: string } {
  const details = String(post.text ?? "").trim();
  return { title: titleFromRefs(post.refs) ?? details.slice(0, TITLE_MAX), details };
}

export function amountRef(amountSats: number): string {
  return `amount:${Math.floor(amountSats)}`;
}

export function payToRef(payTo: string): string {
  return `payto:${payTo.trim()}`;
}

export function amountFromRefs(refs: unknown): number | null {
  if (!Array.isArray(refs)) return null;
  for (const r of refs) {
    const m = /^amount:(\d+)$/.exec(String(r ?? "").trim());
    if (m) return Math.floor(Number(m[1]));
  }
  return null;
}

export function payToFromRefs(refs: unknown): string | null {
  if (!Array.isArray(refs)) return null;
  for (const r of refs) {
    const m = /^payto:(.+)$/.exec(String(r ?? "").trim());
    if (m && validPayTo(m[1]!.trim())) return m[1]!.trim();
  }
  return null;
}

/** The dedicated board, created empty on first use (members join by invite). */
export async function ensureAskBoard(db: Knex, board: string = ASK_BOARD) {
  const existing = await getBoard(db, board);
  if (existing) return existing;
  return createBoard(db, { name: board, mode: "members", members: [] });
}

export interface OpenQuestion {
  id: string;
  title: string;
  details: string;
  amountSats: number | null;
  from: string;
  ts: number;
}

/** Open questions on a board: kind=request posts, decoded, oldest first. */
export async function openQuestions(db: Knex, board: string = ASK_BOARD): Promise<OpenQuestion[]> {
  const row = await getBoard(db, board);
  if (!row) return [];
  const { posts } = await getPosts(db, board, { limit: 200, markRead: false });
  const out: OpenQuestion[] = [];
  for (const p of posts) {
    if (p.locked || p.kind !== "request") continue;
    const { title, details } = decodeQuestion({ text: p.text, refs: p.refs });
    if (!title) continue;
    out.push({
      id: p.id, title, details,
      amountSats: amountFromRefs(p.refs),
      from: p.from, ts: p.ts,
    });
  }
  return out;
}

export interface TriageResult {
  available: boolean;
  clarity: { score: number; level: string; confidence: number } | null;
  duplicate: { matchId: string | null; matchTitle: string | null; confidence: number } | null;
  openCount: number;
}

/**
 * Review a draft question with one Jev call: clarity score + duplicate
 * choice against the open list. Advisory only; any failure (no key,
 * timeout, bad shape) returns available:false and the asker proceeds.
 */
export async function triageQuestion(
  decide: JevDecide,
  input: { title: string; details: string; amountSats: number; open: Array<{ id: string; title: string }> },
): Promise<TriageResult> {
  const base = { available: false, clarity: null, duplicate: null, openCount: input.open.length } as TriageResult;
  try {
    const questions: Record<string, { type: "score" | "choice"; instructions: string; criteria: unknown }> = {
      clarity: {
        type: "score",
        instructions: "Rate how clearly this paid question states what answer earns the bounty.",
        criteria: CLARITY_LEVELS,
      },
    };
    if (input.open.length > 0) {
      const criteria: Record<string, string> = {};
      for (const q of input.open.slice(0, TRIAGE_OPEN_LIMIT)) criteria[q.id] = q.title.slice(0, 120);
      criteria.novel = "No duplicate — this is a new question";
      questions.duplicate = {
        type: "choice",
        instructions: "Which open question, if any, asks the same thing?",
        criteria,
      };
    }
    const r = await decide(
      { title: input.title, details: input.details, amount_sats: input.amountSats },
      questions as Parameters<JevDecide>[1],
    );
    const out: TriageResult = { ...base, available: true };
    const clarity = (r.answers as Record<string, { score?: unknown; confidence?: unknown }>).clarity;
    const ci = Math.floor(Number(clarity?.score) || 0);
    out.clarity = {
      score: Math.max(0, Math.min(CLARITY_LEVELS.length - 1, ci)),
      level: CLARITY_LEVELS[Math.max(0, Math.min(CLARITY_LEVELS.length - 1, ci))]!,
      confidence: Number(clarity?.confidence) || 0,
    };
    const dup = (r.answers as Record<string, { choice?: unknown; confidence?: unknown }>)?.duplicate;
    if (typeof dup?.choice === "string" && dup.choice !== "novel") {
      const match = input.open.find((q) => q.id === dup.choice);
      out.duplicate = {
        matchId: dup.choice,
        matchTitle: match?.title ?? null,
        confidence: Number(dup.confidence) || 0,
      };
    } else if (dup) {
      out.duplicate = { matchId: null, matchTitle: null, confidence: Number(dup.confidence) || 0 };
    }
    return out;
  } catch {
    return base;
  }
}

export interface GradeResult {
  available: boolean;
  score: number | null;
  level: string | null;
  confidence: number;
}

/** Blind-grade one answer against its question. Advisory; fail-open like triage. */
export async function gradeAnswer(
  decide: JevDecide,
  input: { question: string; submission: string },
): Promise<GradeResult> {
  const q = String(input.question ?? "").trim();
  const s = String(input.submission ?? "").trim();
  if (!q) fail("BAD_PARAM", "question required");
  if (!s) fail("BAD_PARAM", "submission required");
  try {
    const r = await decide(
      { question: q.slice(0, 2000), submission: s.slice(0, 4000) },
      {
        quality: {
          type: "score",
          instructions: "Score this answer against the question. Judge the answer only.",
          criteria: GRADE_LEVELS,
        },
      } as Parameters<JevDecide>[1],
    );
    const a = (r.answers as Record<string, { score?: unknown; confidence?: unknown }>).quality;
    const score = Math.max(0, Math.min(GRADE_LEVELS.length - 1, Math.floor(Number(a?.score) || 0)));
    return { available: true, score, level: GRADE_LEVELS[score]!, confidence: Number(a?.confidence) || 0 };
  } catch {
    return { available: false, score: null, level: null, confidence: 0 };
  }
}
