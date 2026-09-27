import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { logEvent } from "../src/events.ts";
import {
  compileWatchFilter,
  mergeWatchEvents,
  parseDurationMs,
  parseWatchFilter,
  watchMatches,
  watchPoll,
  watchQuery,
  watchSourceNames,
  watchTailCursor,
} from "../src/watch.ts";

delete process.env.OPENROUTER_API_KEY;

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

const ev = (over = {}) => ({
  source: "policy",
  type: "request.created",
  at: 1000,
  key: "1",
  dir: "",
  sats: 0,
  origin: "cli",
  status: "",
  detail: "",
  ...over,
});

test("duration parsing is units-only and loud", () => {
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("15m"), 900_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("7d"), 604_800_000);
  assert.throws(() => parseDurationMs("5x"), /bad duration/);
  assert.throws(() => parseDurationMs("3600"), /bad duration/); // bare numbers are ambiguous — say so
});

test("filter DSL: fields, operators, alternatives, hierarchical types", () => {
  const now = 1_000_000_000;
  const f = (text) => parseWatchFilter(text, now);
  assert.equal(f("type=payment").conds.length, 1);
  // Hierarchical: `payment` is a prefix of `payment.received` …
  assert.equal(watchMatches(ev({ type: "payment.received", sats: 500 }), f("type=payment")), true);
  assert.equal(watchMatches(ev({ type: "request.created" }), f("type=request")), true);
  // … and a documented alias: `payment` also means "money moved", so a
  // stream payment or an x402 receipt counts.
  assert.equal(watchMatches(ev({ type: "stream.tick", sats: 20 }), f("type=payment")), true);
  assert.equal(watchMatches(ev({ type: "x402.received", sats: 20 }), f("type=payment")), true);
  // Unrelated types stay unrelated.
  assert.equal(watchMatches(ev({ type: "board.post" }), f("type=payment")), false);
  assert.equal(watchMatches(ev({ type: "request.created" }), f("type=request.approved")), false);
  assert.equal(watchMatches(ev({ sats: 500 }), f("sats>=100")), true);
  assert.equal(watchMatches(ev({ sats: 99 }), f("sats>=100")), false);
  assert.equal(watchMatches(ev({ sats: 0 }), f("sats<100")), true);
  assert.equal(watchMatches(ev({ detail: "JEVES-tips" }), f("detail~tips")), true);
  assert.equal(watchMatches(ev({ origin: "cast" }), f("origin=cli|cast")), true);
  assert.equal(watchMatches(ev({ origin: "cast" }), f("origin!=cli|cast")), false);
  assert.equal(watchMatches(ev({ dir: "in" }), f("dir=in")), true);
  // since/until are relative to now and land on `at`.
  const since = f("since=1h").conds[0];
  assert.deepEqual(since, { field: "at", op: ">=", value: now - 3_600_000 });
  const until = f("until=30m").conds[0];
  assert.deepEqual(until, { field: "at", op: "<=", value: now + 1_800_000 });
  // ANDed conditions.
  assert.equal(watchMatches(ev({ type: "payment.received", sats: 500, at: now }), f("type=payment sats>=100 since=1h")), true);
  assert.equal(watchMatches(ev({ type: "payment.received", sats: 5, at: now }), f("type=payment sats>=100 since=1h")), false);
});

test("filter DSL rejects nonsense instead of matching everything", () => {
  assert.throws(() => parseWatchFilter("sats"), /cannot parse filter term/);
  assert.throws(() => parseWatchFilter("nope=1"), /unknown filter field "nope"/);
  assert.throws(() => parseWatchFilter("sats~abc"), /field sats accepts/);
  assert.throws(() => parseWatchFilter("type>=x"), /field type accepts/);
  assert.throws(() => parseWatchFilter("sats>=abc"), /needs a number/);
  assert.throws(() => parseWatchFilter("since=5"), /bad duration/);
});

test("JSON filter form", () => {
  const now = 2_000_000_000;
  const c = compileWatchFilter({ type: ["payment", "stream"], minSats: 100, dir: "in", sinceHours: 1 }, now);
  assert.equal(watchMatches(ev({ type: "x402.received", sats: 250, dir: "in", at: now - 60_000 }), c), true);
  assert.equal(watchMatches(ev({ type: "x402.received", sats: 250, dir: "in", at: now - 7_200_000 }), c), false);
  assert.equal(watchMatches(ev({ type: "stream.tick", sats: 250, dir: "out", at: now - 60_000 }), c), false);
  assert.equal(compileWatchFilter(undefined).conds.length, 0);
  assert.throws(() => compileWatchFilter({ bogus: 1 }), /unknown filter field/);
});

