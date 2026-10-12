/**
 * Multi-machine sync for tiered memory (P3). R2 carries encrypted packs +
 * signed plaintext manifests; the local DB stays the system of record.
 *
 * Crypto layout (all decided in design review):
 * - Pack bodies: AES-256-GCM under the per-identity sync secret (custody).
 * - Distribution: the sync secret travels PGP-wrapped — handed directly in
 *   the pairing ceremony, or via `keyWraps` in the manifest on rotation.
 * - Manifests: PLAINTEXT (hashes, pins, tombstones, wraps) signed by the
 *   device's wallet identity key (BSM). Hashes leak little; packs leak
 *   nothing. Tombstone hashes reveal "something was forgotten" — accepted.
 * - Merge: content writes idempotent by hash, tombstones beat content,
 *   pins last-writer-wins by signed timestamp. Silent resolutions are
 *   counted in the merge report (audit trail, not popups).
 * - Rotation stops FUTURE reads, not copies already synced. Stated plainly.
 */
import type { Knex } from "knex";
import { createHash, createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { r2Get, r2List, r2Put, vecDelete, vecUpsert, type R2Env, type VectorizeEnv } from "./memoryCloud.ts";import { stableStringify } from "./memoryTiers.ts";

export interface PackItem {
  hash: string;
  visibility: string;
  tag: string;
  tag_public: number;
  ts: number;
  from_fp: string;
  author: string;
  payload: string;
  pin: number;
  pin_ts: number;
  importance: number;
}

export interface PackVector {
  hash: string;
  dims: number;
  b64: string;
  model: string;
}

export interface SyncPack {
  v: 1;
  deviceFp: string;
  ts: number;
  items: PackItem[];
  vectors: PackVector[];
  tombstones: string[];
}

export interface SyncManifest {
  v: 1;
  deviceFp: string;
  identityKey: string;
  epoch: number;
  packs: string[];
  pins: Record<string, { pin: number; ts: number }>;
  tombstones: string[];
  keyWraps: Record<string, string>;
  ts: number;
  sig: string;
}

const PACK_AAD = "bsvos-memory-pack-v1";

function fail(code: string, message: string, status = 500): never {
  throw Object.assign(new Error(message), { code, status });
}

/** AES-256-GCM pack envelope (base64 JSON). Throws on misuse, never partial. */
export function packEncrypt(syncHex: string, pack: SyncPack): string {
  if (!/^[0-9a-f]{64}$/.test(syncHex)) fail("BAD_PARAM", "sync secret must be 32 bytes hex", 400);
  const key = Buffer.from(syncHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(PACK_AAD, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(pack), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(JSON.stringify({ iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") })).toString("base64");
}

export function packDecrypt(syncHex: string, blob: string): SyncPack {
  if (!/^[0-9a-f]{64}$/.test(syncHex)) fail("BAD_PARAM", "sync secret must be 32 bytes hex", 400);
  let env: { iv?: string; tag?: string; ct?: string };
  try {
    env = JSON.parse(Buffer.from(blob.trim(), "base64").toString("utf8"));
  } catch {
    fail("BAD_PACK", "pack envelope is not valid base64 JSON", 400);
    throw new Error("unreachable");
  }
  if (!env || typeof env.iv !== "string" || typeof env.tag !== "string" || typeof env.ct !== "string") {
    fail("BAD_PACK", "pack envelope is malformed", 400);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(syncHex, "hex"), Buffer.from(env.iv, "base64"));
    decipher.setAAD(Buffer.from(PACK_AAD, "utf8"));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
    const pack = JSON.parse(pt) as SyncPack;
    if (!pack || pack.v !== 1 || !Array.isArray(pack.items)) fail("BAD_PACK", "pack body failed validation", 400);
    return pack;
  } catch (e) {
    if ((e as { code?: string }).code === "BAD_PACK") throw e;
    fail("BAD_PACK", "pack decryption failed (wrong sync secret or corrupted pack)", 400);
    throw new Error("unreachable");
  }
}

export function packHash(blob: string): string {
  return createHash("sha256").update(blob, "utf8").digest("hex");
}

/** Canonical manifest bytes for signing (everything but sig). */
export function manifestCanonical(m: Omit<SyncManifest, "sig">): string {
  return stableStringify(m);
}

export interface MergeReport {
  items: number;
  vectors: number;
  tombstones: number;
  pins: number;
  packs: number;
}

/**
 * Merge one decrypted pack + manifest pins. Idempotent: re-applying the same
 * pack changes nothing. Tombstones delete local vectors (index hygiene) and
 * land in memory_tombstones so recall strikes them everywhere.
 */
export async function mergePack(db: Knex, pack: SyncPack, pins: Record<string, { pin: number; ts: number }>, now = Date.now()): Promise<MergeReport> {
  const report: MergeReport = { items: 0, vectors: 0, tombstones: 0, pins: 0, packs: 1 };
  for (const item of pack.items ?? []) {
    if (!item || !/^[0-9a-f]{64}$/.test(item.hash ?? "")) continue;
    // Check-then-insert: knex/better-sqlite3 returns [1] even on ignored
    // conflicts, so existence must be read to keep merge reports honest.
    const exists = await db("memory_items").where({ hash: item.hash }).first();
    if (!exists) {
      await db("memory_items").insert({
        hash: item.hash,
        visibility: item.visibility === "public" || item.visibility === "shared" ? item.visibility : "private",
        tag: String(item.tag ?? "").slice(0, 32),
        tag_public: item.tag_public ? 1 : 0,
        ts: Math.floor(Number(item.ts) || now),
        from_fp: String(item.from_fp ?? ""),
        author: String(item.author ?? "").slice(0, 64),
        payload: String(item.payload ?? ""),
        pin: item.pin ? 1 : 0,
        pin_ts: Math.floor(Number(item.pin_ts) || 0),
        importance: Number(item.importance) || 0,
        created_at: now,
      });
      report.items++;
    }
  }
  for (const v of pack.vectors ?? []) {
    if (!v || !/^[0-9a-f]{64}$/.test(v.hash ?? "") || !Number.isInteger(v.dims) || v.dims <= 0 || typeof v.b64 !== "string") continue;
    const buf = Buffer.from(v.b64, "base64");
    if (buf.length !== v.dims * 4) continue;
    const vexists = await db("memory_vectors").where({ hash: v.hash }).first();
    if (!vexists) {
      await db("memory_vectors").insert({
        hash: v.hash, dims: v.dims, vec: buf, model: String(v.model ?? "").slice(0, 80), updated_at: now,
      });
      report.vectors++;
    }
  }
  for (const hash of pack.tombstones ?? []) {
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    const texists = await db("memory_tombstones").where({ hash }).first();
    if (!texists) {
      await db("memory_tombstones").insert({ hash, ts: pack.ts, from_fp: pack.deviceFp });
      report.tombstones++;
      await db("memory_vectors").where({ hash }).del();
    }
  }
  for (const [hash, p] of Object.entries(pins ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(hash) || !p || typeof p.ts !== "number") continue;
    const n = await db("memory_items").where({ hash }).where("pin_ts", "<", Math.floor(p.ts)).update({
      pin: p.pin ? 1 : 0, pin_ts: Math.floor(p.ts),
    });
    if (n) report.pins++;
  }
  return report;
}

async function syncGet(db: Knex, key: string): Promise<string | null> {
  const row = (await db("memory_sync_state").where({ key }).first()) as { value?: string } | undefined;
  return typeof row?.value === "string" && row.value ? row.value : null;
}

async function syncSet(db: Knex, key: string, value: string, now = Date.now()): Promise<void> {
  await db("memory_sync_state").insert({ key, value, updated_at: now }).onConflict("key").merge({ value, updated_at: now });
}

export interface SyncEnv {
  r2: R2Env;
  vec: VectorizeEnv;
  fetchFn?: typeof fetch;
}

export interface PushReport {
  pack: string;
  items: number;
  vectors: number;
  tombstones: number;
  manifestTs: number;
  vecUpserted: number;
  vecDeleted: number;
}

/** Build a full-snapshot pack, encrypt, upload, publish manifest, fan out vectors. */
export async function syncPush(
  db: Knex,
  env: SyncEnv,
  self: { fingerprint: string; identityKey: string; sign: (message: string) => string; syncHex: string },
  now = Date.now(),
): Promise<PushReport> {
  const items = (await db("memory_items").select()) as Array<Record<string, unknown>>;
  const vectors = (await db("memory_vectors").select()) as Array<{ hash: string; dims: number; vec: Uint8Array; model: string }>;
  const tombs = (await db("memory_tombstones").select("hash")) as Array<{ hash: string }>;
  const pack: SyncPack = {
    v: 1,
    deviceFp: self.fingerprint,
    ts: now,
    items: items.map((r) => ({
      hash: String(r.hash), visibility: String(r.visibility), tag: String(r.tag ?? ""),
      tag_public: Number(r.tag_public) || 0, ts: Number(r.ts), from_fp: String(r.from_fp ?? ""),
      author: String(r.author ?? ""), payload: String(r.payload ?? ""),
      pin: Number(r.pin) || 0, pin_ts: Number(r.pin_ts) || 0, importance: Number(r.importance) || 0,
    })),
    vectors: vectors.map((v) => ({
      hash: v.hash, dims: v.dims, b64: Buffer.from(v.vec).toString("base64"), model: v.model,
    })),
    tombstones: tombs.map((t) => t.hash).filter((h) => /^[0-9a-f]{64}$/.test(h)),
  };
  const blob = packEncrypt(self.syncHex, pack);
  const packId = packHash(blob);
  await r2Put(env.r2, `packs/${packId}.json.enc`, Buffer.from(blob, "utf8"), "application/json", env.fetchFn);

  // Epoch + current wraps for the manifest (rotation distribution rides here).
  const epochRow = (await db("memory_sync_keys").orderBy("epoch", "desc").first()) as { epoch: number; wrapped: string } | undefined;
  const epoch = epochRow?.epoch ?? 0;
  let keyWraps: Record<string, string> = {};
  try {
    keyWraps = (JSON.parse(epochRow?.wrapped ?? "{}") ?? {}) as Record<string, string>;
    if (!keyWraps || typeof keyWraps !== "object") keyWraps = {};
  } catch {
    keyWraps = {};
  }
  const pins: Record<string, { pin: number; ts: number }> = {};
  for (const item of pack.items) {
    if (item.pin) pins[item.hash] = { pin: 1, ts: item.pin_ts || item.ts };
  }
  const manifest: Omit<SyncManifest, "sig"> = {
    v: 1, deviceFp: self.fingerprint, identityKey: self.identityKey, epoch,
    packs: [packId], pins, tombstones: pack.tombstones, keyWraps, ts: now,
  };
  const sig = self.sign(manifestCanonical(manifest));
  await r2Put(env.r2, `manifests/${self.fingerprint}.json`, Buffer.from(JSON.stringify({ ...manifest, sig }), "utf8"), "application/json", env.fetchFn);

  // Vectorize fan-out: public vectors changed since last sync + tombstone deletes.
  const lastVec = Number((await syncGet(db, "lastVecSync")) ?? 0);
  const fresh = (await db("memory_vectors").select()) as Array<{ hash: string; dims: number; vec: Uint8Array; model: string; updated_at: number }>;
  const changed = fresh.filter((v) => v.updated_at > lastVec && v.dims === 384);
  let vecUpserted = 0;
  let vecDeleted = 0;
  const vecOk = env.vec.accountId?.trim() && env.vec.token?.trim();
  if (vecOk && changed.length) {
    vecUpserted = await vecUpsert(env.vec, changed.map((v) => {
      const f = new Float32Array(v.dims);
      const buf = Buffer.from(v.vec);
      for (let i = 0; i < v.dims; i++) f[i] = buf.readFloatLE(i * 4);
      return { id: v.hash, values: [...f], metadata: { model: v.model } };
    }), env.fetchFn);
  }
  const struck = pack.tombstones;
  if (vecOk && struck.length) {
    vecDeleted = await vecDelete(env.vec, struck, env.fetchFn);
  }
  if (vecOk) await syncSet(db, "lastVecSync", String(now), now);
  await syncSet(db, "lastPush", String(now), now);
  return { pack: packId, items: pack.items.length, vectors: pack.vectors.length, tombstones: pack.tombstones.length, manifestTs: now, vecUpserted, vecDeleted };
}

export interface PullReport {
  manifests: number;
  applied: MergeReport;
  adoptedEpoch: number | null;
  peers: Array<{ fingerprint: string; ts: number }>;
}

/** Pull every peer manifest, apply new packs + pins, adopt newer key wraps. */
export async function syncPull(
  db: Knex,
  env: SyncEnv,
  self: {
    fingerprint: string;
    epoch: () => Promise<number>;
    unwrap: (blob: string) => Promise<void>;
    decryptPack: (blob: string) => Promise<SyncPack>;
  },
  verify: (identityKey: string, message: string, sig: string) => boolean,
  now = Date.now(),
): Promise<PullReport> {
  const report: PullReport = {
    manifests: 0,
    applied: { items: 0, vectors: 0, tombstones: 0, pins: 0, packs: 0 },
    adoptedEpoch: null,
    peers: [],
  };
  const keys = await r2List(env.r2, "manifests/", env.fetchFn);
  for (const key of keys) {
    const raw = await r2Get(env.r2, key, env.fetchFn);
    if (!raw) continue;
    let m: SyncManifest;
    try {
      m = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      continue;
    }
    if (!m || m.v !== 1 || !/^[0-9A-F]{40}$/.test(m.deviceFp ?? "") || !m.sig) continue;
    const { sig, ...unsigned } = m;
    if (!verify(m.identityKey, manifestCanonical(unsigned), sig)) continue;
    if (m.deviceFp === self.fingerprint) continue;
    report.manifests++;
    report.peers.push({ fingerprint: m.deviceFp, ts: m.ts });
    const lastSeen = Number((await syncGet(db, `peer:${m.deviceFp}`)) ?? 0);
    // Newer sync-key epoch for us? Adopt before decrypting packs.
    const myEpoch = await self.epoch();
    if (typeof m.epoch === "number" && m.epoch > myEpoch && m.keyWraps?.[self.fingerprint]) {
      try {
        await self.unwrap(m.keyWraps[self.fingerprint]);
        report.adoptedEpoch = m.epoch;
      } catch {
        /* undecryptable wrap: keep old key, still merge readable packs */
      }
    }
    if (m.ts <= lastSeen) continue;
    for (const packId of m.packs ?? []) {
      if (!/^[0-9a-f]{64}$/.test(packId)) continue;
      if (await syncGet(db, `pack:${packId}`)) continue;
      const blob = await r2Get(env.r2, `packs/${packId}.json.enc`, env.fetchFn);
      if (!blob) continue;
      let pack: SyncPack;
      try {
        pack = await self.decryptPack(Buffer.from(blob).toString("utf8"));
      } catch {
        continue; // wrong epoch or corrupt: skip the pack, keep pulling
      }
      const r = await mergePack(db, pack, m.pins ?? {}, now);
      report.applied.items += r.items;
      report.applied.vectors += r.vectors;
      report.applied.tombstones += r.tombstones;
      report.applied.pins += r.pins;
      report.applied.packs++;
      await syncSet(db, `pack:${packId}`, "1", now);
    }
    await syncSet(db, `peer:${m.deviceFp}`, String(m.ts), now);
  }
  await syncSet(db, "lastPull", String(now), now);
  return report;
}
