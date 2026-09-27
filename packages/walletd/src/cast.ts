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
import type { Knex } from "knex";
import { randomBytes } from "node:crypto";
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

export async function migrateCast(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("cast_episodes"))) {
    await db.schema.createTable("cast_episodes", (t) => {
      t.string("id", 16).primary();
      t.string("title", 120).notNullable();
      t.text("feed").notNullable().defaultTo("");
      t.text("splits").notNullable();
      t.integer("created_at").notNullable();
    });
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
}

interface EpisodeRow { id: string; title: string; feed: string; splits: string; created_at: number }
interface SessionRow {
  id: string; episode: string; title: string; rate_per_min: number; every_secs: number;
  max_total: number; stream_ids: string; status: string; started_at: number; stopped_at: number | null;
}

function toEpisode(r: EpisodeRow): Episode {
  return { id: r.id, title: r.title, feed: r.feed, splits: JSON.parse(r.splits) as ValueSplit[], createdAt: r.created_at };
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
  opts: { title: string; feed?: string; splits: ValueSplit[] },
): Promise<Episode> {
  const title = (opts.title ?? "").trim().slice(0, 120);
  if (!title) fail("BAD_PARAM", "title required");
  if (!opts.splits.length) fail("BAD_PARAM", "splits required");
  const row: EpisodeRow = {
    id: newId("ep"), title, feed: (opts.feed ?? "").trim().slice(0, 500),
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

/** Beat payloads for one session: one per stream so every split keeps flowing. */
export function sessionBeats(s: CastSession, elapsedMin: number): Array<{ streamId: string; text: string; refs: string[] }> {
  return s.streamIds.map((sid) => ({
    streamId: sid,
    text: `playing ${s.title} +${Math.floor(elapsedMin)}m`,
    refs: [`stream:${sid}`],
  }));
}
