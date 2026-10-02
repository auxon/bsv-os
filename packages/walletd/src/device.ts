/**
 * Phase 0: authenticated remote access for the iOS client.
 *
 * Design and threat model: docs/ios.md. The short version of why this file
 * exists at all: the daemon's security model is `isLoopbackPeer()` returning
 * 403 for anything that is not loopback, and a phone is never loopback. So
 * remote access is a new trust boundary, not a configuration change, and it
 * needs its own authentication and its own explicit authorisation.
 *
 * Two layers, deliberately separate:
 *
 *   - transport  — WireGuard (or a VPN). Not implemented here; it authenticates
 *                  the network, and this file assumes it. Nothing here should
 *                  be exposed to the open internet.
 *   - identity   — a per-device bearer token, minted by an explicit pairing
 *                  step, revocable from the desktop, stored server-side only as
 *                  a hash.
 *
 * The authorisation rule is the load-bearing part: a device may call an
 * explicit allowlist, and the origin it acts under is DERIVED from the
 * authenticated device (`device:<name>`), never supplied by the caller. That
 * mirrors `appInvoke`, where the origin comes from the installed app's domain
 * rather than from the request body.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Knex } from "knex";

// ── authorisation: the allowlist ─────────────────────────────────────────
//
// Single source of truth for the daemon. docs/ios.md and the Swift
// DeviceAllowlist mirror these sets, and packages/walletd/test/ios-parity.test.mjs
// parses all three and fails if they disagree — so widening access means editing
// the doc, the Swift and this file on purpose, in one commit.

/**
 * Reads. These spend nothing and are not policy-gated, but most of them still
 * need an unlocked wallet: only getVersion/getNetwork/getHeight/getHeader answer
 * while locked, because the rest must derive per-wallet keys. A locked wallet
 * returns WALLET_LOCKED, which the client models as `isLocked`.
 */
export const DEVICE_READS: readonly string[] = [
  "isAuthenticated",
  "getVersion",
  "getNetwork",
  "getHeight",
  "getHeader",
  "balance",
  "addressQr",
  "history",
  "policyList",
  "policyPending",
  "listPending",
  "utxos",
  "ordList",
  "bsv21List",
  "appList",
];

/**
 * Writes. Every one still runs through the policy engine under the device's own
 * origin, so caps and the ask-then-approve loop apply exactly as they do for the
 * CLI. Being on this list is permission to *ask*, not to spend.
 */
export const DEVICE_WRITES: readonly string[] = [
  "lock",
  "unlock",
  "policyApprove",
  "policyDeny",
  "send",
  "anchorFile",
  "sweepOut",
  "inscribe",
  "appInvoke",
  // The app store. Installing adds an origin that may *ask* to spend; the cap
  // it requests still needs approval, and widening it later needs approval
  // again, so this grants no spending authority by itself.
  "appInstall",
  "appRemove",
];

/**
 * Key-material methods. Never device-callable, whatever the convenience.
 *
 * On the desktop these are terminal-only. iOS has no terminal, which makes
 * exposing them tempting — and that is precisely why they are data here rather
 * than a comment. The phone must not become the weakest key path in the system
 * because it is the most convenient one.
 */
export const NEVER_DEVICE_CALLABLE: readonly string[] = [
  "createWallet",
  "importWallet",
  "recoverySetup",
  "recoveryRotate",
  "recoveryRestore",
  "exportEntropy",
  "twetchAccountImport",
  "twetchAccountImportFromPhrase",
  "twetchAccountImportFromSeed",
];

export function isDeviceCallable(method: string): boolean {
  if (NEVER_DEVICE_CALLABLE.includes(method)) return false;
  return DEVICE_READS.includes(method) || DEVICE_WRITES.includes(method);
}

/** The origin a device acts under. Derived, never supplied. */
export function deviceOrigin(name: string): string {
  return `device:${name}`;
}

// ── storage ──────────────────────────────────────────────────────────────

