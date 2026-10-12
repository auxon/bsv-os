/**
 * Tiered memory write path (P1). Pure coordination over custody + tiers tables:
 * visibility parsing, `--for` recipient resolution, L1 hot cache, L2 tier
 * rows, and payload building. L3 board/usenet writes stay in rpc.ts on the
 * existing boardPublish path; this module never touches the network.
 *
 * Envelope model: private/shared payloads are PGP ciphertext (to self, or
 * to recipients + self). Board transport may add its own envelope on top —
 * defense in depth, stated honestly. Public payloads are plaintext, as today.
 */
import type { Knex } from "knex";
import { cleanTag, contentHash, normalizeMemoryText } from "./memory.ts";
import { pgpFingerprint, type Visibility } from "./memoryTiers.ts";
import type { Embedder } from "./embed.ts";
import { vecToBlob } from "./memoryTiers.ts";
import { resolvePerson } from "./people.ts";

export interface WriteInput {
  visibility: Visibility;
  forList: string[];
  pin: boolean;
  tagPublic: boolean | null; // null = follow visibility (public→open, else opaque)
}

export interface Recipient {
  fingerprint: string;
  publicKey: string;
  label: string;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Validate the visibility trio. `forList` entries are raw `--for` values. */
export function parseWriteInput(raw: { visibility?: unknown; for?: unknown; pin?: unknown; tagPublic?: unknown }): WriteInput {
  const v = typeof raw.visibility === "string" ? raw.visibility.trim().toLowerCase() : "private";
  if (v !== "public" && v !== "private" && v !== "shared") {
    fail("BAD_PARAM", "visibility must be private, shared, or public");
  }
  const forRaw = raw.for;
  const forList = (
    Array.isArray(forRaw) ? forRaw : forRaw === undefined || forRaw === null ? [] : [forRaw]
  )
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  if (v === "shared" && !forList.length) {
    fail("BAD_PARAM", "shared visibility needs at least one --for recipient (refusing to write an unreadable memory)");
  }
  if (v !== "shared" && forList.length) {
    fail("BAD_PARAM", `--for needs --visibility shared (got ${v})`);
  }
  return {
    visibility: v as Visibility,
    forList,
    pin: raw.pin === true,
    tagPublic: raw.tagPublic === true ? true : raw.tagPublic === false ? false : null,
  };
}

/**
 * Resolve `--for` values to PGP recipients. Each entry is a 40-hex
 * fingerprint, an identity key, or a @contact name (via resolvePerson).
 * Raw addresses are refused (nothing encrypts to an address). Unknown or
 * revoked keys fail closed with a key-exchange hint — a memory that
 * silently goes plaintext is the worst outcome in this design.
 */
export async function resolveRecipients(db: Knex, forList: string[]): Promise<Recipient[]> {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const raw of forList) {
    let fingerprint = "";
    let label = raw;
    if (/^[0-9a-fA-F]{40}$/.test(raw)) {
      fingerprint = raw.toUpperCase();
    } else {
      const person = await resolvePerson(db, raw).catch(() => null);
      const identityKey = person?.identityKey ?? "";
      if (!identityKey) {
        fail("NOT_FOUND", `no PGP key for ${raw} — exchange keys first (bsv memory key-add), then retry`);
      }
      const row = (await db("memory_devices")
        .where({ identity_key: identityKey.toLowerCase() })
        .whereNull("revoked_at")
        .orderBy("approved_at", "desc")
        .first()) as { fingerprint: string; public_key: string } | undefined;
      if (!row) {
        fail("NOT_FOUND", `no PGP key for ${raw} — exchange keys first (bsv memory key-add), then retry`);
      }
      fingerprint = row.fingerprint;
      label = person?.display || person?.name || raw;
    }
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const row = (await db("memory_devices").where({ fingerprint }).first()) as
      | { fingerprint: string; public_key: string; identity_key: string; revoked_at: number | null }
      | undefined;
    if (!row || row.revoked_at !== null) {
      fail("NOT_FOUND", `no PGP key for ${raw} — exchange keys first (bsv memory key-add), then retry`);
    }
    out.push({ fingerprint, publicKey: row.public_key, label });
  }
  return out;
}

