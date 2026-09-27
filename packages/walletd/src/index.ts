/**
 * bsv-walletd entry: HTTPS on 127.0.0.1:2121 (pinned self-signed cert) +
 * Unix socket at $XDG_RUNTIME_DIR/bsv-walletd.sock. Same JSON-RPC shape on both.
 */
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";
import { dispatch, setBackend, setP2P, setTorrents } from "./rpc.ts";
import { resolveRunnerAppFile } from "./apps.ts";
import { VERSION } from "./rpc.ts";
import { CombinedProvider } from "./chain.ts";
import { dataDir, migrate, openDb } from "./storage.ts";
import { P2PNode, P2P_DEFAULT_PORT, P2P_DISCOVERY_PORT, custodyP2PCrypto } from "./p2p.ts";
import { TorrentService } from "./torrents.ts";
import { storeInboundEnvelope } from "./msgs.ts";
import { ingestPost, onBoardPost } from "./boards.ts";
import { selfAddress } from "./custody.ts";
import { announcedName, learnAddress, profileName, rememberAnnouncedName } from "./people.ts";
import { createBrc100Wallet, type Brc100Context } from "./brc100.ts";
import { check } from "./policy.ts";
import { stringifyBRC100, WalletWireProcessor } from "@bsv/sdk";
import type { Knex } from "knex";
import type { ChainProvider } from "./chain.ts";
import { tick } from "./monitor.ts";
import { tickOrders } from "./nightshift.ts";
import { buildPost, getBoard, getPosts, publishPost } from "./boards.ts";
import { identityPubkeyHex } from "./custody.ts";
import { liveRelay } from "./msgs.ts";
import { CAST_BOARD, MAX_SEGMENT_BYTES, MAX_UPLOAD_BYTES, bumpLiveSegments, getLive, liveDir, liveFileValid, liveIdValid, livePlaylist, mediaExt, mediaFileValid, mediaRoot, newMediaId, sessionBeats, sessionsDue, setLiveMime } from "./cast.ts";
import { spendTo } from "./engine.ts";
import { streamBeatRef, tickStreams } from "./streams.ts";
import { tickCapsules } from "./capsule.ts";

const PORT = Number(process.env.BSV_WALLETD_PORT ?? 2121);
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? path.join(os.homedir(), ".local/share/bsv-os");
const SOCK = path.join(RUNTIME_DIR, "bsv-walletd.sock");
const CERT_DIR = path.join(os.homedir(), ".local/share/bsv-os");

function certPaths(): Promise<{ key: string; cert: string }> {
  return (async () => {
    fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    const key = path.join(CERT_DIR, "walletd.key");
    const cert = path.join(CERT_DIR, "walletd.crt");
    if (!fs.existsSync(key) || !fs.existsSync(cert)) {
      const pems = await selfsigned.generate([{ name: "commonName", value: "bsv-walletd" }], {
        keySize: 2048,
        algorithm: "sha256",
        days: 825,
      });
      fs.writeFileSync(key, pems.private, { mode: 0o600 });
      fs.writeFileSync(cert, pems.cert, { mode: 0o600 });
    }
    return { key, cert };
  })();
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as unknown) : {};
}

async function readBytes(req: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

let wireBackend: { db: Knex; chain: ChainProvider } | null = null;

/** Wired by main() next to setBackend; the /w/:call surface stays dead without it. */
export function setWireBackend(b: { db: Knex; chain: ChainProvider } | null): void {
  wireBackend = b;
}

/** Loopback peers (incl. IPv4-mapped IPv6) may use the wallet RPC; anyone else is a buyer. */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** POST /cast/media — store one recording, return its playback URL. */
async function castUploadHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ext = mediaExt(req.headers["content-type"] ?? "");
  if (!ext) return json(415, { error: { code: "BAD_TYPE", message: "recording must be video/webm, video/mp4, audio/webm, audio/mp4, audio/mpeg, or audio/ogg" } });
  const announced = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(announced) && announced > MAX_UPLOAD_BYTES) {
    return json(413, { error: { code: "TOO_BIG", message: "recording exceeds 256 MiB" } });
  }
  const buf = await readBytes(req);
  if (buf.length === 0) return json(400, { error: { code: "BAD_PARAM", message: "empty body" } });
  if (buf.length > MAX_UPLOAD_BYTES) return json(413, { error: { code: "TOO_BIG", message: "recording exceeds 256 MiB" } });
  const name = `${newMediaId()}${ext}`;
  try {
    fs.mkdirSync(mediaRoot(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(mediaRoot(), name), buf, { mode: 0o600 });
  } catch {
    return json(500, { error: { code: "STORE", message: "could not store recording" } });
  }
  json(200, { id: name, url: `/cast/media/${name}`, bytes: buf.length, mime: (req.headers["content-type"] ?? "").split(";")[0] });
}

