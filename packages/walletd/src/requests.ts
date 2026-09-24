/**
 * Payment requests: signed asks for money that travel over any channel.
 *
 * A request is a compact code (`bsvpay1:<base64url JSON>`) whose payload —
 * requester identity key, receive address, exact sats, memo, timestamps —
 * is signed with the requester's identity root via BSM. That makes the code
 * self-authenticating: a payer verifies it against the requester's public
 * key, so it can arrive by DM, QR, or a pasted email without any risk of an
 * address or amount swap in transit. Requests are never auto-paid: only an
 * explicit human approval in the panel or CLI releases sats.
 *
 * After paying, the payer's daemon sends a signed receipt
 * (`bsvrcpt1:<base64url JSON>`) back over the same DM path; the requester's
 * inbox sync verifies it and marks the request paid with the txid. Both
 * directions reuse the existing message transport and store — the only new
 * persistence is the request ledger below.
 */
import type { Knex } from "knex";
import { identitySignMessage, verifyIdentitySignature, identityPubkeyHex } from "./custody.ts";
import { readDm, sendDmPreferred, type Relay, type StoredMessage } from "./msgs.ts";
import type { P2PChannel } from "./p2p.ts";

export const REQUEST_PREFIX = "bsvpay1:";
export const RECEIPT_PREFIX = "bsvrcpt1:";
const REQUEST_DOMAIN = "bsvos-payment-request-v1";
const RECEIPT_DOMAIN = "bsvos-payment-receipt-v1";
const MAX_CODE_CHARS = 4096;
const MAX_MEMO = 120;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_RE = /^[0-9a-fA-F]{66}$/;
const ID_RE = /^[0-9a-f]{32}$/;

export interface PaymentRequest {
  v: 1;
  id: string;
  identityKey: string;
  address: string;
  amount: number;
  memo: string;
  createdAt: number;
  expiresAt: number;
  sig: string;
}

export interface PaymentReceipt {
  v: 1;
  requestId: string;
  payer: string;
  txid: string;
  amount: number;
  at: number;
  sig: string;
}

export interface RequestRow {
  id: string;
  direction: "in" | "out";
  peer: string;
  address: string;
  amount: number;
  memo: string;
  code: string;
  status: "pending" | "paid" | "declined" | "expired";
  txid: string;
  createdAt: number;
  expiresAt: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function cleanMemo(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MEMO);
}

