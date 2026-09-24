/**
 * BitTorrent core (BEP 3), sized for bsvOS file sharing.
 *
 * What this is: a single-file seeder and fetcher that speak the real
 * BitTorrent peer protocol — 68-byte handshake, length-prefixed messages,
 * SHA-1 piece verification, 16 KiB blocks. Peer discovery is bsvOS's own
 * (beacons + authenticated channels asking "who has this infohash?"), so no
 * tracker or DHT is needed; any standard client that connects to our
 * listener can still download from us, and we can fetch from any standard
 * peer given host:port.
 *
 * What this is not (documented): multi-file torrents, magnets, DHT, uTP,
 * encryption, choking/rarest-first scheduling. We unchoke everyone and
 * fetch sequentially from one peer at a time with a small request pipeline.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const BT_PROTOCOL = "BitTorrent protocol";
export const BT_BLOCK_SIZE = 16 * 1024;
export const BT_MAX_PIECE_LENGTH = 4 * 1024 * 1024;
export const BT_MIN_PIECE_LENGTH = 64 * 1024;
export const BT_MAX_PIECES = 4096;
const HANDSHAKE_BYTES = 68;
export const BT_IDLE_TIMEOUT_MS = 30_000;
export const BT_CONNECT_TIMEOUT_MS = 8_000;
const MAX_INFLIGHT_BLOCKS = 8;
const MAX_MESSAGE_BYTES = BT_BLOCK_SIZE + 64;

// ── bencode ────────────────────────────────────────────────────────────────

export type BValue = number | string | Buffer | BValue[] | { [key: string]: BValue };

/** Canonical bencode: dict keys sorted, integers exact, strings length-prefixed. */
export function bencode(value: BValue): Buffer {
  const parts: Buffer[] = [];
  encodeInto(value, parts);
  return Buffer.concat(parts);
}

function encodeInto(value: BValue, out: Buffer[]): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("bencode: integer must be a safe integer");
    out.push(Buffer.from(`i${value}e`));
    return;
  }
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    out.push(Buffer.from(`${b.length}:`), b);
    return;
  }
  if (Buffer.isBuffer(value)) {
    out.push(Buffer.from(`${value.length}:`), value);
    return;
  }
  if (Array.isArray(value)) {
    out.push(Buffer.from("l"));
    for (const item of value) encodeInto(item, out);
    out.push(Buffer.from("e"));
    return;
  }
  if (value && typeof value === "object") {
    out.push(Buffer.from("d"));
    for (const key of Object.keys(value).sort()) {
      const kb = Buffer.from(key, "utf8");
      out.push(Buffer.from(`${kb.length}:`), kb);
      encodeInto(value[key], out);
    }
    out.push(Buffer.from("e"));
    return;
  }
  throw new Error("bencode: unsupported value");
}

export function bdecode(buf: Buffer): BValue {
  let pos = 0;
  const value = decodeAt(buf, () => pos, (p) => (pos = p), 0);
  if (pos !== buf.length) throw new Error("bencode: trailing bytes");
  return value;
}

