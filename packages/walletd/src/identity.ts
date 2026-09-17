/**
 * P4 / F3 first slice: Sign in with Twetch — the OS system identity.
 *
 * Standard OIDC authorization-code + PKCE (S256) against the Twetch issuer
 * (`https://id.entangleit.com` in production). Hand-rolled on node:crypto
 * so walletd grows no new dependency (ARM prebuild pins stay intact):
 * ES256/RS256 id_token verification against the issuer JWKS, a one-shot
 * loopback listener for the redirect, tokens persisted in the wallet DB.
 *
 *	 bsv login  → RPC identityLoginStart
 *	 daemon opens 127.0.0.1:2122/callback, returns the auth URL
 *	 CLI opens the hosted Twetch page (recovery words and signatures stay
 *	 in the browser; the issuer only ever returns a code)
 *	 issuer redirects to loopback → daemon exchanges code, verifies
 *	 iss/aud/exp/nonce/signature → session stored
 *
 * Client registration is manual on the issuer (no dynamic registration):
 * create an app at {issuer}/console with redirect URI
 * `http://127.0.0.1:2122/callback`. Public clients (token auth method
 * `none`) work; confidential clients additionally receive refresh tokens.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Knex } from "knex";
import { getStatus } from "./custody.ts";

export const DEFAULT_ISSUER = "https://id.entangleit.com";
export const DEFAULT_SCOPE = "openid profile offline_access";
export const DEFAULT_REDIRECT_PORT = 2122;

const LOGIN_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const FORM = "application/x-www-form-urlencoded";

export interface IdentityConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectPort: number;
  scope: string;
}

export interface OidcEndpoints {
  issuer: string;
  authorization: string;
  token: string;
  jwks: string;
  revocation: string | null;
}

export interface IdentitySession {
  issuer: string;
  clientId: string;
  sub: string;
  handle: string;
  name: string;
  picture: string;
  profile: string;
  twetchPubkey: string;
  email: string | null;
  emailVerified: boolean;
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string;
  expiresAt: number;
  walletIdentityKey: string | null;
  createdAt: number;
  updatedAt: number;
  /** true when the id_token expired and could not be refreshed. */
  stale?: boolean;
}

