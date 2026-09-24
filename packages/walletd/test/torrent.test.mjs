import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import knex from "knex";
import {
  BT_BLOCK_SIZE,
  BT_MAX_PIECES,
  bencode,
  bdecode,
  bitfieldFor,
  buildMetainfo,
  encodeHandshake,
  fetchTorrent,
  hasPiece,
  infoHashOf,
  makePeerId,
  metainfoBytes,
  parseMetainfo,
  pieceLengthFor,
  serveTorrent,
  sha1,
} from "../src/torrent.ts";
import { TorrentService, migrateTorrents, torrentInfoFromRow } from "../src/torrents.ts";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bsvos-torrent-"));
}

function writeRandom(dir, name, size) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, randomBytes(size));
  return file;
}

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ── bencode + metainfo ─────────────────────────────────────────────────────

test("bencode is canonical and strict", () => {
  assert.equal(bencode({ b: 1, a: 2 }).toString(), "d1:ai2e1:bi1ee");
  assert.equal(bencode([1, Buffer.from("x"), { k: 2 }]).toString(), "li1e1:x d1:ki2eee".replace(/ /g, ""));
  const value = { a: [1, 2], b: Buffer.from([0, 255]), c: { d: Buffer.from("e") } };
  assert.deepEqual(bdecode(bencode(value)), value);

  assert.throws(() => bdecode(Buffer.from("i1ei2e")), /trailing/);
  assert.throws(() => bdecode(Buffer.from("3:ab")), /overruns/);
  assert.throws(() => bdecode(Buffer.from("i99999999999999999999e")), /range/);
  assert.throws(() => bdecode(Buffer.from("d")), /unterminated|end/);
  // Nested exactly 33 deep trips the guard.
  let deep = "1:x";
  for (let i = 0; i < 33; i++) deep = `l${deep}e`;
  assert.throws(() => bdecode(Buffer.from(deep)), /deep/);
});

test("metainfo infohash matches a hand-built canonical info dict", () => {
  const pieces = sha1(Buffer.from("hello"));
  const metainfo = {
    info: { name: "test", length: 5, pieceLength: 8, pieces },
  };
  const expected = Buffer.concat([
    Buffer.from("d6:lengthi5e4:name4:test12:piece lengthi8e6:pieces20:"),
    pieces,
    Buffer.from("e"),
  ]);
  assert.equal(infoHashOf(metainfo), sha1(expected).toString("hex"));
  const roundtrip = parseMetainfo(metainfoBytes(metainfo));
  assert.equal(infoHashOf(roundtrip), infoHashOf(metainfo));
  assert.equal(roundtrip.info.name, "test");
  assert.equal(roundtrip.info.pieceLength, 8);
});

test("piece size adapts and the parser refuses garbage", () => {
  assert.equal(pieceLengthFor(0), 64 * 1024);
  assert.equal(pieceLengthFor(1024), 64 * 1024);
  // 1 GiB fits 4096 pieces exactly at 256 KiB.
  assert.equal(pieceLengthFor(1024 * 1024 * 1024), 256 * 1024);
  // Huge inputs cap at 4 MiB; anything above 16 GiB is refused at share time.
  assert.equal(pieceLengthFor(1024 ** 4), 4 * 1024 * 1024);

  assert.throws(() => parseMetainfo(Buffer.from("i1e")), /dict/);
  const bad = metainfoBytes({ info: { name: "../evil", length: 5, pieceLength: 4, pieces: sha1(Buffer.from("hello")) } });
  assert.throws(() => parseMetainfo(bad), /unsafe/);
  const short = metainfoBytes({ info: { name: "a", length: 9, pieceLength: 4, pieces: sha1(Buffer.from("hello")) } });
  assert.throws(() => parseMetainfo(short), /piece count/);
});

test("bitfields are MSB-first with spare bits clear", () => {
  const bf = bitfieldFor(10, true);
  assert.equal(bf.length, 2);
  assert.equal(bf[0], 0xff);
  assert.equal(bf[1], 0b11000000);
  for (let i = 0; i < 10; i++) assert.equal(hasPiece(bf, i), true);
  assert.equal(hasPiece(bf, 10), false);
});

// ── wire protocol ──────────────────────────────────────────────────────────

