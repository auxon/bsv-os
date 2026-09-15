/**
 * F4 money views: baskets (multi-balance ledger).
 *
 * BRC baskets are local accounting, not chain data: a basket is a named
 * pot, and live UTXOs are attributed to pots by label. Unlabeled live
 * UTXOs always fall in `default`, so balances stay exact even as labels
 * come and go — removing a basket just unlabeled its members.
 *
 * Attribution (F2 link): after every anchor broadcast the engine labels
 * P2PKH-to-self change outputs to the spending origin's basket when one
 * exists, else `default`. Humans refine with `basket assign`; future
 * rails (F12 earnings, F14 receipts) label their own outputs the same way.
 */
import type { Knex } from "knex";
import { Transaction } from "@bsv/sdk";
import type { ChainProvider } from "./chain.ts";
import { selfAddress } from "./custody.ts";

export const DEFAULT_BASKET = "default";

export interface BasketMember {
  txid: string;
  vout: number;
  value: number;
  height: number;
  basket: string;
}

export interface BasketView {
  name: string;
  description: string;
  balance: number;
  memberCount: number;
  members: BasketMember[];
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function validateBasketName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    fail("BAD_PARAM", "basket name must match [A-Za-z0-9._-]{1,64}");
  }
  return name as string;
}

function checkOutpoint(txid: unknown, vout: unknown): { txid: string; vout: number } {
  if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) fail("BAD_PARAM", "txid must be 64 hex chars");
  const v = Math.floor(Number(vout));
  if (!Number.isInteger(v) || v < 0) fail("BAD_PARAM", "vout must be a non-negative integer");
  return { txid: (txid as string).toLowerCase(), vout: v };
}

export async function migrateBaskets(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("baskets"))) {
    await db.schema.createTable("baskets", (t) => {
      t.string("name", 64).primary();
      t.string("description", 280).notNullable().defaultTo("");
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("basket_members"))) {
    await db.schema.createTable("basket_members", (t) => {
      t.string("txid", 64).notNullable();
      t.integer("vout").notNullable();
      t.string("basket", 64).notNullable();
      t.integer("value").notNullable().defaultTo(0);
      t.integer("labeled_at").notNullable();
      t.primary(["txid", "vout"]);
    });
  }
  await ensureDefault(db);
}

export async function ensureDefault(db: Knex): Promise<void> {
  const has = await db("baskets").where({ name: DEFAULT_BASKET }).first();
  if (!has) {
    await db("baskets").insert({ name: DEFAULT_BASKET, description: "Unlabeled spendable funds", created_at: Date.now() });
  }
}

export async function createBasket(db: Knex, name: string, description = ""): Promise<{ name: string; description: string }> {
  const clean = validateBasketName(name);
  await ensureDefault(db);
  const dupe = await db("baskets").where({ name: clean }).first();
  if (dupe) fail("EXISTS", `basket exists: ${clean}`);
  const desc = typeof description === "string" ? description.slice(0, 280) : "";
  await db("baskets").insert({ name: clean, description: desc, created_at: Date.now() });
  return { name: clean, description: desc };
}

export async function removeBasket(db: Knex, name: string): Promise<{ name: string; released: number }> {
  const clean = validateBasketName(name);
  if (clean === DEFAULT_BASKET) fail("BAD_PARAM", "the default basket cannot be removed");
  const gone = await db("baskets").where({ name: clean }).delete();
  if (!gone) fail("NOT_FOUND", `no basket: ${clean}`);
  // Members fall back to `default` via the join — release = unlabeled rows.
  const released = await db("basket_members").where({ basket: clean }).delete();
  return { name: clean, released };
}

/** Label one live-or-future outpoint (value snapshot 0 = unknown). */
export async function assignUtxo(db: Knex, txid: string, vout: number, basket: string): Promise<BasketMember> {
  const clean = validateBasketName(basket);
  const { txid: tx, vout: v } = checkOutpoint(txid, vout);
  const exists = await db("baskets").where({ name: clean }).first();
  if (!exists) fail("NOT_FOUND", `no basket: ${clean} (create it first)`);
  const now = Date.now();
  await db("basket_members")
    .insert({ txid: tx, vout: v, basket: clean, value: 0, labeled_at: now })
    .onConflict(["txid", "vout"])
    .merge({ basket: clean, labeled_at: now });
  return { txid: tx, vout: v, value: 0, height: -1, basket: clean };
}

