/**
 * F3 Identity Center v1: certificate wallet (hold + present).
 *
 * Holds self-contained signed attribute certificates: a certifier (a
 * compressed identity pubkey) attests named fields about a subject by
 * signing the canonical envelope with ECDSA. The daemon verifies the
 * signature at put time, stores the cert, and later discloses ONLY the
 * requested fields — every disclosure is logged for the audit view.
 *
 * Explicitly NOT full BRC-72 (no encrypted fields, no keyring exchange,
 * no revocation overlay): those arrive with the Twetch-identity binding.
 * Unsigned certs are stored honestly labeled `self-asserted` and are
 * never reported as verified.
 */
import type { Knex } from "knex";
import { createHash } from "node:crypto";
import { BigNumber, ECDSA, Hash, PublicKey, Signature } from "@bsv/sdk";
import { stableStringify } from "./apps.ts";

export const CERT_ENVELOPE = "bsv-os-cert-v1";

export interface CertFields {
  [key: string]: string;
}

export interface CertRow {
  id: string;
  type: string;
  certifier: string;
  subject: string;
  fields: string; // JSON
  signature: string | null;
  verified: number;
  issued_at: number;
  expires_at: number;
  revoked: number;
}

export interface CertView {
  id: string;
  type: string;
  certifier: string;
  subject: string;
  fields: CertFields;
  signature: string | null;
  verified: boolean;
  issuedAt: number;
  expiresAt: number;
  expired: boolean;
  revoked: boolean;
  valid: boolean;
}

export interface DisclosureView {
  id: number;
  certId: string;
  certType: string;
  fields: string[];
  to: string;
  createdAt: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function checkType(type: unknown): string {
  if (typeof type !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(type)) {
    fail("BAD_PARAM", "cert type must match [a-z0-9.-]{1,64}");
  }
  return type as string;
}

function checkPubkey(hex: unknown, what: string): string {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{66}$/.test(hex)) {
    fail("BAD_PARAM", `${what} must be a 33-byte compressed pubkey hex`);
  }
  try {
    PublicKey.fromString(hex);
  } catch {
    fail("BAD_PARAM", `${what} is not a valid secp256k1 public key`);
  }
  return (hex as string).toLowerCase();
}

function checkFields(fields: unknown): CertFields {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    fail("BAD_PARAM", "fields must be a string map");
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) fail("BAD_PARAM", "fields must not be empty");
  if (entries.length > 32) fail("BAD_PARAM", "at most 32 fields per cert");
  const out: CertFields = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) fail("BAD_PARAM", `bad field name: ${k}`);
    if (typeof v !== "string" || v.length > 512) fail("BAD_PARAM", `bad field value for: ${k}`);
    out[k] = v;
  }
  return out;
}

/** Canonical bytes the certifier signs (signature itself excluded). */
export function certCanonical(type: string, certifier: string, subject: string, fields: CertFields): string {
  return [CERT_ENVELOPE, type, certifier, subject, stableStringify(fields)].join("\0");
}

export function certDigest(type: string, certifier: string, subject: string, fields: CertFields): BigNumber {
  const bytes = Hash.sha256(new TextEncoder().encode(certCanonical(type, certifier, subject, fields)));
  return BigNumber.fromString(Buffer.from(bytes).toString("hex"), 16);
}

export function certIdFor(type: string, certifier: string, subject: string, fields: CertFields): string {
  return createHash("sha256").update(certCanonical(type, certifier, subject, fields), "utf8").digest("hex");
}

function verifySignature(certifier: string, digest: BigNumber, signature: string): boolean {
  try {
    const sig = Signature.fromDER(signature.trim(), "hex");
    return ECDSA.verify(digest, sig, PublicKey.fromString(certifier));
  } catch {
    return false;
  }
}

export async function migrateCerts(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("certs"))) {
    await db.schema.createTable("certs", (t) => {
      t.string("id", 64).primary();
      t.string("type", 64).notNullable();
      t.string("certifier", 66).notNullable();
      t.string("subject", 66).notNullable().defaultTo("");
      t.text("fields").notNullable();
      t.text("signature").nullable();
      t.integer("verified").notNullable().defaultTo(0);
      t.integer("issued_at").notNullable();
      t.integer("expires_at").notNullable().defaultTo(0);
      t.integer("revoked").notNullable().defaultTo(0);
    });
  }
  if (!(await db.schema.hasTable("disclosures"))) {
    await db.schema.createTable("disclosures", (t) => {
      t.increments("id");
      t.string("cert_id", 64).notNullable();
      t.text("fields").notNullable(); // JSON array of disclosed names
      t.string("to", 200).notNullable().defaultTo("");
      t.integer("created_at").notNullable();
    });
  }
}

