/**
 * Proof of funds, honestly scoped.
 *
 * What this is: a **signed claim** that this wallet holds at least N sats,
 * bound to a **Merkle commitment** over its spendable UTXO set, with an
 * expiry, plus **selective disclosure** — the holder can prove that one
 * specific UTXO is in the committed set without revealing the rest.
 *
 * What this is NOT: a zero-knowledge proof of the balance. A verifier learns
 * "this key claims ≥ N sats" and nothing more; it cannot check the claim
 * against the root without the set. The cryptographic guarantees that *do*
 * hold are: the statement is signed by the identity key (non-repudiable), it
 * is bound to a set commitment that cannot be swapped afterwards, individual
 * UTXOs can be proven by inclusion path, and the claim expires.
 *
 * The one guarantee the issuer gives: this daemon refuses to sign a claim
 * above the spendable total it can actually see. That is a promise about
 * this software, not about the key holder.
 *
 * Why it exists: on BSV an x402 buyer learns the seller's address, the amount,
 * and the on-chain linkage of every payment. This lets a seller say "I can
 * pay, here is my commitment, ask me for a UTXO proof if you want one"
 * without publishing their balance or their UTXO set.
 *
 * Origin: the "secure multi-party computation for critical data" line in
 * auxon/bonsai's README, taken at face value and cut down to what can
 * actually be built soundly. See docs/BONSAI.md.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Knex } from "knex";
import { identitySignMessage, identityPubkeyHex, selfAddress, verifyIdentitySignature } from "./custody.ts";
import { unavailableUtxos } from "./baskets.ts";
import type { ChainProvider } from "./chain.ts";

/** Domain separator: these leaves are never confused with anything else. */
export const FUNDS_LEAF_TAG = "bsvos/funds/v1";
export const FUNDS_STATEMENT_VERSION = 1;
const MAX_VALIDITY_MS = 30 * 86_400_000;
const CLOCK_TOLERANCE_MS = 5 * 60_000;

export function sha256hex(data: Buffer | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

/** One UTXO as a commitment leaf: outpoint + value, tagged. */
export function fundsLeaf(outpoint: string, valueSats: number): Buffer {
  return Buffer.from(sha256hex(`${FUNDS_LEAF_TAG}|${outpoint}|${Math.floor(valueSats)}`), "hex");
}

/**
 * The one and only pair rule: order-independent concatenation, smaller node
 * first. Every level must be built this way, or a verifier cannot reproduce
 * the root — and ordering pairs canonically also removes the
 * duplicate-leaf malleability that positional trees invite.
 */
export function hashPair(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = a.compare(b) <= 0 ? [a, b] : [b, a];
  return createHash("sha256").update(Buffer.concat([lo, hi])).digest();
}

/** Next level: pair neighbours, duplicating a trailing odd node. */
function nextLevel(level: Buffer[]): Buffer[] {
  const next: Buffer[] = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(hashPair(level[i]!, level[i + 1] ?? level[i]!));
  }
  return next;
}

/** Binary Merkle root; the last node is duplicated when the level is odd. */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return Buffer.alloc(32);
  let level = [...leaves].sort(Buffer.compare);
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

/** Sibling hashes proving `leaf` sits in the tree. */
export function merklePath(leaves: Buffer[], leaf: Buffer): Buffer[] {
  if (leaves.length === 0) throw new Error("empty set has no paths");
  let level = [...leaves].sort(Buffer.compare);
  let idx = level.findIndex((l) => l.equals(leaf));
  if (idx < 0) throw new Error("leaf not present in the set");
  const path: Buffer[] = [];
  while (level.length > 1) {
    // An odd trailing node is paired with itself by nextLevel, so the path
    // must carry it as its own sibling — otherwise the proof never verifies.
    const sibling = idx % 2 === 0 ? (level[idx + 1] ?? level[idx]!) : level[idx - 1]!;
    path.push(sibling);
    level = nextLevel(level);
    idx = Math.floor(idx / 2);
  }
  return path;
}

