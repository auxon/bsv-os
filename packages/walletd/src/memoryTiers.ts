/**
 * Layered memory tiers — schema + pure helpers. P0 of the tiered memory build.
 *
 * Tables (all additive, hasTable-guarded like every other migrate):
 * - memory_devices: every PGP device key we know, self or peer. Raw private
 *   keys NEVER land here — keyring custody only (see custody.ts).
 * - memory_items: one row per memory. `payload` is plaintext for public
 *   visibility, armored PGP ciphertext for private/shared. Plaintext tags
 *   only when visibility is public or tag_public is set — tags leak topics.
 * - memory_vectors: cosine-search vectors, PUBLIC VISIBILITY ONLY. An
 *   embedding inverts to approximate text, so a stored vector IS content.
 *   Private/shared memories are embedded at recall over decrypted L1
 *   candidates and never stored. Enforced in code (recall path), not SQL.
 * - memory_sync_keys: wrapped sync-key epochs for multi-machine sync (P3).
 *   `wrapped` is JSON {fingerprint: armored PGP message}; the cleartext
 *   sync secret lives in keyring custody only.
 * - memory_promotions: L5 chain-promotion queue (P4). Eligibility here is
 *   not a write — the inscription stays policy-gated.
 */
import type { Knex } from "knex";
import * as openpgp from "openpgp";

export type Visibility = "public" | "private" | "shared";

export interface MemoryDeviceRow {
  fingerprint: string;
  identity_key: string;
  public_key: string;
  label: string;
  is_self: number;
  approved_at: number;
  revoked_at: number | null;
}

export interface MemoryItemRow {
  hash: string;
  visibility: Visibility;
  tag: string;
  tag_public: number;
  ts: number;
  from_fp: string;
  author: string;
  payload: string;
  pin: number;
  importance: number;
  created_at: number;
}

export interface MemoryVectorRow {
  hash: string;
  dims: number;
  vec: Buffer;
  model: string;
  updated_at: number;
}

export async function migrateMemoryTiers(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("memory_devices"))) {
    await db.schema.createTable("memory_devices", (t) => {
      t.string("fingerprint", 40).primary();
      t.string("identity_key", 66).notNullable().defaultTo("");
      t.text("public_key").notNullable();
      t.string("label", 64).notNullable().defaultTo("");
      t.integer("is_self").notNullable().defaultTo(0);
      t.integer("approved_at").notNullable();
      t.integer("revoked_at").nullable();
    });
  }
  if (!(await db.schema.hasTable("memory_items"))) {
    await db.schema.createTable("memory_items", (t) => {
      t.string("hash", 64).primary();
      t.string("visibility", 8).notNullable().defaultTo("private");
      t.string("tag", 32).notNullable().defaultTo("");
      t.integer("tag_public").notNullable().defaultTo(0);
      t.integer("ts").notNullable();
      t.string("from_fp", 40).notNullable().defaultTo("");
      t.string("author", 64).notNullable().defaultTo("");
      t.text("payload").notNullable();
      t.integer("pin").notNullable().defaultTo(0);
      t.float("importance").notNullable().defaultTo(0);
      t.integer("created_at").notNullable();
    });
    await db.raw("CREATE INDEX IF NOT EXISTS idx_memory_items_ts ON memory_items (ts DESC)");
    await db.raw("CREATE INDEX IF NOT EXISTS idx_memory_items_tag ON memory_items (tag, ts DESC)");
  }
  if (!(await db.schema.hasTable("memory_vectors"))) {
    await db.schema.createTable("memory_vectors", (t) => {
      t.string("hash", 64).primary();
      t.integer("dims").notNullable();
      t.binary("vec").notNullable();
      t.string("model", 80).notNullable().defaultTo("");
      t.integer("updated_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("memory_sync_keys"))) {
    await db.schema.createTable("memory_sync_keys", (t) => {
      t.integer("epoch").primary();
      t.text("wrapped").notNullable();
      t.integer("active").notNullable().defaultTo(0);
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("memory_promotions"))) {
    await db.schema.createTable("memory_promotions", (t) => {
      t.string("hash", 64).primary();
      t.string("reason", 200).notNullable().defaultTo("");
      t.string("status", 16).notNullable().defaultTo("pending");
      t.integer("created_at").notNullable();
    });
  }
}

/** Uppercase hex OpenPGP fingerprint for an armored public key. */
export async function pgpFingerprint(armored: string): Promise<string> {
  const key = await openpgp.readKey({ armoredKey: armored.trim() });
  return key.getFingerprint().toUpperCase();
}

/** Float32 vector <-> little-endian Buffer for the vec BLOB column. */
export function vecToBlob(vec: ArrayLike<number>): Buffer {
  const out = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) out.writeFloatLE(vec[i] ?? 0, i * 4);
  return out;
}

export function vecFromBlob(blob: Uint8Array, dims: number): Float32Array {
  const buf = Buffer.from(blob.buffer, blob.byteOffset, dims * 4);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity in [-1, 1]; 0 when either side is degenerate. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
