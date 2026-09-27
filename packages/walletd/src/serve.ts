/**
 * x402 server mode: this daemon charges for its own answers.
 *
 * The flip of the x402 client rail. A buyer POSTs params for a priced
 * method; without proof they get a 402 + payment-required quote. With a
 * PAYMENT-SIGNATURE carrying a signed tx that pays us >= price, we verify
 * (parse → output check → broadcast ourselves so the money is real, or
 * accept if the chain already knows it), record the one-txid-one-call
 * claim, and serve. Replay a txid and it is refused — the claim table is
 * the turnstile.
 *
 * Economics, stated: prices must clear our costs (Jev ~$0.00002/call plus
 * chain fees on our side: none — serving is read/compute only). Zero-conf
 * acceptance is the documented risk: we broadcast what you give us, and a
 * double-spend burns your future access, not our past answers. Priced
 * methods are owner-safe reads/compute — never spends, never keys.
 */
import type { Knex } from "knex";
import { Transaction } from "@bsv/sdk";
import type { ChainProvider } from "./chain.ts";
import { selfAddress } from "./custody.ts";
import { decide as jevDecideCall, type JevQuestion } from "./jev.ts";
import { recallMemories } from "./memory.ts";
import { p2pkhScript } from "./tx.ts";
import { track } from "./monitor.ts";

export const SERVE_NETWORK = "bsv:mainnet";

export interface ServeMethod {
  method: string;
  description: string;
  defaultPrice: number;
}

export const SERVE_MENU: ServeMethod[] = [
  {
    method: "jevDecide",
    description: "Calibrated Jev decision (noul/choice/score) on your state. Same engine as the local jev_decide tool.",
    defaultPrice: 50,
  },
  {
    method: "memoryRecall",
    description: "Keyword + tag recall over this wallet's shared memory board, optionally merged with bsvos.memory.",
    defaultPrice: 20,
  },
];

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export async function migrateServe(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("x402_server_prices"))) {
    await db.schema.createTable("x402_server_prices", (t) => {
      t.string("method", 64).primary();
      t.integer("price").notNullable();
    });
    for (const m of SERVE_MENU) {
      await db("x402_server_prices").insert({ method: m.method, price: m.defaultPrice });
    }
  }
  if (!(await db.schema.hasTable("x402_server_claims"))) {
    await db.schema.createTable("x402_server_claims", (t) => {
      t.string("txid", 64).primary();
      t.string("method", 64).notNullable();
      t.integer("amount").notNullable();
      t.integer("created_at").notNullable();
    });
  }
}

export async function serveMenu(db: Knex): Promise<Array<{ method: string; description: string; priceSats: number; payTo: string }>> {
  const rows = (await db("x402_server_prices").select()) as Array<{ method: string; price: number }>;
  const prices = new Map(rows.map((r) => [r.method, r.price]));
  const payTo = selfAddress();
  return SERVE_MENU.map((m) => ({
    method: m.method,
    description: m.description,
    priceSats: prices.get(m.method) ?? m.defaultPrice,
    payTo,
  }));
}

export async function servePrice(db: Knex, method: string): Promise<{ method: string; priceSats: number; payTo: string }> {
  const def = SERVE_MENU.find((m) => m.method === method);
  if (!def) fail("NOT_FOUND", `not for sale: ${method}`);
  const row = (await db("x402_server_prices").where({ method }).first()) as { price: number } | undefined;
  return { method, priceSats: row?.price ?? def.defaultPrice, payTo: selfAddress() };
}

export async function serveSetPrice(db: Knex, method: string, priceSats: number): Promise<{ method: string; priceSats: number }> {
  const def = SERVE_MENU.find((m) => m.method === method);
  if (!def) fail("NOT_FOUND", `not sellable: ${method}`);
  const price = Math.floor(Number(priceSats) || 0);
  if (!(price >= 0)) fail("BAD_PARAM", "price must be non-negative sats (0 unlists)");
  await db("x402_server_prices").where({ method }).update({ price });
  return { method, priceSats: price };
}

export async function serveSales(db: Knex, limit = 50): Promise<Array<{ txid: string; method: string; amount: number; createdAt: number }>> {
  const rows = (await db("x402_server_claims").select().orderBy("created_at", "desc").limit(Math.min(Math.max(limit, 1), 200))) as Array<{
    txid: string; method: string; amount: number; created_at: number;
  }>;
  return rows.map((r) => ({ txid: r.txid, method: r.method, amount: r.amount, createdAt: r.created_at }));
}

