/**
 * `bsv watch`: one filtered, cursor-based tail over everything the wallet
 * does — policy lifecycle, stream payments, incoming payments, x402
 * receipts, board/memory posts, cast recordings.
 *
 * This is the one idea worth carrying over from Bonsai (auxon/bonsai): the
 * daemon owns the data, so the *query* runs here and the result is pushed
 * to subscribers instead of every agent diffing state on a timer. No C#,
 * no Qactive, no new state table: the feed is read from tables that
 * already exist.
 *
 * Ordering is (at, source, key). A cursor is the last delivered timestamp
 * plus the composite keys delivered *at* that timestamp, so a tail never
 * skips a row sharing a millisecond with the cursor and never re-sends one
 * it already sent — across daemon restarts, and with nothing new to keep.
 */
import type { Knex } from "knex";

export type WatchDir = "" | "in" | "out";

export interface WatchEvent {
  source: string;
  type: string;
  at: number;
  key: string;
  dir: WatchDir;
  sats: number;
  origin: string;
  status: string;
  detail: string;
}

export interface WatchCursor {
  /** Timestamp of the last delivered event; 0 = start from the beginning. */
  at: number;
  /** Composite keys already delivered at exactly `at` (same-millisecond ties). */
  keys: string[];
}

export const WATCH_TYPES = [
  "request.created",
  "request.approved",
  "request.denied",
  "budget.minted",
  "budget.revoked",
  "payment.received",
  "stream.tick",
  "x402.received",
  "board.post",
  "cast.recording",
  "cast.recording.stopped",
] as const;

/** Fields a filter may mention, and which comparison ops each accepts. */
const TEXT_FIELDS = new Set(["type", "source", "origin", "status", "dir", "detail"]);
const NUM_FIELDS = new Set(["sats", "at"]);
const TIME_FIELDS = new Set(["since", "until"]);
const TEXT_OPS = new Set(["=", "!=", "~"]);
const NUM_OPS = new Set(["=", "!=", ">", ">=", "<", "<="]);

export interface WatchCond {
  field: string;
  op: string;
  value: string | number;
  /** Alternatives from `a|b|c`: ORed inside this condition, ANDed across. */
  alts?: string[];
}

export interface CompiledWatchFilter {
  conds: WatchCond[];
  /** Echo of the caller's own text/JSON, for logs and error messages. */
  text: string;
}

const DURATION = /^(\d+)(s|m|h|d|w)$/;

/** `1h`, `30m`, `7d` — durations only. Absolute times go through `at>=<ms>`. */
export function parseDurationMs(value: string): number {
  const m = DURATION.exec(value);
  if (!m) throw badFilter(`bad duration "${value}" (use 30s, 15m, 1h, 7d, 2w)`);
  const n = Number(m[1]);
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * (unit[m[2]!] ?? 1000);
}

/**
 * Documented aliases, so an agent can ask the obvious question. `payment`
 * means "money moved, either direction" — incoming payments, x402 receipts,
 * and stream payments — because that is what people mean by it.
 */
const TYPE_ALIASES: Record<string, string[]> = {
  payment: ["payment.received", "x402.received", "stream.tick"],
};

/** `payment` matches `payment.received`; `payment.received` matches exactly. */
export function typeMatches(value: string, type: string): boolean {
  if (value === type) return true;
  if (TYPE_ALIASES[value]?.includes(type)) return true;
  return type.startsWith(`${value}.`) || type.startsWith(`${value}:`);
}

function oneOf(value: string): string[] {
  return value.split("|").map((v) => v.trim()).filter((v) => v.length > 0);
}

/** Bad input is the caller's mistake, not a daemon fault — say so in the code. */
function badFilter(message: string): Error {
  return Object.assign(new Error(message), { code: "BAD_PARAM" });
}

function addTextCond(conds: WatchCond[], field: string, op: string, value: string): void {
  const alts = oneOf(value);
  if (alts.length === 0) throw badFilter(`filter ${field}${op} needs a value`);
  // One condition, ORed across the alternatives. `a|b|c` means any of them;
  // two separate conditions would mean all of them, which is never meant.
  conds.push({ field, op, value: alts.join("|"), alts });
}

function addNumCond(conds: WatchCond[], field: string, op: string, value: string): void {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badFilter(`filter ${field}${op} needs a number, got "${value}"`);
  conds.push({ field, op, value: n });
}