export interface TokenSet {
  id_token: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

type FetchFn = typeof fetch;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function b64urlJson(part: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") fail("BAD_TOKEN", "id_token payload is not an object");
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e) throw e;
    fail("BAD_TOKEN", "id_token is malformed");
  }
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function migrateIdentity(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("identity_config"))) {
    await db.schema.createTable("identity_config", (t) => {
      t.integer("id").primary();
      t.string("issuer").notNullable().defaultTo(DEFAULT_ISSUER);
      t.string("client_id").notNullable().defaultTo("");
      t.text("client_secret").nullable();
      t.integer("redirect_port").notNullable().defaultTo(DEFAULT_REDIRECT_PORT);
      t.string("scope").notNullable().defaultTo(DEFAULT_SCOPE);
      t.integer("updated_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("identity_session"))) {
    await db.schema.createTable("identity_session", (t) => {
      t.integer("id").primary();
      t.string("issuer").notNullable();
      t.string("client_id").notNullable().defaultTo("");
      t.string("sub").notNullable();
      t.string("handle").notNullable().defaultTo("");
      t.string("name").notNullable().defaultTo("");
      t.text("picture").notNullable().defaultTo("");
      t.text("profile").notNullable().defaultTo("");
      t.string("twetch_pubkey").notNullable().defaultTo("");
      t.string("email").nullable();
      t.integer("email_verified").notNullable().defaultTo(0);
      t.text("id_token").notNullable();
      t.text("access_token").notNullable().defaultTo("");
      t.text("refresh_token").nullable();
      t.string("scopes").notNullable().defaultTo("");
      t.integer("expires_at").notNullable();
      t.string("wallet_identity_key").nullable();
      t.integer("created_at").notNullable();
      t.integer("updated_at").notNullable();
    });
  }
}

function parseIssuer(raw: string): string {
  const clean = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(clean);
  } catch {
    fail("BAD_PARAM", "issuer must be a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    fail("BAD_PARAM", "issuer must be https (http is allowed for localhost only)");
  }
  return clean;
}

export async function identityConfig(db: Knex): Promise<IdentityConfig> {
  const row = (await db("identity_config").where({ id: 1 }).first()) as Record<string, unknown> | undefined;
  if (!row) {
    return { issuer: DEFAULT_ISSUER, clientId: "", clientSecret: null, redirectPort: DEFAULT_REDIRECT_PORT, scope: DEFAULT_SCOPE };
  }
  return {
    issuer: str(row.issuer) || DEFAULT_ISSUER,
    clientId: str(row.client_id),
    clientSecret: typeof row.client_secret === "string" && row.client_secret ? row.client_secret : null,
    redirectPort: Number.isInteger(row.redirect_port) ? Number(row.redirect_port) : DEFAULT_REDIRECT_PORT,
    scope: str(row.scope) || DEFAULT_SCOPE,
  };
}

export async function setIdentityConfig(
  db: Knex,
  patch: { issuer?: unknown; clientId?: unknown; clientSecret?: unknown; redirectPort?: unknown; scope?: unknown },
): Promise<IdentityConfig> {
  const cur = await identityConfig(db);
  const next: IdentityConfig = { ...cur };
  if (patch.issuer !== undefined) next.issuer = parseIssuer(String(patch.issuer));
  if (patch.clientId !== undefined) {
    const id = String(patch.clientId).trim();
    if (!id) fail("BAD_PARAM", "clientId must not be empty");
    next.clientId = id;
  }
  if (patch.clientSecret !== undefined) {
    if (patch.clientSecret === null) next.clientSecret = null;
    else {
      const secret = String(patch.clientSecret).trim();
      next.clientSecret = secret || null;
    }
  }
  if (patch.redirectPort !== undefined) {
    const port = Number(patch.redirectPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("BAD_PARAM", "redirectPort must be 0-65535");
    next.redirectPort = port;
  }
  if (patch.scope !== undefined) {
    const scope = String(patch.scope).trim();
    if (!scope) fail("BAD_PARAM", "scope must not be empty");
    next.scope = scope;
  }
  await db("identity_config")
    .insert({
      id: 1,
      issuer: next.issuer,
      client_id: next.clientId,
      client_secret: next.clientSecret,
      redirect_port: next.redirectPort,
      scope: next.scope,
      updated_at: Date.now(),
    })
    .onConflict("id")
    .merge();
  return next;
}

const discoveryCache = new Map<string, { at: number; endpoints: OidcEndpoints }>();

export async function discover(
  issuer: string,
  opts: { fetchFn?: FetchFn; maxAgeMs?: number } = {},
): Promise<OidcEndpoints> {
  const base = parseIssuer(issuer);
  const cached = discoveryCache.get(base);
  if (cached && Date.now() - cached.at < (opts.maxAgeMs ?? DISCOVERY_TTL_MS)) return cached.endpoints;
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${base}/.well-known/openid-configuration`);
  } catch (e) {
    fail("RAILS", `issuer unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) fail("RAILS", `discovery failed (${res.status})`);
  const doc = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const authorization = str(doc.authorization_endpoint);
  const token = str(doc.token_endpoint);
  const jwks = str(doc.jwks_uri);
  if (!authorization || !token || !jwks) fail("RAILS", "issuer discovery missing required endpoints");
  const endpoints: OidcEndpoints = {
    issuer: base,
    authorization,
    token,
    jwks,
    revocation: str(doc.revocation_endpoint) || null,
  };
  discoveryCache.set(base, { at: Date.now(), endpoints });
  return endpoints;
}

async function fetchJwks(url: string, fetchFn: FetchFn): Promise<JsonWebKey[]> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    fail("RAILS", `jwks unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) fail("RAILS", `jwks failed (${res.status})`);
  const doc = (await res.json().catch(() => ({}))) as { keys?: unknown };
  const keys = Array.isArray(doc.keys) ? (doc.keys as JsonWebKey[]) : [];
  if (!keys.length) fail("RAILS", "jwks has no keys");
  return keys;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function publicKeyFor(key: JsonWebKey): KeyObject {
  try {
    return createPublicKey({ key, format: "jwk" });
  } catch {
    fail("BAD_TOKEN", "jwks key is not usable");
  }
}

export async function verifyIdToken(
  idToken: string,
  opts: { issuer: string; clientId: string; nonce?: string; keys: JsonWebKey[]; now?: number },
): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) fail("BAD_TOKEN", "id_token is not a JWT");
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];
  const header = b64urlJson(rawHeader);
  const payload = b64urlJson(rawPayload);
  const alg = str(header.alg);
  if (alg !== "ES256" && alg !== "RS256") fail("BAD_TOKEN", `unsupported id_token alg ${alg || "?"}`);
  const key = opts.keys.find((k) => (k as { kid?: string }).kid === header.kid) ?? opts.keys[0];
  if (!key) fail("BAD_TOKEN", "id_token key id not found in jwks");
  const pub = publicKeyFor(key);
  const data = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
  const sig = Buffer.from(rawSig, "base64url");
  const ok =
    alg === "ES256"
      ? cryptoVerify("sha256", data, { key: pub, dsaEncoding: "ieee-p1363" }, sig)
      : cryptoVerify("sha256", data, pub, sig);
  if (!ok) fail("BAD_TOKEN", "id_token signature is invalid");
  if (str(payload.iss) !== opts.issuer) fail("BAD_TOKEN", "id_token issuer mismatch");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.map(String).includes(opts.clientId)) fail("BAD_TOKEN", "id_token audience mismatch");
  const now = opts.now ?? Date.now();
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) fail("BAD_TOKEN", "id_token is expired");
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) fail("BAD_TOKEN", "id_token nonce mismatch");
  return payload;
}

async function authenticatedPost(
  url: string,
  form: URLSearchParams,
  clientId: string,
  clientSecret: string | null,
  fetchFn: FetchFn,
): Promise<Record<string, unknown>> {
  const attempts: Array<{ headers: Record<string, string>; body: URLSearchParams }> = [];
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    attempts.push({ headers: { "content-type": FORM, authorization: `Basic ${basic}` }, body: new URLSearchParams(form) });
  }
  attempts.push({ headers: { "content-type": FORM }, body: new URLSearchParams(form) });
  let last: Response | null = null;
  let detail = "";
  for (const attempt of attempts) {
    let res: Response;
    try {
      res = await fetchFn(url, { method: "POST", headers: attempt.headers, body: attempt.body });
    } catch (e) {
      fail("RAILS", `issuer unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.id_token === "string") return body;
      if (url.includes("/revoke")) return body;
      fail("TOKEN", `token response missing id_token`);
    }
    last = res;
    detail = await res.text().catch(() => "");
    if (res.status !== 401 && res.status !== 400) break;
  }
  fail("TOKEN", `issuer rejected the request (${last?.status ?? "?"})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
}

function sessionFromRow(row: Record<string, unknown>): IdentitySession {
  return {
    issuer: str(row.issuer),
    clientId: str(row.client_id),
    sub: str(row.sub),
    handle: str(row.handle),
    name: str(row.name),
    picture: str(row.picture),
    profile: str(row.profile),
    twetchPubkey: str(row.twetch_pubkey),
    email: typeof row.email === "string" && row.email ? row.email : null,
    emailVerified: row.email_verified === 1,
    idToken: str(row.id_token),
    accessToken: str(row.access_token),
    refreshToken: typeof row.refresh_token === "string" && row.refresh_token ? row.refresh_token : null,
    scopes: str(row.scopes),
    expiresAt: Number(row.expires_at),
    walletIdentityKey: typeof row.wallet_identity_key === "string" && row.wallet_identity_key ? row.wallet_identity_key : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function sessionRow(db: Knex): Promise<Record<string, unknown> | undefined> {
  return (await db("identity_session").where({ id: 1 }).first()) as Record<string, unknown> | undefined;
}

export async function currentSession(
  db: Knex,
  opts: { fetchFn?: FetchFn; refreshSkewMs?: number } = {},
): Promise<IdentitySession | null> {
  const row = await sessionRow(db);
  if (!row) return null;
  let session = sessionFromRow(row);
  // Login often happens while the daemon is locked (the default), so the
  // binding fills in the first time the wallet identity is available.
  if (!session.walletIdentityKey) {
    const status = await getStatus();
    if (status.identityKey) {
      await db("identity_session")
        .where({ id: 1 })
        .update({ wallet_identity_key: status.identityKey, updated_at: Date.now() });
      session = { ...session, walletIdentityKey: status.identityKey };
    }
  }
  const skew = opts.refreshSkewMs ?? REFRESH_SKEW_MS;
  if (session.expiresAt - skew > Date.now()) return session;
  if (!session.refreshToken) return { ...session, stale: true };
  const fetchFn = opts.fetchFn ?? fetch;
  const cfg = await identityConfig(db);
  const secret = cfg.clientId === session.clientId ? cfg.clientSecret : null;
  try {
    const endpoints = await discover(session.issuer, { fetchFn });
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    const tokens = (await authenticatedPost(endpoints.token, form, session.clientId, secret, fetchFn)) as unknown as TokenSet;
    const now = Date.now();
    let claims: Record<string, unknown> | null = null;
    if (typeof tokens.id_token === "string") {
      const keys = await fetchJwks(endpoints.jwks, fetchFn);
      claims = await verifyIdToken(tokens.id_token, { issuer: session.issuer, clientId: session.clientId, keys });
    }
    const update: Record<string, unknown> = {
      id_token: tokens.id_token,
      access_token: str(tokens.access_token) || session.accessToken,
      refresh_token: str(tokens.refresh_token) || session.refreshToken,
      expires_at: now + Number(tokens.expires_in ?? 3600) * 1000,
      updated_at: now,
    };
    if (claims) {
      update.handle = str(claims.preferred_username) || session.handle;
      update.name = str(claims.name) || session.name;
      update.picture = str(claims.picture) || session.picture;
      update.profile = str(claims.profile) || session.profile;
      update.twetch_pubkey = str(claims.twetch_pubkey) || session.twetchPubkey;
    }
    await db("identity_session").where({ id: 1 }).update(update);
    const refreshed = await sessionRow(db);
    return refreshed ? sessionFromRow(refreshed) : null;
  } catch {
    return { ...session, stale: true };
  }
}

interface PendingLogin {
  status: "pending" | "done" | "error";
  authUrl: string;
  redirectUri: string;
  expiresAt: number;
  error: { code: string; message: string } | null;
  close: () => void;
}

let pending: PendingLogin | null = null;

export async function startLogin(
  db: Knex,
  opts: {
    issuer?: string;
    clientId?: string;
    clientSecret?: string | null;
    redirectPort?: number;
    scope?: string;
    fetchFn?: FetchFn;
    timeoutMs?: number;
    force?: boolean;
  } = {},
): Promise<{ authUrl: string; redirectUri: string; expiresAt: number }> {
  const cfg = await identityConfig(db);
  const issuer = parseIssuer(opts.issuer ?? cfg.issuer);
  const clientId = (opts.clientId ?? cfg.clientId).trim();
  const clientSecret = opts.clientSecret !== undefined ? opts.clientSecret : cfg.clientSecret;
  const scope = (opts.scope ?? cfg.scope).trim();
  const port = opts.redirectPort ?? cfg.redirectPort;
  if (!clientId) {
    fail("SETUP_REQUIRED", "no Twetch client registered — create one at the issuer /console, then run: bsv login --client-id=<id>");
  }
  if (!opts.force) {
    const existing = await sessionRow(db);
    const expiresAt = Math.floor(Number(existing?.expires_at) || 0);
    if (existing && expiresAt > Date.now() + 60_000) {
      fail("ALREADY", "already signed in — run bsv logout first (or bsv login --force)");
    }
  }
  if (pending && pending.status === "pending") cancelLogin();
  const fetchFn = opts.fetchFn ?? fetch;
  const endpoints = await discover(issuer, { fetchFn });
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");

  let server: Server;
  let actualPort = 0;
  server = createServer((req, res) => void handleCallback(req, res));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        actualPort = addr.port;
        resolve();
      });
    });
  } catch (e) {
    fail("PORT_BUSY", `cannot listen on 127.0.0.1:${port} — ${e instanceof Error ? e.message : String(e)}`);
  }
  const redirectUri = `http://127.0.0.1:${actualPort}/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authUrl = `${endpoints.authorization}?${params.toString()}`;
  const timeoutMs = opts.timeoutMs ?? LOGIN_TTL_MS;
  const expiresAt = Date.now() + timeoutMs;

  const timer = setTimeout(() => {
    if (pending?.authUrl === authUrl) {
      pending.status = "error";
      pending.error = { code: "TIMEOUT", message: "login timed out — run bsv login again" };
      pending.close();
    }
  }, timeoutMs);
  timer.unref?.();

  pending = {
    status: "pending",
    authUrl,
    redirectUri,
    expiresAt,
    error: null,
    close: () => {
      clearTimeout(timer);
      try {
        server.close();
        server.closeIdleConnections?.();
      } catch {
        /* ignore */
      }
    },
  };

  function respond(res: ServerResponse, status: number, title: string, body: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font-family:system-ui,sans-serif;background:#0c0c0d;color:#f4f1ea;display:grid;place-items:center;height:100vh;margin:0">` +
        `<main style="max-width:34rem;padding:2rem;text-align:center"><h1 style="font-size:1.25rem">${title}</h1><p style="opacity:.8">${body}</p></main>` +
        `</body></html>`,
    );
  }

  async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const finishError = (code: string, message: string): void => {
      if (pending?.authUrl === authUrl) {
        pending.status = "error";
        pending.error = { code, message };
      }
      respond(res, 400, "Twetch sign-in failed", message);
      res.on("finish", () => {
        if (pending?.authUrl === authUrl) pending.close();
      });
    };
    const gotState = url.searchParams.get("state") ?? "";
    if (!safeEq(gotState, state)) {
      finishError("STATE", "state mismatch — run bsv login again");
      return;
    }
    const providerError = url.searchParams.get("error");
    if (providerError) {
      finishError("DENIED", `Twetch returned ${providerError}: ${url.searchParams.get("error_description") ?? ""}`.trim());
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code) {
      finishError("BAD_PARAM", "no authorization code in callback");
      return;
    }
    try {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      });
      const tokens = (await authenticatedPost(endpoints.token, form, clientId, clientSecret, fetchFn)) as unknown as TokenSet;
      const keys = await fetchJwks(endpoints.jwks, fetchFn);
      const claims = await verifyIdToken(tokens.id_token, { issuer, clientId, nonce, keys });
      const sub = str(claims.sub);
      if (!sub) fail("BAD_TOKEN", "id_token has no sub");
      const status = await getStatus();
      const now = Date.now();
      const existing = await sessionRow(db);
      await db("identity_session")
        .insert({
          id: 1,
          issuer,
          client_id: clientId,
          sub,
          handle: str(claims.preferred_username),
          name: str(claims.name),
          picture: str(claims.picture),
          profile: str(claims.profile),
          twetch_pubkey: str(claims.twetch_pubkey),
          email: str(claims.email) || null,
          email_verified: claims.email_verified === true ? 1 : 0,
          id_token: tokens.id_token,
          access_token: str(tokens.access_token),
          refresh_token: str(tokens.refresh_token) || null,
          scopes: str(tokens.scope) || scope,
          expires_at: now + Number(tokens.expires_in ?? 3600) * 1000,
          wallet_identity_key: status.identityKey,
          created_at: existing ? Number(existing.created_at) : now,
          updated_at: now,
        })
        .onConflict("id")
        .merge();
      if (pending?.authUrl === authUrl) {
        pending.status = "done";
      }
      respond(res, 200, "Signed in with Twetch", `@${str(claims.preferred_username) || sub} — you can close this window.`);
      res.on("finish", () => {
        if (pending?.authUrl === authUrl) pending.close();
      });
    } catch (e) {
      const codeName = (e as { code?: string }).code ?? "INTERNAL";
      const message = e instanceof Error ? e.message : String(e);
      finishError(codeName, message);
    }
  }

  return { authUrl, redirectUri, expiresAt };
}

