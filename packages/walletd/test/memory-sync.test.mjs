import { test } from "node:test";
import assert from "node:assert/strict";
import { after, before } from "node:test";

// Partitioned keyring namespace (see custody.ts svc()).
process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-memory-sync";
import knex from "knex";
import { BSM, PrivateKey } from "@bsv/sdk";
import { migrate } from "../src/storage.ts";
import { signS3Request } from "../src/memoryCloud.ts";
import {
  manifestCanonical, mergePack, packDecrypt, packEncrypt, packHash,
} from "../src/memorySync.ts";
import { distillTag, openRouterChat, tiersStatus } from "../src/memoryJob.ts";
import { promotionScore, stableStringify } from "../src/memoryTiers.ts";

function memdb() {
  return knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
}

before(async () => {
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

const SYNC = "ab".repeat(32);

function samplePack(over = {}) {
  return {
    v: 1,
    deviceFp: "A".repeat(40),
    ts: 1000,
    items: [
      {
        hash: "a".repeat(64), visibility: "public", tag: "ops", tag_public: 1, ts: 1000,
        from_fp: "A".repeat(40), author: "t", payload: "deploy keys rotate monthly",
        pin: 0, pin_ts: 0, importance: 0,
      },
    ],
    vectors: [{ hash: "a".repeat(64), dims: 2, b64: Buffer.alloc(8).toString("base64"), model: "m" }],
    tombstones: ["b".repeat(64)],
    ...over,
  };
}

test("pack envelope roundtrips; tamper and wrong secret fail closed", () => {
  const blob = packEncrypt(SYNC, samplePack());
  assert.match(blob, /^[A-Za-z0-9+/=]+$/);
  const back = packDecrypt(SYNC, blob);
  assert.equal(back.items.length, 1);
  assert.equal(back.tombstones[0], "b".repeat(64));
  assert.equal(typeof packHash(blob), "string");
  assert.equal(packHash(blob).length, 64);
  // Flip one char in the blob: auth tag fails, not silent corruption.
  // (assert.throws regex matches messages; our codes live on err.code.)
  const badPack = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.equal(e.code, "BAD_PACK");
      return;
    }
    assert.fail("should have thrown BAD_PACK");
  };
  const tampered = blob.slice(0, 20) + (blob[20] === "A" ? "B" : "A") + blob.slice(21);
  badPack(() => packDecrypt(SYNC, tampered));
  badPack(() => packDecrypt("cd".repeat(32), blob));
  badPack(() => packDecrypt(SYNC, "!!!not-base64!!!"));
  try {
    packEncrypt("short", samplePack());
    assert.fail("should have thrown BAD_PARAM");
  } catch (e) {
    assert.equal(e.code, "BAD_PARAM");
  }
});

test("merge is idempotent; tombstones win and clean vectors; pins are LWW", async () => {
  const db = memdb();
  try {
    await migrate(db);
    const pack = samplePack();
    const pins = { ["a".repeat(64)]: { pin: 1, ts: 2000 } };
    const r1 = await mergePack(db, pack, pins, 3000);
    assert.deepEqual([r1.items, r1.vectors, r1.tombstones, r1.pins, r1.packs], [1, 1, 1, 1, 1]);
    assert.equal((await db("memory_items").where({ hash: "a".repeat(64) }).first()).pin, 1);
    assert.equal((await db("memory_tombstones").select()).length, 1);
    // Re-apply: nothing changes.
    const r2 = await mergePack(db, pack, pins, 3000);
    assert.deepEqual([r2.items, r2.vectors, r2.tombstones, r2.pins], [0, 0, 0, 0]);
    // Older pin loses; newer pin wins.
    const r3 = await mergePack(db, samplePack(), { ["a".repeat(64)]: { pin: 0, ts: 1000 } }, 3000);
    assert.equal(r3.pins, 0);
    assert.equal((await db("memory_items").where({ hash: "a".repeat(64) }).first()).pin, 1);
    const r4 = await mergePack(db, samplePack(), { ["a".repeat(64)]: { pin: 0, ts: 5000 } }, 3000);
    assert.equal(r4.pins, 1);
    assert.equal((await db("memory_items").where({ hash: "a".repeat(64) }).first()).pin, 0);
    // Malformed rows are skipped, never fatal.
    const r5 = await mergePack(db, samplePack({ items: [{ hash: "zzz" }], vectors: [{ hash: "zzz" }], tombstones: ["zzz"] }), {}, 3000);
    assert.deepEqual([r5.items, r5.vectors, r5.tombstones], [0, 0, 0]);
  } finally {
    await db.destroy();
  }
});

