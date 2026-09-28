/**
 * EntangleIT Trust: fetch + offline-verify signed reputation profiles.
 *
 * bsvOS is a Trust *consumer*. A profile is ES256 over canonical JSON and is
 * verified locally against the issuer key — a fetched object is never trusted
 * on its own, and a verification problem is always fail-closed: the base
 * policy thresholds apply and no money moves differently.
 *
 * Terms only ever widen the Jev auto-approval band INSIDE an origin's existing
 * cap or sub-wallet budget (`min(cap, terms)` — trust loosens, never uncaps).
 * Everything else in policy (modes, caps, budgets, approvals) is untouched.
 *
 * Config (daemon environment):
 *   TRUST_URL       base URL of the Trust worker (unset = feature off)
 *   TRUST_MODE      off | log | enforce (default enforce)
 *   TRUST_CACHE_MS  profile cache TTL, min 30s (default 5 minutes; issuer key
 *                   is cached for 24h)
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey as NodeJsonWebKey } from "node:crypto";
import type { AutoThresholds } from "./jev.ts";

export type TrustMode = "off" | "log" | "enforce";
export type TrustLevel = "new" | "building" | "proven" | "trusted" | "elite";

export interface TrustTerms {
  /** Multiplier on an approval threshold (only ever loosens; never uncaps). */
  approvalMultiplier: number;
  /** Bond discount in bps (server-side rails; informational here). */
  bondDiscountBps: number;
  /** Ceiling a seller may discount for this subject, in bps. */
  discountCeilingBps: number;
}

export interface TrustProfile {
  v: number;
  iss: string;
  sub: string;
  members: string[];
  issuedAt: string;
  expiresAt: string;
  level: TrustLevel;
  score: number;
  confidence: number;
  axes?: Record<string, unknown>;
  terms: TrustTerms;
  reasons: string[];
  band?: { flag?: string; [key: string]: unknown };
}

export interface SignedProfile {
  profile: TrustProfile;
  signature: string;
  keyId?: string;
  alg?: string;
}

export interface TrustState {
  configured: boolean;
  mode: TrustMode;
  subject: string | null;
  verified: boolean;
  profile: TrustProfile | null;
  level: TrustLevel | null;
  terms: TrustTerms | null;
  expiresAt: string | null;
  reasons: string[];
  error: string | null;
}