/** Compact durations: 30m, 12h, 7d (default 7d, 5m–90d). */
export function parseDuration(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TTL_MS;
  const m = /^(\d{1,4})([mhd])$/.exec(String(raw).trim().toLowerCase());
  if (!m) fail("BAD_PARAM", "expiry must look like 30m, 12h, or 7d");
  const n = Number(m[1]);
  const ms = n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
  if (ms < 5 * 60_000 || ms > 90 * 86_400_000) fail("BAD_PARAM", "expiry must be between 5m and 90d");
  return ms;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function requestCanonical(r: Omit<PaymentRequest, "sig">): string {
  return [REQUEST_DOMAIN, r.id, r.identityKey.toLowerCase(), r.address, String(r.amount), r.memo, String(r.createdAt), String(r.expiresAt)].join("|");
}

export function receiptCanonical(r: Omit<PaymentReceipt, "sig">): string {
  return [RECEIPT_DOMAIN, r.requestId, r.payer.toLowerCase(), r.txid, String(r.amount), String(r.at)].join("|");
}

export function encodeCode(prefix: string, payload: unknown, sig: string): string {
  return `${prefix}${base64url(Buffer.from(JSON.stringify({ ...(payload as object), sig }), "utf8"))}`;
}

function decodeCode(raw: string, expected: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.length > MAX_CODE_CHARS) fail("BAD_CODE", "code too long");
  if (!text.startsWith(expected)) {
    fail("BAD_CODE", expected === REQUEST_PREFIX ? "not a payment request code" : "not a payment receipt code");
  }
  try {
    const parsed = JSON.parse(fromBase64url(text.slice(expected.length)).toString("utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") fail("BAD_CODE", "code payload must be an object");
    return parsed;
  } catch (e) {
    if ((e as { code?: string }).code === "BAD_CODE") throw e;
    fail("BAD_CODE", "code payload is not valid JSON");
  }
}

export function buildRequest(input: {
  identityKey: string;
  address: string;
  amount: number;
  memo?: string;
  ttlMs?: number;
  now?: number;
  sign?: (message: string) => string;
}): PaymentRequest {
  const now = input.now ?? Date.now();
  const payload = {
    v: 1 as const,
    id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
    identityKey: input.identityKey.toLowerCase(),
    address: input.address,
    amount: Math.max(1, Math.floor(input.amount)),
    memo: cleanMemo(input.memo),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
  };
  const sign = input.sign ?? identitySignMessage;
  return { ...payload, sig: sign(requestCanonical(payload)) };
}

export function encodeRequest(request: PaymentRequest): string {
  const { sig, ...payload } = request;
  return encodeCode(REQUEST_PREFIX, payload, sig);
}

export function parseRequest(code: string): PaymentRequest {
  const o = decodeCode(code, REQUEST_PREFIX);
  if (o.v !== 1) fail("BAD_CODE", "unsupported request version");
  const r: PaymentRequest = {
    v: 1,
    id: String(o.id ?? ""),
    identityKey: String(o.identityKey ?? "").toLowerCase(),
    address: String(o.address ?? ""),
    amount: Math.floor(Number(o.amount) || 0),
    memo: cleanMemo(o.memo),
    createdAt: Math.floor(Number(o.createdAt) || 0),
    expiresAt: Math.floor(Number(o.expiresAt) || 0),
    sig: String(o.sig ?? ""),
  };
  if (!ID_RE.test(r.id)) fail("BAD_CODE", "request id malformed");
  if (!KEY_RE.test(r.identityKey)) fail("BAD_CODE", "requester identity key malformed");
  if (!(r.amount > 0)) fail("BAD_CODE", "amount must be positive");
  if (!(r.createdAt > 0) || !(r.expiresAt > r.createdAt)) fail("BAD_CODE", "request timestamps malformed");
  if (!r.sig) fail("BAD_CODE", "request signature missing");
  if (!verifyIdentitySignature(r.identityKey, requestCanonical(r), r.sig)) {
    fail("BAD_SIG", "request signature does not match the requester's key");
  }
  return r;
}

export function buildReceipt(input: {
  requestId: string;
  payer: string;
  txid: string;
  amount: number;
  at?: number;
  sign?: (message: string) => string;
}): PaymentReceipt {
  const payload = {
    v: 1 as const,
    requestId: input.requestId,
    payer: input.payer.toLowerCase(),
    txid: input.txid,
    amount: Math.max(1, Math.floor(input.amount)),
    at: input.at ?? Date.now(),
  };
  const sign = input.sign ?? identitySignMessage;
  return { ...payload, sig: sign(receiptCanonical(payload)) };
}

export function encodeReceipt(receipt: PaymentReceipt): string {
  const { sig, ...payload } = receipt;
  return encodeCode(RECEIPT_PREFIX, payload, sig);
}

export function parseReceipt(code: string): PaymentReceipt {
  const o = decodeCode(code, RECEIPT_PREFIX);
  if (o.v !== 1) fail("BAD_CODE", "unsupported receipt version");
  const r: PaymentReceipt = {
    v: 1,
    requestId: String(o.requestId ?? ""),
    payer: String(o.payer ?? "").toLowerCase(),
    txid: String(o.txid ?? ""),
    amount: Math.floor(Number(o.amount) || 0),
    at: Math.floor(Number(o.at) || 0),
    sig: String(o.sig ?? ""),
  };
  if (!ID_RE.test(r.requestId)) fail("BAD_CODE", "receipt request id malformed");
  if (!KEY_RE.test(r.payer)) fail("BAD_CODE", "payer identity key malformed");
  if (!/^[0-9a-fA-F]{64}$/.test(r.txid)) fail("BAD_CODE", "receipt txid malformed");
  if (!(r.amount > 0) || !(r.at > 0)) fail("BAD_CODE", "receipt amount/time malformed");
  if (!r.sig) fail("BAD_CODE", "receipt signature missing");
  if (!verifyIdentitySignature(r.payer, receiptCanonical(r), r.sig)) {
    fail("BAD_SIG", "receipt signature does not match the payer's key");
  }
  return r;
}

/** Extract the first payment code in a message body, if any. */
export function findCode(text: string): string | null {
  const t = text.trim();
  const start = t.indexOf(REQUEST_PREFIX) >= 0 ? t.indexOf(REQUEST_PREFIX) : t.indexOf(RECEIPT_PREFIX);
  if (start < 0) return null;
  const rest = t.slice(start).split(/\s+/)[0];
  return rest || null;
}

// ── storage ────────────────────────────────────────────────────────────────

export function migrateRequests(db: Knex): Promise<void> {
  return (async () => {
    if (!(await db.schema.hasTable("payment_requests"))) {
      await db.schema.createTable("payment_requests", (t) => {
        t.string("id", 32).primary();
        t.string("direction", 3).notNullable();
        t.string("peer", 66).notNullable().defaultTo("");
        t.string("address", 40).notNullable().defaultTo("");
        t.integer("amount").notNullable();
        t.string("memo", 120).notNullable().defaultTo("");
        t.text("code").notNullable();
        t.string("status", 10).notNullable().defaultTo("pending");
        t.string("txid", 64).notNullable().defaultTo("");
        t.integer("created_at").notNullable();
        t.integer("expires_at").notNullable();
      });
    }
  })();
}

function rowToRequest(r: {
  id: string; direction: string; peer: string; address: string; amount: number; memo: string;
  code: string; status: string; txid: string; created_at: number; expires_at: number;
}): RequestRow {
  return {
    id: r.id,
    direction: r.direction === "out" ? "out" : "in",
    peer: r.peer,
    address: r.address,
    amount: r.amount,
    memo: r.memo,
    code: r.code,
    status: (["pending", "paid", "declined", "expired"] as const).includes(r.status as never)
      ? (r.status as RequestRow["status"])
      : "pending",
    txid: r.txid,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Requests past expiry flip to expired lazily; a lapsed ask is not payable. */
export async function expireOld(db: Knex, now = Date.now()): Promise<number> {
  return db("payment_requests").where({ status: "pending" }).where("expires_at", "<", now).update({ status: "expired" });
}

export async function getRequest(db: Knex, id: string): Promise<RequestRow | null> {
  const row = (await db("payment_requests").where({ id }).first()) as {
    id: string; direction: string; peer: string; address: string; amount: number; memo: string;
    code: string; status: string; txid: string; created_at: number; expires_at: number;
  } | undefined;
  return row ? rowToRequest(row) : null;
}

export async function listRequests(db: Knex, direction?: "in" | "out", limit = 50): Promise<RequestRow[]> {
  let q = db("payment_requests").select();
  if (direction) q = q.where({ direction });
  const rows = (await q.orderBy("created_at", "desc").limit(limit)) as Array<{
    id: string; direction: string; peer: string; address: string; amount: number; memo: string;
    code: string; status: string; txid: string; created_at: number; expires_at: number;
  }>;
  return rows.map(rowToRequest);
}

async function insertRow(db: Knex, row: {
  id: string; direction: "in" | "out"; peer: string; address: string; amount: number; memo: string;
  code: string; status: RequestRow["status"]; txid: string; createdAt: number; expiresAt: number;
}): Promise<void> {
  await db("payment_requests").insert({
    id: row.id,
    direction: row.direction,
    peer: row.peer.toLowerCase(),
    address: row.address,
    amount: row.amount,
    memo: row.memo,
    code: row.code,
    status: row.status,
    txid: row.txid,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  });
}

/** Build and store an outgoing request with a concrete signing/address hook (tests). */
export async function recordOutgoing(
  db: Knex,
  request: PaymentRequest,
  peer: string,
): Promise<RequestRow> {
  const code = encodeRequest(request);
  await insertRow(db, {
    id: request.id,
    direction: "out",
    peer,
    address: request.address,
    amount: request.amount,
    memo: request.memo,
    code,
    status: "pending",
    txid: "",
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });
  return (await getRequest(db, request.id)) as RequestRow;
}

/** Store a verified incoming request (deduped by id). */
export async function saveIncoming(db: Knex, request: PaymentRequest, code?: string): Promise<{ fresh: boolean; row: RequestRow }> {
  const existing = await getRequest(db, request.id);
  if (existing) return { fresh: false, row: existing };
  await insertRow(db, {
    id: request.id,
    direction: "in",
    peer: request.identityKey,
    address: request.address,
    amount: request.amount,
    memo: request.memo,
    code: code ?? encodeRequest(request),
    status: "pending",
    txid: "",
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });
  return { fresh: true, row: (await getRequest(db, request.id)) as RequestRow };
}

export async function markPaid(db: Knex, id: string, txid: string): Promise<RequestRow | null> {
  await db("payment_requests").where({ id }).where({ status: "pending" }).update({ status: "paid", txid });
  return getRequest(db, id);
}

export async function markDeclined(db: Knex, id: string): Promise<RequestRow | null> {
  await db("payment_requests").where({ id }).where({ status: "pending" }).update({ status: "declined" });
  return getRequest(db, id);
}

/** Why a pending incoming request can or cannot be paid right now. */
export function payableError(row: RequestRow, now = Date.now()): string | null {
  if (row.direction !== "in") return "not an incoming request";
  if (row.status !== "pending") return `request is ${row.status}`;
  if (row.expiresAt <= now) return "request has expired";
  if (!(row.amount > 0)) return "request amount is not positive";
  return null;
}

// ── sync (incoming requests + receipts) ────────────────────────────────────

export interface SyncResult {
  scanned: number;
  imported: number;
  paid: number;
  /** Signed receipts that matched but are not chain-verified yet. */
  claimed: number;
}

export interface TxLookup {
  tx(txid: string): Promise<{ vout: Array<{ value?: number; addresses?: string[] }> } | null>;
}

/**
 * Chain check for incoming payments: the receipt's txid must resolve and
 * contain an output to our receive address worth at least the claimed
 * amount. `chain.tx` reports values in BSV (WoC's /tx/hash shape), so the
 * comparison converts to sats. A fake or underpriced receipt never settles.
 */
export function incomingPaymentVerifier(chain: TxLookup, address: string) {
  return async (txid: string, amountSats: number): Promise<boolean> => {
    if (!/^[0-9a-fA-F]{64}$/.test(txid) || !(amountSats > 0) || !address) return false;
    const tx = await chain.tx(txid);
    if (!tx) return false;
    return tx.vout.some((o) => {
      if (!(o.addresses ?? []).includes(address)) return false;
      const sats = Math.round((o.value ?? 0) * 1e8);
      return sats >= amountSats;
    });
  };
}

/**
 * Decrypt inbound messages client-side (nothing plaintext is persisted) and
 * fold in any payment codes: requests become payable rows, receipts mark our
 * outgoing requests paid — but only after `verifyPayment` confirms the txid
 * really paid this wallet. Safe to run often; both sides dedupe by id.
 */
export async function scanInbound(
  db: Knex,
  opts: { limit?: number; verifyPayment?: (txid: string, amountSats: number) => Promise<boolean> } = {},
): Promise<SyncResult> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const rows = (await db("messages").where({ direction: "in" }).orderBy("created_at", "desc").limit(limit)) as StoredMessage[];
  const result: SyncResult = { scanned: 0, imported: 0, paid: 0, claimed: 0 };
  for (const row of rows) {
    result.scanned++;
    let text = "";
    try {
      text = (await readDm(db, row.id)).text; // throws when locked
    } catch {
      break; // locked: stop the scan, the caller can retry after unlock
    }
    const code = findCode(text);
    if (!code) continue;
    try {
      if (code.startsWith(REQUEST_PREFIX)) {
        const request = parseRequest(code);
        const saved = await saveIncoming(db, request, code);
        if (saved.fresh) result.imported++;
      } else {
        const receipt = parseReceipt(code);
        const existing = await getRequest(db, receipt.requestId);
        if (!existing || existing.direction !== "out" || existing.status !== "pending" || existing.amount !== receipt.amount) {
          continue;
        }
        let verified = false;
        try {
          verified = opts.verifyPayment ? await opts.verifyPayment(receipt.txid, receipt.amount) : false;
        } catch {
          verified = false; // chain unavailable: leave it pending, retry next scan
        }
        if (!verified) {
          result.claimed++;
          continue;
        }
        const updated = await markPaid(db, receipt.requestId, receipt.txid);
        if (updated?.status === "paid") result.paid++;
      }
    } catch {
      /* malformed or forged payloads are not requests */
    }
  }
  return result;
}

/** Send the request code to the payer over the normal message path. */
export async function sendRequestCode(
  db: Knex,
  relay: Relay,
  p2p: P2PChannel | null,
  to: string,
  code: string,
  memo: string,
): Promise<{ sent: boolean }> {
  try {
    const text = `${code}${memo ? `\n${memo}` : ""}`;
    await sendDmPreferred(db, relay, p2p, identityPubkeyHex(), to, text);
    return { sent: true };
  } catch {
    return { sent: false };
  }
}

/** Send a signed receipt back to the requester (best effort). */
export async function sendReceipt(
  db: Knex,
  relay: Relay,
  p2p: P2PChannel | null,
  request: RequestRow,
  txid: string,
  amount: number,
): Promise<{ sent: boolean }> {
  try {
    const receipt = buildReceipt({
      requestId: request.id,
      payer: identityPubkeyHex(),
      txid,
      amount,
    });
    await sendDmPreferred(db, relay, p2p, identityPubkeyHex(), request.peer, encodeReceipt(receipt));
    return { sent: true };
  } catch {
    return { sent: false };
  }
}
