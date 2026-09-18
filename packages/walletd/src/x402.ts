/**
 * F14 x402 pay-per-call + spend attestations.
 *
 * Client flow (standard envelope, BSV settlement): GET/POST the resource,
 * read the 402 + PAYMENT-REQUIRED header, pay `amount` sats to `payTo`
 * through the policy engine, retry with PAYMENT-SIGNATURE carrying the
 * broadcast txid, store the PAYMENT-RESPONSE settlement as a receipt.
 * Free (non-402) resources return their data with paid:false — `x402 pay`
 * is also a plain receipt-less fetch.
 *
 * Attestations: BRC-42-signed activity statements (counts + txid pointers
 * a verifier resolves itself — the daemon stores no per-tx amounts) for
 * discount/trust tiers. Verification always needs a private side (a key
 * holder), so `verify` is custody-gated like everything else.
 */
import type { Knex } from "knex";
import { brc42SignData, brc42Verify } from "./custody.ts";
import { sendSats } from "./engine.ts";
import type { ChainProvider } from "./chain.ts";
import type { JevDecide } from "./jev.ts";
import type { WalletProtocol } from "@bsv/sdk";
import { createHash } from "node:crypto";

export const ATTEST_PROTOCOL: WalletProtocol = [2, "bsv os attestations"];

export interface X402Requirement {
  scheme: string;
  network: string;
  amount: number;
  payTo: string;
  asset: string;
  resourceUrl: string;
  description: string;
  raw: unknown;
}

export interface X402Receipt {
  url: string;
  amountSats: number;
  payTo: string;
  txid: string;
  settled: unknown;
  createdAt: number;
}