/**
 * Text DSL: whitespace-separated `field op value` conditions, ANDed.
 * `type=payment stream sats>=100 since=1h` — `|` separates alternatives,
 * `~` is a case-insensitive substring test, `since`/`until` take durations.
 * Unknown fields and bad operators throw: a filter that silently matches
 * everything is worse than no filter at all.
 */
export function parseWatchFilter(text: string, now: number = Date.now()): CompiledWatchFilter {
  const conds: WatchCond[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    for (const token of trimmed.split(/\s+/)) {
      const m = /^([A-Za-z_]+)(!=|>=|<=|=|>|<|~)(.+)$/.exec(token);
      if (!m) throw badFilter(`cannot parse filter term "${token}" (want field=value)`);
      const [, field, op, value] = m as unknown as [string, string, string, string];
      const f = field.toLowerCase();
      if (TIME_FIELDS.has(f)) {
        const ms = parseDurationMs(value);
        conds.push({ field: "at", op: f === "since" ? ">=" : "<=", value: f === "since" ? now - ms : now + ms });
        continue;
      }
      if (TEXT_FIELDS.has(f)) {
        if (!TEXT_OPS.has(op)) throw badFilter(`field ${f} accepts = != ~, not ${op}`);
        addTextCond(conds, f, op, value);
        continue;
      }
      if (NUM_FIELDS.has(f)) {
        if (!NUM_OPS.has(op)) throw badFilter(`field ${f} accepts ${[...NUM_OPS].join(" ")}, not ${op}`);
        addNumCond(conds, f, op, value);
        continue;
      }
      throw badFilter(`unknown filter field "${f}" (known: ${[...TEXT_FIELDS, ...NUM_FIELDS, ...TIME_FIELDS].join(", ")})`);
    }
  }
  return { conds, text: trimmed };
}

/** JSON form for RPC/MCP callers: { type, source, minSats, since, sinceMs, ... }. */
export function compileWatchFilter(spec: unknown, now: number = Date.now()): CompiledWatchFilter {
  if (spec === undefined || spec === null) return { conds: [], text: "" };
  if (typeof spec === "string") return parseWatchFilter(spec, now);
  if (typeof spec !== "object" || Array.isArray(spec)) throw badFilter("filter must be a string or an object");
  const o = spec as Record<string, unknown>;
  const conds: WatchCond[] = [];
  const eq = (field: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string" && typeof value !== "number") {
      throw badFilter(`filter ${field} must be a string, number, or array of strings`);
    }
    if (NUM_FIELDS.has(field)) addNumCond(conds, field, "=", String(value));
    else addTextCond(conds, field, "=", String(value));
  };
  for (const [k, v] of Object.entries(o)) {
    const f = k.toLowerCase();
    if (v === undefined || v === null) continue;
    if (f === "minsats") { addNumCond(conds, "sats", ">=", String(v)); continue; }
    if (f === "maxsats") { addNumCond(conds, "sats", "<=", String(v)); continue; }
    if (f === "sincesecs" || f === "since") { conds.push({ field: "at", op: ">=", value: now - Math.floor(Number(v) * 1000) }); continue; }
    if (f === "sincehours") { conds.push({ field: "at", op: ">=", value: now - Math.floor(Number(v) * 3_600_000) }); continue; }
    if (f === "sinems" || f === "untilsms" || f === "untilms") { addNumCond(conds, "at", f.startsWith("since") ? ">=" : "<=", String(v)); continue; }
    if (!TEXT_FIELDS.has(f) && !NUM_FIELDS.has(f)) throw badFilter(`unknown filter field "${f}"`);
    if (Array.isArray(v)) {
      // An array is a set of alternatives, not a conjunction: { type: ["payment","stream"] }
      if (NUM_FIELDS.has(f)) throw badFilter(`filter ${f} takes a single number (use min${f} / max${f})`);
      if (!v.every((x) => typeof x === "string")) throw badFilter(`filter ${f} array must hold strings`);
      addTextCond(conds, f, "=", v.join("|"));
      continue;
    }
    eq(f, v);
  }
  return { conds, text: JSON.stringify(o) };
}

