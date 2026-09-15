/**
 * F10 social recovery: Shamir-split wallet entropy across guardians.
 *
 * Ceremony (all human-at-keyboard, like create/import — agents never touch
 * shares, and there is deliberately NO restore RPC usable without them):
 * - `setup`: split the 16-byte wallet entropy into N shares (any M
 *   reconstruct), print each guardian's card ONCE, store metadata only.
 * - `restore`: combine M cards on-device, verify the set fingerprint,
 *   re-enroll. Works on a fresh machine with nothing but the cards.
 * - `rotate`: re-split the same seed (new set id, new polynomial) —
 *   rotation and guardian revocation move NO funds.
 *
 * What the daemon stores: set metadata (ids, threshold, guardian names,
 * fingerprint, superseded flags). NEVER shares, NEVER the seed. The set
 * fingerprint rides ON the cards, so a fresh device can verify before
 * trusting a reconstruction.
 */
import type { Knex } from "knex";
import { createHash, randomBytes } from "node:crypto";
import { combine, split, type Share } from "./shamir.ts";

export const RECOVERY_MAGIC = "BSV1";
const ENTROPY_BYTES = 16;

export interface Guardian {
  name: string;
  identityKey: string | null; // Twetch-bound guardian key when known (F3 follow-up)
}

export interface RecoverySet {
  setId: string;
  need: number;
  total: number;
  fingerprint: string;
  guardians: Guardian[];
  createdAt: number;
  superseded: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function fingerprintOf(entropy: Uint8Array): string {
  return createHash("sha256").update("bsv-os-recovery-v1").update(entropy).digest("hex");
}

function checkGuardian(g: unknown): Guardian {
  if (!g || typeof g !== "object") fail("BAD_PARAM", "guardian must be {name}");
  const { name, identityKey } = g as { name?: unknown; identityKey?: unknown };
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    fail("BAD_PARAM", "guardian name must match [A-Za-z0-9._-]{1,64}");
  }
  if (identityKey !== undefined && identityKey !== null) {
    if (typeof identityKey !== "string" || !/^[0-9a-fA-F]{66}$/.test(identityKey)) {
      fail("BAD_PARAM", `guardian ${name}: identityKey must be 33-byte compressed pubkey hex`);
    }
  }
  return { name: name as string, identityKey: (identityKey as string | undefined) ?? null };
}

/**
 * Card text. Carries everything a fresh device needs: set id, threshold,
 * this share (x + data), and the set fingerprint for pre-trust verify.
 * Hex, never words — cards cannot be mistaken for recovery phrases.
 */
export function packCard(setId: string, need: number, total: number, share: Share, fingerprint: string): string {
  const data = Buffer.from(share.y).toString("hex");
  return [RECOVERY_MAGIC, setId, `${need}of${total}`, String(share.x), data, fingerprint.slice(0, 16)].join("-");
}

export interface ParsedCard {
  setId: string;
  need: number;
  total: number;
  share: Share;
  fingerprint: string;
}

export function parseCard(card: string): ParsedCard {
  const parts = String(card ?? "").trim().split("-");
  if (parts.length !== 6 || parts[0] !== RECOVERY_MAGIC) fail("BAD_CARD", "not a BSV1 recovery card");
  const [, setId, mStr, xStr, dataHex, fp] = parts as string[];
  if (!/^[0-9a-f]{16}$/.test(setId!)) fail("BAD_CARD", "bad set id");
  const m = /^(\d+)of(\d+)$/.exec(mStr!);
  if (!m) fail("BAD_CARD", "bad threshold");
  const need = Number(m[1]);
  const total = Number(m[2]!);
  const x = Number(xStr);
  if (!/^[0-9a-fA-F]+$/.test(dataHex!) || dataHex!.length % 2 !== 0) fail("BAD_CARD", "bad share data");
  const data = Buffer.from(dataHex!, "hex");
  if (data.length !== ENTROPY_BYTES) fail("BAD_CARD", `share must hold ${ENTROPY_BYTES} bytes`);
  if (!/^[0-9a-f]{16}$/i.test(fp!)) fail("BAD_CARD", "bad fingerprint");
  if (!(need! >= 1) || !(total! >= need!) || total! > 255 || !(x >= 1) || x > 255) {
    fail("BAD_CARD", "threshold out of range");
  }
  return {
    setId: setId!, need: need!, total: total!,
    share: { x, y: new Uint8Array(data) }, fingerprint: fp!.toLowerCase(),
  };
}