/** GET /cast/media/<file> — playback with range support for seeking. */
function castMediaHttp(req: IncomingMessage, res: ServerResponse, name: string): void {
  const fail = (status: number, message: string): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  };
  if (!mediaFileValid(name)) return fail(404, "not found");
  const file = path.join(mediaRoot(), name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return fail(404, "not found");
  } catch {
    return fail(404, "not found");
  }
  const mime = name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".webm") ? "video/webm" : name.endsWith(".m4a") ? "audio/mp4" : name.endsWith(".mp3") ? "audio/mpeg" : "audio/ogg";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!range) {
    res.writeHead(200, { "content-type": mime, "content-length": stat.size, "accept-ranges": "bytes", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= stat.size) {
    res.writeHead(416, { "content-range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    "content-type": mime, "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "accept-ranges": "bytes", "cache-control": "no-store",
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

/** POST /cast/live/<id>/segment[?init=1] — append one ingest chunk. */
async function castSegmentHttp(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!wireBackend) return json(503, { error: "wallet engine offline" });
  if (!liveIdValid(id)) return json(404, { error: "not found" });
  let live;
  try {
    live = await getLive(wireBackend.db, id);
  } catch {
    return json(404, { error: "not found" });
  }
  if (live.status !== "live") return json(409, { error: { code: "BAD_STATE", message: "broadcast ended" } });
  const url = new URL(req.url ?? "/", "https://wallet");
  const isInit = url.searchParams.get("init") === "1";
  const announced = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(announced) && announced > MAX_SEGMENT_BYTES) {
    return json(413, { error: { code: "TOO_BIG", message: "segment exceeds 8 MiB" } });
  }
  const buf = await readBytes(req);
  if (buf.length === 0 || buf.length > MAX_SEGMENT_BYTES) {
    return json(buf.length === 0 ? 400 : 413, { error: { code: "BAD_PARAM", message: "bad segment" } });
  }
  const dir = liveDir(id);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (isInit) {
      // Sanity: init must open a real container (ftyp = mp4, EBML = webm).
      const isMp4 = buf.length > 8 && buf.subarray(4, 8).toString("latin1") === "ftyp";
      const isWebm = buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
      if (!isMp4 && !isWebm) return json(400, { error: { code: "BAD_PARAM", message: "init chunk is not mp4/webm" } });
      fs.writeFileSync(path.join(dir, "init.mp4"), buf, { mode: 0o600 });
      const mime = url.searchParams.get("mime") ?? "";
      if (mime) {
        try {
          await setLiveMime(wireBackend.db, id, mime);
        } catch {
          /* mime is advisory; the bytes decide playback */
        }
      }
      return json(200, { segment: "init.mp4", bytes: buf.length });
    }
    const n = await bumpLiveSegments(wireBackend.db, id);
    fs.writeFileSync(path.join(dir, `seg-${n}.m4s`), buf, { mode: 0o600 });
    json(200, { segment: `seg-${n}.m4s`, bytes: buf.length });
  } catch (e) {
    json(500, { error: e instanceof Error ? e.message : "store failed" });
  }
}

/** GET /cast/live/<id>/<file> — rolling playlist, init, or one segment. */
function castLiveFileHttp(req: IncomingMessage, res: ServerResponse, id: string, file: string): void {
  const fail = (status: number, message: string): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  };
  if (!wireBackend) return fail(503, "wallet engine offline");
  if (!liveIdValid(id) || !liveFileValid(file)) return fail(404, "not found");
  void (async () => {
    try {
      const live = await getLive(wireBackend!.db, id);
      if (file === "index.m3u8") {
        const body = livePlaylist(live.segments, live.status === "ended");
        res.writeHead(200, {
          "content-type": "application/vnd.apple.mpegurl", "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      const fp = path.join(liveDir(id), file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fp);
        if (!stat.isFile()) return fail(404, "not found");
      } catch {
        return fail(404, "not found");
      }
      const mime = file.endsWith(".m4s") ? "video/iso.segment" : "video/mp4";
      res.writeHead(200, { "content-type": mime, "content-length": stat.size, "cache-control": "no-store" });
      fs.createReadStream(fp).pipe(res);
    } catch {
      fail(404, "not found");
    }
  })();
}

/**
 * Public seller manifest for x402market verification + listing. Base URL
 * comes from BSV_SERVE_PUBLIC (the tunnel/WAN address) falling back to the
 * request host — the verifier probes the paid tool path absolutely.
 */
async function serveManifestHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!wireBackend) return json(503, { error: "wallet engine offline" });
  const { serveMenu } = await import("./serve.ts");
  const menu = await serveMenu(wireBackend.db).catch(() => null);
  if (!menu) return json(503, { error: "wallet locked" });
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  const base = (process.env.BSV_SERVE_PUBLIC ?? `https://${host}`).replace(/\/+$/, "");
  json(200, {
    name: "bsvOS wallet answers",
    tagline: "Calibrated Jev decisions and agent memory recall, settled in sats.",
    baseUrl: base,
    payTo: menu[0]?.payTo ?? "",
    network: "bsv:mainnet",
    tools: menu.filter((m) => m.priceSats > 0).map((m) => ({
      name: m.method === "jevDecide" ? "decide" : m.method === "memoryRecall" ? "recall" : m.method,
      method: "POST",
      path: `${base}/v1/serve/${m.method}`,
      priceSats: m.priceSats,
      paid: true,
      description: m.description,
      body: m.method === "jevDecide" ? "{state, questions}" : "{query?, tag?, limit?}",
    })),
  });
}

/**
 * Paid method dispatch for remote buyers. No proof → 402 + quote headers.
 * PAYMENT-SIGNATURE proof → verify/broadcast/serve. Errors that mean "not
 * paid" stay 402 (no money moved or claim recorded); method failures are
 * 400/500 only after a claim is recorded.
 */
async function serveHttp(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  const json = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  };
  if (!wireBackend) return json(503, { error: { code: "NO_BACKEND", message: "wallet engine offline" } });
  let body: unknown = {};
  try {
    body = await readJson(req);
  } catch {
    return json(400, { error: { code: "PARSE", message: "invalid JSON" } });
  }
  const { serveMenu, servePrice, serveCall, serveRequirement, b64json, parseProof } = await import("./serve.ts");
  const menu = await serveMenu(wireBackend.db).catch(() => null);
  const item = menu?.find((m) => m.method === method);
  if (!item) return json(404, { error: { code: "NOT_FOR_SALE", message: `not for sale: ${method}` } });
  const resource = `https://wallet/v1/serve/${method}`;
  const quote = async (): Promise<void> => {
    const q = await servePrice(wireBackend!.db, method);
    json(402, { error: "payment_required", priceSats: q.priceSats, payTo: q.payTo, network: "bsv:mainnet" }, {
      "payment-required": b64json(serveRequirement(method, q.priceSats, q.payTo, resource)),
    });
  };
  const sig = req.headers["payment-signature"];
  if (typeof sig !== "string" || !sig) return quote();
  let txHex: string;
  try {
    txHex = parseProof(sig);
  } catch (e) {
    return json(402, { error: { code: (e as { code?: string })?.code ?? "BAD_PROOF", message: e instanceof Error ? e.message : "bad proof" } });
  }
  try {
    const out = await serveCall({ db: wireBackend.db, chain: wireBackend.chain }, method, body, txHex);
    json(200, { data: out.data, receipt: out.receipt }, {
      "payment-response": b64json({ success: true, ...out.receipt }),
    });
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "INTERNAL";
    if (code === "BAD_PROOF" || code === "REPLAY" || code === "UNPAID") {
      return json(402, { error: { code, message: e instanceof Error ? e.message : code } });
    }
    json(code === "BAD_PARAM" || code === "BAD_METHOD" || code === "NOT_FOUND" ? 400 : 500, {
      error: { code, message: code === "INTERNAL" ? "serve failed" : (e instanceof Error ? e.message : code) },
    });
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    vary: "Origin",
  };
}

