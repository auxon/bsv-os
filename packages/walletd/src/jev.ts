/**
 * Jev (TypeSafe System One) decision client.
 *
 * One POST to OpenRouter's alpha decisions endpoint (or a compatible
 * endpoint via JEV_URL); the key comes from OPENROUTER_API_KEY in the
 * daemon's environment — never from the wallet's custody slots. Jev is
 * advisory infrastructure: `scoreSpend` turns a spend into a calibrated
 * allow/ask/deny + routine/unverified/harmful answer, and `autoApprove`
 * is the only gate that may turn that into an autonomous approval. Every
 * failure is a coded error; policy callers fail closed.
 *
 * Env:
 *   OPENROUTER_API_KEY            required for any Jev call
 *   JEV_URL                       default OpenRouter alpha decisions endpoint
 *   JEV_MODEL                     default typesafe/jev-1.13
 *   JEV_TIMEOUT_MS / JEV_RETRIES  per-attempt timeout / retry budget
 *   BSV_WALLETD_JEV=off           kill switch for the policy advisor only
 *   BSV_WALLETD_JEV_AUTO_MIN_PROB auto mode: minimum P(allow)
 *   BSV_WALLETD_JEV_AUTO_MAX_RISK auto mode: maximum risk score (< 0.5 = routine)
 *   BSV_WALLETD_JEV_AUTO_MIN_CONF auto mode: minimum confidence
 */
export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  criteria?: unknown;
}

export interface JevAnswer {
  type: JevQuestionType;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
}

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  elapsedMs: number;
}

export type JevDecide = (
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts?: { model?: string },
) => Promise<JevResult>;

export interface SpendContext {
  origin: string;
  action: string;
  amountSats: number;
  kind?: "spend" | "x402";
  label?: string;
  to?: string;
  host?: string;
  resourceUrl?: string;
  description?: string;
}

export interface SpendScore {
  verdict: "allow" | "ask" | "deny";
  verdictProb: number;
  risk: number;
  riskLevel: "routine" | "unverified" | "harmful";
  confidence: number;
  model: string;
  cost: number;
  elapsedMs: number;
}

export interface AutoThresholds {
  minVerdictProb: number;
  maxRisk: number;
  minConfidence: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

const RISK_LEVELS = ["routine", "unverified", "harmful"] as const;

export function jevModel(): string {
  return process.env.JEV_MODEL ?? "typesafe/jev-1.13";
}

export function jevEndpoint(): string {
  return process.env.JEV_URL ?? "https://openrouter.ai/api/alpha/decisions";
}

export function jevKeyPresent(): boolean {
  return Boolean((process.env.OPENROUTER_API_KEY ?? "").trim());
}

/** Policy-advisor switch: key present and not explicitly turned off. */
export function jevEnabled(): boolean {
  return jevKeyPresent() && process.env.BSV_WALLETD_JEV !== "off";
}

export function autoThresholds(): AutoThresholds {
  return {
    minVerdictProb: Number(process.env.BSV_WALLETD_JEV_AUTO_MIN_PROB ?? 0.7),
    maxRisk: Number(process.env.BSV_WALLETD_JEV_AUTO_MAX_RISK ?? 0.5),
    minConfidence: Number(process.env.BSV_WALLETD_JEV_AUTO_MIN_CONF ?? 0.6),
  };
}

/** The single autonomous-approval predicate: calibrated and fail-closed. */
export function autoApprove(score: SpendScore, t: AutoThresholds = autoThresholds()): boolean {
  return (
    score.verdict === "allow" &&
    score.verdictProb >= t.minVerdictProb &&
    score.risk < t.maxRisk &&
    score.confidence >= t.minConfidence
  );
}

export function describeScore(score: SpendScore): string {
  return (
    `Jev ${score.verdict} p=${score.verdictProb.toFixed(2)} ` +
    `risk=${score.risk.toFixed(2)} ${score.riskLevel} conf=${score.confidence.toFixed(2)}`
  );
}

function validateQuestions(questions: unknown): asserts questions is Record<string, JevQuestion> {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) {
    fail("BAD_PARAM", "questions must be a non-empty map of { <id>: question }");
  }
  for (const [id, q] of Object.entries(questions as Record<string, JevQuestion>)) {
    if (q === null || typeof q !== "object") fail("BAD_PARAM", `question "${id}" must be an object`);
    if (!["noul", "choice", "score"].includes(q.type)) {
      fail("BAD_PARAM", `question "${id}": type must be "noul", "choice", or "score"`);
    }
    if (typeof q.instructions !== "string" || !q.instructions.trim()) {
      fail("BAD_PARAM", `question "${id}": instructions is required`);
    }
    if (q.type === "choice") {
      if (q.criteria === null || typeof q.criteria !== "object" || Array.isArray(q.criteria) || !Object.keys(q.criteria).length) {
        fail("BAD_PARAM", `question "${id}": choice criteria must be a non-empty map of { <option>: description }`);
      }
    }
    if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        fail("BAD_PARAM", `question "${id}": score criteria must be an array of at least two levels`);
      }
    }
  }
}

