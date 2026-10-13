/**
 * Cloudflare clients for tiered memory (P3). Fetch-only, no SDK.
 *
 * - R2 over the S3-compatible API (SigV4, region `auto`): encrypted sync
 *   packs + signed manifests. Needs R2 API keys (dashboard-created — there
 *   is no API route for minting them): CLOUDFLARE_R2_ACCESS_KEY_ID,
 *   CLOUDFLARE_R2_SECRET_ACCESS_KEY, CLOUDFLARE_R2_BUCKET
 *   (default bsvos-memory-packs).
 * - Vectorize v2 REST (account token): public-vector fan-out for the shared
 *   semantic index bsvos-memory-public (384-dim cosine). PUBLIC ONLY —
 *   vectors invert to approximate text, so a stored vector IS content.
 *
 * Everything leaving the machine here is ciphertext, hashes, or public
 * data. Private plaintext never touches these paths.
 */
import { createHash, createHmac } from "node:crypto";

export interface R2Env {
  accessKey?: string;
  secretKey?: string;
  accountId?: string;
  bucket?: string;
}

export interface VectorizeEnv {
  accountId?: string;
  token?: string;
  index?: string;
}

export const R2_BUCKET_DEFAULT = "bsvos-memory-packs";
export const VECTORIZE_INDEX_DEFAULT = "bsvos-memory-public";

export function r2Configured(env: R2Env): boolean {
  return Boolean(env.accessKey?.trim() && env.secretKey?.trim() && env.accountId?.trim());
}

export function r2Bucket(env: R2Env): string {
  return (env.bucket ?? "").trim() || R2_BUCKET_DEFAULT;
}

export function vectorizeConfigured(env: VectorizeEnv): boolean {
  return Boolean(env.accountId?.trim() && env.token?.trim());
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hex(b: Buffer): string {
  return b.toString("hex");
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** AWS Signature V4 for R2 (region is always `auto`). Exported for tests. */
export function signS3Request(opts: {
  accessKey: string;
  secretKey: string;
  accountId: string;
  bucket: string;
  method: string;
  key: string;
  query?: string;
  body?: Uint8Array;
  contentType?: string;
  now?: Date;
}): SignedRequest {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const uri = `/${opts.bucket}/${opts.key.split("/").map(encodeURIComponent).join("/")}`;
  const query = opts.query ?? "";
  const payloadHash = createHash("sha256").update(opts.body ?? new Uint8Array(0)).digest("hex");
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (opts.contentType) headers["content-type"] = opts.contentType;
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const canonical = [opts.method, uri, query, canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical, "utf8").digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, dateStamp), "auto"), "s3"), "aws4_request"), toSign);
  const auth = `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${hex(signingKey)}`;
  return { url: `https://${host}${uri}${query ? `?${query}` : ""}`, headers: { ...headers, authorization: auth } };
}

async function s3(opts: {
  env: R2Env; method: string; key: string; query?: string; body?: Uint8Array; contentType?: string; fetchFn?: typeof fetch;
}): Promise<{ status: number; body: Uint8Array; etag: string }> {
  const { env, method, key } = opts;
  const accessKey = (env.accessKey ?? "").trim();
  const secretKey = (env.secretKey ?? "").trim();
  const accountId = (env.accountId ?? "").trim();
  if (!accessKey || !secretKey || !accountId) {
    throw Object.assign(new Error("R2 is not configured (CLOUDFLARE_R2_ACCESS_KEY_ID/_SECRET_ACCESS_KEY/_ACCOUNT)"), { code: "R2_NOT_CONFIGURED", status: 503 });
  }
  const signed = signS3Request({
    accessKey, secretKey, accountId, bucket: r2Bucket(env),
    method, key, query: opts.query, body: opts.body, contentType: opts.contentType,
  });
  const res = await (opts.fetchFn ?? fetch)(signed.url, {
    method,
    headers: signed.headers,
    body: opts.body ? Buffer.from(opts.body) : undefined,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, body: buf, etag: res.headers.get("etag") ?? "" };
}

export async function r2Put(env: R2Env, key: string, body: Uint8Array, contentType = "application/octet-stream", fetchFn?: typeof fetch): Promise<void> {
  const r = await s3({ env, method: "PUT", key, body, contentType, fetchFn });
  if (r.status !== 200) {
    throw Object.assign(new Error(`R2 PUT failed (${r.status})`), { code: "R2_FAILED", status: 502 });
  }
}

export async function r2Get(env: R2Env, key: string, fetchFn?: typeof fetch): Promise<Uint8Array | null> {
  const r = await s3({ env, method: "GET", key, fetchFn });
  if (r.status === 404) return null;
  if (r.status !== 200) {
    throw Object.assign(new Error(`R2 GET failed (${r.status})`), { code: "R2_FAILED", status: 502 });
  }
  return r.body;
}

export async function r2Delete(env: R2Env, key: string, fetchFn?: typeof fetch): Promise<void> {
  const r = await s3({ env, method: "DELETE", key, fetchFn });
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
    throw Object.assign(new Error(`R2 DELETE failed (${r.status})`), { code: "R2_FAILED", status: 502 });
  }
}

/** Keys under a prefix (ListObjectsV2, minimal <Key> parse, 1000 max). */
export async function r2List(env: R2Env, prefix: string, fetchFn?: typeof fetch): Promise<string[]> {
  // SigV4 requires query params sorted by name in the canonical request.
  const q = `list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
  const r = await s3({ env, method: "GET", key: "", query: q, fetchFn });
  if (r.status !== 200) {
    throw Object.assign(new Error(`R2 LIST failed (${r.status})`), { code: "R2_FAILED", status: 502 });
  }
  const xml = Buffer.from(r.body).toString("utf8");
  const out: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out.filter(Boolean);
}

export interface VecPoint {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
}

function vecBase(env: VectorizeEnv): { base: string; token: string } {
  const accountId = (env.accountId ?? "").trim();
  const token = (env.token ?? "").trim();
  if (!accountId || !token) {
    throw Object.assign(new Error("Vectorize is not configured (CLOUDFLARE_ACCOUNT_ID/_API_TOKEN)"), { code: "VEC_NOT_CONFIGURED", status: 503 });
  }
  const index = ((env.index ?? "").trim() || VECTORIZE_INDEX_DEFAULT).trim();
  return { base: `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${index}`, token };
}

async function vecCall(env: VectorizeEnv, path: string, body: unknown, fetchFn?: typeof fetch): Promise<unknown> {
  const { base, token } = vecBase(env);
  const res = await (fetchFn ?? fetch)(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`vectorize ${path} failed (${res.status}): ${text.slice(0, 160)}`), { code: "VEC_FAILED", status: 502 });
  }
  return JSON.parse(text);
}

/** Upsert public vectors (chunked). IDs are content hashes (idempotent). */
export async function vecUpsert(env: VectorizeEnv, vectors: VecPoint[], fetchFn?: typeof fetch): Promise<number> {
  let n = 0;
  for (let i = 0; i < vectors.length; i += 200) {
    await vecCall(env, "/insert", { vectors: vectors.slice(i, i + 200) }, fetchFn);
    n += Math.min(200, vectors.length - i);
  }
  return n;
}

/** Delete vectors by id (tombstone propagation). */
export async function vecDelete(env: VectorizeEnv, ids: string[], fetchFn?: typeof fetch): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    await vecCall(env, "/delete_by_ids", { ids: ids.slice(i, i + 200) }, fetchFn);
    n += Math.min(200, ids.length - i);
  }
  return n;
}