/** Minimal independent BitTorrent client: raw frames, no shared code paths. */
class RawClient {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
  }
  static async connect(port, infoHash, peerId = "-TEST01-abcdefghijkl") {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new RawClient(socket);
    socket.write(
      Buffer.concat([
        Buffer.from([19]),
        Buffer.from("BitTorrent protocol"),
        Buffer.alloc(8),
        Buffer.from(infoHash, "hex"),
        Buffer.from(peerId),
      ]),
    );
    return client;
  }
  async bytes(n, timeoutMs = 3000) {
    while (this.buf.length < n) {
      this.buf = Buffer.concat([this.buf, await this.chunk(timeoutMs)]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  chunk(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("raw client timeout")), timeoutMs);
      this.socket.once("data", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      this.socket.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("raw client closed"));
      });
    });
  }
  async message(timeoutMs = 3000) {
    const head = await this.bytes(4, timeoutMs);
    const len = head.readUInt32BE(0);
    if (len === 0) return { id: -1, payload: Buffer.alloc(0) };
    const rest = await this.bytes(len, timeoutMs);
    return { id: rest[0], payload: rest.subarray(1) };
  }
  send(id, payload = Buffer.alloc(0)) {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(1 + payload.length, 0);
    head[4] = id;
    this.socket.write(Buffer.concat([head, payload]));
  }
  close() {
    this.socket.destroy();
  }
}