/** Register (or refresh) this device's row in the key directory. */
export async function registerSelfDevice(
  db: Knex,
  input: { fingerprint: string; publicKey: string; identityKey: string; label?: string },
  now = Date.now(),
): Promise<void> {
  const expect = await pgpFingerprint(input.publicKey).catch(() => "");
  if (expect !== input.fingerprint.toUpperCase()) {
    fail("BAD_PARAM", "public key does not match its fingerprint");
  }
  const existing = (await db("memory_devices").where({ fingerprint: input.fingerprint.toUpperCase() }).first()) as
    | { fingerprint: string }
    | undefined;
  if (existing) {
    await db("memory_devices")
      .where({ fingerprint: input.fingerprint.toUpperCase() })
      .update({ public_key: input.publicKey, identity_key: input.identityKey.toLowerCase(), label: input.label ?? "", approved_at: now, revoked_at: null });
    return;
  }
  await db("memory_devices").insert({
    fingerprint: input.fingerprint.toUpperCase(),
    identity_key: input.identityKey.toLowerCase(),
    public_key: input.publicKey,
    label: input.label ?? "",
    is_self: 1,
    approved_at: now,
    revoked_at: null,
  });
}

export interface TierWrite {
  hash: string;
  tag: string;
  tagPublic: boolean;
  payload: string;
  vectorized: boolean;
}

/**
 * Write L2 tier rows for one memory. Callers pass the already-built payload
 * (plaintext for public, armored PGP otherwise) and an optional embedder —
 * vectors are stored for PUBLIC visibility only, never for ciphertext.
 */
export async function writeTierRows(
  db: Knex,
  input: {
    text: string;
    visibility: Visibility;
    tag: string;
    tagPublic: boolean | null;
    pin: boolean;
    fromFp: string;
    author: string;
    payload: string;
    embedder?: Embedder | null;
  },
  now = Date.now(),
): Promise<TierWrite> {
  const clean = normalizeMemoryText(input.text);
  if (!clean) fail("BAD_PARAM", "text required");
  const hash = contentHash(clean);
  const tag = cleanTag(input.tag);
  const tagPublic = input.tagPublic ?? input.visibility === "public";
  await db("memory_items").insert({
    hash,
    visibility: input.visibility,
    tag,
    tag_public: tagPublic ? 1 : 0,
    ts: now,
    from_fp: input.fromFp,
    author: input.author,
    payload: input.payload,
    pin: input.pin ? 1 : 0,
    importance: 0,
    created_at: now,
  }).onConflict("hash").ignore();
  let vectorized = false;
  if (input.visibility === "public" && input.embedder) {
    const [vec] = await input.embedder.embed([clean]);
    if (vec && vec.length > 0) {
      await db("memory_vectors").insert({
        hash,
        dims: vec.length,
        vec: vecToBlob(vec),
        model: input.embedder.name,
        updated_at: now,
      }).onConflict("hash").ignore();
      vectorized = true;
    }
  }
  return { hash, tag, tagPublic, payload: input.payload, vectorized };
}

// ── L1 hot cache: process-local, TTL + cap, wiped on wallet lock. ──

export interface HotHit {
  hash: string;
  text: string;
  tag: string;
  visibility: Visibility;
  at: number;
}

const HOT_MAX = 100;
const HOT_TTL_MS = 10 * 60 * 1000;
const hot = new Map<string, HotHit>();

export function hotPut(hit: HotHit): void {
  hot.delete(hit.hash);
  hot.set(hit.hash, hit);
  while (hot.size > HOT_MAX) {
    const oldest = hot.keys().next().value;
    if (oldest === undefined) break;
    hot.delete(oldest);
  }
}

export function hotClear(): void {
  hot.clear();
}

export function hotList(now = Date.now()): HotHit[] {
  const out: HotHit[] = [];
  for (const [hash, hit] of hot) {
    if (now - hit.at > HOT_TTL_MS) {
      hot.delete(hash);
      continue;
    }
    out.push(hit);
  }
  return out;
}

export function hotGet(hash: string, now = Date.now()): HotHit | null {
  const hit = hot.get(hash);
  if (!hit || now - hit.at > HOT_TTL_MS) {
    if (hit) hot.delete(hash);
    return null;
  }
  return hit;
}
