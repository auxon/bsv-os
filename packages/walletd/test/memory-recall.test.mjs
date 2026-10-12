import { after, before, test } from "node:test";
import assert from "node:assert/strict";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-memory-recall";
import knex from "knex";
import { migrate } from "../src/storage.ts";
import { buildPost, createBoard, ingestPost, newBoardKeyHex } from "../src/boards.ts";
import { MEMORY_BOARD } from "../src/memory.ts";
import { hotClear, hotList, hotPut } from "../src/memoryWrite.ts";
import { hybridRecall, parseDepth, resolveEmbedder } from "../src/memoryRecall.ts";
import { fixtureEmbedder } from "../src/embed.ts";
import { migrateServe, servePriceFor, setServeMeta } from "../src/serve.ts";

before(async () => {
  process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-memory-recall";
  const { __resetCache, createWallet, destroyWallet, unlock } = await import("../src/custody.ts");
  __resetCache();
  await destroyWallet().catch(() => {});
  await createWallet();
  await unlock();
});

after(async () => {
  const { destroyWallet } = await import("../src/custody.ts");
  await destroyWallet().catch(() => {});
});

function memdb() {
  return knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
}

const FAKE_FETCH = async () => ({ ok: false, json: async () => null });
const DECRYPT = async (armored) => (armored === "CIPHERTEXT-1" ? "secret deploy plan" : null);
const NULL_DECRYPT = async () => null;

async function seedTiers(db) {
  const now = Date.now();
  await db("memory_items").insert([
    {
      hash: "a".repeat(64), visibility: "public", tag: "ops", tag_public: 1, ts: now,
      from_fp: "F".repeat(40), author: "t", payload: "deploy keys rotate monthly", pin: 0, importance: 0, created_at: now,
    },
    {
      hash: "b".repeat(64), visibility: "private", tag: "", tag_public: 0, ts: now - 1000,
      from_fp: "F".repeat(40), author: "t", payload: "CIPHERTEXT-1", pin: 0, importance: 0, created_at: now,
    },
  ]);
  await db("memory_vectors").insert({
    hash: "a".repeat(64), dims: 8, vec: Buffer.alloc(32), model: "fixture", updated_at: now,
  });
}

test("depth validation rejects the unbuilt tiers", () => {
  assert.equal(parseDepth(undefined), "local");
  assert.equal(parseDepth("hot"), "hot");
  assert.throws(() => parseDepth("cold"), /P3\/P4/);
  assert.throws(() => parseDepth("chain"), /P3\/P4/);
});

test("public tier served by keyword; L1 backfills; hot depth reads cache", async () => {
  const db = memdb();
  try {
    await migrate(db);
    await seedTiers(db);
    hotClear();
    const r = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT }, { query: "deploy keys", semantic: false });
    assert.equal(r.semantic, false);
    assert.deepEqual(r.hits.map((h) => h.hash), ["a".repeat(64), "b".repeat(64)]); // both match; exact phrase first
    assert.equal(r.hits[0].backend, "tiers");
    assert.equal(hotList().length, 2); // both served hits backfilled
    const hot = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT }, { query: "deploy", depth: "hot", semantic: false });
    assert.equal(hot.depth, "hot");
    assert.deepEqual(hot.hits.map((h) => h.hash), ["a".repeat(64), "b".repeat(64)]); // both backfilled
  } finally {
    await db.destroy();
    hotClear();
  }
});

test("private tier decrypts when possible, skips + counts when locked", async () => {
  const db = memdb();
  try {
    await migrate(db);
    await seedTiers(db);
    hotClear();
    const open = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT }, { query: "secret deploy", semantic: false });
    const priv = open.hits.find((h) => h.hash === "b".repeat(64));
    assert.ok(priv);
    assert.equal(priv.text, "secret deploy plan"); // decrypted, not ciphertext
    assert.equal(open.lockedSkipped, 0);

    hotClear();
    const locked = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: NULL_DECRYPT }, { query: "secret deploy", semantic: false });
    assert.ok(!locked.hits.some((h) => h.hash === "b".repeat(64)));
    assert.equal(locked.lockedSkipped, 1);
  } finally {
    await db.destroy();
    hotClear();
  }
});