export async function migrateDevices(db: Knex): Promise<void> {
  if (await db.schema.hasTable("devices")) return;
  await db.schema.createTable("devices", (t) => {
    t.string("id", 64).primary();
    t.string("name", 120).notNullable();
    t.string("platform", 40).notNullable().defaultTo("unknown");
    t.string("token_hash", 64).notNullable();
    t.integer("created_at").notNullable();
    t.integer("last_seen").nullable();
    t.integer("revoked_at").nullable();
    // Phase 3: an APNs token so a pending approval can reach the lock screen.
    t.string("apns_token", 200).nullable();
  });
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
  hasApns: boolean;
}

function toRecord(row: Record<string, unknown>): DeviceRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    platform: String(row.platform ?? "unknown"),
    createdAt: Number(row.created_at) || 0,
    lastSeen: row.last_seen === null || row.last_seen === undefined ? null : Number(row.last_seen),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    hasApns: typeof row.apns_token === "string" && row.apns_token.length > 0,
  };
}

/** Tokens are stored as a hash, so a database read does not yield a credential. */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking position information through timing.
 * Both sides are fixed-length sha256 hex, so lengths always match.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ── pairing ──────────────────────────────────────────────────────────────
//
// In memory on purpose: a short-lived code should not survive a restart, and
// there is nothing to migrate.

const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 5;
/** Unambiguous alphabet: no 0/O, 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface PendingPairing {
  code: string;
  expiresAt: number;
  attempts: number;
}

let pendingPairing: PendingPairing | null = null;

export function mintPairingCode(): { code: string; expiresAt: number } {
  const bytes = randomBytes(8);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const expiresAt = Date.now() + CODE_TTL_MS;
  pendingPairing = { code, expiresAt, attempts: 0 };
  return { code, expiresAt };
}

/** What `bsv device pair` shows, if a pairing is still open. */
export function pendingPairingView(): { code: string; expiresAt: number } | null {
  if (!pendingPairing || pendingPairing.expiresAt <= Date.now()) return null;
  return { code: pendingPairing.code, expiresAt: pendingPairing.expiresAt };
}

export function cancelPairing(): void {
  pendingPairing = null;
}

export interface PairedDevice {
  deviceId: string;
  token: string;
}

export class DeviceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
  }
}

/**
 * Complete a pairing. Returns the token exactly once — it is never recoverable
 * afterwards, because only its hash is kept.
 */