/** Label fresh outputs (engine calls this after a broadcast is accepted). */
export async function labelOutputs(
  db: Knex,
  txid: string,
  outputs: Array<{ vout: number; value: number; basket: string }>,
): Promise<number> {
  if (outputs.length === 0) return 0;
  const now = Date.now();
  const tx = txid.toLowerCase();
  for (const o of outputs) {
    await db("basket_members")
      .insert({ txid: tx, vout: o.vout, value: o.value, basket: o.basket, labeled_at: now })
      .onConflict(["txid", "vout"])
      .merge({ value: o.value, basket: o.basket, labeled_at: now });
  }
  return outputs.length;
}

/** Origin's basket when one is named exactly that, else `default`. */
export async function resolveBasketForOrigin(db: Knex, origin: string): Promise<string> {
  await ensureDefault(db);
  if (typeof origin === "string" && origin) {
    const hit = await db("baskets").where({ name: origin }).first();
    if (hit) return origin;
  }
  return DEFAULT_BASKET;
}

/**
 * Per-basket balances: live chain UTXOs joined to labels. Labels pointing
 * at removed baskets, and every unlabeled UTXO, count as `default`.
 *
 * Chain indexes lag our own mempool: an output we just spent can linger in
 * the unspent list while our spend is still unconfirmed. Without correction
 * the same sats show in two pots at once, so outpoints consumed by our own
 * tracked (non-failed) transactions are excluded — failed spends never
 * moved anything, so they stay counted. Both directions self-heal.
 */
export async function basketBalances(
  db: Knex,
  chain: ChainProvider,
  address: string,
): Promise<BasketView[]> {
  await ensureDefault(db);
  const live = await chain.utxos(address);
  const spent = await spentByUs(db);
  const labels = (await db("basket_members").select()) as Array<{
    txid: string; vout: number; basket: string; value: number;
  }>;
  const byOutpoint = new Map(labels.map((l) => [`${l.txid}:${l.vout}`, l.basket]));
  const known = new Set((await db("baskets").select("name")).map((r: { name: string }) => r.name));
  const buckets = new Map<string, BasketMember[]>();
  for (const u of live.utxos) {
    if (spent.has(`${u.txid}:${u.vout}`)) continue; // ours, already re-spent
    const labeled = byOutpoint.get(`${u.txid}:${u.vout}`);
    const basket = labeled && known.has(labeled) ? labeled : DEFAULT_BASKET;
    const list = buckets.get(basket) ?? [];
    list.push({ txid: u.txid, vout: u.vout, value: u.value, height: u.height, basket });
    buckets.set(basket, list);
  }
  const meta = new Map(
    ((await db("baskets").select()) as Array<{ name: string; description: string }>).map((r) => [r.name, r.description]),
  );
  return [...meta.entries()].map(([name, description]) => {
    const members = (buckets.get(name) ?? []).sort((a, b) => b.value - a.value);
    return {
      name,
      description,
      balance: members.reduce((a, m) => a + m.value, 0),
      memberCount: members.length,
      members: members.slice(0, 100),
    };
  });
}

/** Outpoints consumed by our own tracked, non-failed transactions. */
export async function spentByUs(db: Knex): Promise<Set<string>> {
  const spent = new Set<string>();
  const rows = (await db("pending_txs").select("tx_hex", "status").whereNot({ status: "failed" })) as Array<{
    tx_hex: string | null; status: string;
  }>;
  for (const r of rows) {
    if (!r.tx_hex) continue;
    try {
      const tx = Transaction.fromHex(r.tx_hex);
      for (const input of tx.inputs ?? []) {
        const txid = (input as { sourceTXID?: unknown }).sourceTXID;
        const vout = (input as { sourceOutputIndex?: unknown }).sourceOutputIndex;
        if (typeof txid === "string" && Number.isInteger(vout)) spent.add(`${txid.toLowerCase()}:${vout}`);
      }
    } catch {
      /* unparseable hex: leave the outpoints counted */
    }
  }
  return spent;
}

export async function walletBaskets(db: Knex, chain: ChainProvider): Promise<BasketView[]> {
  return basketBalances(db, chain, selfAddress());
}
