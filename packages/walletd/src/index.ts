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
const RUNNER_APPS = new Set(["twetch", "explorer", "colosseum"]);

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
  await new Promise<void>((resolve, reject) => {
    tlsServer.once("error", reject);
    tlsServer.listen(PORT, "127.0.0.1", resolve);
  });
  // eslint-disable-next-line no-console
  console.log(`bsv-walletd ${VERSION} https on 127.0.0.1:${PORT}`);

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
