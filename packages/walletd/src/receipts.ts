/**
 * Purchase receipts as 1Sat Ordinals.
 *
 * A receipt records a payment: who paid whom, how many sats, for what, with
 * the payment's txid — as a small JSON payload inscribed on a 1-sat ordinal
 * and delivered straight to the counterparty's address in the same
 * transaction (the inscription IS the send). The payload is BSM-signed by
 * the payer's identity key, so a holder can prove who issued it without
 * trusting any server; the chain proves when it was inscribed.
 *
 * This module owns the payload codec and the local ledger of issued
 * receipts. Inscription (fees, policy, broadcast) is injected by the
 * daemon so tests can exercise the orchestration without a chain.
 */
import type { Knex } from "knex";
import { identityPubkeyHex, identitySignMessage, verifyIdentitySignature } from "./custody.ts";
import { p2pkhScript } from "./tx.ts";

export const RECEIPT_TYPE = "bsvos-receipt";
const RECEIPT_DOMAIN = "bsvos-receipt-v1";
const MAX_MEMO = 120;
const MAX_PAYLOAD_BYTES = 2000;
const KEY_RE = /^[0-9a-fA-F]{66}$/;
const TXID_RE = /^[0-9a-fA-F]{64}$/;

export interface ReceiptPayload {
  v: 1;
  t: typeof RECEIPT_TYPE;
  txid: string;
  amount: number;
  memo: string;
  from: string;
  to: string;
  at: number;
  requestId: string;
  sig: string;
}

export interface ReceiptRow {
  id: string;
  paymentTxid: string;
  requestId: string;
  peer: string;
  peerAddress: string;
  amount: number;
  memo: string;
  dataHex: string;
  status: "inscribed" | "notified";
  createdAt: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function cleanText(raw: unknown, max = MAX_MEMO): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function receiptCanonical(r: Omit<ReceiptPayload, "sig" | "v" | "t">): string {
  return [RECEIPT_DOMAIN, r.txid, String(r.amount), r.from.toLowerCase(), r.to, r.memo, String(r.at), r.requestId].join("|");
}

export function buildReceipt(input: {
  txid: string;
  amount: number;
  from: string;
  to: string;
  memo?: string;
  requestId?: string;
  at?: number;
  sign?: (message: string) => string;
}): ReceiptPayload {
  if (!TXID_RE.test(input.txid)) fail("BAD_PARAM", "payment txid must be 64 hex");
  if (!(input.amount > 0)) fail("BAD_PARAM", "amount must be positive sats");
  if (!KEY_RE.test(input.from)) fail("BAD_PARAM", "payer identity key required");
  const to = String(input.to ?? "").trim();
  if (!to) fail("BAD_PARAM", "recipient (identity key or address) required");
  const payload: Omit<ReceiptPayload, "sig"> = {
    v: 1,
    t: RECEIPT_TYPE,
    txid: input.txid.toLowerCase(),
    amount: Math.floor(input.amount),
    memo: cleanText(input.memo),
    from: input.from.toLowerCase(),
    to,
    at: input.at ?? Date.now(),
    requestId: cleanText(input.requestId, 32),
  };
  const sign = input.sign ?? identitySignMessage;
  const receipt: ReceiptPayload = { ...payload, sig: sign(receiptCanonical(payload)) };
  const bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) fail("BAD_PARAM", `receipt payload too large (${bytes} > ${MAX_PAYLOAD_BYTES} bytes)`);
  return receipt;
}

export function verifyReceipt(receipt: ReceiptPayload): boolean {
  if (receipt?.v !== 1 || receipt.t !== RECEIPT_TYPE) return false;
  if (!TXID_RE.test(receipt.txid) || !(receipt.amount > 0) || !KEY_RE.test(receipt.from)) return false;
  const { sig, v: _v, t: _t, ...rest } = receipt;
  return verifyIdentitySignature(receipt.from, receiptCanonical(rest), sig);
}

export function receiptDataHex(receipt: ReceiptPayload): string {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("hex");
}

export function parseReceiptPayload(dataHex: string): ReceiptPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(dataHex, "hex").toString("utf8")) as ReceiptPayload;
    return verifyReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── local ledger ───────────────────────────────────────────────────────────

export function migrateReceipts(db: Knex): Promise<void> {
  return (async () => {
    if (!(await db.schema.hasTable("receipts"))) {
      await db.schema.createTable("receipts", (t) => {
        t.string("id", 64).primary(); // inscription txid
        t.string("payment_txid", 64).notNullable();
        t.string("request_id", 32).notNullable().defaultTo("");
        t.string("peer", 66).notNullable().defaultTo("");
        t.string("peer_address", 40).notNullable();
        t.integer("amount").notNullable();
        t.string("memo", 120).notNullable().defaultTo("");
        t.text("data_hex").notNullable();
        t.string("status", 10).notNullable().defaultTo("inscribed");
        t.integer("created_at").notNullable();
      });
    }
  })();
}

