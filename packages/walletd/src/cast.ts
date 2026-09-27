/**
 * Value-for-value creator streaming: a player that pays while it plays.
 *
 * An episode registers value splits (creator + guests, pct each, Podcasting
 * 2.0 value-block style). `play` opens one sats-stream per recipient at
 * rate × share on the shared `cast` board; while the session is active the
 * minutely loop posts playback beats, the streams pay, and `stop` ends it
 * all. Splits settle automatically — the host never touches guest money.
 *
 * Honesty first: v1 trusts the listener's stop button. Beats prove the
 * session is open, not that ears are present — value-for-value is
 * voluntary by design, and the payer is the listener. A runner player with
 * real audio-element events (play/pause/seek) graduates beats from
 * self-attested to observed; the stream layer needs no changes.
 */
import fs from "node:fs";
import type { Knex } from "knex";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createStream, setStreamStatus } from "./streams.ts";

export const CAST_BOARD = "cast";
export const CAST_AGENT = "cast-player";

export interface ValueSplit {
  address: string;
  pct: number;
}

export interface Episode {
  id: string;
  title: string;
  feed: string;
  mediaUrl: string;
  /** Live broadcast (video/audio stream) vs on-demand file. */
  live: boolean;
  splits: ValueSplit[];
  createdAt: number;
}

export interface CastSession {
  id: string;
  episode: string;
  title: string;
  ratePerMin: number;
  everySecs: number;
  maxTotal: number;
  streamIds: string[];
  status: "playing" | "stopped";
  startedAt: number;
  stoppedAt: number | null;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function newId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = `${prefix}_`;
  for (const b of randomBytes(6)) id += chars[b % chars.length];
  return id;
}

/** Parse "addr:70,addr:30" into validated splits summing to 100. */
export function parseSplits(raw: unknown, p2pkhValid: (addr: string) => boolean): ValueSplit[] {
  const text = String(raw ?? "").trim();
  if (!text) fail("BAD_PARAM", "splits required: <address>:<pct>[,<address>:<pct>…]");
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) fail("BAD_PARAM", "1..8 splits");
  const seen = new Set<string>();
  const splits = parts.map((p) => {
    const i = p.lastIndexOf(":");
    if (i <= 0) fail("BAD_PARAM", `bad split (want address:pct): ${p.slice(0, 20)}`);
    const address = p.slice(0, i).trim();
    const pct = Number(p.slice(i + 1));
    if (!p2pkhValid(address)) fail("BAD_PARAM", `bad address in splits: ${address.slice(0, 16)}…`);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) fail("BAD_PARAM", `bad pct in splits: ${p.slice(0, 30)}`);
    const key = address.toLowerCase();
    if (seen.has(key)) fail("BAD_PARAM", "duplicate address in splits");
    seen.add(key);
    return { address, pct };
  });
  const total = splits.reduce((a, s) => a + s.pct, 0);
  if (Math.abs(total - 100) > 0.001) fail("BAD_PARAM", `splits must sum to 100 (got ${total})`);
  return splits;
}

export async function migrateCast(db: Knex): Promise<void> {  if (!(await db.schema.hasTable("cast_episodes"))) {
    await db.schema.createTable("cast_episodes", (t) => {
      t.string("id", 16).primary();
      t.string("title", 120).notNullable();
      t.text("feed").notNullable().defaultTo("");
      t.text("media_url").notNullable().defaultTo("");
      t.integer("is_live").notNullable().defaultTo(0);
      t.text("splits").notNullable();
      t.integer("created_at").notNullable();
    });
  } else {
    if (!(await db.schema.hasColumn("cast_episodes", "media_url"))) {
      await db.schema.alterTable("cast_episodes", (t) => {
        t.text("media_url").notNullable().defaultTo("");
      });
    }
    if (!(await db.schema.hasColumn("cast_episodes", "is_live"))) {
      await db.schema.alterTable("cast_episodes", (t) => {
        t.integer("is_live").notNullable().defaultTo(0);
      });
    }
  }
  if (!(await db.schema.hasTable("cast_sessions"))) {
    await db.schema.createTable("cast_sessions", (t) => {
      t.string("id", 16).primary();
      t.string("episode", 16).notNullable();
      t.string("title", 120).notNullable().defaultTo("");
      t.integer("rate_per_min").notNullable();
      t.integer("every_secs").notNullable();
      t.integer("max_total").notNullable();
      t.text("stream_ids").notNullable();
      t.string("status").notNullable().defaultTo("playing");
      t.integer("started_at").notNullable();
      t.integer("stopped_at").nullable();
    });
  }
  await migrateCastLive(db);
}