test("merge orders by (at, source, key) and never re-sends", () => {
  const rows = [
    ev({ source: "stream", at: 2000, key: "b" }),
    ev({ source: "board", at: 1000, key: "z" }),
    ev({ source: "board", at: 1000, key: "a" }),
    ev({ source: "policy", at: 1000, key: "9" }),
  ];
  const all = mergeWatchEvents(rows, null, 10, { conds: [], text: "" });
  assert.deepEqual(all.events.map((e) => `${e.at}/${e.source}/${e.key}`), [
    "1000/board/a", "1000/board/z", "1000/policy/9", "2000/stream/b",
  ]);
  assert.deepEqual(all.cursor, { at: 2000, keys: ["stream|b"] });
  // Draining from a cursor: everything already delivered is gone.
  const rest = mergeWatchEvents([...rows, ev({ at: 3000, key: "new" })], all.cursor, 10, { conds: [], text: "" });
  assert.deepEqual(rest.events.map((e) => e.at), [3000]);
  assert.deepEqual(rest.cursor, { at: 3000, keys: ["policy|new"] });
});

test("same-millisecond events survive a limited drain", () => {
  // Three rows share a millisecond; the caller takes one, then the rest
  // must still arrive (the cursor carries the keys, not just the time).
  const rows = [
    ev({ source: "a", at: 5000, key: "1" }),
    ev({ source: "b", at: 5000, key: "2" }),
    ev({ source: "c", at: 5000, key: "3" }),
  ];
  const none = { conds: [], text: "" };
  const first = mergeWatchEvents(rows, null, 1, none);
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.cursor, { at: 5000, keys: ["a|1"] });
  const second = mergeWatchEvents(rows, first.cursor, 1, none);
  assert.deepEqual(second.events.map((e) => e.key), ["2"]);
  const third = mergeWatchEvents(rows, second.cursor, 5, none);
  assert.deepEqual(third.events.map((e) => e.key), ["3"]);
  const drained = mergeWatchEvents(rows, third.cursor, 5, none);
  assert.deepEqual(drained.events, []);
  assert.deepEqual(drained.cursor, third.cursor); // idle drain keeps the cursor
});

test("feed merges every source the daemon already keeps", async () => {
  const db = await memdb();
  try {
    const now = Date.now();
    await logEvent(db, "request.created", { origin: "cli", amountSats: 250, action: "app-spend", detail: "JEVES-tips" });
    await db("stream_ticks").insert({ stream_id: "stm_abc", beat_id: "b1", amount: 1155, status: "paid", detail: "", created_at: now });
    await db("x402_receipts").insert({ url: "https://x/serve/menu", amount_sats: 20, pay_to: "1abc", txid: "f".repeat(64), settled: "mined", created_at: now });
    await db("receipts").insert({
      id: "rcpt1", payment_txid: "a".repeat(64), peer: "1peer", peer_address: "1peer", amount: 500,
      memo: "thanks", data_hex: "", status: "inscribed", created_at: now,
    });
    await db("board_posts").insert({
      id: "bp1", board: "memory", direction: "out", from_key: "02aa", agent: "opencode",
      ts: now, received_at: now, envelope: JSON.stringify({ t: "memory.remember" }), sig_ok: 1,
    });
    await db("funds_attestations").insert({
      key: "a".repeat(66), address: "1me", min_sats: 25_000, root: "b".repeat(64),
      utxo_count: 7, total_sats: 90_000, created_at: now, valid_until: now + 3_600_000,
      statement: "{}", signature: "sig", anchor_txid: "c".repeat(64),
    });
    await db("cast_sessions").insert({
      id: "cs_1", episode: "ep_1", title: "Live set", rate_per_min: 20, every_secs: 30, max_total: 1000,
      stream_ids: "[]", status: "stopped", started_at: now, stopped_at: now + 1,
    });

    assert.deepEqual(watchSourceNames(), ["policy", "stream", "receipt", "x402", "board", "attest", "cast"]);

    const all = await watchQuery(db, { limit: 50 });
    const types = all.events.map((e) => e.type);
    for (const want of ["request.created", "stream.tick", "payment.received", "x402.received", "board.post", "funds.attested", "cast.recording", "cast.recording.stopped"]) {
      assert.ok(types.includes(want), `expected ${want} in ${JSON.stringify(types)}`);
    }
    // Money is labelled as money, in both directions.
    const tick = all.events.find((e) => e.type === "stream.tick");
    assert.deepEqual([tick.dir, tick.sats, tick.origin], ["out", 1155, "stm_abc"]);
    const rcpt = all.events.find((e) => e.type === "payment.received");
    assert.deepEqual([rcpt.dir, rcpt.sats, rcpt.origin], ["in", 500, "1peer"]);
    const post = all.events.find((e) => e.type === "board.post");
    assert.equal(post.status, "ok");
    assert.match(post.detail, /memory memory\.remember/);

    // Filtering happens in the daemon, which is the whole point.
    const paid = await watchQuery(db, { filter: "type=payment|stream sats>=1000", limit: 50 });
    assert.deepEqual(paid.events.map((e) => `${e.type}:${e.sats}`), ["stream.tick:1155"]);
    const origin = await watchQuery(db, { filter: "origin=opencode", limit: 50 });
    assert.deepEqual(origin.events.map((e) => e.type), ["board.post"]);
  } finally {
    await db.destroy();
  }
});