test("tombstones strike tier rows; legacy dupes collapse to the tier hit", async () => {
  const db = memdb();
  try {
    await migrate(db);
    await seedTiers(db);
    hotClear();
    const { identityPubkeyHex } = await import("../src/custody.ts");
    const me = identityPubkeyHex();
    const board = await createBoard(db, { name: MEMORY_BOARD, mode: "members" });
    // Legacy board post with the SAME content hash as the public tier row.
    const env = buildPost({
      board: MEMORY_BOARD, from: me, keyHex: board.keyHex, text: "deploy keys rotate monthly",
      kind: "artifact", refs: ["#memory", `sha256:${"a".repeat(64)}`, "tag:ops"],
    });
    await ingestPost(db, env);
    // Forget marker strikes a different tier row.
    const tomb = buildPost({
      board: MEMORY_BOARD, from: me, keyHex: board.keyHex, text: "forget b",
      kind: "artifact", refs: ["#memory-forget", `sha256:${"b".repeat(64)}`], replyTo: "zzz",
    });
    await ingestPost(db, tomb);
    const r = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT }, { query: "deploy", semantic: false });
    const hashes = r.hits.map((h) => h.hash);
    assert.deepEqual(hashes, ["a".repeat(64)]); // one hit (tier wins), b struck out
    assert.equal(r.hits[0].backend, "tiers");
  } finally {
    await db.destroy();
    hotClear();
  }
});

test("semantic fusion rescues a paraphrase the keywords miss", async () => {
  const db = memdb();
  try {
    await migrate(db);
    hotClear();
    const now = Date.now();
    await db("memory_items").insert([
      { hash: "c".repeat(64), visibility: "public", tag: "", tag_public: 0, ts: now, from_fp: "F", author: "t", payload: "guitar pitch practice routines", pin: 0, importance: 0, created_at: now },
      { hash: "d".repeat(64), visibility: "public", tag: "", tag_public: 0, ts: now, from_fp: "F", author: "t", payload: "grocery list milk eggs bread", pin: 0, importance: 0, created_at: now },
    ]);
    const emb = fixtureEmbedder(8);
    const kw = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT, embedder: emb }, { query: "guitar practice", semantic: false });
    assert.deepEqual(kw.hits.map((h) => h.hash), ["c".repeat(64)]);
    const sem = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT, embedder: emb }, { query: "guitar practice", semantic: true });
    assert.equal(sem.semantic, true);
    assert.equal(sem.hits[0].hash, "c".repeat(64));
    // Pure noise stays out even with semantic on.
    const noise = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT, embedder: emb }, { query: "xylophone zebra", semantic: true });
    assert.equal(noise.hits.length, 0);
  } finally {
    await db.destroy();
    hotClear();
  }
});

test("seller scope serves public tiers only", async () => {
  const db = memdb();
  try {
    await migrate(db);
    await seedTiers(db);
    hotClear();
    const r = await hybridRecall(db, { fetchFn: FAKE_FETCH, decrypt: DECRYPT }, { query: "deploy secret", semantic: false, scope: "seller" });
    assert.ok(r.hits.some((h) => h.hash === "a".repeat(64)));
    assert.ok(!r.hits.some((h) => h.hash === "b".repeat(64)));
    assert.ok(r.lockedSkipped >= 1);
  } finally {
    await db.destroy();
    hotClear();
  }
});

test("embedder resolution prefers env, then cache, then null", async () => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const emb = fixtureEmbedder(4);
  assert.equal(resolveEmbedder(emb), emb);
  assert.equal(resolveEmbedder(null), null);
  // No env and (almost certainly) no cached model in CI: null, not a throw.
  const auto = resolveEmbedder("auto");
  assert.ok(auto === null || typeof auto.embed === "function");
});

test("depth-all pricing is 2x at quote and at verify", async () => {
  const db = memdb();
  try {
    await migrateServe(db);
    await setServeMeta(db, "payto", "1Bv4wgSatZYLzv5Lz9JNCaHMqmn87UcuNp");
    const base = await servePriceFor(db, "memoryRecall", {});
    const deep = await servePriceFor(db, "memoryRecall", { depth: "all" });
    assert.ok(base.priceSats > 0);
    assert.equal(deep.priceSats, base.priceSats * 2);
    assert.equal(deep.depthMultiplier, 2);
    const other = await servePriceFor(db, "jevDecide", { depth: "all" });
    assert.equal(other.depthMultiplier, 1);
  } finally {
    await db.destroy();
  }
});