interface EpisodeRow { id: string; title: string; feed: string; media_url: string; is_live: number; splits: string; created_at: number }
interface SessionRow {
  id: string; episode: string; title: string; rate_per_min: number; every_secs: number;
  max_total: number; stream_ids: string; status: string; started_at: number; stopped_at: number | null;
}

function toEpisode(r: EpisodeRow): Episode {
  return {
    id: r.id, title: r.title, feed: r.feed, mediaUrl: r.media_url ?? "", live: (r.is_live ?? 0) === 1,
    splits: JSON.parse(r.splits) as ValueSplit[], createdAt: r.created_at,
  };
}

function toSession(r: SessionRow): CastSession {
  return {
    id: r.id, episode: r.episode, title: r.title, ratePerMin: r.rate_per_min,
    everySecs: r.every_secs, maxTotal: r.max_total,
    streamIds: JSON.parse(r.stream_ids) as string[],
    status: r.status === "stopped" ? "stopped" : "playing",
    startedAt: r.started_at, stoppedAt: r.stopped_at,
  };
}

export async function addEpisode(
  db: Knex,
  opts: { title: string; feed?: string; mediaUrl?: string; live?: boolean; splits: ValueSplit[] },
): Promise<Episode> {
  const title = (opts.title ?? "").trim().slice(0, 120);
  if (!title) fail("BAD_PARAM", "title required");
  if (!opts.splits.length) fail("BAD_PARAM", "splits required");
  const mediaUrl = (opts.mediaUrl ?? "").trim().slice(0, 500);
  if (mediaUrl && !/^https?:\/\//i.test(mediaUrl) && !mediaUrl.startsWith("/")) {
    fail("BAD_PARAM", "media must be an http(s) URL or site path");
  }
  const row: EpisodeRow = {
    id: newId("ep"), title, feed: (opts.feed ?? "").trim().slice(0, 500),
    media_url: mediaUrl, is_live: opts.live === true ? 1 : 0,
    splits: JSON.stringify(opts.splits), created_at: Date.now(),
  };
  await db("cast_episodes").insert(row);
  return toEpisode(row);
}

export async function listEpisodes(db: Knex): Promise<Episode[]> {
  const rows = (await db("cast_episodes").select().orderBy("created_at", "desc").limit(50)) as EpisodeRow[];
  return rows.map(toEpisode);
}

export async function getEpisode(db: Knex, id: string): Promise<Episode> {
  const row = (await db("cast_episodes").where({ id }).first()) as EpisodeRow | undefined;
  if (!row) fail("NOT_FOUND", `no episode: ${String(id).slice(0, 16)}`);
  return toEpisode(row!);
}

export interface PlayDeps {
  createStream: typeof createStream;
}

export async function startSession(
  db: Knex,
  deps: PlayDeps,
  opts: { episode: string; ratePerMin: number; every: unknown; maxTotal: number; tickSecs: (every: unknown) => number; now?: number },
): Promise<CastSession> {
  const ep = await getEpisode(db, opts.episode);
  const ratePerMin = Math.floor(Number(opts.ratePerMin) || 0);
  if (!(ratePerMin > 0)) fail("BAD_PARAM", "rate must be positive sats/min");
  const tickSecs = Math.floor(Number(opts.tickSecs(opts.every)) || 0);
  if (!(tickSecs >= 60)) fail("BAD_PARAM", "interval minimum 60s");
  const maxTotal = Math.floor(Number(opts.maxTotal) || 0);
  if (!(maxTotal >= 1000)) fail("BAD_PARAM", "max total must be at least 1000 sats");
  const now = opts.now ?? Date.now();
  const streamIds: string[] = [];
  for (const s of ep.splits) {
    const st = await deps.createStream(db, {
      name: `cast ${ep.title.slice(0, 40)} ${s.pct}% ${s.address.slice(0, 8)}`,
      payee: s.address,
      ratePerMin: Math.max(1, Math.round((ratePerMin * s.pct) / 100)),
      every: tickSecs,
      maxTotal: Math.max(1000, Math.floor((maxTotal * s.pct) / 100)),
      board: CAST_BOARD,
      now,
    });
    streamIds.push(st.id);
  }
  const row: SessionRow = {
    id: newId("cs"), episode: ep.id, title: ep.title, rate_per_min: ratePerMin,
    every_secs: tickSecs, max_total: maxTotal, stream_ids: JSON.stringify(streamIds),
    status: "playing", started_at: now, stopped_at: null,
  };
  await db("cast_sessions").insert(row);
  return toSession(row);
}