export function verifyMerklePath(leaf: Buffer, path: Buffer[], root: Buffer): boolean {
  let node = leaf;
  for (const sibling of path) node = hashPair(node, sibling);
  return node.equals(root);
}

/* ------------------------------------------------------------------ *
 * The statement
 * ------------------------------------------------------------------ */

/**
 * The shareable object. Deliberately excludes the balance and UTXO count —
 * publishing those would defeat the point. Canonical JSON (sorted keys, no
 * whitespace) is what gets signed, so both sides hash the same bytes.
 */
export interface FundsStatement {
  v: number;
  kind: "funds";
  key: string;
  address: string;
  minSats: number;
  root: string;
  createdAt: number;
  validUntil: number;
  nonce: string;
}

export interface FundsAttestation {
  statement: FundsStatement;
  signature: string;
}

export function canonicalStatement(s: FundsStatement): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) ordered[k] = (s as unknown as Record<string, unknown>)[k];
  return JSON.stringify(ordered);
}

export interface SpendableUtxo {
  outpoint: string;
  valueSats: number;
}

export interface AttestDeps {
  db: Knex;
  chain: ChainProvider;
  now?: () => number;
  sign?: (message: string) => string;
  key?: () => string;
  address?: () => string;
}

/** SHA-256 digests are 32 bytes. */
const HEX64 = /^[0-9a-f]{64}$/;
/** Identity keys are compressed secp256k1 points: 33 bytes (66 hex), or
 * 32-byte x-only (64 hex) on some encoders. Accept both. */
const HEX_KEY = /^([0-9a-f]{64}|[0-9a-f]{66})$/;

/**
 * Build and sign a claim. Refuses to claim more than the wallet can see:
 * the daemon will not sign a statement it knows to be false.
 */
export async function createFundsAttestation(
  deps: AttestDeps,
  opts: { minSats: number; validForMs?: number } = { minSats: 0 },
): Promise<FundsAttestation & { totalSats: number; utxoCount: number }> {
  const now = deps.now?.() ?? Date.now();
  const minSats = Math.floor(Number(opts.minSats) || 0);
  if (!(minSats > 0)) {
    throw Object.assign(new Error("minSats must be a positive sat count"), { code: "BAD_PARAM" });
  }
  const validFor = Math.min(MAX_VALIDITY_MS, Math.max(60_000, Math.floor(Number(opts.validForMs) || 3_600_000)));
  const key = deps.key?.() ?? identityPubkeyHex();
  const address = deps.address?.() ?? selfAddress();
  const hold = await spendableUtxos(deps.db, deps.chain, address);
  const totalSats = hold.reduce((sum, u) => sum + u.valueSats, 0);
  if (hold.length === 0) {
    throw Object.assign(new Error("no spendable UTXOs — nothing to attest"), { code: "RAILS" });
  }
  if (totalSats < minSats) {
    throw Object.assign(
      new Error(`cannot attest ${minSats} sats: only ${totalSats} spendable across ${hold.length} UTXOs`),
      { code: "RAILS" },
    );
  }
  const root = merkleRoot(hold.map((u) => fundsLeaf(u.outpoint, u.valueSats))).toString("hex");
  const statement: FundsStatement = {
    v: FUNDS_STATEMENT_VERSION,
    kind: "funds",
    key,
    address,
    minSats,
    root,
    createdAt: now,
    validUntil: now + validFor,
    nonce: randomBytes(8).toString("hex"),
  };
  const message = canonicalStatement(statement);
  const signature = deps.sign?.(message) ?? identitySignMessage(message);
  return { statement, signature, totalSats, utxoCount: hold.length };
}

/** Never throw while verifying: hostile input must produce a failed check. */
function iso(ms: unknown): string {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : "invalid";
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  /** What a holder of this object learns, and what they do not. */
  disclosure: { reveals: string[]; doesNotReveal: string[] };
}

/**
 * Verify a claim. Every check is reported, so a buyer sees exactly which
 * property failed instead of a bare "invalid".
 */