test("cursor drains a live feed exactly once, and polls block until it happens", async () => {
  const db = await memdb();
  try {
    const first = await watchPoll(db, { limit: 5, waitMs: 0 });
    assert.deepEqual(first.events, []);
    assert.equal(first.timedOut, true);

    // Nothing new: a 1s long-poll must time out rather than invent events.
    const idle = await watchPoll(db, { limit: 5, waitMs: 1000 });
    assert.deepEqual(idle.events, []);
    assert.equal(idle.timedOut, true);

    await logEvent(db, "budget.minted", { origin: "watch-test", amountSats: 1000 });
    const got = await watchPoll(db, { filter: "type=budget", limit: 5, waitMs: 1000 });
    assert.equal(got.events.length, 1);
    assert.equal(got.events[0].type, "budget.minted");
    const cursor = got.cursor;
    // Re-polling with the same cursor yields nothing new; with a fresh one, the row.
    const again = await watchPoll(db, { filter: "type=budget", cursor, limit: 5, waitMs: 0 });
    assert.deepEqual(again.events, []);
    const replay = await watchPoll(db, { filter: "type=budget", limit: 5, waitMs: 0 });
    assert.equal(replay.events.length, 1);
  } finally {
    await db.destroy();
  }
});

test("tail cursor parks at the newest event, not the oldest", async () => {
  const db = await memdb();
  try {
    // Empty: park at now so following simply waits.
    const empty = await watchTailCursor(db);
    assert.equal(empty.keys.length, 0);
    assert.ok(empty.at > 0);

    const base = Date.now();
    await db("policy_events").insert({ created_at: base - 5000, type: "budget.minted", origin: "old", amount_sats: 1, action: "", detail: "" });
    await db("policy_events").insert({ created_at: base, type: "request.created", origin: "newest", amount_sats: 0, action: "", detail: "" });
    const tail = await watchTailCursor(db);
    assert.equal(tail.at, base);
    assert.deepEqual(tail.keys, ["policy|" + (await db("policy_events").max({ m: "id" }).first()).m]);
    // Following from the tail cursor sees nothing until something new lands.
    const quiet = await watchPoll(db, { cursor: tail, limit: 10, waitMs: 300 });
    assert.deepEqual(quiet.events, []);
    await logEvent(db, "budget.revoked", { origin: "after", amountSats: 0 });
    const live = await watchPoll(db, { cursor: tail, limit: 10, waitMs: 2000 });
    assert.deepEqual(live.events.map((e) => e.type), ["budget.revoked"]);
  } finally {
    await db.destroy();
  }
});

test("a source larger than one page still reaches the newest event", async () => {
  // Regression: the policy source once filtered on created_at but ordered by
  // id, so past one page the newest events were unreachable — a live stream
  // went silent while rows kept landing.
  const db = await memdb();
  try {
    const base = Date.now() - 1000;
    const rows = [];
    for (let i = 0; i < 120; i++) {
      rows.push({ created_at: base + i, type: "request.created", origin: `agent-${i}`, amount_sats: i, action: "", detail: "" });
    }
    await db("policy_events").insert(rows);

    // Draining from the beginning in small pages must reach the end.
    let cursor = null;
    const seen = [];
    for (let i = 0; i < 20; i++) {
      const page = await watchQuery(db, { limit: 10, cursor });
      if (page.events.length === 0) break;
      seen.push(...page.events.map((e) => e.origin));
      cursor = page.cursor;
    }
    assert.equal(seen.length, 120);
    assert.equal(new Set(seen).size, 120, "no duplicates while draining");
    assert.equal(seen.at(-1), "agent-119");

    // And a tail cursor jumps to the end, so the next event is live.
    const tail = await watchTailCursor(db);
    const after = await watchPoll(db, { cursor: tail, limit: 10, waitMs: 200 });
    assert.deepEqual(after.events, []);
    await logEvent(db, "request.approved", { origin: "live-one", amountSats: 5 });
    const live = await watchPoll(db, { cursor: tail, limit: 10, waitMs: 2000 });
    assert.deepEqual(live.events.map((e) => e.origin), ["live-one"]);
  } finally {
    await db.destroy();
  }
});

test("a broken source is named, never silently skipped", async () => {
  const db = await memdb();
  try {
    await db.schema.dropTable("stream_ticks");
    await assert.rejects(() => watchQuery(db, { limit: 5 }), /watch source "stream" failed/);
  } finally {
    await db.destroy();
  }
});