/** One decision call. Retries 429/529/network like the skill helper; throws coded errors. */
export async function decide(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { model?: string; fetchFn?: typeof fetch } = {},
): Promise<JevResult> {
  if (state === undefined || state === null) fail("BAD_PARAM", "state is required (string, object, or array)");
  validateQuestions(questions);
  const key = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!key) fail("NO_KEY", "OPENROUTER_API_KEY is not set in the daemon environment");
  const fetchFn = opts.fetchFn ?? fetch;
  const timeout = Number(process.env.JEV_TIMEOUT_MS ?? 10_000);
  const retries = Number(process.env.JEV_RETRIES ?? 2);
  const body = JSON.stringify({ state, questions, model: opts.model ?? jevModel() });
  const started = Date.now();
  let last: { code: string; message: string } | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res: Response;
    let text: string;
    let parsed: unknown = null;
    try {
      res = await fetchFn(jevEndpoint(), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      text = await res.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave null */
      }
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof Error && e.name === "AbortError";
      last = {
        code: aborted ? "JEV_TIMEOUT" : "JEV_UNAVAILABLE",
        message: aborted ? `no answer within ${timeout} ms` : `decision endpoint unreachable: ${e instanceof Error ? e.message : e}`,
      };
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      fail(last.code, last.message);
    } finally {
      clearTimeout(timer);
    }
    const obj = (parsed ?? {}) as { model?: unknown; answers?: unknown; usage?: unknown; error?: { message?: unknown } };
    if (res.ok) {
      if (!obj.answers || typeof obj.answers !== "object") {
        fail("JEV_BAD_RESPONSE", `non-decision response: ${text.slice(0, 200)}`);
      }
      return {
        model: typeof obj.model === "string" ? obj.model : jevModel(),
        answers: obj.answers as Record<string, JevAnswer>,
        usage: (obj.usage ?? undefined) as JevResult["usage"],
        elapsedMs: Date.now() - started,
      };
    }
    const message = typeof obj.error?.message === "string" ? obj.error.message : text.slice(0, 300);
    last = { code: `JEV_${res.status}`, message };
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    fail(last.code, message);
  }
  fail(last?.code ?? "JEV_UNAVAILABLE", last?.message ?? "unknown failure");
}

/** Factual, compact state: what leaves the wallet and to whom. */
export function spendState(ctx: SpendContext): Record<string, unknown> {
  const state: Record<string, unknown> = {
    origin: ctx.origin,
    action: ctx.action,
    amount_sats: ctx.amountSats,
    kind: ctx.kind ?? "spend",
  };
  if (ctx.label) state.label = ctx.label;
  if (ctx.to) state.pay_to = ctx.to;
  if (ctx.host) state.host = ctx.host;
  if (ctx.resourceUrl) state.resource_url = ctx.resourceUrl;
  if (ctx.description) state.description = ctx.description;
  return state;
}

export function spendQuestions(ctx: SpendContext): Record<string, JevQuestion> {
  const x402 = ctx.kind === "x402";
  return {
    verdict: {
      type: "choice",
      instructions: x402
        ? "What should wallet policy do with this pay-per-call (x402) quote before paying it?"
        : "What should wallet spending policy do with this action?",
      criteria: {
        allow: x402
          ? "routine quote from a plausible host, amount consistent with the resource"
          : "routine, low-risk spend a reasonable policy would approve",
        ask: x402
          ? "unverified quote — host, amount, or description warrant human confirmation"
          : "uncertain or unusual — a human should confirm before it spends",
        deny: x402
          ? "suspicious quote — fraud, extortion, or clear policy-violation signals"
          : "high risk or clearly against spending policy",
      },
    },
    risk: {
      type: "score",
      instructions: x402
        ? "How risky is paying this quote as described?"
        : "How risky is this spend for the wallet's owner?",
      criteria: ["routine", "unverified", "harmful"],
    },
  };
}

export function scoreFromAnswers(answers: Record<string, JevAnswer>, meta: { model: string; cost?: number; elapsedMs: number }): SpendScore {
  const verdict = answers.verdict;
  if (!verdict || verdict.type !== "choice" || !verdict.choice) fail("JEV_BAD_RESPONSE", "decision is missing a verdict");
  if (!["allow", "ask", "deny"].includes(verdict.choice)) fail("JEV_BAD_RESPONSE", `unknown verdict ${verdict.choice}`);
  const risk = answers.risk;
  if (!risk || risk.type !== "score" || typeof risk.score !== "number") fail("JEV_BAD_RESPONSE", "decision is missing a risk score");
  const idx = Math.max(0, Math.min(RISK_LEVELS.length - 1, Math.round(risk.score)));
  const riskLevel = (risk.legend?.[String(idx)] ?? RISK_LEVELS[idx]) as SpendScore["riskLevel"];
  return {
    verdict: verdict.choice as SpendScore["verdict"],
    verdictProb: Number(verdict.probabilities?.[verdict.choice] ?? 0),
    risk: risk.score,
    riskLevel,
    confidence: Math.min(Number(verdict.confidence ?? 0), Number(risk.confidence ?? 0)),
    model: meta.model,
    cost: Number(meta.cost ?? 0),
    elapsedMs: meta.elapsedMs,
  };
}

/** Score a spend (or x402 quote) — the policy advisor's one call shape. */
export async function scoreSpend(
  ctx: SpendContext,
  opts: { decide?: JevDecide; model?: string } = {},
): Promise<SpendScore> {
  const fn = opts.decide ?? decide;
  const r = await fn(spendState(ctx), spendQuestions(ctx), opts.model ? { model: opts.model } : undefined);
  return scoreFromAnswers(r.answers, { model: r.model, cost: r.usage?.cost, elapsedMs: r.elapsedMs });
}