function decodeAt(
  buf: Buffer,
  getPos: () => number,
  setPos: (p: number) => void,
  depth: number,
): BValue {
  if (depth > 32) throw new Error("bencode: nesting too deep");
  let pos = getPos();
  const byte = buf[pos];
  if (byte === undefined) throw new Error("bencode: unexpected end");
  if (byte === 0x69) { // i
    const end = buf.indexOf(0x65, pos + 1);
    if (end < 0) throw new Error("bencode: unterminated integer");
    const text = buf.subarray(pos + 1, end).toString("ascii");
    if (!/^-?\d+$/.test(text)) throw new Error("bencode: bad integer");
    const n = Number(text);
    if (!Number.isSafeInteger(n)) throw new Error("bencode: integer out of range");
    setPos(end + 1);
    return n;
  }
  if (byte === 0x6c) { // l
    setPos(pos + 1);
    const list: BValue[] = [];
    while (buf[getPos()] !== 0x65) {
      list.push(decodeAt(buf, getPos, setPos, depth + 1));
      if (getPos() >= buf.length) throw new Error("bencode: unterminated list");
    }
    setPos(getPos() + 1);
    return list;
  }
  if (byte === 0x64) { // d
    setPos(pos + 1);
    const dict: { [key: string]: BValue } = {};
    while (buf[getPos()] !== 0x65) {
      const key = decodeAt(buf, getPos, setPos, depth + 1);
      if (!Buffer.isBuffer(key)) throw new Error("bencode: dict key must be a string");
      dict[key.toString("utf8")] = decodeAt(buf, getPos, setPos, depth + 1);
      if (getPos() >= buf.length) throw new Error("bencode: unterminated dict");
    }
    setPos(getPos() + 1);
    return dict;
  }
  // byte string
  const colon = buf.indexOf(0x3a, pos);
  if (colon < 0) throw new Error("bencode: bad string length");
  const lenText = buf.subarray(pos, colon).toString("ascii");
  if (!/^\d+$/.test(lenText)) throw new Error("bencode: bad string length");
  const len = Number(lenText);
  const start = colon + 1;
  if (start + len > buf.length) throw new Error("bencode: string overruns buffer");
  setPos(start + len);
  return Buffer.from(buf.subarray(start, start + len));
}

// ── metainfo ───────────────────────────────────────────────────────────────

export interface Metainfo {
  announce?: string;
  info: { name: string; length: number; pieceLength: number; pieces: Buffer };
}

export function pieceLengthFor(length: number): number {
  let n = BT_MIN_PIECE_LENGTH;
  while (n < BT_MAX_PIECE_LENGTH && Math.ceil(length / n) > BT_MAX_PIECES) n *= 2;
  return n;
}

export function sha1(buf: Buffer): Buffer {
  return createHash("sha1").update(buf).digest();
}

/** The wire dict uses the spec's exact keys — `piece length`, not `pieceLength`. */
function infoDict(info: Metainfo["info"]): BValue {
  return {
    length: info.length,
    name: info.name,
    "piece length": info.pieceLength,
    pieces: info.pieces,
  };
}

export function infoHashOf(metainfo: Metainfo): string {
  return sha1(bencode(infoDict(metainfo.info))).toString("hex");
}

export function metainfoBytes(metainfo: Metainfo): Buffer {
  return bencode({
    ...(metainfo.announce ? { announce: metainfo.announce } : {}),
    info: infoDict(metainfo.info),
  });
}

export function buildMetainfo(filePath: string, opts: { name?: string } = {}): Metainfo {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("only regular files can be shared");
  const length = stat.size;
  if (length === 0) throw new Error("empty files cannot be shared");
  if (length > BT_MAX_PIECE_LENGTH * BT_MAX_PIECES) {
    throw new Error("file too large for single-file torrents (max 16 GiB)");
  }
  const pieceLength = pieceLengthFor(length);
  const pieces: Buffer[] = [];
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(pieceLength);
    let offset = 0;
    while (offset < length) {
      const want = Math.min(pieceLength, length - offset);
      const got = fs.readSync(fd, buf, 0, want, offset);
      if (got !== want) throw new Error(`short read at ${offset}`);
      pieces.push(sha1(buf.subarray(0, got)));
      offset += got;
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    info: {
      name: opts.name ?? path.basename(filePath),
      length,
      pieceLength,
      pieces: Buffer.concat(pieces),
    },
  };
}