function rowToReceipt(r: {
  id: string; payment_txid: string; request_id: string; peer: string; peer_address: string;
  amount: number; memo: string; data_hex: string; status: string; created_at: number;
}): ReceiptRow {
  return {
    id: r.id,
    paymentTxid: r.payment_txid,
    requestId: r.request_id,
    peer: r.peer,
    peerAddress: r.peer_address,
    amount: r.amount,
    memo: r.memo,
    dataHex: r.data_hex,
    status: r.status === "notified" ? "notified" : "inscribed",
    createdAt: r.created_at,
  };
}

export async function listReceipts(db: Knex, limit = 50): Promise<ReceiptRow[]> {
  const rows = (await db("receipts").select().orderBy("created_at", "desc").limit(limit)) as Array<{
    id: string; payment_txid: string; request_id: string; peer: string; peer_address: string;
    amount: number; memo: string; data_hex: string; status: string; created_at: number;
  }>;
  return rows.map(rowToReceipt);
}

export async function getReceipt(db: Knex, id: string): Promise<ReceiptRow | null> {
  const row = (await db("receipts").where({ id }).first()) as {
    id: string; payment_txid: string; request_id: string; peer: string; peer_address: string;
    amount: number; memo: string; data_hex: string; status: string; created_at: number;
  } | undefined;
  return row ? rowToReceipt(row) : null;
}

export interface ReceiptDeps {
  db: Knex;
  /** Inscribe the payload and deliver the 1-sat ordinal to `to` in one tx. */
  inscribe: (opts: { dataHex: string; contentType: string; to: string; label: string }) => Promise<{ txid: string; fee: number }>;
  /** Best-effort DM so the counterparty knows what just arrived. */
  notify?: (peer: string, text: string) => Promise<{ sent: boolean }>;
  selfKey?: () => string;
  sign?: (message: string) => string;
  now?: () => number;
}

export interface IssueResult {
  id: string;
  paymentTxid: string;
  outpoint: string;
  to: string;
  amount: number;
  fee: number;
  notified: boolean;
}

/**
 * Inscribe a signed receipt and deliver it to the counterparty. The carrier
 * is a 1-sat ordinal at vout 0 of the inscription transaction.
 */
export async function issueReceipt(
  deps: ReceiptDeps,
  input: { txid: string; amount: number; memo?: string; peer?: string; peerAddress: string; requestId?: string },
): Promise<IssueResult> {
  const peerAddress = String(input.peerAddress ?? "").trim();
  try {
    p2pkhScript(peerAddress);
  } catch {
    fail("BAD_PARAM", "receipt recipient must be a valid P2PKH address");
  }
  const from = (deps.selfKey ?? identityPubkeyHex)();
  const peer = KEY_RE.test(input.peer ?? "") ? (input.peer as string).toLowerCase() : "";
  const receipt = buildReceipt({
    txid: input.txid,
    amount: input.amount,
    from,
    to: peer || peerAddress,
    memo: input.memo,
    requestId: input.requestId,
    ...(deps.sign ? { sign: deps.sign } : {}),
    ...(deps.now ? { at: deps.now() } : {}),
  });
  const dataHex = receiptDataHex(receipt);
  const inscribed = await deps.inscribe({
    dataHex,
    contentType: "application/json",
    to: peerAddress,
    label: `receipt ${receipt.txid.slice(0, 12)}`,
  });
  await deps.db("receipts").insert({
    id: inscribed.txid,
    payment_txid: receipt.txid,
    request_id: receipt.requestId,
    peer,
    peer_address: peerAddress,
    amount: receipt.amount,
    memo: receipt.memo,
    data_hex: dataHex,
    status: "inscribed",
    created_at: Date.now(),
  });
  let notified = false;
  if (peer && deps.notify) {
    const text = `Receipt inscribed: ${receipt.amount} sats${receipt.memo ? ` for "${receipt.memo}"` : ""} (payment ${receipt.txid.slice(0, 16)}…) — 1Sat ordinal delivered to ${peerAddress}.`;
    try {
      ({ sent: notified } = await deps.notify(peer, text));
    } catch {
      notified = false;
    }
    if (notified) await deps.db("receipts").where({ id: inscribed.txid }).update({ status: "notified" });
  }
  return {
    id: inscribed.txid,
    paymentTxid: receipt.txid,
    outpoint: `${inscribed.txid}:0`,
    to: peerAddress,
    amount: receipt.amount,
    fee: inscribed.fee,
    notified,
  };
}
