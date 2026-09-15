import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import {
  boardGet,
  boardList,
  claimGig,
  listGigs,
  paidGig,
  submitGig,
  trackGig,
  untrackGig,
} from "../src/gigs.ts";

async function memdb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await migrate(db);
  return db;
}

// Shape lifted from the live agentpay board (Pagetoll flywheel).
const BOARD = {
  items: [
    {
      id: "14f41c8e65cfe833886afc14dfe2f30c",
      title: "Pagetoll flywheel: hash of https://example.com/",
      description: "Hash the markdown.",
      category: "dev",
      amountSats: 10000,
      status: "open",
      escrow: { mode: "p2pkh", state: 0, workerPubKey: "", deadline: 0 },
      acceptance: { kind: "hash", expectedHash: "5945db", notes: "n" },
    },
    { id: "bad", title: 42 },
  ],
};

const stubBoard = async (url) => {
  if (url.includes("/bounties/14f41c8e65cfe833886afc14dfe2f30c")) {
    return new Response(JSON.stringify(BOARD.items[0]), { status: 200 });
  }
  return new Response(JSON.stringify(BOARD), { status: 200 });
};

test("board parses live shapes, drops malformed rows", async () => {
  const rows = await boardList({ fetchFn: stubBoard });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "14f41c8e65cfe833886afc14dfe2f30c");
  assert.equal(rows[0].amountSats, 10000);
  assert.equal(rows[0].escrow.state, 0);
  assert.equal(rows[0].acceptance.kind, "hash");
  const one = await boardGet("14f41c8e65cfe833886afc14dfe2f30c", { fetchFn: stubBoard });
  assert.equal(one.title, BOARD.items[0].title);
  await assert.rejects(boardGet("no way!", { fetchFn: stubBoard }), (e) => e.code === "BAD_PARAM");
  await assert.rejects(boardList({ fetchFn: async () => new Response("x", { status: 500 }) }), (e) => e.code === "RAILS");
});

test("lifecycle: track -> claim -> submit -> paid lands in earnings", async () => {
  const db = await memdb();
  try {
    const item = await boardGet("14f41c8e65cfe833886afc14dfe2f30c", { fetchFn: stubBoard });
    const t = await trackGig(db, item);
    assert.equal(t.lifecycle, "tracked");
    assert.equal((await trackGig(db, item)).lifecycle, "tracked"); // idempotent re-track
    assert.equal((await listGigs(db)).length, 1);

    // keyless claim: guided, nothing recorded as claimed
    const guided = await claimGig(db, item.id, { fetchFn: stubBoard });
    assert.equal(guided.lifecycle, "tracked");
    assert.match(guided.guided, /AGENTPAY_KEY/);

    // live claim + submit against a stubbed agentpay (payout to self)
    const calls = [];
    const keyed = {
      fetchFn: async (url, init) => {
        calls.push(url);
        if (url.endsWith("/claim")) return new Response(JSON.stringify({ claim: { ok: true }, link: { id: 1 } }), { status: 200 });
        if (url.endsWith("/submit")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return stubBoard(url);
      },
    };
    const claimed = await claimGig(db, item.id, {
      ...keyed, key: "agp_testkey123",
      payoutAddress: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU",
    });
    assert.equal(claimed.lifecycle, "claimed");
    assert.ok(calls.some((u) => u.endsWith("/claim")));
    assert.equal((await claimGig(db, item.id, { ...keyed, key: "agp_testkey123" })).lifecycle, "claimed");

    const sub = await submitGig(db, item.id, { workHash: "ab".repeat(32) }, { ...keyed, key: "agp_testkey123" });
    assert.equal(sub.lifecycle, "submitted");

    const paid = await paidGig(db, item.id, "a".repeat(64), 0);
    assert.equal(paid.lifecycle, "paid");
    assert.equal(paid.basket, "earnings");
    const baskets = await db("baskets").where({ name: "earnings" });
    assert.equal(baskets.length, 1);
    const members = await db("basket_members").where({ basket: "earnings" });
    assert.equal(members.length, 1);

    // untrack a fresh row; paid rows stay queryable
    await untrackGig(db, item.id);
    assert.equal((await listGigs(db)).length, 0);
  } finally {
    await db.destroy();
  }
});

test("transitions and inputs fail closed", async () => {
  const db = await memdb();
  try {
    const item = await boardGet("14f41c8e65cfe833886afc14dfe2f30c", { fetchFn: stubBoard });
    await assert.rejects(claimGig(db, "ghost", {}), (e) => e.code === "NOT_FOUND");
    await assert.rejects(submitGig(db, item.id, {}, {}), (e) => e.code === "NOT_FOUND");
    await trackGig(db, item);
    await assert.rejects(submitGig(db, item.id, {}, {}), (e) => e.code === "BAD_STATE");
    await assert.rejects(claimGig(db, item.id, { key: "junk" }), (e) => e.code === "NO_KEY");
    await assert.rejects(paidGig(db, item.id, "zzz", 0), (e) => e.code === "BAD_PARAM");
    await assert.rejects(paidGig(db, item.id, "a".repeat(64), -1), (e) => e.code === "BAD_PARAM");
    await assert.rejects(untrackGig(db, "ghost"), (e) => e.code === "NOT_FOUND");
  } finally {
    await db.destroy();
  }
});