export function cancelLogin(): { cancelled: boolean } {
  const wasPending = pending?.status === "pending";
  if (wasPending && pending) pending.close();
  if (pending?.status === "pending") pending = null;
  return { cancelled: wasPending };
}

export async function loginStatus(db: Knex): Promise<{
  state: "idle" | "pending" | "done" | "error";
  authUrl?: string;
  expiresAt?: number;
  error?: { code: string; message: string } | null;
  session?: IdentitySession | null;
}> {
  if (pending && pending.status === "pending") {
    return { state: "pending", authUrl: pending.authUrl, expiresAt: pending.expiresAt };
  }
  if (pending && pending.status === "error") {
    const error = pending.error;
    pending = null;
    return { state: "error", error };
  }
  const row = await sessionRow(db);
  if (row) return { state: "done", session: sessionFromRow(row) };
  return { state: "idle" };
}

export async function logout(db: Knex, opts: { fetchFn?: FetchFn } = {}): Promise<{ loggedOut: boolean }> {
  const row = await sessionRow(db);
  cancelLogin();
  if (!row) return { loggedOut: false };
  if (typeof row.refresh_token === "string" && row.refresh_token) {
    try {
      const cfg = await identityConfig(db);
      const secret = cfg.clientId === str(row.client_id) ? cfg.clientSecret : null;
      const endpoints = await discover(str(row.issuer), { fetchFn: opts.fetchFn });
      if (endpoints.revocation) {
        const form = new URLSearchParams({
          token: row.refresh_token,
          token_type_hint: "refresh_token",
          client_id: str(row.client_id),
        });
        await authenticatedPost(endpoints.revocation, form, str(row.client_id), secret, opts.fetchFn ?? fetch);
      }
    } catch {
      /* best effort — local sign-out must never fail on the network */
    }
  }
  await db("identity_session").where({ id: 1 }).del();
  return { loggedOut: true };
}