export function verifyFundsAttestation(input: unknown, now = Date.now()): VerifyResult {
  const checks: VerifyCheck[] = [];
  const obj = (input ?? {}) as { statement?: unknown; signature?: unknown };
  const s = (obj.statement ?? {}) as Partial<FundsStatement>;
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  add("shape", typeof obj.statement === "object" && obj.statement !== null && typeof obj.signature === "string",
    "statement object plus signature string");
  add("version", s.v === FUNDS_STATEMENT_VERSION && s.kind === "funds",
    `v=${String(s.v)} kind=${String(s.kind)} (expected v=${FUNDS_STATEMENT_VERSION} kind=funds)`);
  const keyOk = typeof s.key === "string" && HEX_KEY.test(s.key);
  add("key", keyOk, keyOk ? `identity key is ${(s.key as string).length / 2} bytes of hex` : "key must be 64 or 66 hex chars");
  add("minSats", Number.isInteger(s.minSats) && Number(s.minSats) > 0,
    `claim is ≥ ${String(s.minSats)} sats`);
  add("root", typeof s.root === "string" && HEX64.test(s.root),
    typeof s.root === "string" && HEX64.test(s.root) ? "set commitment present" : "root must be 64 hex chars");
  add("window", Number.isFinite(Number(s.createdAt)) && Number.isFinite(Number(s.validUntil)) && Number(s.validUntil) > Number(s.createdAt),
    `valid ${iso(s.createdAt)} → ${iso(s.validUntil)}`);

  const signed = keyOk && typeof s.key === "string" && typeof obj.signature === "string";
  const sigOk = signed ? verifyIdentitySignature(s.key as string, canonicalStatement(s as FundsStatement), obj.signature as string) : false;
  add("signature", sigOk, sigOk ? "ECDSA signature verifies against the claimed key" : "signature does not verify");

  const expired = Number(s.validUntil) <= now;
  add("unexpired", !expired,
    expired ? `expired ${iso(s.validUntil)}` : `valid for another ${Math.round((Number(s.validUntil) - now) / 1000)}s`);
  const future = Number(s.createdAt) > now + CLOCK_TOLERANCE_MS;
  add("clock", !future, future ? `createdAt is in the future (${iso(s.createdAt)})` : "createdAt is plausible");

  const structural = checks.filter((c) => c.name !== "unexpired" && c.name !== "clock").every((c) => c.ok);
  return {
    // A structurally valid but expired claim is not a valid claim today.
    ok: structural && !expired && !future,
    checks,
    disclosure: {
      reveals: ["the identity key that signed", "a receive address", "the minimum claimed", "a commitment to the UTXO set", "creation and expiry times"],
      doesNotReveal: ["the balance", "which UTXOs are held", "the number of UTXOs", "the wallet's history"],
    },
  };
}

export interface SpendableResult {
  utxos: SpendableUtxo[];
  unavailable: number;
}

/**
 * Confirmed UTXOs at our address, minus spent and reserved (capsule) ones.
 * Takes an optional snapshot so a caller can derive the spendable set and
 * the "everything we hold" set from ONE chain read — two reads can disagree
 * (a new block, a mempool view), which produced phantom "not spendable"
 * answers before this was a single snapshot.
 */
export async function spendableUtxos(
  db: Knex,
  chain: ChainProvider,
  address: string,
  snapshot?: { utxos: Array<{ txid: string; vout: number; value: number }> },
): Promise<SpendableUtxo[]> {
  const [u, blocked] = await Promise.all([
    snapshot ? Promise.resolve(snapshot) : chain.utxos(address),
    unavailableUtxos(db),
  ]);
  return u.utxos
    .map((x) => ({ outpoint: `${x.txid}_${x.vout}`, valueSats: x.value }))
    .filter((x) => x.valueSats > 0 && !blocked.has(x.outpoint));
}

/**
 * Disclose one UTXO: the leaf plus its path to the root. This is the part
 * that is cryptographically sound — anyone can check the UTXO is in the
 * committed set, and nobody learns the rest of the set.
 */
