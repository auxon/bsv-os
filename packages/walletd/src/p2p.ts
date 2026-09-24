/**
 * F6.2 peer-to-peer transport: LAN discovery + authenticated direct channels.
 *
 * The relay path (msgs.ts) stays the store-and-forward default; this module
 * adds a direct leg for peers that can see each other. Discovery is a UDP
 * multicast beacon carrying only the identity key + listening port; the
 * channel is a TCP socket whose handshake proves the claimed key with a
 * BRC-42 scoped signature (both directions), so an announced peer is
 * authenticated, not trusted. Message frames carry the exact same envelope
 * and BRC-42 ciphertext as the relay path — the sender is implicit in the
 * key, so decryption authenticates authorship and no plaintext is ever held
 * by this module.
 *
 * Boundaries: crypto lives in custody.ts (via the P2PCrypto adapter — the
 * only seam tests swap), envelope building/storage live in msgs.ts, and
 * inbound frames are handed to an `onDm` callback that must resolve before
 * the frame is acked. A locked wallet fails the handshake closed and stops
 * beaconing; it never signs, encrypts, or decrypts.
 */
import dgram from "node:dgram";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { brc42SignHash, brc42VerifyDigest, identityPubkeyHex } from "./custody.ts";
import type { WalletProtocol } from "@bsv/sdk";

export const P2P_APP = "bsvos-p2p";
export const P2P_VERSION = 1;
export const P2P_PROTOCOL: WalletProtocol = [2, "bsvos p2p v1"];
export const P2P_HANDSHAKE_KEY_ID = "handshake";
export const P2P_DISCOVERY_GROUP = "239.255.66.79";
export const P2P_DISCOVERY_PORT = 21212;
export const P2P_DEFAULT_PORT = 21213;
export const P2P_BEACON_MS = 5_000;
export const P2P_TTL_MS = 30_000;
export const MAX_FRAME_BYTES = 128 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 5_000;
export const ACK_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const MAX_SESSIONS = 32;
export const MAX_INBOUND_PER_MINUTE = 120;

const KEY_RE = /^[0-9a-fA-F]{66}$/;

export interface Beacon {
  v: 1;
  app: typeof P2P_APP;
  identityKey: string;
  port: number;
  name?: string;
  payTo?: string;
  /** BitTorrent listener port (file sharing) when the daemon seeds. */
  bt?: number;
}

const PAY_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,33}$/;

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 24);
}

function cleanPay(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  return PAY_RE.test(s) ? s : "";
}

/** Strict beacon codec: unknown versions/shapes are ignored, never routed. */
export function encodeBeacon(b: Beacon): string {
  return JSON.stringify(b);
}

export function decodeBeacon(raw: string): Beacon | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 768) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  if (o.v !== P2P_VERSION || o.app !== P2P_APP) return null;
  if (typeof o.identityKey !== "string" || !KEY_RE.test(o.identityKey)) return null;
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const name = cleanName(o.name);
  const payTo = cleanPay(o.payTo);
  const btRaw = Number(o.bt);
  const bt = Number.isInteger(btRaw) && btRaw >= 1 && btRaw <= 65535 ? btRaw : 0;
  return {
    v: 1,
    app: P2P_APP,
    identityKey: o.identityKey.toLowerCase(),
    port,
    ...(name ? { name } : {}),
    ...(payTo ? { payTo } : {}),
    ...(bt ? { bt } : {}),
  };
}

/**
 * Both handshake signatures bind role, both parties, and both nonces, so a
 * captured signature cannot be replayed into a different session, role, or
 * peer pair (the BRC-42 scope binds the counterparty a second time).
 */
export function handshakeTranscript(
  role: "initiator" | "responder",
  self: string,
  peer: string,
  initiatorNonce: string,
  responderNonce: string,
  selfPay = "",
  peerPay = "",
  selfName = "",
  peerName = "",
): Buffer {
  return createHash("sha256")
    .update(
      `${P2P_APP}|v${P2P_VERSION}|${role}|${self.toLowerCase()}|${peer.toLowerCase()}|${initiatorNonce}|${responderNonce}|${selfPay}|${peerPay}|${selfName}|${peerName}`,
    )
    .digest();
}