/**
 * BRC-100 wire call codes (WalletWireCalls, @bsv/sdk 2.6.0 — wire-stable
 * by design). The HTTP transport posts payload-only bodies to /w/:call,
 * so the daemon rebuilds the frame: [code][olen][originator][payload].
 */
const WIRE_CALL_CODES: Record<string, number> = {
  createAction: 1,
  signAction: 2,
  abortAction: 3,
  listActions: 4,
  internalizeAction: 5,
  listOutputs: 6,
  relinquishOutput: 7,
  getPublicKey: 8,
  revealCounterpartyKeyLinkage: 9,
  revealSpecificKeyLinkage: 10,
  encrypt: 11,
  decrypt: 12,
  createHmac: 13,
  verifyHmac: 14,
  createSignature: 15,
  verifySignature: 16,
  acquireCertificate: 17,
  listCertificates: 18,
  proveCertificate: 19,
  relinquishCertificate: 20,
  discoverByIdentityKey: 21,
  discoverByAttributes: 22,
  isAuthenticated: 23,
  waitForAuthentication: 24,
  getHeight: 25,
  getHeader: 26,
  getNetwork: 27,
  getVersion: 28,
};

function originHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Bundled runner apps served from the daemon's own origin. */
const RUNNER_APPS = new Set(["twetch", "explorer", "colosseum", "cast"]);