export async function proveFundsUtxo(
  deps: AttestDeps,
  statement: FundsStatement,
  outpoint: string,
): Promise<{ outpoint: string; valueSats: number; leaf: string; path: string[]; root: string; ok: boolean }> {
  const address = statement.address || selfAddress();
  const all = await deps.chain.utxos(address);
  const [hold, blocked] = await Promise.all([
    spendableUtxos(deps.db, deps.chain, address, all),
    unavailableUtxos(deps.db),
  ]);
  const target = hold.find((u) => u.outpoint === outpoint);
  if (!target) {
    // Say which case this is: not ours at all, or ours but not spendable.
    const held = all.utxos.some((x) => `${x.txid}_${x.vout}` === outpoint);
    if (!held) {
      throw Object.assign(new Error(`${outpoint} is not a UTXO of ${address}`), { code: "BAD_PARAM" });
    }
    throw Object.assign(
      new Error(
        blocked.has(outpoint)
          ? `${outpoint} is held but not spendable (reserved by a capsule, or tracked as spent) — a funds attestation only commits to coins it can spend`
          : `${outpoint} is held but not spendable (excluded from the spendable set — re-issue the attestation against the current set)`,
      ),
      { code: "BAD_PARAM" },
    );
  }
  const leaves = hold.map((u) => fundsLeaf(u.outpoint, u.valueSats));
  const leaf = fundsLeaf(target.outpoint, target.valueSats);
  const path = merklePath(leaves, leaf);
  const root = Buffer.from(statement.root, "hex");
  return {
    outpoint: target.outpoint,
    valueSats: target.valueSats,
    leaf: leaf.toString("hex"),
    path: path.map((p) => p.toString("hex")),
    root: statement.root,
    ok: verifyMerklePath(leaf, path, root),
  };
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

export async function migrateFunds(db: Knex): Promise<void> {
  if (await db.schema.hasTable("funds_attestations")) return;
  await db.schema.createTable("funds_attestations", (t) => {
    t.increments("id");
    t.string("key", 66).notNullable();
    t.string("address", 64).notNullable();
    t.integer("min_sats").notNullable();
    t.string("root", 64).notNullable();
    t.integer("utxo_count").notNullable().defaultTo(0);
    t.integer("total_sats").notNullable().defaultTo(0);
    t.integer("created_at").notNullable();
    t.integer("valid_until").notNullable();
    t.text("statement").notNullable();
    t.text("signature").notNullable();
    t.string("anchor_txid", 64).nullable();
  });
}

export interface FundsRecord {
  id: number;
  key: string;
  address: string;
  minSats: number;
  root: string;
  utxoCount: number;
  totalSats: number;
  createdAt: number;
  validUntil: number;
  statement: string;
  signature: string;
  anchorTxid: string | null;
}

export async function recordFundsAttestation(
  db: Knex,
  att: FundsAttestation & { totalSats: number; utxoCount: number },
): Promise<number> {
  const [id] = await db("funds_attestations").insert({
    key: att.statement.key,
    address: att.statement.address,
    min_sats: att.statement.minSats,
    root: att.statement.root,
    utxo_count: att.utxoCount,
    total_sats: att.totalSats,
    created_at: att.statement.createdAt,
    valid_until: att.statement.validUntil,
    statement: canonicalStatement(att.statement),
    signature: att.signature,
    anchor_txid: null,
  });
  return Number(id);
}

export async function listFundsAttestations(db: Knex, limit = 20): Promise<FundsRecord[]> {
  const rows = (await db("funds_attestations")
    .select()
    .orderBy("id", "desc")
    .limit(Math.min(100, Math.max(1, Math.floor(Number(limit) || 20))))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    key: String(r.key),
    address: String(r.address),
    minSats: Number(r.min_sats),
    root: String(r.root),
    utxoCount: Number(r.utxo_count),
    totalSats: Number(r.total_sats),
    createdAt: Number(r.created_at),
    validUntil: Number(r.valid_until),
    statement: String(r.statement),
    signature: String(r.signature),
    anchorTxid: r.anchor_txid === null || r.anchor_txid === undefined ? null : String(r.anchor_txid),
  }));
}