export interface SpendStatement {
  version: 1;
  identityKey: string;
  days: number;
  since: number;
  txCount: number;
  txs: Array<{ txid: string; status: string; label: string; at: number }>;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function b64jsonParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Parse a 402 into a BSV requirement (header first, body fallback). */
export function parseRequirement(
  headers: Record<string, string>,
  bodyJson: unknown,
  url: string,
): X402Requirement {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  const headerReq = b64jsonParse(lowered["payment-required"] ?? null);
  const h = (headerReq ?? {}) as Record<string, unknown>;
  const b = (bodyJson ?? {}) as Record<string, unknown>;
  const network = String(h.network ?? b.network ?? "");
  if (!/bsv/i.test(network)) {
    fail("UNSUPPORTED_NETWORK", `no BSV requirement offered (got ${network || "none"})`);
  }
  const amount = Math.floor(Number(h.amount ?? (b as { priceSats?: unknown }).priceSats) || 0);
  const payTo = String(h.payTo ?? b.payTo ?? "");
  if (!(amount > 0)) fail("BAD_QUOTE", "quote amount must be positive sats");
  if (!payTo) fail("BAD_QUOTE", "quote payTo missing");
  const resource = (h.resource ?? {}) as Record<string, unknown>;
  return {
    scheme: String(h.scheme ?? "exact"),
    network,
    amount,
    payTo,
    asset: String(h.asset ?? "native:BSV"),
    resourceUrl: String(resource.url ?? url),
    description: String(resource.description ?? ""),
    raw: headerReq ?? bodyJson ?? null,
  };
}

export async function migrateX402(db: Knex): Promise<void> {
  if (await db.schema.hasTable("x402_receipts")) return;
  await db.schema.createTable("x402_receipts", (t) => {
    t.increments("id");
    t.text("url").notNullable();
    t.integer("amount_sats").notNullable();
    t.string("pay_to", 64).notNullable().defaultTo("");
    t.string("txid", 64).notNullable().defaultTo("");
    t.text("settled").nullable();
    t.integer("created_at").notNullable();
  });
}

export async function listReceipts(db: Knex): Promise<X402Receipt[]> {
  const rows = (await db("x402_receipts").select().orderBy("created_at", "desc").limit(100)) as Array<{
    url: string; amount_sats: number; pay_to: string; txid: string; settled: string | null; created_at: number;
  }>;
  return rows.map((r) => ({
    url: r.url, amountSats: r.amount_sats, payTo: r.pay_to, txid: r.txid,
    settled: r.settled ? JSON.parse(r.settled) as unknown : null, createdAt: r.created_at,
  }));
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface PayResult {
  paid: boolean;
  receipt: X402Receipt | null;
  status: number;
  data: unknown;
}

/**
 * One-shot metered fetch: quote → policy-gated pay → retry with proof →
 * receipt. Non-402 responses return {paid:false} with the data.
 *
 * Quote screening: the requirement (host, amount, description, resource)
 * travels into the policy decision state, so a Jev-scored origin judges
 * the actual quote — not just "an x402 payment happened".
 */
export async function x402Pay(opts: {
  db: Knex;
  chain: ChainProvider;
  url: string;
  method?: string;
  body?: unknown;
  origin: string;
  fetchFn?: FetchFn;
  jev?: JevDecide;
}): Promise<PayResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const method = (opts.method ?? "GET").toUpperCase();
  const first = await fetchFn(opts.url, {
    method,
    headers: { accept: "application/json" },
  });
  if (first.status !== 402) {
    return { paid: false, receipt: null, status: first.status, data: await first.json().catch(() => null) };
  }
  const rawHeaders: Record<string, string> = {};
  first.headers.forEach((v, k) => {
    rawHeaders[k] = v;
  });
  const quoteBody = await first.json().catch(() => null);
  const req = parseRequirement(rawHeaders, quoteBody, opts.url);
  const host = (() => {
    try {
      return new URL(opts.url).hostname;
    } catch {
      return opts.url;
    }
  })();
  const { txid, hex: txHex } = await sendSats({
    db: opts.db, chain: opts.chain, origin: opts.origin,
    to: req.payTo, sats: req.amount, label: `x402 ${host} ${req.amount} sats`,
    context: {
      kind: "x402",
      host,
      resourceUrl: req.resourceUrl,
      description: req.description,
      to: req.payTo,
    },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  // Exact gateway envelope (auxon/x402-gateway src/x402.ts): the gateway
  // verifies the raw tx itself and broadcasts via ARC. One txid pays for
  // exactly one call (server-side replay claim).
  const proof = b64json({
    x402Version: 2, scheme: req.scheme, network: req.network,
    txHex, encoding: "raw-hex",
  });
  const init: RequestInit = {
    method,
    headers: { accept: "application/json", "PAYMENT-SIGNATURE": proof },
  };
  if (opts.body !== undefined && method !== "GET") {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const second = await fetchFn(opts.url, init);
  const settledRaw = second.headers.get("payment-response");
  const settled = b64jsonParse(settledRaw) ?? null;
  const data = await second.json().catch(() => null);
  if (second.status === 402) {
    fail("STILL_402", "gateway rejected the payment proof — retry once, then report the txid");
  }
  const receipt: X402Receipt = {
    url: opts.url, amountSats: req.amount, payTo: req.payTo, txid,
    settled, createdAt: Date.now(),
  };
  await opts.db("x402_receipts").insert({
    url: receipt.url, amount_sats: receipt.amountSats, pay_to: receipt.payTo,
    txid: receipt.txid, settled: JSON.stringify(settled), created_at: receipt.createdAt,
  });
  return { paid: true, receipt, status: second.status, data };
}

function statementBytes(s: SpendStatement): number[] {
  return Array.from(Buffer.from(JSON.stringify(s), "utf8"));
}

function statementId(s: SpendStatement): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex");
}

/** Mint a BRC-42-signed activity statement (needs unlock). */
export async function attestSpend(
  db: Knex,
  identityKey: string,
  opts: { days?: number; verifier?: string } = {},
): Promise<{ statement: SpendStatement; keyId: string; signature: string }> {
  const days = Math.min(Math.max(Math.floor(Number(opts.days) || 30), 1), 365);
  const since = Date.now() - days * 86_400_000;
  const rows = (await db("pending_txs")
    .select("txid", "status", "label", "created_at")
    .where("created_at", ">=", since)
    .orderBy("created_at", "desc")
    .limit(100)) as Array<{ txid: string; status: string; label: string; created_at: number }>;
  const statement: SpendStatement = {
    version: 1, identityKey, days, since,
    txCount: rows.length,
    txs: rows.map((r) => ({ txid: r.txid, status: r.status, label: r.label, at: r.created_at })),
  };
  const keyId = statementId(statement).slice(0, 32);
  const verifier = opts.verifier ?? "self";
  const sig = brc42SignData(ATTEST_PROTOCOL, keyId, verifier, statementBytes(statement));
  return {
    statement, keyId,
    signature: Buffer.from(sig).toString("hex"),
  };
}

/** Verify a statement (needs unlock — a key holder's check). */
export function verifyAttestation(opts: {
  statement: SpendStatement; keyId: string; signature: string; verifier?: string;
}): { valid: boolean; statement: SpendStatement } {
  const s = opts.statement;
  if (!s || s.version !== 1 || typeof s.identityKey !== "string") fail("BAD_PARAM", "not a spend statement");
  if (!/^[0-9a-fA-F]+$/.test(opts.signature)) fail("BAD_PARAM", "signature must be hex");
  // The keyId binds the signature to this exact statement.
  if (opts.keyId !== statementId({ ...s }).slice(0, 32)) return { valid: false, statement: s };
  const ok = brc42Verify(
    ATTEST_PROTOCOL, opts.keyId, opts.verifier ?? "self", false,
    statementBytes(s), Array.from(Buffer.from(opts.signature, "hex")),
  );
  return { valid: ok, statement: s };
}
