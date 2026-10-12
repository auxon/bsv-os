/**
 * Embedders for semantic recall. Two backends, one interface — and a test seam.
 *
 * - Workers AI (`@cf/baai/bge-small-en-v1.5`): PUBLIC content only. Private
 *   plaintext must never leave the machine, so the daemon calls this only
 *   for public-visibility text. Account id + token come from the environment
 *   (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN), never from apps.
 * - Lazy local (Transformers.js MiniLM-class): the ONLY backend allowed for
 *   private/shared text. The model (~90MB) downloads on first use into the
 *   wallet data dir — never during install, never in tests.
 * - Injectable `Embedder` for tests and callers (fixture vectors, no network).
 */
import path from "node:path";
import { dataDir } from "./storage.ts";

export interface Embedder {
  name: string;
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const BGE_MODEL = "@cf/baai/bge-small-en-v1.5";
export const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

function clean(texts: string[]): string[] {
  return texts.map((t) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 2048));
}

export function workersAiEmbedder(opts: { accountId: string; token: string; model?: string }): Embedder {
  const model = opts.model ?? BGE_MODEL;
  return {
    name: `workers-ai:${model}`,
    dims: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const input = clean(texts);
      if (!input.length) return [];
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: input }),
      });
      const body = (await res.json()) as { success?: boolean; result?: { data?: number[][] }; errors?: Array<{ message?: string }> };
      if (!res.ok || body.success !== true || !Array.isArray(body.result?.data)) {
        const detail = (body.errors ?? []).map((e) => e.message ?? "").join("; ").slice(0, 200);
        throw new Error(`workers-ai embeddings failed (${res.status}) ${detail}`);
      }
      return body.result.data.map((row) => Float32Array.from(row));
    },
  };
}

type Extractor = (texts: string | string[], opts?: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

let localPipe: Extractor | null = null;

/** Local MiniLM embedder. Model downloads once into the data dir on first use. */
export function lazyLocalEmbedder(opts: { model?: string; cacheDir?: string } = {}): Embedder {
  const model = opts.model ?? LOCAL_MODEL;
  return {
    name: `local:${model}`,
    dims: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const input = clean(texts);
      if (!input.length) return [];
      if (!localPipe) {
        const mod = (await import("@xenova/transformers")) as {
          pipeline(task: string, model: string, opts?: Record<string, unknown>): Promise<Extractor>;
        };
        localPipe = await mod.pipeline("feature-extraction", model, {
          cache_dir: opts.cacheDir ?? path.join(dataDir(), "models"),
        });
      }
      const out = await localPipe(input, { pooling: "mean", normalize: true });
      return out.tolist().map((row) => Float32Array.from(row));
    },
  };
}

/** Deterministic fixture embedder for tests: hash-bucketed unit vectors. */
export function fixtureEmbedder(dims = 8): Embedder {
  return {
    name: "fixture",
    dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = new Float32Array(dims);
        const words = t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        for (const w of words) {
          let h = 2166136261;
          for (let i = 0; i < w.length; i++) {
            h ^= w.charCodeAt(i);
            h = Math.imul(h, 16777619);
          }
          v[Math.abs(h) % dims] += 1;
        }
        let n = 0;
        for (let i = 0; i < dims; i++) n += v[i] * v[i];
        const s = Math.sqrt(n) || 1;
        for (let i = 0; i < dims; i++) v[i] /= s;
        return v;
      });
    },
  };
}