async function withSeeder(filePath, fn) {
  const metainfo = buildMetainfo(filePath);
  const infoHash = infoHashOf(metainfo);
  const torrent = {
    infoHash,
    name: metainfo.info.name,
    length: metainfo.info.length,
    pieceLength: metainfo.info.pieceLength,
    pieces: metainfo.info.pieces,
    filePath,
  };
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    void serveTorrent(socket, (ih) => (ih === infoHash ? torrent : null), { idleTimeoutMs: 3000 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await fn({ torrent, metainfo, infoHash, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a foreign client can handshake and pull a piece", async () => {
  const dir = tmpdir();
  const file = writeRandom(dir, "payload.bin", BT_BLOCK_SIZE + 1234);
  await withSeeder(file, async ({ metainfo, infoHash, port }) => {
    const client = await RawClient.connect(port, infoHash);
    const hello = await client.bytes(68);
    assert.equal(hello.subarray(1, 20).toString("ascii"), "BitTorrent protocol");
    assert.equal(hello.subarray(28, 48).toString("hex"), infoHash);
    assert.notDeepEqual(hello.subarray(48, 68), Buffer.alloc(20)); // a real peer id, not zeros

    const bitfield = await client.message();
    assert.equal(bitfield.id, 5);
    assert.equal(hasPiece(bitfield.payload, 0), true);

    client.send(2); // interested
    const unchoke = await client.message();
    assert.equal(unchoke.id, 1);

    client.send(6, (() => {
      const p = Buffer.alloc(12);
      p.writeUInt32BE(0, 0); // index
      p.writeUInt32BE(0, 4); // begin
      p.writeUInt32BE(BT_BLOCK_SIZE, 8);
      return p;
    })());
    const piece = await client.message();
    assert.equal(piece.id, 7);
    assert.equal(piece.payload.readUInt32BE(0), 0);
    assert.equal(piece.payload.readUInt32BE(4), 0);
    const source = fs.readFileSync(file);
    assert.deepEqual(piece.payload.subarray(8), source.subarray(0, BT_BLOCK_SIZE));
    client.close();
  });
});

test("a handshake for an unknown infohash is dropped without a reply", async () => {
  const dir = tmpdir();
  const file = writeRandom(dir, "payload.bin", 4096);
  await withSeeder(file, async ({ port }) => {
    const client = await RawClient.connect(port, "ab".repeat(20));
    await assert.rejects(client.bytes(68, 500), /closed|timeout/);
  });
});

test("fetch downloads and verifies every piece over loopback", async () => {
  const dir = tmpdir();
  const size = 300 * 1024 + 77; // 5 pieces at the 64 KiB floor
  const source = writeRandom(dir, "movie.bin", size);
  await withSeeder(source, async ({ torrent, metainfo, port }) => {
    const dest = path.join(dir, "out", "movie.bin");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const progress = [];
    const result = await fetchTorrent({
      host: "127.0.0.1",
      port,
      torrent: { ...torrent, filePath: dest },
      onProgress: (p) => progress.push(p),
      idleTimeoutMs: 5000,
    });
    assert.equal(result.bytes, size);
    assert.equal(progress.at(-1).totalPieces, Math.ceil(size / metainfo.info.pieceLength));
    assert.equal(hashFile(dest), hashFile(source));
  });
});

test("a corrupted seed fails piece verification", async () => {
  const dir = tmpdir();
  const source = writeRandom(dir, "good.bin", 4096);
  const bad = writeRandom(dir, "bad.bin", 4096);
  const metainfo = buildMetainfo(source);
  const infoHash = infoHashOf(metainfo);
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    void serveTorrent(socket, () => ({
      infoHash, name: "bad.bin", length: metainfo.info.length,
      pieceLength: metainfo.info.pieceLength, pieces: metainfo.info.pieces, filePath: bad,
    }), { idleTimeoutMs: 3000 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const dest = path.join(dir, "out.bin");
    await assert.rejects(
      fetchTorrent({
        host: "127.0.0.1", port,
        torrent: {
          infoHash, name: "bad.bin", length: metainfo.info.length,
          pieceLength: metainfo.info.pieceLength, pieces: metainfo.info.pieces, filePath: dest,
        },
        idleTimeoutMs: 5000,
      }),
      /failed verification/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── TorrentService ─────────────────────────────────────────────────────────

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrateTorrents(db);
  return db;
}

test("service shares, serves, fetches, and removes", async () => {
  const dir = tmpdir();
  const source = writeRandom(dir, "shared.dat", 150 * 1024);
  const db = await memdb();
  const service = new TorrentService({ db, port: 0, fetchDir: path.join(dir, "fetched") });
  await service.start();
  const clientDb = await memdb();
  const clientDir = tmpdir();
  const client = new TorrentService({ db: clientDb, port: 0, fetchDir: clientDir });
  try {
    assert.ok(service.btPort > 0);
    const row = await service.share(source);
    assert.equal(row.direction, "seed");
    assert.equal(row.status, "seeding");
    assert.match(row.infoHash, /^[0-9a-f]{40}$/);
    assert.ok(fs.existsSync(path.join(dir, "fetched", `${row.infoHash}.torrent`)));

    // A second wallet (its own DB) fetches by the .torrent file.
    const torrentFile = path.join(dir, "fetched", `${row.infoHash}.torrent`);
    const fetched = await client.fetch({
      torrentFile,
      peer: `127.0.0.1:${service.btPort}`,
      out: path.join(clientDir, "copy.dat"),
    });
    assert.equal(fetched.path, path.join(clientDir, "copy.dat"));
    assert.equal(hashFile(fetched.path), hashFile(source));

    // The leech row tracks the download; the seed row is untouched.
    const leechRow = await client.get(row.infoHash);
    assert.equal(leechRow.direction, "leech");
    assert.equal(leechRow.status, "done");
    assert.equal(leechRow.bytesDone, fs.statSync(fetched.path).size);
    const seedRow = await service.get(row.infoHash);
    assert.equal(seedRow.status, "seeding");
    assert.equal(seedRow.path, source);

    // Removing the leech deletes its copy; the seed still serves.
    assert.deepEqual(await client.remove(row.infoHash, { deleteFile: true }), { removed: true });
    assert.equal(fs.existsSync(fetched.path), false);
    assert.equal((await service.get(row.infoHash)).direction, "seed");

    assert.deepEqual(await service.remove(row.infoHash), { removed: true });
    assert.equal(await service.get(row.infoHash), null);
  } finally {
    await client.stop();
    await clientDb.destroy();
    await service.stop();
    await db.destroy();
  }
});

test("peersFor finds wallets that report the infohash", async () => {
  const dir = tmpdir();
  const source = writeRandom(dir, "ask.dat", 2048);
  const db = await memdb();
  const service = new TorrentService({ db, port: 0, fetchDir: path.join(dir, "f") });
  const row = await service.share(source);
  const asked = [];
  const fakeChannel = {
    online: () => true,
    deliver: async () => false,
    peers: () => [
      { identityKey: "02".repeat(33), address: "127.0.0.1", port: 1, lastSeen: 3, online: true, name: "has-it", payTo: "", nameVerified: true, btPort: 51515 },
      { identityKey: "03".repeat(33), address: "127.0.0.1", port: 2, lastSeen: 2, online: true, name: "no", payTo: "", nameVerified: true, btPort: 51516 },
      { identityKey: "04".repeat(33), address: "127.0.0.1", port: 3, lastSeen: 1, online: false, name: "offline", payTo: "", nameVerified: true, btPort: 51517 },
    ],
    torrentsOf: async (key) => {
      asked.push(key);
      return key.startsWith("02") ? [row.infoHash.toUpperCase()] : [];
    },
    status: () => ({ enabled: true, identityKey: null, port: null, discovery: false, sessions: 0, peers: 0 }),
  };
  const wired = new TorrentService({ db, port: 0, fetchDir: path.join(dir, "f2"), p2p: () => fakeChannel });
  try {
    const found = await wired.peersFor(row.infoHash);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "has-it");
    assert.equal(found[0].btPort, 51515);
    assert.equal(asked.length, 2); // offline peers are never asked
  } finally {
    await service.stop();
    await db.destroy();
  }
});

test("torrentInfoFromRow round-trips pieces", async () => {
  const dir = tmpdir();
  const source = writeRandom(dir, "rt.bin", 4096);
  const db = await memdb();
  const service = new TorrentService({ db, port: 0, fetchDir: path.join(dir, "f") });
  try {
    const row = await service.share(source);
    const info = torrentInfoFromRow(row, "/tmp/x");
    assert.equal(info.pieces.length, 20);
    assert.equal(info.filePath, "/tmp/x");
    assert.equal(info.infoHash, row.infoHash);
  } finally {
    await db.destroy();
  }
});