export function parseMetainfo(bytes: Buffer): Metainfo {
  const decoded = bdecode(bytes);
  if (!decoded || typeof decoded !== "object" || Buffer.isBuffer(decoded) || Array.isArray(decoded)) {
    throw new Error("not a metainfo dict");
  }
  const d = decoded as { [k: string]: BValue };
  const info = d.info;
  if (!info || typeof info !== "object" || Buffer.isBuffer(info) || Array.isArray(info)) {
    throw new Error("metainfo: info dict missing");
  }
  const i = info as { [k: string]: BValue };
  const name = Buffer.isBuffer(i.name) ? i.name.toString("utf8") : "";
  const length = typeof i.length === "number" ? i.length : -1;
  const pieceLength = typeof i["piece length"] === "number" ? (i["piece length"] as number) : -1;
  const pieces = Buffer.isBuffer(i.pieces) ? i.pieces : Buffer.alloc(0);
  if (!name || /[/\\]/.test(name) || name === "." || name === "..") throw new Error("metainfo: unsafe name");
  if (!(length >= 0) || !(pieceLength > 0) || pieceLength > BT_MAX_PIECE_LENGTH) {
    throw new Error("metainfo: bad length/piece length");
  }
  if (pieces.length === 0 || pieces.length % 20 !== 0) throw new Error("metainfo: bad pieces");
  const expected = Math.max(1, Math.ceil(length / pieceLength));
  if (pieces.length / 20 !== expected) throw new Error("metainfo: piece count mismatch");
  if (expected > BT_MAX_PIECES) throw new Error("metainfo: too many pieces");
  const announce = Buffer.isBuffer(d.announce) ? d.announce.toString("utf8") : undefined;
  return { ...(announce ? { announce } : {}), info: { name, length, pieceLength, pieces } };
}

export function pieceHashAt(pieces: Buffer, index: number): Buffer {
  return pieces.subarray(index * 20, index * 20 + 20);
}

// ── wire protocol ──────────────────────────────────────────────────────────

export function makePeerId(): Buffer {
  return Buffer.concat([Buffer.from("-BSOS01-"), randomBytes(12)]);
}

export function encodeHandshake(infoHashHex: string, peerIdBytes: Buffer): Buffer {
  const reserved = Buffer.alloc(8);
  return Buffer.concat([
    Buffer.from([BT_PROTOCOL.length]),
    Buffer.from(BT_PROTOCOL, "ascii"),
    reserved,
    Buffer.from(infoHashHex, "hex"),
    peerIdBytes,
  ]);
}

export interface WireMessage {
  id: number;
  payload: Buffer;
}

const MSG = {
  CHOKE: 0,
  UNCHOKE: 1,
  INTERESTED: 2,
  NOT_INTERESTED: 3,
  HAVE: 4,
  BITFIELD: 5,
  REQUEST: 6,
  PIECE: 7,
  CANCEL: 8,
} as const;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/**
 * One socket, one ordered stream: the handshake bytes and every subsequent
 * message come from the same buffer, so no bytes are lost between phases.
 */