test("manifest canonical form is key-order stable; BSM sign/verify roundtrips", async () => {
  const a = { v: 1, b: [1, 2], a: { z: 1, y: 2 } };
  const b = { a: { y: 2, z: 1 }, b: [1, 2], v: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(stableStringify(a), '{"a":{"y":2,"z":1},"b":[1,2],"v":1}');
  const priv = PrivateKey.fromRandom();
  const pub = priv.toPublicKey().toString();
  const msg = manifestCanonical({ v: 1, deviceFp: "A".repeat(40), ts: 5 });
  const sig = BSM.sign(Array.from(Buffer.from(msg, "utf8")), priv, "base64");
  const { verifyIdentitySignature } = await import("../src/custody.ts");
  assert.equal(verifyIdentitySignature(pub, msg, sig), true);
  assert.equal(verifyIdentitySignature(pub, `${msg}tampered`, sig), false);
});

test("promotion scores pin first, decay with age", () => {
  const now = Date.now();
  const pinned = promotionScore({ pin: 1, importance: 0, ts: now }, now);
  const hot = promotionScore({ pin: 0, importance: 1, ts: now }, now);
  const stale = promotionScore({ pin: 0, importance: 1, ts: now - 60 * 86_400_000 }, now);
  assert.ok(pinned > hot && hot > stale);
});

test("tiers status counts honestly on an empty database", async () => {
  const db = memdb();
  try {
    await migrate(db);
    const st = await tiersStatus(db, 3);
    assert.equal(st.l1.size, 3);
    assert.equal(st.l2.items, 0);
    assert.equal(st.l2.vectors, 0);
    assert.deepEqual(st.promotions.top, []);
  } finally {
    await db.destroy();
  }
});

test("distill needs a real cluster; stub chat shapes the artifact", async () => {
  const db = memdb();
  try {
    await migrate(db);
    const now = Date.now();
    await db("memory_items").insert([
      { hash: "a".repeat(64), visibility: "public", tag: "ops", tag_public: 1, ts: now, from_fp: "F", author: "t", payload: "rotate deploy keys monthly", pin: 0, pin_ts: 0, importance: 0, created_at: now },
      { hash: "b".repeat(64), visibility: "public", tag: "ops", tag_public: 1, ts: now, from_fp: "F", author: "t", payload: "backup runbook lives in ops", pin: 0, pin_ts: 0, importance: 0, created_at: now },
    ]);
    // Only two readable: below the default minimum of three.
    await assert.rejects(
      distillTag(db, { tag: "ops" }, async (r) => r.payload, async () => ({ title: "x", summary: "y".repeat(50) })),
      (e) => e.code === "TOO_FEW",
    );
    await db("memory_items").insert(
      { hash: "c".repeat(64), visibility: "public", tag: "ops", tag_public: 1, ts: now, from_fp: "F", author: "t", payload: "oncall handoff fridays", pin: 0, pin_ts: 0, importance: 0, created_at: now },
    );
    let seen = "";
    const out = await distillTag(db, { tag: "ops" }, async (r) => r.payload, async (system, user) => {
      seen = user;
      return { title: "Ops habits", summary: "Rotate keys, keep the runbook, hand off Fridays. " + "x".repeat(30) };
    });
    assert.equal(out.count, 3);
    assert.equal(out.title, "Ops habits");
    assert.ok(seen.includes("rotate deploy keys"));
    // Bad chat output fails closed, never a half artifact.
    await assert.rejects(
      distillTag(db, { tag: "ops" }, async (r) => r.payload, async () => ({ title: "", summary: "short" })),
      (e) => e.code === "JUDGE_FAILED",
    );
  } finally {
    await db.destroy();
  }
});

test("openRouterChat fails closed without a key (no network touched)", async () => {
  await assert.rejects(openRouterChat("", "m", "s", "u"), (e) => e.code === "AI_NOT_CONFIGURED");
});

test("SigV4 signing is deterministic, date-bound, and tamper-evident", () => {  const base = {
    accessKey: "AKID", secretKey: "secret", accountId: "acct", bucket: "bkt",
    method: "PUT", key: "packs/abc.json.enc", now: new Date("2026-01-02T03:04:05.000Z"),
  };
  const a = signS3Request({ ...base, body: new Uint8Array([1, 2, 3]) });
  const b = signS3Request({ ...base, body: new Uint8Array([1, 2, 3]) });
  assert.equal(a.headers.authorization, b.headers.authorization);
  assert.match(a.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20260102\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.ok(a.url.startsWith("https://acct.r2.cloudflarestorage.com/bkt/packs/abc.json.enc"));
  const c = signS3Request({ ...base, body: new Uint8Array([1, 2, 4]) });
  assert.notEqual(a.headers.authorization, c.headers.authorization);
  const d = signS3Request({ ...base, body: new Uint8Array([1, 2, 3]), now: new Date("2026-01-02T03:04:06.000Z") });
  assert.notEqual(a.headers.authorization, d.headers.authorization);
  assert.ok(!("content-type" in signS3Request({ ...base, body: new Uint8Array(0) }).headers));
  const ct = signS3Request({ ...base, body: new Uint8Array(0), contentType: "application/json" });
  assert.match(ct.headers.authorization ?? "", /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
});

test("two-device sync over stub R2: push, pair, pull, tombstone", async () => {
  const C = await import("../src/custody.ts");
  const { syncPush, syncPull, packDecrypt } = await import("../src/memorySync.ts");
  const { vecToBlob } = await import("../src/memoryTiers.ts");
  const { fixtureEmbedder } = await import("../src/embed.ts");
  const { default: knexLib } = await import("knex");
  const { migrate: migrateDb } = await import("../src/storage.ts");
  const initialized = new Set();
  const use = async (suffix) => {
    process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = suffix;
    C.__resetCache();
    if (!initialized.has(suffix)) {
      await C.destroyWallet().catch(() => {});
      await C.createWallet();
      initialized.add(suffix);
    }
    await C.unlock();
  };
  const dbOf = async () => {
    const db = knexLib({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    await migrateDb(db);
    return db;
  };
  const store = new Map();
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && u.search.includes("list-type=2")) {
      const prefix = u.searchParams.get("prefix") ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      const xml = `<ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join("")}</ListBucketResult>`;
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from(xml) };
    }
    const key = u.pathname.split("/").slice(2).join("/");
    if (method === "PUT") {
      store.set(key, Buffer.from(await new Response(init.body).arrayBuffer()));
      return { ok: true, status: 200, headers: new Map([["etag", '"x"']]), arrayBuffer: async () => Buffer.alloc(0) };
    }
    if (!store.has(key)) return { ok: true, status: 404, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) };
    return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => store.get(key) };
  };
  const vecCalls = [];
  const vecFetch = async (url) => {
    vecCalls.push(String(url));
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ success: true, result: {} }) };
  };
  const cloudFetch = async (url, init) => (String(url).includes("/vectorize/") ? vecFetch(url, init) : fakeFetch(url, init));
  const r2 = { accessKey: "A", secretKey: "S", accountId: "acct", bucket: "bkt" };
  const vec = { accountId: "acct", token: "tok", index: "idx" };
  const pushEnv = { r2: { ...r2 }, vec: { ...vec }, fetchFn: cloudFetch };

  const dbs = [];
  try {
    // Device A: wallet, device key, one public memory + vector.
    await use("-test-sync-a");
    const devA = await C.pgpEnsureDeviceKey("device-a");
    const identA = C.identityPubkeyHex();
    const secretA = await C.syncSecret();
    const dbA = await dbOf();
    dbs.push(dbA);
    const now = Date.now();
    await dbA("memory_items").insert({
      hash: "a".repeat(64), visibility: "public", tag: "ops", tag_public: 1, ts: now,
      from_fp: devA.fingerprint, author: "a", payload: "deploy keys rotate monthly",
      pin: 0, pin_ts: 0, importance: 0, created_at: now,
    });
    const va = new Float32Array(384);
    va[0] = 1; // unit vector: dims must match the 384-dim shared index
    await dbA("memory_vectors").insert({ hash: "a".repeat(64), dims: 384, vec: vecToBlob(va), model: "test", updated_at: now });

    // Device B: wallet + device key (fresh, empty DB).
    await use("-test-sync-b");
    const devB = await C.pgpEnsureDeviceKey("device-b");
    const dbB = await dbOf();
    dbs.push(dbB);

    // Pair out of band: A wraps to B's pubkey; B adopts (proves same secret).
    await use("-test-sync-a");
    const blob = await C.wrapSyncKey([devB.publicKey]);
    await use("-test-sync-b");
    await C.unwrapSyncKey(blob);
    assert.equal(await C.syncSecret(), secretA);

    // A pushes (stub R2 + stub Vectorize).
    await use("-test-sync-a");
    const push = await syncPush(dbA, pushEnv, {
      fingerprint: devA.fingerprint, identityKey: identA,
      sign: (m) => C.identitySignMessage(m), syncHex: secretA,
    });
    assert.equal(push.items, 1);
    assert.ok(vecCalls.length >= 1, "public vectors fan out");

    // B pulls: manifest verifies, pack decrypts, item + vector land.
    await use("-test-sync-b");
    const pull = await syncPull(dbB, pushEnv, {
      fingerprint: devB.fingerprint,
      epoch: async () => 0,
      unwrap: (bl) => C.unwrapSyncKey(bl).then(() => {}),
      decryptPack: async (bl) => packDecrypt(await C.syncSecret(), bl),
    }, C.verifyIdentitySignature);
    assert.equal(pull.manifests, 1);
    assert.equal(pull.applied.items, 1);
    assert.equal((await dbB("memory_items").select()).length, 1);
    assert.equal((await dbB("memory_vectors").select()).length, 1);

    // Tombstone propagation: A forgets, pushes; B pulls; vector gone.
    await use("-test-sync-a");
    await dbA("memory_tombstones").insert({ hash: "a".repeat(64), ts: Date.now(), from_fp: devA.fingerprint });
    await dbA("memory_vectors").where({ hash: "a".repeat(64) }).del();
    await syncPush(dbA, pushEnv, {
      fingerprint: devA.fingerprint, identityKey: identA,
      sign: (m) => C.identitySignMessage(m), syncHex: secretA,
    });
    await use("-test-sync-b");
    const pull2 = await syncPull(dbB, pushEnv, {
      fingerprint: devB.fingerprint,
      epoch: async () => 0,
      unwrap: (bl) => C.unwrapSyncKey(bl).then(() => {}),
      decryptPack: async (bl) => packDecrypt(await C.syncSecret(), bl),
    }, C.verifyIdentitySignature);
    assert.equal(pull2.applied.tombstones, 1);
    assert.equal((await dbB("memory_vectors").select()).length, 0);
  } finally {
    for (const db of dbs) await db.destroy().catch(() => {});
    process.env.BSV_WALLETD_KEYCHAIN_SUFFIX = "-test-memory-sync";
  }
});