function runnerAppDir(name: string): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    name === "twetch" ? process.env.BSV_TWETCH_APP_DIR : undefined,
    process.env.BSV_RUNNER_APPS_DIR ? path.join(process.env.BSV_RUNNER_APPS_DIR, name) : undefined,
    path.resolve(here, `../../runner/apps/${name}`),
    `/usr/share/bsv-os/runner/apps/${name}`,
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

const JSON_API_PORT = Number(process.env.BSV_WALLETD_JSON_PORT ?? 3321);
const JSON_BODY_LIMIT = 1024 * 1024;
const JSON_METHODS = new Map(Object.keys(WIRE_CALL_CODES).map((method) => [method, method]));
JSON_METHODS.set("getHeaderForHeight", "getHeader");
const JSON_PUBLIC_METHODS = new Set(["getVersion", "getNetwork", "getHeight", "getHeader"]);

async function readJsonApiBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const tooLarge = () => Object.assign(new Error("JSON body exceeds 1 MiB"), { status: 413 });
  if (Number(req.headers["content-length"]) > JSON_BODY_LIMIT) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += chunk.length;
    if (size > JSON_BODY_LIMIT) throw tooLarge();
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("JSON body must be an object"), { status: 400 });
  }
  return body as Record<string, unknown>;
}

export function jsonApiHandler(backend?: Brc100Context) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let headers: Record<string, string> = { "content-type": "application/json", vary: "Origin" };
    const reply = (status: number, body: unknown): void => {
      const json = stringifyBRC100(body);
      req.resume();
      res.writeHead(status, headers);
      res.end(json);
    };
    try {
      const origin = req.headers.origin;
      let parsed: URL;
      try {
        if (typeof origin !== "string") throw new Error();
        parsed = new URL(origin);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin ||
            !parsed.hostname || parsed.host.length > 200) throw new Error();
      } catch {
        reply(403, { message: "missing or malformed Origin", code: "FORBIDDEN_ORIGIN" });
        return;
      }
      headers = { ...headers, ...corsHeaders(origin) };
      const route = (req.url ?? "/").split("?")[0]!;
      const method = JSON_METHODS.get(route.slice(1));
      if (!route.startsWith("/") || !method) {
        reply(404, { error: `Unknown wallet path: ${route}` });
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        reply(405, { message: "POST only" });
        return;
      }
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        reply(415, { message: "Content-Type must be application/json" });
        return;
      }
      const args = await readJsonApiBody(req);
      const ctx = backend ?? (wireBackend ? { ...wireBackend, fetchFn: fetch } : null);
      if (!ctx) {
        reply(503, { message: "wallet engine offline" });
        return;
      }
      const originator = parsed.host;
      if (!JSON_PUBLIC_METHODS.has(method)) {
        const gate = await check(ctx.db, originator, 0, `brc100-json-${method}`);
        if (gate.verdict !== "allow") {
          reply(403, { message: `POLICY_DENY: ${gate.reason}`, code: "POLICY_DENY" });
          return;
        }
      }
      if (method === "signAction" && typeof args.reference === "string") {
        const staged = await ctx.db("brc100_pending").where({ reference: args.reference }).first();
        if (staged) {
          const context = JSON.parse(staged.context) as { origin: string; external: number; fee: number };
          const amount = context.external + context.fee;
          if (context.origin !== originator || !Number.isSafeInteger(amount) || amount < 0) {
            reply(403, { message: "POLICY_DENY: action owner mismatch or invalid spend", code: "POLICY_DENY" });
            return;
          }
          const gate = await check(ctx.db, originator, amount, "brc100-action");
          if (gate.verdict !== "allow") {
            reply(403, { message: `POLICY_DENY: ${gate.reason}`, code: "POLICY_DENY" });
            return;
          }
        }
      }
      const wallet = createBrc100Wallet(ctx);
      const out = await wallet[method](args, originator);
      reply(200, method === "waitForAuthentication" ? { authenticated: true } : out ?? {});
    } catch (e) {
      const error = e as { status?: number; code?: unknown; message?: string };
      const code = typeof error?.code === "string" && error.message?.startsWith(`${error.code}:`)
        ? error.code : undefined;
      const status = error?.status ?? (code === "POLICY_DENY" ? 403 : code ? 400 : 500);
      reply(status, { message: status === 500 ? "wallet request failed" : error.message, ...(code ? { code } : {}) });
    }
  };
}

