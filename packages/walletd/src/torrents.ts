/**
 * Torrent service: the daemon's filesharing face.
 *
 * A torrent is a row in `torrents` plus a local file. Seeding opens a
 * BitTorrent listener and answers any peer that knows the infohash;
 * fetching resolves a torrent (infohash in the DB, or a .torrent file),
 * finds a peer (explicit host:port, or discovered bsvOS wallets that
 * answer "I have it"), downloads with per-piece verification, and only
 * then publishes the file at its final path.
 *
 * Discovery rides the authenticated P2P channel (`torrentsOf`); the bulk
 * transfer is standard BitTorrent on a separate TCP port advertised in the
 * beacon. No tracker, no DHT, no plaintext concerns beyond what the file
 * itself is — piece hashes are the integrity boundary, so a hostile peer
 * can waste bandwidth but never corrupt a file.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Knex } from "knex";
import type { P2PChannel, PeerInfo } from "./p2p.ts";
import {
  buildMetainfo, fetchTorrent, infoHashOf, metainfoBytes, parseMetainfo, pieceCountOf,
  serveTorrent, type Metainfo, type TorrentInfo,
} from "./torrent.ts";

export interface TorrentRow {
  infoHash: string;
  name: string;
  length: number;
  pieceLength: number;
  piecesHex: string;
  path: string;
  direction: "seed" | "leech";
  status: "seeding" | "fetching" | "done" | "error";
  bytesDone: number;
  detail: string;
  createdAt: number;
}

export function migrateTorrents(db: Knex): Promise<void> {
  return (async () => {
    if (!(await db.schema.hasTable("torrents"))) {
      await db.schema.createTable("torrents", (t) => {
        t.string("info_hash", 40).primary();
        t.string("name", 255).notNullable();
        t.integer("length").notNullable();
        t.integer("piece_length").notNullable();
        t.text("pieces").notNullable();
        t.text("path").notNullable().defaultTo("");
        t.string("direction", 8).notNullable().defaultTo("seed");
        t.string("status", 12).notNullable().defaultTo("seeding");
        t.integer("bytes_done").notNullable().defaultTo(0);
        t.text("detail").notNullable().defaultTo("");
        t.integer("created_at").notNullable();
      });
    }
  })();
}

function rowToTorrent(r: {
  info_hash: string; name: string; length: number; piece_length: number; pieces: string;
  path: string; direction: string; status: string; bytes_done: number; detail: string; created_at: number;
}): TorrentRow {
  return {
    infoHash: r.info_hash,
    name: r.name,
    length: r.length,
    pieceLength: r.piece_length,
    piecesHex: r.pieces,
    path: r.path,
    direction: r.direction === "leech" ? "leech" : "seed",
    status: (["seeding", "fetching", "done", "error"] as const).includes(r.status as never)
      ? (r.status as TorrentRow["status"])
      : "error",
    bytesDone: r.bytes_done,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

export function torrentInfoFromRow(row: TorrentRow, filePath = row.path): TorrentInfo {
  return {
    infoHash: row.infoHash,
    name: row.name,
    length: row.length,
    pieceLength: row.pieceLength,
    pieces: Buffer.from(row.piecesHex, "hex"),
    filePath,
  };
}

export function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

export interface TorrentServiceOptions {
  db: Knex;
  p2p?: () => P2PChannel | null;
  port?: number;
  fetchDir: string;
  now?: () => number;
}

export class TorrentService {
  private readonly db: Knex;
  private readonly p2p: () => P2PChannel | null;
  private readonly fetchDir: string;
  private readonly now: () => number;
  private readonly port: number;
  private server: net.Server | null = null;
  btPort: number | null = null;
  private hashCache: string[] = [];

  constructor(opts: TorrentServiceOptions) {
    this.db = opts.db;
    this.p2p = opts.p2p ?? (() => null);
    this.fetchDir = opts.fetchDir;
    this.port = opts.port ?? 51413;
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(this.fetchDir, { recursive: true });
  }

  /** Start the BitTorrent listener. A busy port disables seeding, not the daemon. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => void this.onPeer(socket));
    server.on("error", () => {
      /* per-connection errors are handled in onPeer */
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "0.0.0.0", () => resolve());
      });
    } catch {
      this.btPort = null;
      server.close();
      return;
    }
    this.server = server;
    const addr = server.address();
    this.btPort = typeof addr === "object" && addr ? addr.port : null;
    await this.refreshHashes();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.btPort = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async onPeer(socket: net.Socket): Promise<void> {
    socket.setNoDelay(true);
    socket.on("error", () => socket.destroy());
    await serveTorrent(socket, (infoHash) => this.seedable(infoHash));
  }

  private async seedable(infoHash: string): Promise<TorrentInfo | null> {
    const row = await this.get(infoHash);
    if (!row || row.direction !== "seed" || row.status !== "seeding") return null;
    try {
      const stat = fs.statSync(row.path);
      if (!stat.isFile() || stat.size !== row.length) return null;
    } catch {
      return null;
    }
    return torrentInfoFromRow(row);
  }

  async get(infoHash: string): Promise<TorrentRow | null> {
    const row = (await this.db("torrents").where({ info_hash: infoHash.toLowerCase() }).first()) as {
      info_hash: string; name: string; length: number; piece_length: number; pieces: string;
      path: string; direction: string; status: string; bytes_done: number; detail: string; created_at: number;
    } | undefined;
    return row ? rowToTorrent(row) : null;
  }

  async list(): Promise<TorrentRow[]> {
    const rows = (await this.db("torrents").select().orderBy("created_at", "desc")) as Array<{
      info_hash: string; name: string; length: number; piece_length: number; pieces: string;
      path: string; direction: string; status: string; bytes_done: number; detail: string; created_at: number;
    }>;
    return rows.map(rowToTorrent);
  }

  /** Infohashes we are actively seeding (answered to peers over the P2P channel). */
  async seededHashes(): Promise<string[]> {
    const rows = (await this.db("torrents").where({ direction: "seed", status: "seeding" }).select("info_hash")) as Array<{ info_hash: string }>;
    return rows.map((r) => r.info_hash);
  }

  /** Sync view for the beacon-time query frame (P2PNode.onTorrents). */
  cachedHashes(): string[] {
    return this.hashCache;
  }

  async refreshHashes(): Promise<void> {
    this.hashCache = await this.seededHashes();
  }

  async share(filePath: string, name?: string): Promise<TorrentRow> {
    const abs = path.resolve(filePath);
    const metainfo = buildMetainfo(abs, name ? { name } : {});
    const infoHash = infoHashOf(metainfo);
    await this.upsert({
      infoHash,
      name: metainfo.info.name,
      length: metainfo.info.length,
      pieceLength: metainfo.info.pieceLength,
      piecesHex: metainfo.info.pieces.toString("hex"),
      path: abs,
      direction: "seed",
      status: "seeding",
      bytesDone: metainfo.info.length,
      detail: "",
    });
    fs.writeFileSync(path.join(this.fetchDir, `${infoHash}.torrent`), metainfoBytes(metainfo));
    await this.refreshHashes();
    return (await this.get(infoHash)) as TorrentRow;
  }

  async remove(infoHash: string, opts: { deleteFile?: boolean } = {}): Promise<{ removed: boolean }> {
    const row = await this.get(infoHash);
    if (!row) return { removed: false };
    await this.db("torrents").where({ info_hash: row.infoHash }).delete();
    if (opts.deleteFile && row.direction === "leech" && row.path.startsWith(this.fetchDir)) {
      await fs.promises.unlink(row.path).catch(() => {});
    }
    await fs.promises.unlink(path.join(this.fetchDir, `${row.infoHash}.torrent`)).catch(() => {});
    await this.refreshHashes();
    return { removed: true };
  }

  /** Peers (from the authenticated channel) that report having this infohash. */
  async peersFor(infoHash: string): Promise<Array<PeerInfo & { hasTorrent: boolean }>> {
    const channel = this.p2p();
    if (!channel?.torrentsOf) return [];
    const peers = channel.peers().filter((p) => p.online).slice(0, 8);
    const found: Array<PeerInfo & { hasTorrent: boolean }> = [];
    await Promise.all(peers.map(async (p) => {
      try {
        const hashes = await channel.torrentsOf?.(p.identityKey);
        if (hashes?.some((h) => h.toLowerCase() === infoHash.toLowerCase())) found.push({ ...p, hasTorrent: true });
      } catch {
        /* peer did not answer — it just isn't a source */
      }
    }));
    return found;
  }

  async fetch(params: {
    infoHash?: string;
    torrentFile?: string;
    peer?: string;
    out?: string;
    onProgress?: (piece: number, total: number, bytes: number) => void;
  }): Promise<{ infoHash: string; name: string; path: string; bytes: number; source: string }> {
    let row: TorrentRow | null = null;
    if (params.infoHash) {
      row = await this.get(params.infoHash);
      if (!row) throw Object.assign(new Error(`unknown torrent ${params.infoHash} — share it or pass a .torrent file`), { code: "NOT_FOUND" });
    } else if (params.torrentFile) {
      const bytes = await fs.promises.readFile(params.torrentFile);
      const metainfo: Metainfo = parseMetainfo(bytes);
      const infoHash = infoHashOf(metainfo);
      const existing = await this.get(infoHash);
      if (existing) {
        row = existing;
      } else {
        await this.upsert({
          infoHash,
          name: metainfo.info.name,
          length: metainfo.info.length,
          pieceLength: metainfo.info.pieceLength,
          piecesHex: metainfo.info.pieces.toString("hex"),
          path: "",
          direction: "leech",
          status: "fetching",
          bytesDone: 0,
          detail: "",
        });
        row = (await this.get(infoHash)) as TorrentRow;
      }
    }
    if (!row) throw Object.assign(new Error("infoHash or torrentFile required"), { code: "BAD_PARAM" });

    // Resolve a source: explicit host:port, else discovered wallets.
    let source = "";
    let host = "";
    let port = 0;
    if (params.peer) {
      const m = /^([^:]+):(\d{1,5})$/.exec(params.peer.trim());
      if (!m) throw Object.assign(new Error("peer must be host:port"), { code: "BAD_PARAM" });
      host = m[1];
      port = Number(m[2]);
      source = params.peer.trim();
    } else {
      const found = await this.peersFor(row.infoHash);
      const usable = found.find((p) => p.address && p.btPort);
      if (!usable) {
        throw Object.assign(
          new Error(`no peer found for ${row.infoHash.slice(0, 12)}… — pass --peer host:port or wait for a seeder to appear`),
          { code: "NO_PEER" },
        );
      }
      host = usable.address;
      port = usable.btPort as number;
      source = `${usable.name || usable.identityKey.slice(0, 12)} (${host}:${port})`;
    }

    const dest = path.resolve(params.out ?? path.join(this.fetchDir, row.name));
    const temp = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // A seed row describes the local copy we serve — fetching another copy
    // must not clobber it. Leech rows track this download's lifecycle.
    const trackRow = row.direction === "leech";
    if (trackRow) await this.update(row.infoHash, { status: "fetching", path: dest, detail: `from ${source}`, bytesDone: 0 });
    try {
      const result = await fetchTorrent({
        host,
        port,
        torrent: torrentInfoFromRow(row, temp),
        ...(params.onProgress ? { onProgress: (p) => params.onProgress?.(p.piece, p.totalPieces, p.bytes) } : {}),
      });
      await fs.promises.rename(temp, dest);
      if (trackRow) {
        await this.update(row.infoHash, { status: "done", path: dest, bytesDone: result.bytes, detail: `from ${source}` });
      }
      return { infoHash: row.infoHash, name: row.name, path: dest, bytes: result.bytes, source };
    } catch (err) {
      await fs.promises.unlink(temp).catch(() => {});
      if (trackRow) {
        await this.update(row.infoHash, {
          status: "error",
          detail: err instanceof Error ? err.message : "fetch failed",
        });
        await this.db("torrents").where({ info_hash: row.infoHash }).delete();
      }
      throw err;
    }
  }

  private async upsert(input: {
    infoHash: string; name: string; length: number; pieceLength: number; piecesHex: string;
    path: string; direction: "seed" | "leech"; status: TorrentRow["status"]; bytesDone: number; detail: string;
  }): Promise<void> {
    const existing = await this.db("torrents").where({ info_hash: input.infoHash }).first();
    const values = {
      info_hash: input.infoHash,
      name: input.name,
      length: input.length,
      piece_length: input.pieceLength,
      pieces: input.piecesHex,
      path: input.path,
      direction: input.direction,
      status: input.status,
      bytes_done: input.bytesDone,
      detail: input.detail,
      created_at: this.now(),
    };
    if (existing) {
      const { created_at: _created, ...updatable } = values;
      await this.db("torrents").where({ info_hash: input.infoHash }).update(updatable);
    } else {
      await this.db("torrents").insert(values);
    }
  }

  private async update(
    infoHash: string,
    patch: { status?: TorrentRow["status"]; path?: string; bytesDone?: number; detail?: string },
  ): Promise<void> {
    const values: Record<string, unknown> = {};
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.path !== undefined) values.path = patch.path;
    if (patch.bytesDone !== undefined) values.bytes_done = patch.bytesDone;
    if (patch.detail !== undefined) values.detail = patch.detail;
    if (Object.keys(values).length > 0) {
      await this.db("torrents").where({ info_hash: infoHash }).update(values);
    }
  }
}

/** Exposed for tests: the exact bytes a seed creates for a file. */
export function seedPreview(filePath: string): { infoHash: string; pieces: number; metainfo: Metainfo } {
  const metainfo = buildMetainfo(filePath);
  return {
    infoHash: infoHashOf(metainfo),
    pieces: pieceCountOf({ length: metainfo.info.length, pieceLength: metainfo.info.pieceLength }),
    metainfo,
  };
}