/** Does one alternative hold for this event? */
function altHolds(field: string, op: string, alt: string | number, ev: WatchEvent): boolean {
  if (field === "at" || field === "sats") {
    const n = Number(field === "at" ? ev.at : ev.sats);
    const v = Number(alt);
    switch (op) {
      case "=": return n === v;
      case "!=": return n !== v;
      case ">": return n > v;
      case ">=": return n >= v;
      case "<": return n < v;
      case "<=": return n <= v;
      default: return true;
    }
  }
  const s = String(ev[field as keyof WatchEvent] ?? "");
  const v = String(alt);
  switch (op) {
    case "~": return s.toLowerCase().includes(v.toLowerCase());
    // type/source are hierarchical: `payment` also means `payment.received`.
    case "=": return field === "type" || field === "source" ? typeMatches(v, s) : v === s;
    case "!=": return v !== s;
    default: return true;
  }
}

function condHolds(cond: WatchCond, ev: WatchEvent): boolean {
  const alts = cond.alts && cond.alts.length > 0 ? cond.alts : [cond.value];
  // `a|b` is "any of them" — except when negated, where it reads as
  // "neither": origin!=cli|cast means "not cli and not cast".
  if (cond.op === "!=") return alts.every((alt) => altHolds(cond.field, "=", alt, ev));
  return alts.some((alt) => altHolds(cond.field, cond.op, alt, ev));
}

export function watchMatches(ev: WatchEvent, filter: CompiledWatchFilter): boolean {
  return filter.conds.every((c) => condHolds(c, ev));
}

/** Stable identity of an event within the merged feed. */
export function watchKey(ev: WatchEvent): string {
  return `${ev.source}|${ev.key}`;
}

interface WatchSource {
  name: string;
  /** Newest timestamp this source holds (0 when empty) — used to tail. */
  maxAt: (db: Knex) => Promise<number>;
  pull: (db: Knex, fromAt: number, limit: number) => Promise<WatchEvent[]>;
}

const maxOf = async (db: Knex, table: string, col: string): Promise<number> => {
  const row = (await db(table).max({ m: col }).first()) as { m?: number | string | null } | undefined;
  const n = Number(row?.m);
  return Number.isFinite(n) ? n : 0;
};