export async function completePairing(
  db: Knex,
  opts: { code?: unknown; name?: unknown; platform?: unknown },
): Promise<PairedDevice> {
  if (!pendingPairing || pendingPairing.expiresAt <= Date.now()) {
    // Same error whether the code never existed or expired: telling the
    // caller which would refine a brute-force search.
    throw new DeviceError("NO_PAIRING", "no pairing is open — run `bsv device pair` on the desktop");
  }
  pendingPairing.attempts++;
  if (pendingPairing.attempts > MAX_PAIR_ATTEMPTS) {
    pendingPairing = null;
    throw new DeviceError("TOO_MANY_ATTEMPTS", "too many attempts — run `bsv device pair` again");
  }
  const presented = String(opts.code ?? "").trim().toUpperCase();
  if (!presented || !constantTimeEqualHex(hashToken(presented), hashToken(pendingPairing.code))) {
    throw new DeviceError("BAD_CODE", "that pairing code is not correct");
  }

  const name = String(opts.name ?? "").trim().slice(0, 120) || "ios device";
  const platform = String(opts.platform ?? "unknown").trim().slice(0, 40) || "unknown";
  const deviceId = `dev_${randomBytes(8).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const now = Date.now();

  await db("devices").insert({
    id: deviceId,
    name,
    platform,
    token_hash: hashToken(token),
    created_at: now,
    last_seen: null,
    revoked_at: null,
    apns_token: null,
  });
  // Single use, and the window closes immediately.
  pendingPairing = null;
  return { deviceId, token };
}

// ── authentication ───────────────────────────────────────────────────────

/** Resolve a bearer token to a live device, or null. Updates last_seen. */
export async function authenticateDevice(db: Knex, token: string): Promise<DeviceRecord | null> {
  const presented = String(token ?? "").trim();
  if (!presented) return null;
  const digest = hashToken(presented);
  const rows = (await db("devices").select()) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const stored = String(row.token_hash ?? "");
    if (stored.length !== digest.length) continue;
    // Compare every row rather than short-circuiting on the first match, so a
    // lookup does not reveal how many devices exist or which one matched.
    if (constantTimeEqualHex(stored, digest)) {
      const record = toRecord(row);
      if (record.revokedAt !== null) return null;
      await db("devices").where({ id: record.id }).update({ last_seen: Date.now() });
      return record;
    }
  }
  return null;
}

export async function listDevices(db: Knex): Promise<DeviceRecord[]> {
  const rows = (await db("devices").select().orderBy("created_at", "asc")) as Array<Record<string, unknown>>;
  return rows.map(toRecord);
}

async function findDevice(db: Knex, idOrName: string): Promise<DeviceRecord | null> {
  const rows = (await db("devices").select()) as Array<Record<string, unknown>>;
  const hit = rows.find((r) => String(r.id) === idOrName || String(r.name) === idOrName);
  return hit ? toRecord(hit) : null;
}

export async function revokeDevice(db: Knex, idOrName: string): Promise<boolean> {
  const device = await findDevice(db, idOrName);
  if (!device) return false;
  await db("devices").where({ id: device.id }).update({ revoked_at: Date.now() });
  return true;
}

export async function renameDevice(db: Knex, idOrName: string, name: string): Promise<boolean> {
  const device = await findDevice(db, idOrName);
  if (!device) return false;
  const clean = name.trim().slice(0, 120);
  if (!clean) throw new DeviceError("BAD_PARAM", "name must not be empty");
  await db("devices").where({ id: device.id }).update({ name: clean });
  return true;
}

// ── the request decision ─────────────────────────────────────────────────
//
// Kept here, as a pure function over headers, rather than inline in the HTTP
// handler: these are the security rules, and security rules in this repo are
// testable. The handler in index.ts is thin wiring around this.

export interface DeviceDecision {
  ok: boolean;
  status: number;
  code: string;
  message: string;
  device?: DeviceRecord;
}

export async function authorizeDeviceRequest(opts: {
  db: Knex;
  method: string;
  authorization?: string | undefined;
  origin?: string | undefined;
  deviceMarker?: string | undefined;
  now?: number;
}): Promise<DeviceDecision> {
  const deny = (status: number, code: string, message: string): DeviceDecision => ({
    ok: false, status, code, message,
  });

  // 1. Browsers always send Origin; native clients never do. Its presence means
  //    a web page (or a stray browser on the LAN) is reaching for the wallet,
  //    and this surface answers no preflight, so a browser cannot get here
  //    legitimately.
  if (typeof opts.origin === "string" && opts.origin.length > 0) {
    return deny(403, "FORBIDDEN", "the device surface refuses browser-originated requests");
  }

  // 2. A marker a browser could not set cross-origin without a preflight.
  if (opts.deviceMarker !== "1") {
    return deny(400, "BAD_REQUEST", "X-Bsv-Device: 1 header required");
  }

  // 3. A live, unrevoked device. Checked before the allowlist so an
  //    unauthenticated caller learns nothing about which methods exist.
  const auth = String(opts.authorization ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const device = await authenticateDevice(opts.db, token);
  if (!device) return deny(403, "FORBIDDEN", "device is not paired, or was revoked");

  // 4. Authorisation: an explicit allowlist, never a prefix of the wallet's
  //    dispatch. Key-material methods are refused here by name.
  if (!isDeviceCallable(opts.method)) {
    return deny(403, "NOT_ALLOWED", `method not allowed for a paired device: ${opts.method}`);
  }

  // 5. Bound a stolen token.
  if (!allowRequest(device.id, opts.now)) {
    return deny(429, "RATE_LIMITED", "too many requests from this device");
  }

  return { ok: true, status: 200, code: "OK", message: "", device };
}

// ── rate limiting ────────────────────────────────────────────────────────
//
// Bounds a stolen token. In memory: a restart clears it, which is the safe
// direction (a restart should not lock anyone out).

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 60;

const requestLog = new Map<string, number[]>();

export function allowRequest(deviceId: string, now: number = Date.now()): boolean {
  const recent = (requestLog.get(deviceId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_REQUESTS) {
    requestLog.set(deviceId, recent);
    return false;
  }
  recent.push(now);
  requestLog.set(deviceId, recent);
  return true;
}

export function resetRateLimits(): void {
  requestLog.clear();
}