export async function listSessions(db: Knex): Promise<CastSession[]> {
  const rows = (await db("cast_sessions").select().orderBy("started_at", "desc").limit(50)) as SessionRow[];
  return rows.map(toSession);
}

export async function getSession(db: Knex, id: string): Promise<CastSession> {
  const row = (await db("cast_sessions").where({ id }).first()) as SessionRow | undefined;
  if (!row) fail("NOT_FOUND", `no session: ${String(id).slice(0, 16)}`);
  return toSession(row!);
}

export async function stopSession(db: Knex, id: string, now = Date.now()): Promise<CastSession> {
  const s = await getSession(db, id);
  if (s.status === "stopped") return s;
  for (const sid of s.streamIds) {
    await setStreamStatus(db, sid, "done").catch(() => null);
  }
  await db("cast_sessions").where({ id }).update({ status: "stopped", stopped_at: now });
  return getSession(db, id);
}

/** Sessions needing beats now (playing). Pure query for the minutely loop. */
export async function sessionsDue(db: Knex): Promise<CastSession[]> {
  const rows = (await db("cast_sessions").where({ status: "playing" }).select()) as SessionRow[];
  return rows.map(toSession);
}

/** Beat payloads for one session: one per stream so every split keeps flowing. */export function sessionBeats(s: CastSession, elapsedMin: number): Array<{ streamId: string; text: string; refs: string[] }> {
  return s.streamIds.map((sid) => ({
    streamId: sid,
    text: `playing ${s.title} +${Math.floor(elapsedMin)}m`,
    refs: [`stream:${sid}`],
  }));
}

// ── live ingest (browser → HLS) ──────────────────────────────────────────
// The browser's MediaRecorder (video/mp4) emits an init chunk (ftyp+moov)
// then one fmp4 fragment per timeslice. We store init.mp4 + seg-N.m4s and
// serve a rolling-window playlist; hls.js plays it live, and stop appends
// ENDLIST so the broadcast persists as a VOD recording. No ffmpeg, no
// transmuxing — the browser already encodes; the daemon only files.

export interface LiveSession {
  id: string;
  episode: string;
  status: "live" | "ended";
  segments: number;
  /** Recorder mime (e.g. video/webm) — players pick HLS (mp4) vs MSE (webm). */
  mime: string;
  startedAt: number;
  stoppedAt: number | null;
}

export const LIVE_WINDOW = 20;
export const MAX_LIVE_SEGMENTS = 500;
export const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

export function liveIdValid(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9]{6,16}$/.test(id);
}

export function liveFileValid(name: unknown): name is "index.m3u8" | "init.mp4" | string {
  if (typeof name !== "string") return false;
  if (name === "index.m3u8" || name === "init.mp4") return true;
  const m = /^seg-(\d{1,6})\.m4s$/.exec(name);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n < MAX_LIVE_SEGMENTS;
}

/** Rolling HLS playlist over [0, segments): windowed while live, full + ENDLIST when ended. */
export function livePlaylist(segments: number, ended: boolean, targetDuration = 6): string {
  const start = ended ? 0 : Math.max(0, segments - LIVE_WINDOW);
  const out = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${targetDuration}`, `#EXT-X-MEDIA-SEQUENCE:${start}`, '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = start; i < segments; i++) {
    out.push(`#EXTINF:${targetDuration}.0,`, `seg-${i}.m4s`);
  }
  if (ended) out.push("#EXT-X-ENDLIST");
  return out.join("\n") + "\n";
}

export async function migrateCastLive(db: Knex): Promise<void> {
  if (await db.schema.hasTable("cast_live")) {
    if (!(await db.schema.hasColumn("cast_live", "mime"))) {
      await db.schema.alterTable("cast_live", (t) => {
        t.string("mime", 64).notNullable().defaultTo("");
      });
    }
    return;
  }
  await db.schema.createTable("cast_live", (t) => {
    t.string("id", 16).primary();
    t.string("episode", 16).notNullable();
    t.string("status").notNullable().defaultTo("live");
    t.integer("segments").notNullable().defaultTo(0);
    t.string("mime", 64).notNullable().defaultTo("");
    t.integer("started_at").notNullable();
    t.integer("stopped_at").nullable();
  });
}

interface LiveRow { id: string; episode: string; status: string; segments: number; mime: string; started_at: number; stopped_at: number | null }

function toLive(r: LiveRow): LiveSession {
  return {
    id: r.id, episode: r.episode, status: r.status === "ended" ? "ended" : "live",
    segments: r.segments, mime: r.mime ?? "", startedAt: r.started_at, stoppedAt: r.stopped_at,
  };
}