const SOURCES: WatchSource[] = [
  {
    name: "policy",
    maxAt: (db) => maxOf(db, "policy_events", "created_at"),
    pull: async (db, fromAt, limit) => {
      const rows = await db("policy_events")
        .select("id", "created_at", "type", "origin", "amount_sats", "action", "detail")
        .where("created_at", ">", fromAt)
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit);
      return rows.map((r) => ({
        source: "policy",
        type: String(r.type),
        at: Number(r.created_at) || 0,
        key: String(r.id),
        dir: "" as WatchDir,
        sats: Number(r.amount_sats) || 0,
        origin: String(r.origin ?? ""),
        status: String(r.action ?? ""),
        detail: String(r.detail ?? ""),
      }));
    },
  },
  {
    name: "stream",
    maxAt: (db) => maxOf(db, "stream_ticks", "created_at"),
    pull: async (db, fromAt, limit) => {
      const rows = await db("stream_ticks")
        .select("id", "stream_id", "beat_id", "amount", "status", "detail", "created_at")
        .where("created_at", ">", fromAt)
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit);
      return rows.map((r) => ({
        source: "stream",
        type: "stream.tick",
        at: Number(r.created_at) || 0,
        key: String(r.id),
        dir: "out" as WatchDir,
        sats: Number(r.amount) || 0,
        origin: String(r.stream_id ?? ""),
        status: String(r.status ?? ""),
        detail: String(r.detail ?? "") || (r.beat_id ? `beat ${r.beat_id}` : ""),
      }));
    },
  },
  {
    name: "receipt",
    maxAt: (db) => maxOf(db, "receipts", "created_at"),
    pull: async (db, fromAt, limit) => {
      const rows = await db("receipts")
        .select("id", "payment_txid", "peer", "amount", "memo", "status", "created_at")
        .where("created_at", ">", fromAt)
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit);
      return rows.map((r) => ({
        source: "receipt",
        type: "payment.received",
        at: Number(r.created_at) || 0,
        key: String(r.id),
        dir: "in" as WatchDir,
        sats: Number(r.amount) || 0,
        origin: String(r.peer ?? ""),
        status: String(r.status ?? ""),
        detail: [String(r.memo ?? ""), `tx ${String(r.payment_txid ?? "").slice(0, 12)}`].filter(Boolean).join(" — "),
      }));
    },
  },
  {
    name: "x402",
    maxAt: (db) => maxOf(db, "x402_receipts", "created_at"),
    pull: async (db, fromAt, limit) => {
      const rows = await db("x402_receipts")
        .select("id", "url", "amount_sats", "pay_to", "settled", "created_at")
        .where("created_at", ">", fromAt)
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit);
      return rows.map((r) => {
        // `settled` holds the facilitator's JSON reply; surface the verdict,
        // not the blob.
        let verdict = String(r.settled ?? "");
        let txid = "";
        try {
          const settled = JSON.parse(verdict) as { success?: unknown; transaction?: unknown };
          verdict = settled.success ? "settled" : "failed";
          txid = typeof settled.transaction === "string" ? settled.transaction : "";
        } catch {
          /* not JSON: show it raw */
        }
        return {
          source: "x402",
          type: "x402.received",
          at: Number(r.created_at) || 0,
          key: String(r.id),
          dir: "in" as WatchDir,
          sats: Number(r.amount_sats) || 0,
          origin: String(r.pay_to ?? ""),
          status: verdict,
          detail: `${String(r.url ?? "")}${txid ? ` — tx ${txid.slice(0, 12)}` : ""}`,
        };
      });
    },
  },
  {
    name: "board",
    maxAt: (db) => maxOf(db, "board_posts", "received_at"),
    pull: async (db, fromAt, limit) => {
      const rows = await db("board_posts")
        .select("id", "board", "direction", "agent", "sig_ok", "received_at", "envelope")
        .where("received_at", ">", fromAt)
        .orderBy("received_at")
        .orderBy("id")
        .limit(limit);
      return rows.map((r) => {
        let verb = "post";
        try {
          const env = JSON.parse(String(r.envelope ?? "{}")) as { t?: string };
          if (env.t) verb = String(env.t);
        } catch {
          /* unparsable envelope: the direction still shows */
        }
        return {
          source: "board",
          type: "board.post",
          at: Number(r.received_at) || 0,
          key: `${String(r.board)}|${String(r.id)}`,
          dir: "" as WatchDir,
          sats: 0,
          origin: String(r.agent ?? ""),
          status: Number(r.sig_ok) === 1 ? "ok" : "bad-sig",
          detail: `${String(r.direction ?? "")} ${String(r.board ?? "")} ${verb}`.trim(),
        };
      });
    },
  },
  {
    name: "cast",
    maxAt: async (db) => Math.max(
      await maxOf(db, "cast_sessions", "started_at"),
      await maxOf(db, "cast_sessions", "stopped_at"),
    ),
    pull: async (db, fromAt, limit) => {
      const started = await db("cast_sessions")
        .select("id", "episode", "title", "rate_per_min", "status", "started_at")
        .where("started_at", ">", fromAt)
        .orderBy("started_at")
        .orderBy("id")
        .limit(limit);
      const stopped = await db("cast_sessions")
        .select("id", "episode", "status", "stopped_at")
        .whereNotNull("stopped_at")
        .andWhere("stopped_at", ">", fromAt)
        .orderBy("stopped_at")
        .orderBy("id")
        .limit(limit);
      const evs: WatchEvent[] = started.map((r) => ({
        source: "cast",
        type: "cast.recording",
        at: Number(r.started_at) || 0,
        key: String(r.id),
        dir: "" as WatchDir,
        sats: 0,
        origin: String(r.episode ?? ""),
        status: "playing",
        detail: `${String(r.title ?? "")} — ${Number(r.rate_per_min) || 0} sats/min`.trim(),
      }));
      for (const r of stopped) {
        evs.push({
          source: "cast",
          type: "cast.recording.stopped",
          at: Number(r.stopped_at) || 0,
          key: `${String(r.id)}|stop`,
          dir: "" as WatchDir,
          sats: 0,
          origin: String(r.episode ?? ""),
          status: String(r.status ?? "stopped"),
          detail: "",
        });
      }
      return evs;
    },
  },
];

export function watchSourceNames(): string[] {
  return SOURCES.map((s) => s.name);
}

/**
 * A cursor parked at "now": the newest timestamp any source holds, plus the
 * keys sitting at that instant. Following from here delivers only what
 * happens next — never a replay of the archive.
 */