/** Split entropy for guardians (order = card assignment order). */
export function splitFor(
  entropy: Uint8Array,
  need: number,
  guardians: Guardian[],
): { setId: string; need: number; total: number; fingerprint: string; cards: Array<{ guardian: Guardian; card: string }> } {
  if (entropy.length !== ENTROPY_BYTES) fail("BAD_PARAM", `entropy must be ${ENTROPY_BYTES} bytes`);
  if (!Number.isInteger(need) || need < 1) fail("BAD_PARAM", "need must be >= 1");
  if (guardians.length < 1 || guardians.length > 255) fail("BAD_PARAM", "need 1..255 guardians");
  if (need > guardians.length) fail("BAD_PARAM", "need cannot exceed guardian count");
  const clean = guardians.map(checkGuardian);
  const names = new Set(clean.map((g) => g.name.toLowerCase()));
  if (names.size !== clean.length) fail("BAD_PARAM", "guardian names must be unique");
  const fingerprint = fingerprintOf(entropy);
  const setId = randomBytes(8).toString("hex");
  const shares = split(entropy, need, clean.length);
  return {
    setId,
    need,
    total: clean.length,
    fingerprint,
    cards: shares.map((share, i) => ({
      guardian: clean[i]!,
      card: packCard(setId, need, clean.length, share, fingerprint),
    })),
  };
}

/** Combine cards → entropy, enforcing one set, quorum, and fingerprint. */
export function combineCards(cards: string[]): {
  entropy: Uint8Array; setId: string; need: number; total: number; fingerprint: string;
} {
  if (cards.length === 0) fail("BAD_CARD", "no cards given");
  const parsed = cards.map((c) => parseCard(c));
  const first = parsed[0]!;
  for (const p of parsed) {
    if (p.setId !== first.setId) fail("BAD_CARD", "cards from different sets refuse to mix");
    if (p.fingerprint !== first.fingerprint) fail("BAD_CARD", "fingerprint mismatch — a card is foreign or corrupt");
  }
  if (parsed.length < first.need) {
    fail("BAD_CARD", `quorum not met: have ${parsed.length}, need ${first.need}`);
  }
  const entropy = combine(parsed.map((p) => p.share));
  // Cards carry the 16-hex-char fingerprint PREFIX (card brevity); a
  // mismatch here means a wrong/foreign card, not a weak check — the
  // shares themselves remain the full 128-bit secret.
  if (fingerprintOf(entropy).slice(0, 16) !== first.fingerprint) {
    fail("BAD_CARD", "reconstruction failed fingerprint check — a card is wrong");
  }
  return { entropy, setId: first.setId, need: first.need, total: first.total, fingerprint: first.fingerprint };
}

export async function migrateRecovery(db: Knex): Promise<void> {
  if (await db.schema.hasTable("recovery_sets")) return;
  await db.schema.createTable("recovery_sets", (t) => {
    t.string("set_id", 16).primary();
    t.integer("need").notNullable();
    t.integer("total").notNullable();
    t.string("fingerprint", 64).notNullable();
    t.text("guardians").notNullable(); // JSON Guardian[]
    t.integer("created_at").notNullable();
    t.integer("superseded").notNullable().defaultTo(0);
  });
}

export async function recordSet(
  db: Knex,
  set: { setId: string; need: number; total: number; fingerprint: string; guardians: Guardian[] },
): Promise<void> {
  await db("recovery_sets").insert({
    set_id: set.setId, need: set.need, total: set.total,
    fingerprint: set.fingerprint, guardians: JSON.stringify(set.guardians),
    created_at: Date.now(), superseded: 0,
  });
}

export async function listSets(db: Knex): Promise<RecoverySet[]> {
  const rows = (await db("recovery_sets").select().orderBy("created_at", "desc").limit(20)) as Array<{
    set_id: string; need: number; total: number; fingerprint: string;
    guardians: string; created_at: number; superseded: number;
  }>;
  return rows.map((r) => ({
    setId: r.set_id, need: r.need, total: r.total, fingerprint: r.fingerprint,
    guardians: JSON.parse(r.guardians) as Guardian[],
    createdAt: r.created_at, superseded: r.superseded,
  }));
}

export async function supersedeSets(db: Knex, exceptSetId: string): Promise<number> {
  return db("recovery_sets").whereNot({ set_id: exceptSetId }).update({ superseded: 1 });
}
