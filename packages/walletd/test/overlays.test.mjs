import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  overlayHealth,
  overlayLookup,
  overlayTopics,
  tagsFor,
  tagTransaction,
  tokenRegistry,
} from "../src/overlays.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    return true;
  });
}

const TOKENS = [
  { token_id: "a".repeat(64) + "_0", symbol: "AAA", decimals: 2 },
  { token_id: "b".repeat(64) + "_1", symbol: "", decimals: 8 },
  { garbage: true },
];

function stubFetch(routes) {
  return async (url, init) => {
    for (const [match, body, status] of routes) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: status ?? 200 });
    }
    return new Response("nope", { status: 404 });
  };
}

test("health reports live/down without throwing", async () => {
  const fetchFn = stubFetch([
    ["chaintracks/height", { height: 1 }],
    ["sigma.1sat.app", "down", 500],
  ]);
  const rows = await overlayHealth({ fetchFn });
  assert.equal(rows.length, 3);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.bsv21.live, true);
  assert.ok(byId.bsv21.latencyMs >= 0);
  assert.equal(byId.sigma.live, false);
  assert.equal(byId.sigma.latencyMs, -1);
  // total outage still resolves
  const dead = await overlayHealth({ fetchFn: async () => { throw new Error("down"); } });
  assert.ok(dead.every((r) => r.live === false));
});

test("topics come from the live registry; lookup is strict", async () => {
  const fetchFn = stubFetch([["/1sat/bsv21/tokens", TOKENS]]);
  const topics = await overlayTopics({ fetchFn });
  assert.ok(topics.some((t) => t.topic === "bsv21 tokens"));
  assert.ok(topics.some((t) => t.topic === `tm_${"a".repeat(64)}_0` && t.symbol === "AAA"));
  await rejectsCode(overlayLookup("garbage", { fetchFn }), "BAD_TOPIC");
  await rejectsCode(overlayLookup(`tm_${"a".repeat(64)}_0`, { fetchFn }), "BAD_PARAM");
  await rejectsCode(
    overlayLookup(`tm_${"c".repeat(64)}_0`, { fetchFn, address: "1abc" }),
    "RAILS",
  );
});

test("lookup reads unspent/history per token", async () => {
  const unspent = [{ txid: "d".repeat(64), vout: 0, satoshis: 100 }];
  const fetchFn = stubFetch([
    ["/unspent", unspent],
    ["/history", [{ txid: "e".repeat(64) }]],
  ]);
  const u = await overlayLookup(`tm_${"a".repeat(64)}_0`, { fetchFn, address: "1abc" });
  assert.equal(u.what, "unspent");
  assert.equal(u.rows.length, 1);
  const h = await overlayLookup(`tm_${"a".repeat(64)}_0`, { fetchFn, address: "1abc", what: "history" });
  assert.equal(h.what, "history");
  assert.equal(h.rows.length, 1);
});

test("tagging is ownership-scoped to tracked txs", async () => {
  const db = await memdb();
  try {
    const txid = "f".repeat(64);
    await rejectsCode(tagTransaction(db, txid, ["tm_x"]), "NOT_OURS");
    await rejectsCode(tagTransaction(db, "zzz", ["tm_x"]), "BAD_PARAM");
    await rejectsCode(tagTransaction(db, txid, []), "BAD_PARAM");
    await db("pending_txs").insert({
      txid, label: "x", status: "seen", attempts: 0, last_check: 0, created_at: Date.now(),
    });
    const tagged = await tagTransaction(db, txid.toUpperCase(), ["tm_a", "tm_b", "tm_a", ""]);
    assert.deepEqual(tagged.topics, ["tm_a", "tm_b"]);
    assert.deepEqual(await tagsFor(db, txid), ["tm_a", "tm_b"]); // sorted, deduped
    assert.deepEqual(await tagsFor(db, "0".repeat(64)), []);
    await rejectsCode(tagTransaction(db, txid, ["x".repeat(201)]), "BAD_PARAM");
  } finally {
    await db.destroy();
  }
});

test("token registry tolerates junk rows", async () => {
  const fetchFn = stubFetch([["/1sat/bsv21/tokens", TOKENS]]);
  const { tokenRegistry: reg } = await import("../src/overlays.ts");
  const rows = await reg({ fetchFn });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].symbol, `${"b".repeat(12)}`);
  await rejectsCode(reg({ fetchFn: async () => new Response("x", { status: 500 }) }), "RAILS");
});
