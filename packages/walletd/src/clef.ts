/**
 * Clef (Cloudflare decision models) vision client.
 *
 * Same posture as jev.ts: one POST to Workers AI, credentials from the
 * daemon environment only — never from app pages or custody slots.
 * Classification is advisory infrastructure for MemeStudio: template id,
 * hook bucket, and caption QA. The app warns, never blocks.
 * Every failure is a coded error; callers fail open.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID         required for any Clef call
 *   CLOUDFLARE_API_TOKEN          required (Workers AI scope)
 *   CLEF_VARIANT                  clef | clef-flash (default clef;
 *                                 flash was unserved 2026-10-02)
 *   CLEF_TIMEOUT_MS / CLEF_RETRIES per-attempt timeout / retry budget
 *
 * Shapes per https://developers.cloudflare.com/workers-ai/models/clef
 * (schema-input/output.json): choice criteria are option->description
 * maps, score criteria are ordered level arrays, images are embedded
 * {content_type, base64}, answers live under result.answers.
 */
export type ClefVariant = "clef" | "clef-flash";

export interface ClefChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface ClefScoreAnswer {
  type: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface ClefClassifyResult {
  model: string;
  template: ClefChoiceAnswer | null;
  hook: ClefChoiceAnswer | null;
  qa: ClefScoreAnswer | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  elapsedMs: number;
}

export const CLEF_TEMPLATES: Record<string, string> = {
  "roll-safe": "man tapping temple, smug obvious-advice",
  drake: "two-panel preference: rejecting top, approving bottom",
  "distracted-boyfriend": "man checking out another woman, labeled choice",
  "two-buttons": "sweating choice between two red buttons",
  "expanding-brain": "4-stage glowing brain escalation",
  "change-my-mind": "man at table with sign, hot take",
  "success-kid": "fist-pumping toddler on beach",
  "woman-yelling-cat": "yelling woman vs unimpressed cat at dinner",
  "gru-plan": "gru 4-panel scheming board",
  stonks: "suit man before rising stock chart",
  "batman-slap": "batman slapping robin mid-sentence",
  "is-this-pigeon": "man gesturing at butterfly, mislabeling",
  morpheus: "what if I told you matrix headshot",
  oprah: "you get a car, everybody gets",
  "futurama-fry": "squinting fry, not sure if",
  boromir: "one does not simply walk into",
  "keyboard-typing": "hands on keyboard closeup",
  "computer-guy": "man pointing at monitor",
  "trojan-horse": "wooden horse at gates",
  euphoria: "that euphoria feeling reaction",
  announcement: "text announcement, no meme template",
  unknown: "none of the above",
};

export const CLEF_HOOKS: Record<string, string> = {
  money: "getting paid, fees, escrow, payouts, prices, earnings",
  custody: "keys, seeds, wallets, self-custody, who holds what",
  trust: "reputation, trust scores, verification, age vs credibility",
  philosophy: "identity, purpose, vibes, manifestos with no money ask",
  meta: "about the meme program itself, raw templates",
};

export const CLEF_QA_LEVELS = ["clean", "minor", "blocked"];

/** 4 MiB decoded-image ceiling enforced by the API; reject early. */
export const CLEF_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function clefVariant(): ClefVariant {
  const v = (process.env.CLEF_VARIANT ?? "clef").trim();
  return v === "clef-flash" ? "clef-flash" : "clef";
}

export function clefEnabled(): boolean {
  return Boolean((process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim()) &&
    Boolean((process.env.CLOUDFLARE_API_TOKEN ?? "").trim());
}

/** Classify one meme image + caption. Throws coded errors; callers fail open. */
export async function classifyMeme(
  input: { imageBase64: string; contentType?: string; caption?: string },
  opts: { fetchFn?: typeof fetch } = {},
): Promise<ClefClassifyResult> {
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const key = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (!account || !key) {
    fail("CLEF_NO_KEY", "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set in the daemon environment");
  }
  const raw = (input.imageBase64 ?? "").replace(/^data:image\/\w+;base64,/, "");
  if (!raw) fail("BAD_PARAM", "imageBase64 is required");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > CLEF_MAX_IMAGE_BYTES) {
    fail("BAD_PARAM", `image is ${bytes.length} bytes; Clef limit is ${CLEF_MAX_IMAGE_BYTES}`);
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const timeout = Number(process.env.CLEF_TIMEOUT_MS ?? 15_000);
  const retries = Number(process.env.CLEF_RETRIES ?? 1);
  const body = JSON.stringify({
    model: clefVariant(),
    state: { caption: input.caption ?? "" },
    images: [{ content_type: input.contentType ?? "image/jpeg", base64: raw }],
    questions: {
      template: {
        type: "choice",
        instructions: "Which meme template is this image? Answer unknown if none match.",
        criteria: CLEF_TEMPLATES,
      },
      hook: {
        type: "choice",
        instructions: "Which engagement angle does the image plus caption use?",
        criteria: CLEF_HOOKS,
      },
      qa: {
        type: "score",
        instructions: "Rate caption problems: overlap with faces, illegible contrast, blank frames.",
        criteria: CLEF_QA_LEVELS,
      },
    },
  });
  const started = Date.now();
  let last: { code: string; message: string } | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res: Response;
    let text: string;
    let parsed: { result?: { model?: unknown; answers?: unknown; usage?: unknown }; error?: { message?: unknown } } | null = null;
    try {
      res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef`, {
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
        code: aborted ? "CLEF_TIMEOUT" : "CLEF_UNAVAILABLE",
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
    const answers = (parsed?.result?.answers ?? {}) as {
      template?: ClefChoiceAnswer; hook?: ClefChoiceAnswer; qa?: ClefScoreAnswer;
    };
    if (res.ok) {
      return {
        model: typeof parsed?.result?.model === "string" ? parsed.result.model as string : clefVariant(),
        template: answers.template ?? null,
        hook: answers.hook ?? null,
        qa: answers.qa ?? null,
        usage: (parsed?.result?.usage ?? undefined) as ClefClassifyResult["usage"],
        elapsedMs: Date.now() - started,
      };
    }
    const message = typeof parsed?.error?.message === "string" ? parsed.error.message : text.slice(0, 300);
    last = { code: `CLEF_${res.status}`, message };
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    fail(last.code, message);
  }
  fail(last?.code ?? "CLEF_UNAVAILABLE", last?.message ?? "unknown failure");
}