export async function watchTailCursor(db: Knex): Promise<WatchCursor> {
  const stamps = await Promise.all(SOURCES.map((s) => s.maxAt(db)));
  const at = Math.max(0, ...stamps.map((n) => (Number.isFinite(n) ? n : 0)));
  if (at === 0) return { at: Date.now(), keys: [] };
  const rows = await pullAll(db, at - 1, 200);
  return { at, keys: rows.filter((e) => e.at === at).map((e) => watchKey(e)) };
}

/**
 * Merge, order, filter, and advance the cursor. Events already delivered
 * (anything older than the cursor, or sharing its millisecond and key) are
 * dropped, so a caller can poll as fast as it likes without duplicates.
 */
export function mergeWatchEvents(
  events: WatchEvent[],
  cursor: WatchCursor | null,
  limit: number,
  filter: CompiledWatchFilter,
): { events: WatchEvent[]; cursor: WatchCursor | null } {
  const at = cursor?.at ?? 0;
  const seen = new Set((cursor?.keys ?? []).map((k) => `${at}|${k}`));
  const fresh = events.filter((e) => {
    if (e.at < at) return false;
    if (e.at === at && seen.has(`${e.at}|${watchKey(e)}`)) return false;
    return true;
  });
  fresh.sort((a, b) => a.at - b.at || (a.source < b.source ? -1 : a.source > b.source ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: WatchEvent[] = [];
  for (const e of fresh) {
    if (!watchMatches(e, filter)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  if (out.length === 0) return { events: out, cursor };
  const last = out[out.length - 1]!;
  // Keys accumulate while the cursor sits on one millisecond: a drain that
  // stops mid-millisecond must not forget what it already sent, or the
  // next call replays it.
  const carried = cursor && cursor.at === last.at ? cursor.keys : [];
  const keys = [...carried, ...out.filter((e) => e.at === last.at).map((e) => watchKey(e))];
  return { events: out, cursor: { at: last.at, keys } };
}

async function pullAll(db: Knex, fromAt: number, per: number): Promise<WatchEvent[]> {
  const batches = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        return await s.pull(db, fromAt, per);
      } catch (e) {
        // Name the source: a feed that silently drops a table is a lie.
        throw new Error(`watch source "${s.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  return batches.flat();
}

export interface WatchQueryOpts {
  filter?: unknown;
  cursor?: WatchCursor | null;
  limit?: number;
  now?: number;
}

export async function watchQuery(
  db: Knex,
  opts: WatchQueryOpts = {},
): Promise<{ events: WatchEvent[]; cursor: WatchCursor | null; filter: string }> {
  const now = opts.now ?? Date.now();
  const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)));
  const filter = compileWatchFilter(opts.filter, now);
  const cursor = opts.cursor ?? null;
  const rows = await pullAll(db, cursor?.at ?? 0, Math.max(limit * 2, 50));
  const merged = mergeWatchEvents(rows, cursor, limit, filter);
  return { ...merged, filter: filter.text };
}

/** Long-poll: sleep until something matches, or `waitMs` elapses. */
export async function watchPoll(
  db: Knex,
  opts: WatchQueryOpts & { waitMs?: number } = {},
): Promise<{ events: WatchEvent[]; cursor: WatchCursor | null; filter: string; timedOut: boolean }> {
  const wait = Math.min(60_000, Math.max(0, Math.floor(Number(opts.waitMs) || 0)));
  const deadline = Date.now() + wait;
  for (;;) {
    const res = await watchQuery(db, opts);
    if (res.events.length > 0 || Date.now() >= deadline) {
      return { ...res, timedOut: res.events.length === 0 };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Tail indexes: polling is `where ts > cursor`, so keep those cheap. */
export async function migrateWatch(db: Knex): Promise<void> {
  const stmts: Array<[string, string]> = [
    ["policy_events", "created_at"],
    ["stream_ticks", "created_at"],
    ["receipts", "created_at"],
    ["x402_receipts", "created_at"],
    ["board_posts", "received_at"],
    ["cast_sessions", "started_at"],
    ["cast_sessions", "stopped_at"],
  ];
  for (const [table, col] of stmts) {
    if (!(await db.schema.hasTable(table))) continue;
    await db.raw(`CREATE INDEX IF NOT EXISTS ?? ON ?? (??)`, [`watch_${table}_${col}`, table, col]);
  }
}