/** Crypto seam: production is custody, tests swap in-process key roots. */
export interface P2PCrypto {
  available(): boolean;
  identity(): string;
  sign(counterparty: string, digest: Buffer): Buffer;
  verify(signer: string, digest: Buffer, sig: Buffer): boolean;
}

export const custodyP2PCrypto: P2PCrypto = {
  available: () => {
    try {
      identityPubkeyHex();
      return true;
    } catch {
      return false;
    }
  },
  identity: () => identityPubkeyHex(),
  sign: (counterparty, digest) =>
    Buffer.from(brc42SignHash(P2P_PROTOCOL, P2P_HANDSHAKE_KEY_ID, counterparty, [...digest])),
  verify: (signer, digest, sig) =>
    brc42VerifyDigest(P2P_PROTOCOL, P2P_HANDSHAKE_KEY_ID, signer, false, [...digest], [...sig]),
};

export interface PeerInfo {
  identityKey: string;
  address: string;
  port: number;
  lastSeen: number;
  online: boolean;
  name: string;
  payTo: string;
  nameVerified: boolean;
  /** BitTorrent listener port advertised by the peer (0 = none). */
  btPort: number;
}

export interface PeerSeed {
  identityKey: string;
  address: string;
  port: number;
}

/**
 * Static seeds for networks where multicast cannot reach the peer (VPNs,
 * filtered LANs): `66hex@host:port`, comma/space separated. Invalid entries
 * are ignored — a malformed config must never take the daemon down.
 */
export function parsePeerSeeds(raw: string | undefined): PeerSeed[] {
  const out: PeerSeed[] = [];
  if (!raw) return out;
  for (const entry of raw.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^([0-9a-fA-F]{66})@([^@:]+):(\d{1,5})$/.exec(entry);
    if (!m) continue;
    const port = Number(m[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ identityKey: m[1].toLowerCase(), address: m[2], port });
  }
  return out;
}