export function trustUrl(): string | null {
  const raw = (process.env.TRUST_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function trustMode(): TrustMode {
  const m = (process.env.TRUST_MODE ?? "enforce").trim().toLowerCase();
  return m === "off" || m === "log" ? m : "enforce";
}

/** The subject a bsvOS wallet asks about: its wallet identity key. */
export function trustSubject(identityKey: string): string {
  return `key:${identityKey.trim().toLowerCase()}`;
}

/**
 * Canonical JSON exactly as the issuer signs it (`~/trust src/core.ts`):
 * object keys sorted, arrays in order, null for null/undefined.
 */
export function trustCanonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => trustCanonical(v)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${trustCanonical(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Verify a signed profile offline: ES256 (raw P1363, base64url) over the
 * canonical JSON, subject match, not expired. Pure; no network, no wallet.
 */
export function verifyTrustSignature(
  publicJwk: unknown,
  signed: SignedProfile,
  opts: { subject: string; now?: number },
): { valid: boolean; reason?: string } {
  const now = opts.now ?? Date.now();
  const profile = signed?.profile as TrustProfile | undefined;
  if (!profile || typeof profile !== "object") return { valid: false, reason: "not a profile" };
  if (profile.sub !== opts.subject) return { valid: false, reason: `subject mismatch (${profile.sub})` };
  const expires = Date.parse(profile.expiresAt);
  if (!Number.isFinite(expires)) return { valid: false, reason: "missing expiresAt" };
  if (expires <= now) return { valid: false, reason: "profile expired" };
  if (signed.alg && signed.alg !== "ES256") return { valid: false, reason: `unsupported alg ${signed.alg}` };
  if (typeof signed.signature !== "string" || !signed.signature) return { valid: false, reason: "missing signature" };
  try {
    const key = createPublicKey({ key: publicJwk as NodeJsonWebKey, format: "jwk" });
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(trustCanonical(profile), "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signed.signature, "base64url"),
    );
    return ok ? { valid: true } : { valid: false, reason: "bad signature" };
  } catch (e) {
    return { valid: false, reason: `verify failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function normalizeTerms(raw: TrustTerms | undefined): TrustTerms {
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  };
  return {
    approvalMultiplier: num(raw?.approvalMultiplier, 1, 1, 4),
    bondDiscountBps: num(raw?.bondDiscountBps, 0, 0, 10000),
    discountCeilingBps: num(raw?.discountCeilingBps, 0, 0, 10000),
  };
}

const ISSUER_KEY_TTL_MS = 24 * 60 * 60 * 1000;
function profileTtlMs(): number {
  return Math.max(30_000, Number(process.env.TRUST_CACHE_MS ?? 300_000) || 300_000);
}

interface IssuerKey {
  url: string;
  alg: string;
  keyId: string;
  publicJwk: unknown;
  at: number;
}

let issuerKeyCache: IssuerKey | null = null;
let profileCache: { subject: string; state: TrustState; at: number } | null = null;

async function getJson(url: string, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`trust ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch this wallet's Trust profile and verify it offline. Never throws for a
 * missing URL, network error, or bad signature — the returned state carries
 * the failure and `verified: false` (fail closed). Failures are not cached.
 */
export async function trustState(opts: {
  identityKey: string;
  fetchFn?: typeof fetch;
  now?: number;
  force?: boolean;
}): Promise<TrustState> {
  const url = trustUrl();
  const mode = trustMode();
  const subject = trustSubject(opts.identityKey);
  const base: TrustState = {
    configured: Boolean(url), mode, subject, verified: false,
    profile: null, level: null, terms: null, expiresAt: null, reasons: [], error: null,
  };
  if (!url) return { ...base, error: "TRUST_URL not configured" };
  const now = opts.now ?? Date.now();
  if (!opts.force && profileCache && profileCache.subject === subject && now - profileCache.at < profileTtlMs()) {
    return profileCache.state;
  }
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    let key = issuerKeyCache && issuerKeyCache.url === url && now - issuerKeyCache.at < ISSUER_KEY_TTL_MS ? issuerKeyCache : null;
    if (!key) {
      const raw = (await getJson(`${url}/v1/key`, fetchFn)) as { alg?: unknown; keyId?: unknown; publicJwk?: unknown };
      if (!raw || typeof raw.publicJwk !== "object" || raw.publicJwk === null) throw new Error("issuer key missing");
      key = {
        url,
        alg: typeof raw.alg === "string" ? raw.alg : "ES256",
        keyId: typeof raw.keyId === "string" ? raw.keyId : "",
        publicJwk: raw.publicJwk,
        at: now,
      };
      issuerKeyCache = key;
    }
    const signed = (await getJson(`${url}/v1/profile/${encodeURIComponent(subject)}`, fetchFn)) as SignedProfile;
    const check = verifyTrustSignature(key.publicJwk, signed, { subject, now });
    const state: TrustState = check.valid
      ? {
          ...base,
          verified: true,
          profile: signed.profile,
          level: signed.profile.level,
          terms: normalizeTerms(signed.profile.terms),
          expiresAt: signed.profile.expiresAt,
          reasons: Array.isArray(signed.profile.reasons) ? signed.profile.reasons : [],
        }
      : { ...base, error: check.reason ?? "verification failed" };
    profileCache = { subject, state, at: now };
    return state;
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Test/embedding override: where the policy layer gets the identity key. */
let identityProvider: (() => string | null) | null = null;
export function setTrustIdentityProvider(fn: () => string | null): void {
  identityProvider = fn;
}

/**
 * The policy layer's view: verified terms for this wallet, or null if trust is
 * off, unconfigured, locked, unreachable, or unverifiable. Never throws.
 */
export async function trustTermsForPolicy(
  opts: { fetchFn?: typeof fetch; now?: number } = {},
): Promise<{ level: TrustLevel; terms: TrustTerms; expiresAt: string } | null> {
  if (trustMode() === "off" || !trustUrl() || !identityProvider) return null;
  let identity: string | null = null;
  try {
    identity = identityProvider();
  } catch {
    return null;
  }
  if (!identity) return null;
  const state = await trustState({ identityKey: identity, ...opts });
  if (!state.verified || !state.profile || !state.terms) return null;
  return { level: state.profile.level, terms: state.terms, expiresAt: state.profile.expiresAt };
}

export const TRUST_PROB_STEP = 0.05;
export const TRUST_CONF_STEP = 0.05;
export const TRUST_PROB_FLOOR = 0.5;
export const TRUST_CONF_FLOOR = 0.4;

/**
 * Widen the Jev auto-approval band by the trust multiplier: each step buys a
 * 5-point relaxation of the verdict and confidence bars, floored. The risk
 * bar never moves, and the origin's cap / sub-wallet budget still binds —
 * trust relaxes how confident Jev must be, not how much may be spent.
 */
export function trustAdjustedThresholds(base: AutoThresholds, multiplier: number): AutoThresholds {
  const m = Math.max(1, Math.min(4, Math.floor(Number(multiplier) || 1)));
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    minVerdictProb: round2(Math.max(base.minVerdictProb - TRUST_PROB_STEP * (m - 1), TRUST_PROB_FLOOR)),
    maxRisk: base.maxRisk,
    minConfidence: round2(Math.max(base.minConfidence - TRUST_CONF_STEP * (m - 1), TRUST_CONF_FLOOR)),
  };
}

/** Drop cached profiles and issuer keys (tests; config changes). */
export function resetTrustCache(): void {
  issuerKeyCache = null;
  profileCache = null;
}