export class PeerStream {
  private buf = Buffer.alloc(0);
  private messages: WireMessage[] = [];
  private bytesWaiter: { n: number; resolve: (b: Buffer) => void } | null = null;
  private messageWaiter: { resolve: (m: WireMessage) => void; reject: (e: Error) => void } | null = null;
  private closed = false;
  private readonly socket: net.Socket;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onClose: () => void;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.onData = (chunk: Buffer) => this.push(chunk);
    this.onClose = () => this.fail();
    socket.on("data", this.onData);
    socket.once("close", this.onClose);
    socket.once("error", this.onClose);
  }

  private push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  private drain(): void {
    if (this.bytesWaiter && this.buf.length >= this.bytesWaiter.n) {
      const w = this.bytesWaiter;
      this.bytesWaiter = null;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
      return this.drain();
    }
    if (!this.bytesWaiter) {
      for (;;) {
        if (this.buf.length < 4) break;
        const len = this.buf.readUInt32BE(0);
        if (len > MAX_MESSAGE_BYTES) {
          this.socket.destroy();
          break;
        }
        if (this.buf.length < 4 + len) break;
        const id = len === 0 ? -1 : this.buf[4];
        const payload = len > 1 ? Buffer.from(this.buf.subarray(5, 4 + len)) : Buffer.alloc(0);
        this.buf = this.buf.subarray(4 + len);
        if (id < 0) continue; // keepalive
        const msg: WireMessage = { id, payload };
        if (this.messageWaiter) {
          const w = this.messageWaiter;
          this.messageWaiter = null;
          w.resolve(msg);
          return this.drain();
        }
        this.messages.push(msg);
      }
    }
  }

  private fail(): void {
    this.closed = true;
    if (this.messageWaiter) {
      const w = this.messageWaiter;
      this.messageWaiter = null;
      w.reject(new Error("torrent: socket closed"));
    }
  }

  /** Read the 68-byte peer handshake (does not write ours). */
  async handshake(timeoutMs = 5_000): Promise<{ infoHash: string; peerId: Buffer }> {
    const head = await this.readBytes(HANDSHAKE_BYTES, timeoutMs);
    if (head[0] !== BT_PROTOCOL.length || head.subarray(1, 20).toString("ascii") !== BT_PROTOCOL) {
      throw new Error("torrent: not a BitTorrent handshake");
    }
    return { infoHash: head.subarray(28, 48).toString("hex"), peerId: head.subarray(48, 68) };
  }

  readBytes(n: number, timeoutMs: number): Promise<Buffer> {
    if (this.buf.length >= n) {
      const out = Buffer.from(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
      return Promise.resolve(out);
    }
    if (this.closed) return Promise.reject(new Error("torrent: socket closed"));
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bytesWaiter = null;
        reject(new Error("torrent: read timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.bytesWaiter = {
        n,
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
      };
    });
  }

  next(timeoutMs: number): Promise<WireMessage> {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift() as WireMessage);
    if (this.closed) return Promise.reject(new Error("torrent: socket closed"));
    return new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageWaiter = null;
        reject(new Error("torrent: idle timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.messageWaiter = {
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

  send(id: number, payload: Buffer = Buffer.alloc(0)): boolean {
    if (this.socket.destroyed) return false;
    const head = Buffer.alloc(5);
    head.writeUInt32BE(1 + payload.length, 0);
    head[4] = id;
    return this.socket.write(Buffer.concat([head, payload]));
  }

  dispose(): void {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("error", this.onClose);
  }
}

export function bitfieldFor(pieceCount: number, all = true): Buffer {
  const bytes = Buffer.alloc(Math.ceil(pieceCount / 8));
  if (all) {
    bytes.fill(0xff);
    const spare = bytes.length * 8 - pieceCount;
    // Spare bits are the LOW bits of the last byte; keep the piece bits high.
    if (spare > 0) bytes[bytes.length - 1] = (0xff << spare) & 0xff;
  }
  return bytes;
}

export function hasPiece(bitfield: Buffer, index: number): boolean {
  const byte = bitfield[index >> 3];
  if (byte === undefined) return false;
  return ((byte >> (7 - (index & 7))) & 1) === 1;
}

export function setBit(bitfield: Buffer, index: number): void {
  bitfield[index >> 3] |= 1 << (7 - (index & 7));
}

export interface TorrentInfo {
  infoHash: string;
  name: string;
  length: number;
  pieceLength: number;
  pieces: Buffer;
  filePath: string;
}

export function pieceCountOf(torrent: Pick<TorrentInfo, "length" | "pieceLength">): number {
  return Math.max(1, Math.ceil(torrent.length / torrent.pieceLength));
}

/** Serve one peer session from a local file. Resolves when the peer goes away. */
export async function serveTorrent(
  socket: net.Socket,
  lookup: (infoHash: string) => TorrentInfo | null | Promise<TorrentInfo | null>,
  opts: { idleTimeoutMs?: number } = {},
): Promise<void> {
  const peer = new PeerStream(socket);
  let fh: fs.promises.FileHandle | null = null;
  try {
    const hello = await peer.handshake(5_000);
    const torrent = await lookup(hello.infoHash);
    if (!torrent || torrent.infoHash !== hello.infoHash) {
      socket.destroy();
      return;
    }
    socket.write(encodeHandshake(torrent.infoHash, makePeerId()));
    peer.send(MSG.BITFIELD, bitfieldFor(pieceCountOf(torrent), true));
    fh = await fs.promises.open(torrent.filePath, "r");
    const idle = opts.idleTimeoutMs ?? BT_IDLE_TIMEOUT_MS;
    for (;;) {
      const msg = await peer.next(idle);
      if (msg.id === MSG.INTERESTED) {
        peer.send(MSG.UNCHOKE);
      } else if (msg.id === MSG.REQUEST) {
        if (msg.payload.length !== 12) continue;
        const index = msg.payload.readUInt32BE(0);
        const begin = msg.payload.readUInt32BE(4);
        const length = msg.payload.readUInt32BE(8);
        const pieceStart = index * torrent.pieceLength;
        const pieceLen = Math.min(torrent.pieceLength, torrent.length - pieceStart);
        if (
          length <= 0 ||
          length > BT_BLOCK_SIZE ||
          begin + length > pieceLen ||
          pieceStart + begin + length > torrent.length
        ) {
          socket.destroy();
          return;
        }
        const block = Buffer.alloc(length);
        const { bytesRead } = await fh.read(block, 0, length, pieceStart + begin);
        if (bytesRead !== length) {
          socket.destroy();
          return;
        }
        peer.send(MSG.PIECE, Buffer.concat([u32(index), u32(begin), block]));
      }
      // CHOKE/NOT_INTERESTED/CANCEL/HAVE: nothing for a seeder to do.
    }
  } catch {
    /* peer vanished, timed out, or sent nonsense — session over */
  } finally {
    peer.dispose();
    if (fh) await fh.close().catch(() => {});
    socket.destroy();
  }
}

export interface FetchProgress {
  piece: number;
  totalPieces: number;
  bytes: number;
}

export interface FetchResult {
  bytes: number;
  peerId: string;
}

/**
 * Fetch a single-file torrent from one peer, verifying every piece against
 * its SHA-1 before it is written. Writes straight to `torrent.filePath`;
 * callers fetch to a temp name and rename on success.
 */
export async function fetchTorrent(opts: {
  host: string;
  port: number;
  torrent: TorrentInfo;
  onProgress?: (p: FetchProgress) => void;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}): Promise<FetchResult> {
  const { torrent } = opts;
  const pieceCount = pieceCountOf(torrent);
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ host: opts.host, port: opts.port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error("torrent: connect timeout"));
    }, opts.connectTimeoutMs ?? BT_CONNECT_TIMEOUT_MS);
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
  const peer = new PeerStream(socket);
  const idle = opts.idleTimeoutMs ?? BT_IDLE_TIMEOUT_MS;
  const fh = await fs.promises.open(torrent.filePath, "w+");
  const done = new Array<boolean>(pieceCount).fill(false);
  let peerBits = Buffer.alloc(Math.ceil(pieceCount / 8));
  let maybeHasAll = true;
  let received = 0;

  try {
    socket.write(encodeHandshake(torrent.infoHash, makePeerId()));
    const hello = await peer.handshake(opts.connectTimeoutMs ?? BT_CONNECT_TIMEOUT_MS);
    if (hello.infoHash !== torrent.infoHash) throw new Error("torrent: peer has a different torrent");
    peer.send(MSG.INTERESTED);

    // Learn what the peer has and wait for unchoke before requesting.
    for (;;) {
      const msg = await peer.next(idle);
      if (msg.id === MSG.BITFIELD) {
        peerBits = Buffer.from(msg.payload);
        maybeHasAll = false;
        peer.send(MSG.INTERESTED); // re-assert after learning the map
      } else if (msg.id === MSG.HAVE) {
        if (msg.payload.length !== 4) continue;
        const index = msg.payload.readUInt32BE(0);
        if (index >> 3 >= peerBits.length) {
          const grown = Buffer.alloc(Math.ceil((index + 1) / 8));
          peerBits.copy(grown);
          peerBits = grown;
        }
        setBit(peerBits, index);
        maybeHasAll = false;
      } else if (msg.id === MSG.UNCHOKE) {
        break;
      } else if (msg.id === MSG.CHOKE) {
        continue;
      } else if (msg.id === MSG.PIECE) {
        continue; // shouldn't happen yet
      }
    }

    const peerHas = (index: number): boolean => (maybeHasAll ? true : hasPiece(peerBits, index));
    const nextPiece = (): number => {
      for (let i = 0; i < pieceCount; i++) if (!done[i] && peerHas(i)) return i;
      return -1;
    };

    while (done.some((d) => !d)) {
      if (opts.signal?.aborted) throw new Error("torrent: aborted");
      const index = nextPiece();
      if (index < 0) throw new Error("torrent: peer has none of the missing pieces");
      const pieceStart = index * torrent.pieceLength;
      const pieceLen = Math.min(torrent.pieceLength, torrent.length - pieceStart);
      const blockCount = Math.ceil(pieceLen / BT_BLOCK_SIZE);
      const pieceBuf = Buffer.alloc(pieceLen);
      const got = new Array<boolean>(blockCount).fill(false);
      const pending = new Set<number>();
      let blocksLeft = blockCount;

      const issue = (): void => {
        for (let b = 0; b < blockCount && pending.size < MAX_INFLIGHT_BLOCKS; b++) {
          if (got[b] || pending.has(b)) continue;
          const begin = b * BT_BLOCK_SIZE;
          const len = Math.min(BT_BLOCK_SIZE, pieceLen - begin);
          peer.send(MSG.REQUEST, Buffer.concat([u32(index), u32(begin), u32(len)]));
          pending.add(b);
        }
      };
      issue();

      while (blocksLeft > 0) {
        if (opts.signal?.aborted) throw new Error("torrent: aborted");
        const msg = await peer.next(idle);
        if (msg.id === MSG.PIECE) {
          if (msg.payload.length < 8) continue;
          const pIndex = msg.payload.readUInt32BE(0);
          const pBegin = msg.payload.readUInt32BE(4);
          const block = msg.payload.subarray(8);
          if (pIndex !== index || pBegin % BT_BLOCK_SIZE !== 0) continue;
          const b = pBegin / BT_BLOCK_SIZE;
          if (b >= blockCount) continue;
          pending.delete(b);
          if (got[b]) continue;
          const want = Math.min(BT_BLOCK_SIZE, pieceLen - pBegin);
          if (block.length !== want) {
            socket.destroy();
            throw new Error("torrent: short block");
          }
          pieceBuf.set(block, pBegin);
          got[b] = true;
          blocksLeft--;
          issue();
        } else if (msg.id === MSG.HAVE) {
          if (msg.payload.length !== 4) continue;
          const haveIndex = msg.payload.readUInt32BE(0);
          if (haveIndex >> 3 >= peerBits.length) {
            const grown = Buffer.alloc(Math.ceil((haveIndex + 1) / 8));
            peerBits.copy(grown);
            peerBits = grown;
          }
          setBit(peerBits, haveIndex);
          maybeHasAll = false;
        } else if (msg.id === MSG.CHOKE) {
          socket.destroy();
          throw new Error("torrent: peer choked us mid-piece");
        } else if (msg.id === MSG.BITFIELD) {
          peerBits = Buffer.from(msg.payload);
          maybeHasAll = false;
        }
      }

      const hash = sha1(pieceBuf);
      if (!hash.equals(pieceHashAt(torrent.pieces, index))) {
        socket.destroy();
        throw new Error(`torrent: piece ${index} failed verification`);
      }
      await fh.write(pieceBuf, 0, pieceLen, pieceStart);
      done[index] = true;
      received += pieceLen;
      peer.send(MSG.HAVE, u32(index));
      opts.onProgress?.({ piece: index + 1, totalPieces: pieceCount, bytes: received });
    }
    peer.send(MSG.NOT_INTERESTED);
    await fh.close();
    socket.destroy();
    return { bytes: received, peerId: hello.peerId.toString("hex") };
  } catch (err) {
    await fh.close().catch(() => {});
    socket.destroy();
    throw err;
  } finally {
    peer.dispose();
  }
}