export function certView(row: CertRow, now = Date.now()): CertView {
  const expired = row.expires_at > 0 && now >= row.expires_at;
  const revoked = row.revoked === 1;
  return {
    id: row.id,
    type: row.type,
    certifier: row.certifier,
    subject: row.subject,
    fields: JSON.parse(row.fields) as CertFields,
    signature: row.signature,
    verified: row.verified === 1,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    expired,
    revoked,
    valid: !expired && !revoked,
  };
}

export async function putCert(
  db: Knex,
  opts: {
    type: string; certifier: string; subject?: string;
    fields: unknown; signature?: string; expiresAt?: number;
  },
): Promise<CertView> {
  const type = checkType(opts.type);
  const certifier = checkPubkey(opts.certifier, "certifier");
  const subject = opts.subject ? checkPubkey(opts.subject, "subject") : "";
  const fields = checkFields(opts.fields);
  const expiresAt = Math.floor(Number(opts.expiresAt) || 0);
  if (expiresAt !== 0 && expiresAt <= Date.now()) fail("BAD_PARAM", "expiry must be in the future");
  let verified = false;
  let signature: string | null = null;
  if (opts.signature !== undefined && opts.signature !== null && String(opts.signature).trim() !== "") {
    signature = String(opts.signature).trim();
    verified = verifySignature(certifier, certDigest(type, certifier, subject, fields), signature);
    if (!verified) fail("BAD_SIG", "signature does not verify against the certifier key");
  }
  const now = Date.now();
  const id = certIdFor(type, certifier, subject, fields);
  const row: CertRow = {
    id, type, certifier, subject, fields: JSON.stringify(fields),
    signature, verified: verified ? 1 : 0,
    issued_at: now, expires_at: expiresAt, revoked: 0,
  };
  const existing = (await db("certs").where({ id }).first()) as CertRow | undefined;
  if (existing) fail("EXISTS", `cert already held: ${id.slice(0, 12)}…`);
  await db("certs").insert(row);
  return certView(row, now);
}

export async function listCerts(db: Knex): Promise<CertView[]> {
  const rows = (await db("certs").select().orderBy("issued_at", "desc").limit(100)) as CertRow[];
  const now = Date.now();
  return rows.map((r) => certView(r, now));
}

export async function getCert(db: Knex, id: string): Promise<CertView | null> {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/i.test(id)) return null;
  const row = (await db("certs").where({ id: id.toLowerCase() }).first()) as CertRow | undefined;
  return row ? certView(row) : null;
}

export async function revokeCert(db: Knex, id: string): Promise<{ id: string; revoked: boolean }> {
  const cert = await getCert(db, id);
  if (!cert) fail("NOT_FOUND", `no cert: ${String(id).slice(0, 12)}…`);
  await db("certs").where({ id: (cert as CertView).id }).update({ revoked: 1 });
  return { id: (cert as CertView).id, revoked: true };
}

/**
 * Present a cert: return ONLY the requested fields (default: all) and log
 * the disclosure (cert, field names, recipient) for the audit view. Field
 * VALUES are the holder's own data; names+recipient+time are the audit.
 */
export async function showCert(
  db: Knex,
  id: string,
  opts: { fields?: string[]; to?: string } = {},
): Promise<{ cert: CertView; disclosed: CertFields; disclosureId: number }> {
  const cert = await getCert(db, id);
  if (!cert) fail("NOT_FOUND", `no cert: ${String(id).slice(0, 12)}…`);
  const c = cert as CertView;
  const names = opts.fields !== undefined ? opts.fields : Object.keys(c.fields);
  if (!Array.isArray(names) || names.length === 0) fail("BAD_PARAM", "fields must be a non-empty list");
  if (names.length > 32) fail("BAD_PARAM", "at most 32 fields per disclosure");
  const disclosed: CertFields = {};
  for (const name of names) {
    if (typeof name !== "string" || !(name in c.fields)) {
      fail("BAD_PARAM", `cert has no field: ${String(name)}`);
    }
    disclosed[name as string] = c.fields[name as string] as string;
  }
  const to = typeof opts.to === "string" ? opts.to.slice(0, 200) : "";
  const [disclosureId] = (await db("disclosures").insert({
    cert_id: c.id, fields: JSON.stringify(Object.keys(disclosed)), to, created_at: Date.now(),
  })) as number[];
  return { cert: c, disclosed, disclosureId: disclosureId as number };
}

export async function listDisclosures(db: Knex): Promise<DisclosureView[]> {
  const rows = (await db("disclosures")
    .leftJoin("certs", "disclosures.cert_id", "certs.id")
    .select("disclosures.id", "disclosures.cert_id", "certs.type", "disclosures.fields", "disclosures.to", "disclosures.created_at")
    .orderBy("disclosures.created_at", "desc")
    .limit(100)) as Array<{
    id: number; cert_id: string; type: string | null; fields: string; to: string; created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    certId: r.cert_id,
    certType: r.type ?? "?",
    fields: JSON.parse(r.fields) as string[],
    to: r.to,
    createdAt: r.created_at,
  }));
}