/** Standard x402 v2 requirement envelope (what 402 responses carry). */
export function serveRequirement(method: string, priceSats: number, payTo: string, resourceUrl: string): Record<string, unknown> {
  return {
    x402Version: 2, scheme: "exact", network: SERVE_NETWORK,
    amount: String(priceSats), payTo, asset: "native:BSV",
    resource: { url: resourceUrl, description: `x402 serve ${method}`, mimeType: "application/json" },
    extra: { satoshis: String(priceSats) },
  };
}

export function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function parseProof(raw: unknown): string {
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(Buffer.from(obj.trim(), "base64").toString("utf8")) as unknown;
    } catch {
      fail("BAD_PROOF", "PAYMENT-SIGNATURE is not valid base64 JSON");
    }
  }
  const txHex = (obj as { txHex?: unknown })?.txHex;
  if (typeof txHex !== "string" || !/^[0-9a-fA-F]+$/.test(txHex)) fail("BAD_PROOF", "proof carries no txHex");
  return txHex;
}

export interface ServeDeps {
  db: Knex;
  chain: ChainProvider;
  fetchFn?: typeof fetch;
  /** Jev transport override (tests). */
  jevFetch?: typeof fetch;
}

/**
 * Verify payment and serve. Throws BAD_METHOD (unknown/unlisted),
 * BAD_PROOF (unparseable/underpaid), REPLAY (txid already claimed), or
 * UNPAID (broadcast failed and chain does not know the tx).
 */
export async function serveCall(
  deps: ServeDeps,
  method: string,
  params: unknown,
  txHex: string,
): Promise<{ data: unknown; receipt: { txid: string; method: string; amountSats: number } }> {
  const { db, chain } = deps;
  const { priceSats, payTo } = await servePrice(db, method);
  if (!(priceSats > 0)) fail("BAD_METHOD", `${method} is not priced for sale`);
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(txHex);
  } catch {
    fail("BAD_PROOF", "proof tx does not parse");
  }
  const payScript = p2pkhScript(payTo).toHex();
  const paid = tx!.outputs.some((o) => (o.lockingScript?.toHex() ?? "") === payScript && (o.satoshis ?? 0) >= priceSats);
  if (!paid) fail("BAD_PROOF", `no output paying ${payTo} >= ${priceSats} sats`);
  const txid = tx!.id("hex");
  const claimed = await db("x402_server_claims").where({ txid }).first();
  if (claimed) fail("REPLAY", "that payment already bought one call");
  // Capture the money ourselves; accept if the chain already knows it
  // (buyer broadcast first) rather than failing a legit payment.
  try {
    await chain.broadcast(txHex);
  } catch {
    const st = await chain.status(txid).catch(() => null);
    if (st?.status !== "SEEN" && st?.status !== "MINED") {
      fail("UNPAID", "payment did not broadcast and the chain does not know it");
    }
  }
  await db("x402_server_claims").insert({ txid, method, amount: priceSats, created_at: Date.now() });
  await track(db, txid, `x402 sale ${method} ${priceSats} sats`, null).catch(() => null);
  const data = await serveDispatch(deps, method, params);
  return { data, receipt: { txid, method, amountSats: priceSats } };
}

async function serveDispatch(deps: ServeDeps, method: string, params: unknown): Promise<unknown> {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  switch (method) {
    case "jevDecide": {
      if (p.state === undefined || p.state === null) fail("BAD_PARAM", "state required");
      if (p.questions === null || typeof p.questions !== "object") fail("BAD_PARAM", "questions map required");
      if (!jevEnabledLocal()) fail("JEV_UNAVAILABLE", "seller has no decision endpoint configured");
      return jevDecideCall(p.state, p.questions as Record<string, JevQuestion>, {
        model: typeof p.model === "string" && p.model ? p.model : undefined,
        ...(deps.jevFetch ? { fetchFn: deps.jevFetch } : {}),
      });
    }
    case "memoryRecall": {
      return recallMemories(deps.db, deps.fetchFn ?? fetch, {
        ...(typeof p.query === "string" ? { query: p.query } : {}),
        ...(typeof p.tag === "string" ? { tag: p.tag } : {}),
        ...(Number.isFinite(Number(p.limit)) ? { limit: Number(p.limit) } : {}),
        ...(p.includePublic === true ? { includePublic: true as const } : {}),
      });
    }
    default:
      fail("BAD_METHOD", `cannot serve: ${method}`);
  }
}

function jevEnabledLocal(): boolean {
  return (process.env.OPENROUTER_API_KEY ?? "").trim().length > 0;
}