/** Runtime peer table: beacons in, online-if-fresh out. No persistence. */
export class PeerRegistry {
  private peers = new Map<string, { address: string; port: number; lastSeen: number; name: string; btPort: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = P2P_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  observe(identityKey: string, address: string, port: number, name = "", btPort = 0): void {
    if (!KEY_RE.test(identityKey) || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const key = identityKey.toLowerCase();
    const prev = this.peers.get(key);
    this.peers.set(key, {
      address,
      port,
      lastSeen: this.now(),
      name: cleanName(name) || prev?.name || "",
      btPort: btPort >= 1 && btPort <= 65535 ? btPort : prev?.btPort ?? 0,
    });
  }

  online(identityKey: string): boolean {
    const r = this.peers.get(identityKey.toLowerCase());
    return !!r && this.now() - r.lastSeen <= this.ttlMs;
  }

  get(identityKey: string): PeerInfo | null {
    const key = identityKey.toLowerCase();
    const r = this.peers.get(key);
    if (!r) return null;
    return {
      identityKey: key,
      address: r.address,
      port: r.port,
      lastSeen: r.lastSeen,
      online: this.online(key),
      name: r.name,
      payTo: "",
      nameVerified: false,
      btPort: r.btPort,
    };
  }

  list(): PeerInfo[] {
    return [...this.peers.keys()]
      .map((k) => this.get(k) as PeerInfo)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  prune(): void {
    const cut = this.now() - this.ttlMs * 4;
    for (const [k, r] of this.peers) if (r.lastSeen < cut) this.peers.delete(k);
  }

  clear(): void {
    this.peers.clear();
  }
}

export interface BeaconTransport {
  start(onBeacon: (raw: string, address: string) => void): Promise<void>;
  send(raw: string): void;
  stop(): Promise<void>;
}

/**
 * UDP multicast transport. A failed bind (no multicast route, locked-down
 * NIC) throws from start() and the node keeps serving TCP only — discovery
 * is an accelerator, never a startup dependency.
 */
export function udpBeaconTransport(opts: { group?: string; port?: number } = {}): BeaconTransport {
  const group = opts.group ?? P2P_DISCOVERY_GROUP;
  const port = opts.port ?? P2P_DISCOVERY_PORT;
  let socket: dgram.Socket | null = null;
  return {
    start: async (onBeacon) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.bind(port, () => {
          try {
            s.setMulticastTTL(1);
            s.setMulticastLoopback(true);
            s.addMembership(group);
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      });
      s.on("error", () => {
        /* a bad packet or NIC must not kill the daemon */
      });
      s.on("message", (msg, rinfo) => onBeacon(msg.toString("utf8"), rinfo.address));
      socket = s;
    },
    send: (raw) => {
      if (!socket) return;
      socket.send(raw, port, group, () => {});
    },
    stop: async () => {
      const s = socket;
      socket = null;
      if (!s) return;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
}

/** Newline-delimited JSON frames with a hard per-frame size cap. */
class JsonLineChannel {
  private buf = "";
  private queue: unknown[] = [];
  private waiter: { resolve: (m: unknown) => void; reject: (e: Error) => void } | null = null;
  private handler: ((msg: unknown) => void) | null = null;
  private closed = false;
  private readonly socket: net.Socket;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.fail());
    socket.on("error", () => this.fail());
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      if (line.length > MAX_FRAME_BYTES) {
        this.socket.destroy();
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.socket.destroy();
        return;
      }
      this.deliver(msg);
    }
    if (this.buf.length > MAX_FRAME_BYTES && !this.buf.includes("\n")) this.socket.destroy();
  }

  private deliver(msg: unknown): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(msg);
    } else if (this.handler) {
      this.handler(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private fail(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(new Error("channel closed"));
    }
  }

  /** Await the next frame (handshake phase). */
  read(timeoutMs: number): Promise<unknown> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error("channel closed"));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("handshake timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.waiter = {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  /** Switch to streaming mode once the handshake completes. */
  setHandler(handler: (msg: unknown) => void): void {
    this.handler = handler;
    const q = this.queue;
    this.queue = [];
    for (const m of q) handler(m);
  }

  write(frame: unknown): boolean {
    if (this.socket.destroyed) return false;
    try {
      return this.socket.write(`${JSON.stringify(frame)}\n`);
    } catch {
      return false;
    }
  }
}

interface Session {
  peer: string;
  socket: net.Socket;
  channel: JsonLineChannel;
  lastActivity: number;
  inboundCount: number;
  inboundWindowStart: number;
  pending: Map<string, () => void>;
  payTo: string;
  name: string;
}

export interface P2PStatus {
  enabled: boolean;
  identityKey: string | null;
  port: number | null;
  discovery: boolean;
  sessions: number;
  peers: number;
}

/**
 * Transport-selection contract used by msgs.sendDmPreferred: `online` is a
 * cheap registry/ session check, `deliver` resolves true only after the
 * recipient acked (stored) the frame.
 */
export interface P2PChannel {
  online(identityKey: string): boolean;
  deliver(identityKey: string, id: string, envelope: unknown): Promise<boolean>;
  meet?(identityKey: string): Promise<{ payTo: string; name: string } | null>;
  /** Ask a peer which torrents it is seeding (null when it did not answer). */
  torrentsOf?(identityKey: string): Promise<string[] | null>;
  peers(): PeerInfo[];
  status(): P2PStatus;
}

export interface P2PNodeOptions {
  crypto: P2PCrypto;
  onDm?: (id: string, envelope: unknown) => unknown | Promise<unknown>;
  /** Receive address + display name announced in the beacon and bound into the handshake. */
  card?: () => { payTo: string; name: string };
  /** Fired once a peer's card is authenticated. */
  onCard?: (identityKey: string, card: { payTo: string; name: string }) => void;
  /** Answer "which torrents do you seed?" for authenticated peers. */
  onTorrents?: () => string[];
  /** Our BitTorrent listener port, advertised in the beacon. */
  btPort?: number;
  port?: number;
  discovery?: boolean;
  transport?: BeaconTransport;
  seeds?: string;
  group?: string;
  discoveryPort?: number;
  now?: () => number;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSessions?: number;
  maxInboundPerMinute?: number;
}

export class P2PNode implements P2PChannel {
  readonly registry: PeerRegistry;
  port = 0;

  private server: net.Server | null = null;
  private transport: BeaconTransport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<string, Session>();
  private inFlight = 0;
  private readonly opts: P2PNodeOptions;
  private readonly staticPeers = new Map<string, PeerSeed>();
  private readonly torrentWaiters = new Map<string, (hashes: string[] | null) => void>();

  constructor(opts: P2PNodeOptions) {
    this.opts = opts;
    this.registry = new PeerRegistry(P2P_TTL_MS, opts.now ?? Date.now);
    for (const seed of parsePeerSeeds(opts.seeds)) this.staticPeers.set(seed.identityKey, seed);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => void this.accept(socket));
    server.on("error", () => {
      /* listener-level errors surface on listen; later ones are ignored */
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? P2P_DEFAULT_PORT, "0.0.0.0", () => resolve());
    });
    this.server = server;
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;

    if (this.opts.discovery !== false) {
      const t =
        this.opts.transport ??
        udpBeaconTransport({ group: this.opts.group, port: this.opts.discoveryPort });
      try {
        await t.start((raw, address) => this.onBeacon(raw, address));
        this.transport = t;
      } catch {
        this.transport = null;
      }
    }
    this.timer = setInterval(() => this.tick(), P2P_BEACON_MS);
    this.timer.unref?.();
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.transport) {
      const t = this.transport;
      this.transport = null;
      await t.stop().catch(() => {});
    }
    for (const s of this.sessions.values()) {
      try {
        s.socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
    for (const [q, resolve] of this.torrentWaiters) {
      this.torrentWaiters.delete(q);
      resolve(null);
    }
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.registry.clear();
  }

  online(identityKey: string): boolean {
    const key = identityKey.toLowerCase();
    return this.sessions.has(key) || this.registry.online(key) || this.staticPeers.has(key);
  }

  /** Handshake with a live peer and return their authenticated receive card. */
  async meet(identityKey: string): Promise<{ payTo: string; name: string } | null> {
    const key = identityKey.toLowerCase();
    if (!KEY_RE.test(key) || !this.opts.crypto.available()) return null;
    const existing = this.sessions.get(key);
    if (existing) return { payTo: existing.payTo, name: existing.name };
    const known = this.registry.get(key);
    const seed = this.staticPeers.get(key);
    const host = known?.online ? known.address : seed?.address;
    const port = known?.online ? known.port : seed?.port;
    if (!host || !port) return null;
    try {
      const session = await this.connectTo({
        identityKey: key, address: host, port, lastSeen: 0, online: true,
        name: "", payTo: "", nameVerified: false, btPort: 0,
      });
      return { payTo: session.payTo, name: session.name };
    } catch {
      return null;
    }
  }

  /** Ask a peer which torrents it seeds. Null when it cannot be reached. */
  async torrentsOf(identityKey: string): Promise<string[] | null> {
    const key = identityKey.toLowerCase();
    if (!KEY_RE.test(key) || !this.opts.crypto.available()) return null;
    let session = this.sessions.get(key);
    if (!session) {
      let peer = this.registry.get(key);
      if (!peer || !peer.online) {
        const seed = this.staticPeers.get(key);
        if (seed) {
          peer = {
            identityKey: key, address: seed.address, port: seed.port, lastSeen: (this.opts.now ?? Date.now)(),
            online: true, name: "", payTo: "", nameVerified: false, btPort: 0,
          };
        }
      }
      if (!peer) return null;
      try {
        session = await this.connectTo(peer);
      } catch {
        return null;
      }
    }
    const q = randomBytes(8).toString("hex");
    const timeoutMs = this.opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    return new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.torrentWaiters.delete(q);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.torrentWaiters.set(q, (hashes) => {
        clearTimeout(timer);
        resolve(hashes);
      });
      if (!session.channel.write({ t: "torrents", q })) {
        clearTimeout(timer);
        this.torrentWaiters.delete(q);
        resolve(null);
      }
    });
  }

  /** Send a discovery beacon now (the periodic tick does this too). */
  announce(): void {
    this.sendBeacon();
  }

  peers(): PeerInfo[] {
    const out = this.registry.list().map((p) => {
      const s = this.sessions.get(p.identityKey);
      return {
        ...p,
        online: p.online || !!s,
        name: s?.name || p.name,
        payTo: s?.payTo || "",
        nameVerified: !!s?.name,
      };
    });
    for (const [key, s] of this.sessions) {
      if (out.some((p) => p.identityKey === key)) continue;
      out.push({
        identityKey: key,
        address: s.socket.remoteAddress ?? "local",
        port: s.socket.remotePort ?? 0,
        lastSeen: s.lastActivity,
        online: true,
        name: s.name,
        payTo: s.payTo,
        nameVerified: !!s.name,
        btPort: this.registry.get(key)?.btPort ?? 0,
      });
    }
    for (const [key, seed] of this.staticPeers) {
      if (out.some((p) => p.identityKey === key)) continue;
      out.push({
        identityKey: key, address: seed.address, port: seed.port, lastSeen: 0, online: true,
        name: "", payTo: "", nameVerified: false, btPort: 0,
      });
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  status(): P2PStatus {
    let identityKey: string | null = null;
    try {
      identityKey = this.opts.crypto.identity().toLowerCase();
    } catch {
      identityKey = null;
    }
    return {
      enabled: this.server !== null,
      identityKey,
      port: this.server ? this.port : null,
      discovery: this.transport !== null,
      sessions: this.sessions.size,
      peers: this.registry.list().length + this.staticPeers.size,
    };
  }

  async deliver(identityKey: string, id: string, envelope: unknown): Promise<boolean> {
    const key = identityKey.toLowerCase();
    if (!KEY_RE.test(key) || !this.opts.crypto.available()) return false;
    let session = this.sessions.get(key);
    if (!session) {
      let peer = this.registry.get(key);
      if (!peer || !peer.online) {
        const seed = this.staticPeers.get(key);
        if (seed) {
          peer = {
            identityKey: key, address: seed.address, port: seed.port, lastSeen: (this.opts.now ?? Date.now)(),
            online: true, name: "", payTo: "", nameVerified: false, btPort: 0,
          };
        }
      }
      if (!peer) return false;
      try {
        session = await this.connectTo(peer);
      } catch (err) {
        if (process.env.BSV_P2P_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(`p2p: connect to ${key.slice(0, 12)}… failed:`, err instanceof Error ? err.message : err);
        }
        return false;
      }
    }
    const delivered = await this.expectAck(session, id, envelope);
    if (!delivered && process.env.BSV_P2P_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`p2p: no ack from ${key.slice(0, 12)}… within ${this.opts.ackTimeoutMs ?? ACK_TIMEOUT_MS}ms`);
    }
    return delivered;
  }

  // ── discovery ──────────────────────────────────────────────────────────

  private tick(): void {
    this.registry.prune();
    const cut = (this.opts.now ?? Date.now)() - (this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    for (const [key, s] of this.sessions) {
      if (s.lastActivity < cut) {
        try {
          s.socket.destroy();
        } catch {
          /* already gone */
        }
        this.sessions.delete(key);
      }
    }
    this.sendBeacon();
  }

  private selfCard(): { payTo: string; name: string } {
    try {
      const c = this.opts.card?.() ?? { payTo: "", name: "" };
      return { payTo: cleanPay(c.payTo), name: cleanName(c.name) };
    } catch {
      return { payTo: "", name: "" };
    }
  }

  private sendBeacon(): void {
    if (!this.transport || !this.opts.crypto.available()) return;
    const card = this.selfCard();
    const bt = Number(this.opts.btPort);
    const beacon: Beacon = {
      v: P2P_VERSION,
      app: P2P_APP,
      identityKey: this.opts.crypto.identity().toLowerCase(),
      port: this.port,
      ...(card.name ? { name: card.name } : {}),
      ...(card.payTo ? { payTo: card.payTo } : {}),
      ...(Number.isInteger(bt) && bt >= 1 && bt <= 65535 ? { bt } : {}),
    };
    this.transport.send(encodeBeacon(beacon));
  }

  private onBeacon(raw: string, address: string): void {
    const b = decodeBeacon(raw);
    if (!b) return;
    try {
      if (b.identityKey === this.opts.crypto.identity().toLowerCase()) return;
    } catch {
      /* locked: identity unknown, record anyway; sends stay closed */
    }
    this.registry.observe(b.identityKey, address, b.port, b.name ?? "", b.bt ?? 0);
  }

  // ── inbound connections ────────────────────────────────────────────────

  private async accept(socket: net.Socket): Promise<void> {
    const max = this.opts.maxSessions ?? MAX_SESSIONS;
    if (!this.server || this.sessions.size + this.inFlight >= max) {
      socket.destroy();
      return;
    }
    this.inFlight++;
    socket.setNoDelay(true);
    const channel = new JsonLineChannel(socket);
    try {
      const card = await this.respond(channel);
      this.install(socket, channel, card);
    } catch {
      socket.destroy();
    } finally {
      this.inFlight--;
    }
  }

  // ── handshake ──────────────────────────────────────────────────────────

  private async connectTo(peer: PeerInfo): Promise<Session> {
    const timeout = this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: peer.address, port: peer.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("connect timeout"));
      }, timeout);
      timer.unref?.();
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    socket.setNoDelay(true);
    const channel = new JsonLineChannel(socket);
    try {
      const confirmed = await this.initiate(channel);
      if (confirmed.identity !== peer.identityKey) throw new Error("peer identity mismatch");
      return this.install(socket, channel, confirmed);
    } catch (e) {
      socket.destroy();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private async initiate(ch: JsonLineChannel): Promise<{ identity: string; payTo: string; name: string }> {
    const handshakeMs = this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    const self = this.opts.crypto.identity().toLowerCase();
    const mine = this.selfCard();
    const n1 = randomBytes(16).toString("hex");
    if (!ch.write({ t: "hello", v: P2P_VERSION, id: self, n: n1, pay: mine.payTo, name: mine.name })) {
      throw new Error("handshake write failed");
    }
    const verify = (await ch.read(handshakeMs)) as Record<string, unknown>;
    if (!verify || verify.t !== "verify" || verify.v !== P2P_VERSION) throw new Error("unexpected handshake frame");
    const peer = typeof verify.id === "string" ? verify.id.toLowerCase() : "";
    const n2 = typeof verify.n === "string" ? verify.n : "";
    const peerPay = cleanPay(verify.pay);
    const peerName = cleanName(verify.name);
    if (!KEY_RE.test(peer) || !n2) throw new Error("bad handshake identity");
    const responderDigest = handshakeTranscript("responder", peer, self, n1, n2, peerPay, mine.payTo, peerName, mine.name);
    const responderSig = Buffer.from(typeof verify.sig === "string" ? verify.sig : "", "hex");
    if (!this.opts.crypto.verify(peer, responderDigest, responderSig)) throw new Error("responder signature invalid");
    const initiatorDigest = handshakeTranscript("initiator", self, peer, n1, n2, mine.payTo, peerPay, mine.name, peerName);
    if (!ch.write({ t: "auth", sig: this.opts.crypto.sign(peer, initiatorDigest).toString("hex") })) {
      throw new Error("auth write failed");
    }
    const ready = (await ch.read(handshakeMs)) as Record<string, unknown>;
    if (!ready || ready.t !== "ready") throw new Error("no ready frame");
    return { identity: peer, payTo: peerPay, name: peerName };
  }

  private async respond(ch: JsonLineChannel): Promise<{ identity: string; payTo: string; name: string }> {
    const handshakeMs = this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    const self = this.opts.crypto.identity().toLowerCase();
    const mine = this.selfCard();
    const hello = (await ch.read(handshakeMs)) as Record<string, unknown>;
    if (!hello || hello.t !== "hello" || hello.v !== P2P_VERSION) throw new Error("unexpected hello");
    const peer = typeof hello.id === "string" ? hello.id.toLowerCase() : "";
    const n1 = typeof hello.n === "string" ? hello.n : "";
    const peerPay = cleanPay(hello.pay);
    const peerName = cleanName(hello.name);
    if (!KEY_RE.test(peer) || !n1) throw new Error("bad hello");
    const n2 = randomBytes(16).toString("hex");
    const responderDigest = handshakeTranscript("responder", self, peer, n1, n2, mine.payTo, peerPay, mine.name, peerName);
    if (
      !ch.write({
        t: "verify",
        v: P2P_VERSION,
        id: self,
        n: n2,
        pay: mine.payTo,
        name: mine.name,
        sig: this.opts.crypto.sign(peer, responderDigest).toString("hex"),
      })
    ) {
      throw new Error("verify write failed");
    }
    const auth = (await ch.read(handshakeMs)) as Record<string, unknown>;
    if (!auth || auth.t !== "auth") throw new Error("unexpected auth frame");
    const initiatorDigest = handshakeTranscript("initiator", peer, self, n1, n2, peerPay, mine.payTo, peerName, mine.name);
    const sig = Buffer.from(typeof auth.sig === "string" ? auth.sig : "", "hex");
    if (!this.opts.crypto.verify(peer, initiatorDigest, sig)) throw new Error("initiator signature invalid");
    if (!ch.write({ t: "ready" })) throw new Error("ready write failed");
    return { identity: peer, payTo: peerPay, name: peerName };
  }

  // ── sessions ───────────────────────────────────────────────────────────

  private install(
    socket: net.Socket,
    channel: JsonLineChannel,
    card: { identity: string; payTo: string; name: string },
  ): Session {
    const peer = card.identity;
    const old = this.sessions.get(peer);
    if (old && old.socket !== socket) {
      try {
        old.socket.destroy();
      } catch {
        /* already gone */
      }
    }
    const session: Session = {
      peer,
      socket,
      channel,
      lastActivity: (this.opts.now ?? Date.now)(),
      inboundCount: 0,
      inboundWindowStart: (this.opts.now ?? Date.now)(),
      pending: new Map(),
      payTo: card.payTo,
      name: card.name,
    };
    this.sessions.set(peer, session);
    channel.setHandler((msg) => void this.onFrame(session, msg));
    socket.on("close", () => {
      if (this.sessions.get(peer) === session) this.sessions.delete(peer);
    });
    if (card.payTo || card.name) this.opts.onCard?.(peer, { payTo: card.payTo, name: card.name });
    return session;
  }

  private async onFrame(session: Session, msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    session.lastActivity = (this.opts.now ?? Date.now)();
    if (m.t === "dm") {
      if (!this.rateOk(session)) {
        session.socket.destroy();
        return;
      }
      const id = typeof m.id === "string" ? m.id : "";
      if (!id) return;
      try {
        await this.opts.onDm?.(id, m.env);
      } catch {
        // Storage failed: no ack, so the sender falls back to the relay.
        return;
      }
      session.channel.write({ t: "ack", ids: [id] });
    } else if (m.t === "ack") {
      const ids = Array.isArray(m.ids) ? m.ids : [];
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const resolve = session.pending.get(id);
        if (resolve) {
          session.pending.delete(id);
          resolve();
        }
      }
    } else if (m.t === "ping") {
      session.channel.write({ t: "pong" });
    } else if (m.t === "torrents") {
      const q = typeof m.q === "string" ? m.q : "";
      if (!q) return;
      if (Array.isArray(m.hashes)) {
        const resolve = this.torrentWaiters.get(q);
        if (resolve) {
          this.torrentWaiters.delete(q);
          resolve(
            m.hashes
              .filter((h): h is string => typeof h === "string" && /^[0-9a-f]{40}$/i.test(h))
              .map((h) => h.toLowerCase()),
          );
        }
      } else {
        session.channel.write({ t: "torrents", q, hashes: this.opts.onTorrents?.() ?? [] });
      }
    }
  }

  private rateOk(session: Session): boolean {
    const now = (this.opts.now ?? Date.now)();
    if (now - session.inboundWindowStart > 60_000) {
      session.inboundWindowStart = now;
      session.inboundCount = 0;
    }
    session.inboundCount++;
    return session.inboundCount <= (this.opts.maxInboundPerMinute ?? MAX_INBOUND_PER_MINUTE);
  }

  private async expectAck(session: Session, id: string, envelope: unknown): Promise<boolean> {
    const ackMs = this.opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    const acked = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        resolve(false);
      }, ackMs);
      timer.unref?.();
      session.pending.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!session.channel.write({ t: "dm", id, env: envelope })) {
      session.pending.delete(id);
      return false;
    }
    session.lastActivity = (this.opts.now ?? Date.now)();
    return acked;
  }
}