export function newLiveId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = randomBytes(12);
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

export async function startLive(db: Knex, episodeId: string, now = Date.now()): Promise<LiveSession> {
  const row = (await db("cast_episodes").where({ id: episodeId }).first()) as EpisodeRow | undefined;
  if (!row) fail("NOT_FOUND", `no episode: ${String(episodeId).slice(0, 16)}`);
  const live: LiveRow = { id: newLiveId(), episode: episodeId, status: "live", segments: 0, mime: "", started_at: now, stopped_at: null };
  await db("cast_live").insert(live);
  await db("cast_episodes").where({ id: episodeId }).update({ is_live: 1 });
  return toLive(live);
}

export async function getLive(db: Knex, id: string): Promise<LiveSession> {
  if (!liveIdValid(id)) fail("BAD_PARAM", "bad live id");
  const row = (await db("cast_live").where({ id }).first()) as LiveRow | undefined;
  if (!row) fail("NOT_FOUND", `no live session: ${id}`);
  return toLive(row);
}

/** Record the browser's recorder mime on first ingest (drives player choice). */
export async function setLiveMime(db: Knex, id: string, mime: string): Promise<void> {
  const clean = String(mime ?? "").split(";")[0]!.trim().toLowerCase().slice(0, 64);
  if (!/^(video|audio)\/[a-z0-9.+-]+$/.test(clean)) fail("BAD_PARAM", "bad mime");
  await db("cast_live").where({ id }).update({ mime: clean });
}

export async function bumpLiveSegments(db: Knex, id: string): Promise<number> {
  const s = await getLive(db, id);
  if (s.status !== "live") fail("BAD_STATE", "live session ended");
  if (s.segments >= MAX_LIVE_SEGMENTS) fail("BAD_STATE", "segment cap reached — stop and start a new broadcast");
  await db("cast_live").where({ id }).update({ segments: s.segments + 1 });
  return s.segments;
}

export async function endLive(db: Knex, id: string, now = Date.now()): Promise<LiveSession> {  const s = await getLive(db, id);
  if (s.status === "ended") return s;
  await db("cast_live").where({ id }).update({ status: "ended", stopped_at: now });
  await db("cast_episodes").where({ id: s.episode }).update({ is_live: 0 });
  return getLive(db, id);
}

export async function listLive(db: Knex): Promise<LiveSession[]> {
  const rows = (await db("cast_live").select().orderBy("started_at", "desc").limit(50)) as LiveRow[];
  return rows.map(toLive);
}

/** Broadcast silence window before a live session is auto-ended. */
export const LIVE_IDLE_MS = 5 * 60_000;

/**
 * End broadcasts whose recorder stopped sending segments (crashed tab,
 * closed lid). Playlists get ENDLIST, so a stalled "live" becomes a
 * replayable recording instead of a stream that never loads.
 */
export async function endStaleLive(
  db: Knex,
  idleMs = LIVE_IDLE_MS,
  now = Date.now(),
): Promise<string[]> {
  const rows = (await db("cast_live").where({ status: "live" }).select()) as LiveRow[];
  const ended: string[] = [];
  for (const r of rows) {
    const dir = liveDir(r.id);
    let last = r.started_at;
    try {
      for (const f of fs.readdirSync(dir)) {
        const st = fs.statSync(path.join(dir, f));
        if (st.mtimeMs > last) last = st.mtimeMs;
      }
    } catch {
      /* no dir yet: fall back to startedAt */
    }
    if (now - last < idleMs) continue;
    await endLive(db, r.id, now);
    ended.push(r.id);
  }
  return ended;
}

// ── media store (recordings + live segments on local disk) ───────────────
// Loopback-only HTTP writes here; ids are server-generated, extensions come
// from a content-type allowlist — no client-controlled paths, ever.

export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

const MEDIA_EXT: Record<string, string> = {
  "video/webm": ".webm",
  "video/mp4": ".mp4",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
};

export function mediaRoot(): string {
  const base = process.env.BSV_WALLETD_DATA ?? path.join(os.homedir(), ".local/share/bsv-os");
  return path.join(base, "cast-media");
}

export function mediaExt(mime: string): string | null {
  return MEDIA_EXT[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function newMediaId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = randomBytes(12);
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

export function mediaFileValid(name: unknown): boolean {
  return typeof name === "string" && /^[a-z0-9]{12}\.(webm|mp4|m4a|mp3|ogg)$/.test(name);
}

export function liveDir(id: string): string {
  return path.join(mediaRoot(), `live-${id}`);
}