export async function listenJsonApi(port = JSON_API_PORT, backend?: Brc100Context): Promise<http.Server> {
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, jsonApiHandler(backend));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

function handler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    // x402 seller surface: POST /v1/serve/<method> with a JSON body.
    // No proof → 402 + payment-required quote. PAYMENT-SIGNATURE proof →
    // verify, broadcast, serve. Payment is the only auth here, so this
    // route stays open to non-loopback peers (see gating below) while the
    // wallet JSON-RPC never leaves loopback.
    // GET /v1/serve/manifest is the x402market seller manifest (public).
    if (req.method === "GET" && typeof req.url === "string" && req.url.split("?")[0] === "/v1/serve/manifest") {
      await serveManifestHttp(req, res);
      return;
    }
    const serveMatch =
      req.method === "POST" && typeof req.url === "string"
        ? /^\/v1\/serve\/([A-Za-z0-9_]+)(\?[^?]*)?$/.exec(req.url.split("?")[0]!)
        : null;
    if (serveMatch) {
      await serveHttp(req, res, serveMatch[1]!);
      return;
    }
    if (!isLoopbackPeer(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "FORBIDDEN", message: "wallet RPC is loopback-only; remote buyers use /v1/serve/<method>" } }));
      return;
    }
    // Cast media store: recordings upload here, live segments append here,
    // playback streams back with range support. Loopback-only by the gate
    // above — the browser recorder and the player are local.
    const castRoute = typeof req.url === "string" ? req.url.split("?")[0]! : "";
    if (castRoute === "/cast/media" && req.method === "POST") {
      await castUploadHttp(req, res);
      return;
    }
    {
      const m = /^\/cast\/media\/([A-Za-z0-9._-]+)$/.exec(castRoute);
      if (m && req.method === "GET") {
        castMediaHttp(req, res, m[1]!);
        return;
      }
    }
    {
      const m = /^\/cast\/live\/([A-Za-z0-9-]+)\/segment$/.exec(castRoute);
      if (m && req.method === "POST") {
        await castSegmentHttp(req, res, m[1]!);
        return;
      }
    }
    {
      const m = /^\/cast\/live\/([A-Za-z0-9-]+)\/([^/]+)$/.exec(castRoute);
      if (m && req.method === "GET") {
        castLiveFileHttp(req, res, m[1]!, m[2]!);
        return;
      }
    }
    // Bundled Twetch companion app: static files served from the daemon's
    // own HTTPS origin, so the page's JSON-RPC calls are same-origin and
    // the pinned loopback cert already covers it. Domain "localhost" keys
    // the runner app; nothing here touches custody or the app bridge.
    const appMatch =
      req.method === "GET" && typeof req.url === "string"
        ? /^\/([a-z0-9-]+)(\/[^?]*)?/.exec(req.url.split("?")[0]!)
        : null;
    if (appMatch && RUNNER_APPS.has(appMatch[1]!)) {
      const name = appMatch[1]!;
      const dir = runnerAppDir(name);
      const asset = dir ? resolveRunnerAppFile(dir, appMatch[2] ?? "/") : null;
      if (!asset) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      try {
        const body = fs.readFileSync(asset.file);
        res.writeHead(200, { "content-type": asset.mime, "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("app bundle unreadable");
      }
      return;
    }
    // BRC-100 wire surface: the HTTP transport posts payload-only bodies
    // to /w/:call (originator travels in the Origin header, browser-
    // stamped and unspoofable). The daemon rebuilds the standard frame
    // and runs it through WalletWireProcessor, so off-the-shelf
    // WalletClients interoperate with zero adaptation.
    if (typeof req.url === "string" && req.url.startsWith("/w/")) {
      const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", ...corsHeaders(origin) });
        res.end(JSON.stringify({ error: "POST only" }));
        return;
      }
      if (!wireBackend) {
        res.writeHead(503, { "content-type": "application/json", ...corsHeaders(origin) });
        res.end(JSON.stringify({ error: { code: "NO_BACKEND", message: "wallet engine offline" } }));
        return;
      }
      const call = req.url.slice(3).split("?")[0]!;
      const code = WIRE_CALL_CODES[call];
      if (code === undefined) {
        res.writeHead(404, { "content-type": "application/json", ...corsHeaders(origin) });
        res.end(JSON.stringify({ error: { code: "BAD_METHOD", message: `unknown wire call ${call}` } }));
        return;
      }
      const originator = originHost(origin) ?? "unknown";
      const payload = await readBytes(req);
      const originatorBytes = Buffer.from(originator, "utf8");
      if (originatorBytes.length > 255) {
        res.writeHead(400, { "content-type": "application/json", ...corsHeaders(origin) });
        res.end(JSON.stringify({ error: { code: "BAD_PARAM", message: "originator too long" } }));
        return;
      }
      const frame = Buffer.concat([Buffer.from([code, originatorBytes.length]), originatorBytes, payload]);
      try {
        const wallet = createBrc100Wallet({ db: wireBackend.db, chain: wireBackend.chain, fetchFn: fetch });
        const processor = new WalletWireProcessor(wallet as never);
        const out = await processor.transmitToWalletUint8Array(frame);
        res.writeHead(200, { "content-type": "application/octet-stream", ...corsHeaders(origin) });
        res.end(Buffer.from(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json", ...corsHeaders(origin) });
        res.end(JSON.stringify({ error: { code: "WIRE", message: e instanceof Error ? e.message : String(e) } }));
      }
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "POST only" }));
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "PARSE", message: "invalid JSON" }, id: null }));
      return;
    }
    const out = await dispatch(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  };
}

export async function main(): Promise<void> {
  const { key, cert } = await certPaths();
  const options = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const serve = handler();

  const tlsServer = https.createServer(options, serve);
  // Loopback by default. Set BSV_WALLETD_BIND=0.0.0.0 (LAN/VPN) to sell
  // x402 methods to remote buyers — the wallet JSON-RPC stays loopback-only
  // regardless (see isLoopbackPeer); only /health + /v1/serve/* answer remotely.
  const bindHost = process.env.BSV_WALLETD_BIND ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    tlsServer.once("error", reject);
    tlsServer.listen(PORT, bindHost, resolve);
  });
  // eslint-disable-next-line no-console
  console.log(`bsv-walletd ${VERSION} https on ${bindHost}:${PORT}`);

  try {
    await listenJsonApi();
  } catch (e) {
    tlsServer.close();
    throw e;
  }
  console.log(`bsv-walletd metanet JSON API on http://127.0.0.1:${JSON_API_PORT}`);

  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    if (fs.existsSync(SOCK)) fs.rmSync(SOCK);
  } catch {
    /* ignore */
  }
  const unix = net.createServer((socket) => {
    let buf = "";
    const unsubs = new Map<string, () => void>();
    socket.on("close", () => {
      for (const off of unsubs.values()) off();
      unsubs.clear();
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      // newline-delimited JSON frames
      const jobs: Array<Promise<void>> = [];
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        type SocketFrame = { id?: unknown; method?: unknown; params?: { boards?: unknown } };
        let parsed: SocketFrame | null = null;
        try {
          parsed = JSON.parse(line) as SocketFrame;
        } catch {
          socket.write(`${JSON.stringify({ error: { code: "PARSE", message: "invalid JSON" }, id: null })}\n`);
          continue;
        }
        // Streaming: boardSubscribe keeps the socket open and pushes events.
        if (parsed?.method === "boardSubscribe") {
          const boards = Array.isArray(parsed.params?.boards)
            ? (parsed.params?.boards as unknown[]).filter((b): b is string => typeof b === "string")
            : [];
          const key = String(parsed.id ?? "1");
          unsubs.get(key)?.();
          unsubs.set(
            key,
            onBoardPost((env) => {
              if (!boards.includes(env.board)) return;
              socket.write(`${JSON.stringify({ event: "board-post", post: env })}\n`);
            }),
          );
          socket.write(`${JSON.stringify({ id: parsed.id ?? null, result: { subscribed: boards } })}\n`);
          continue;
        }
        jobs.push(
          (async () => {
            try {
              socket.write(`${JSON.stringify(await dispatch(parsed))}\n`);
            } catch {
              socket.write(`${JSON.stringify({ error: { code: "PARSE", message: "invalid JSON" }, id: null })}\n`);
            }
          })(),
        );
      }
      void Promise.all(jobs);
    });
  });
  await new Promise<void>((resolve) => {
    unix.listen(SOCK, resolve);
  });
  // eslint-disable-next-line no-console
  console.log(`bsv-walletd socket on ${SOCK}`);

  // Monitor: watch every tracked tx to a terminal state, minutely.
  try {
    const db = openDb();
    await migrate(db);
    const chain = new CombinedProvider();
    setBackend({ db, chain });
    setWireBackend({ db, chain });

    // F6.3 files: BitTorrent listener + torrent registry. Discovery rides
    // the P2P channel (beacon bt port + authenticated "who has it").
    let knownBoards: string[] = [];
    const refreshBoards = async (): Promise<void> => {
      try {
        const rows = (await db("boards").select("name")) as Array<{ name: string }>;
        knownBoards = rows.map((r) => r.name);
      } catch {
        /* pre-migration or transient */
      }
    };
    await refreshBoards();
    setInterval(() => void refreshBoards(), 10_000).unref?.();
    let p2pRef: P2PNode | null = null;
    let torrentService: TorrentService | null = null;
    if (process.env.BSV_TORRENT !== "0") {
      torrentService = new TorrentService({
        db,
        port: Number(process.env.BSV_TORRENT_PORT) || 51413,
        fetchDir: path.join(dataDir(), "torrents"),
        p2p: () => p2pRef,
      });
      await torrentService.start();
      setTorrents(torrentService);
      // eslint-disable-next-line no-console
      console.log(
        torrentService.btPort
          ? `bsv-walletd files on 0.0.0.0:${torrentService.btPort}`
          : "bsv-walletd files disabled (BitTorrent port busy)",
      );
    }

    // F6.2 direct channel: LAN discovery + authenticated TCP sessions.
    // Inbound frames store ciphertext through the same path as the relay.
    if (process.env.BSV_P2P !== "0") {
      rememberAnnouncedName(await profileName(db));
      const p2p = new P2PNode({
        crypto: custodyP2PCrypto,
        port: Number(process.env.BSV_P2P_PORT) || P2P_DEFAULT_PORT,
        discoveryPort: Number(process.env.BSV_P2P_DISCOVERY_PORT) || P2P_DISCOVERY_PORT,
        seeds: process.env.BSV_P2P_PEERS,
        btPort: torrentService?.btPort ?? undefined,
        onTorrents: () => torrentService?.cachedHashes() ?? [],
        boardList: () => knownBoards,
        card: () => {
          try {
            return { payTo: selfAddress(), name: announcedName() };
          } catch {
            return { payTo: "", name: announcedName() };
          }
        },
        onCard: (identityKey, card) => void learnAddress(db, identityKey, card.payTo).catch(() => {}),
        onDm: (id, envelope) => storeInboundEnvelope(db, id, envelope, "p2p"),
        onBoard: async (envelope) => {
          const stored = await ingestPost(db, envelope);
          const env = envelope as { id?: unknown; board?: unknown };
          // eslint-disable-next-line no-console
          console.log(`board: ${String(env.board)} ${String(env.id).slice(0, 12)} ${stored?.fresh ? "stored" : "ignored"}`);
        },
        onBoardQuery: async (board, since) => {
          const rows = (await db("board_posts").where({ board }).where("ts", ">", since).orderBy("ts").limit(200)) as Array<{ envelope: string }>;
          return rows.map((r) => JSON.parse(r.envelope) as unknown);
        },
      });
      try {
        await p2p.start();
        p2pRef = p2p;
        setP2P(p2p);
        const s = p2p.status();
        // eslint-disable-next-line no-console
        console.log(`bsv-walletd p2p on 0.0.0.0:${p2p.port}${s.discovery ? " (LAN discovery on)" : " (discovery unavailable, TCP only)"}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("p2p disabled:", err instanceof Error ? err.message : err);
      }
    } else {
      // eslint-disable-next-line no-console
      console.log("bsv-walletd p2p disabled (BSV_P2P=0)");
    }

    const loop = async (): Promise<void> => {
      try {
        const res = await tick(
          db,
          chain,
          (hex) => chain.broadcast(hex),
          async (txid) => (await db("pending_txs").where({ txid }).first())?.tx_hex ?? null,
        );
        for (const r of res) {
          if (r.to !== "seen") {
            // eslint-disable-next-line no-console
            console.log(`monitor: ${r.txid.slice(0, 12)} ${r.from} -> ${r.to}${r.detail ? ` (${r.detail})` : ""}`);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("monitor tick failed:", err instanceof Error ? err.message : err);
      }
    };
    void loop();
    setInterval(() => void loop(), 60_000).unref?.();

    // NightShift: open due standing-order runs, minutely.
    const shiftLoop = async (): Promise<void> => {
      try {
        const res = await tickOrders(db);
        for (const id of res.orderIds) {
          // eslint-disable-next-line no-console
          console.log(`nightshift: run opened for order ${id}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("nightshift tick failed:", err instanceof Error ? err.message : err);
      }
    };
    void shiftLoop();
    setInterval(() => void shiftLoop(), 60_000).unref?.();

    // Streams: pay fresh heartbeats, auto-pause stale ones, minutely.
    const streamLoop = async (): Promise<void> => {
      try {
        const res = await tickStreams(db, {
          latestBeat: async (s) => {
            const row = await getBoard(db, s.board);
            if (!row) return null;
            const { posts } = await getPosts(db, s.board, { limit: 500, markRead: false });
            const beats = posts.filter((x) => x.refs.includes(streamBeatRef(s.id)) && !x.locked);
            if (!beats.length) return null;
            const top = beats.sort((a, b) => b.ts - a.ts)[0]!;
            return { id: top.id, ts: top.ts };
          },
          pay: async (s, amount, beatId) => {
            const r = await spendTo({
              db, chain, origin: "stream",
              payments: [{ to: s.payee, sats: amount }],
              memo: ["STREAM-PAY", s.id, `beat:${beatId.slice(0, 8)}`],
              label: `stream ${s.name} tick`,
              description: `streamed pay ${amount} sats to ${s.payee} for ${s.name} (heartbeat ${beatId.slice(0, 8)})`,
            });
            return { txid: r.txid, fee: r.fee };
          },
        });
        for (const r of res) {
          if (r.outcome !== "accruing") {
            // eslint-disable-next-line no-console
            console.log(`stream: ${r.stream.slice(0, 12)} ${r.outcome}${r.amount ? ` ${r.amount}sats` : ""}${r.txid ? ` ${r.txid.slice(0, 12)}` : ""}`);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("stream tick failed:", err instanceof Error ? err.message : err);
      }
    };
    void streamLoop();
    setInterval(() => void streamLoop(), 60_000).unref?.();

    // Capsules: auto-pay matured post-dated cheques, minutely.
    const capsuleLoop = async (): Promise<void> => {
      try {
        const res = await tickCapsules({ db, chain });
        for (const r of res) {
          // eslint-disable-next-line no-console
          console.log(`capsule: #${r.capsule} ${r.outcome}${r.txid ? ` ${r.txid.slice(0, 12)}` : ""}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("capsule tick failed:", err instanceof Error ? err.message : err);
      }
    };
    void capsuleLoop();
    setInterval(() => void capsuleLoop(), 60_000).unref?.();

    // Cast: playback beats for open listening sessions, minutely. Beats
    // are local (the streams read the local board); p2p fan-out is skipped.
    const castLoop = async (): Promise<void> => {
      try {
        for (const s of await sessionsDue(db)) {
          const row = await getBoard(db, CAST_BOARD);
          if (!row) continue;
          const elapsedMin = (Date.now() - s.startedAt) / 60_000;
          for (const beat of sessionBeats(s, elapsedMin)) {
            try {
              const env = buildPost({
                board: CAST_BOARD,
                from: identityPubkeyHex(),
                agent: "cast-player",
                keyHex: row.keyHex,
                epoch: row.epoch,
                text: beat.text,
                kind: "artifact",
                refs: beat.refs,
              });
              await publishPost(db, liveRelay(), null, env);
            } catch {
              /* one bad beat never stops the session */
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("cast tick failed:", err instanceof Error ? err.message : err);
      }
    };
    void castLoop();
    setInterval(() => void castLoop(), 60_000).unref?.();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("monitor disabled:", err instanceof Error ? err.message : err);
  }
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  void main().catch((err) => {
    console.error("walletd startup failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
