/**
 * Time capsules: post-dated cheques enforced by your own daemon.
 *
 * Why not bare CLTV: BSV's interpreter demotes OP_CHECKLOCKTIMEVERIFY to a
 * NOP for every UTXO created after the Genesis upgrade (verified in
 * bitcoin-sv/bitcoin-sv src/script/interpreter.cpp — `utxo_after_genesis`
 * forces the NOP2 path, which fails under standard flags). A bare CLTV
 * output is unspendable by anyone, forever — proven the hard way with
 * 1500 sats. Consensus timelock on BSV is transaction-level nLockTime, and
 * a pre-signed nLockTime tx is only as binding as the keys that could
 * double-spend it. So capsules bind the daemon's policy instead of
 * consensus, which is exactly bsvOS's existing trust model (same as
 * everything else here: your machine refuses, your seed overrules).
 *
 * Mechanics: lock selects + reserves funding UTXOs (excluded from every
 * wallet spend selection until release), records the intent {to, amount,
 * message, unlock}. The minutely ticker auto-pays matured capsules with a
 * fresh tx (current fees, note in the OP_RETURN so message and money land
 * together); manual claim and owner cancel (release reservations) complete
 * the surface. Cancel is the honest escape hatch self-custody demands.
 */
import type { Knex } from "knex";
import { Script, Transaction } from "@bsv/sdk";
import type { ChainProvider } from "./chain.ts";
import { p2pkhUnlockHook, selfAddress } from "./custody.ts";
import { buildTx, p2pkhScript, signTx, type SpendableUtxo } from "./tx.ts";
import { check } from "./policy.ts";
import { recordSpend } from "./agents.ts";
import { labelOutputs, resolveBasketForOrigin } from "./baskets.ts";
import { checkMemo, lockingScriptOf } from "./engine.ts";
import { track } from "./monitor.ts";
import { reservedUtxos, unavailableUtxos } from "./baskets.ts";

export const CAPSULE_ORIGIN = "capsule";
const WOC_INFO = "https://api.whatsonchain.com/v1/bsv/main/chain/info";
/** Locktime type threshold (height < 500M, timestamp otherwise). */
export const LOCKTIME_THRESHOLD = 500_000_000;
/** Reserve inputs must cover amount plus this fee headroom. */
export const RESERVE_FEE_HEADROOM = 1000;

export interface Capsule {
  id: string;
  locktime: number;
  kind: "height" | "time";
  toAddress: string;
  amount: number;
  message: string;
  status: "locked" | "claimed" | "cancelled";
  reserved: string[];
  claimTxid: string | null;
  createdAt: number;
}

export interface ChainTip {
  blocks: number;
  mediantime: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export async function fetchChainTip(fetchFn: typeof fetch = fetch): Promise<ChainTip> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchFn(WOC_INFO, { signal: ctrl.signal });
    if (!res.ok) fail("RAILS", `chain tip ${res.status}`);
    const j = (await res.json()) as { blocks?: unknown; mediantime?: unknown };
    const blocks = Math.floor(Number(j.blocks) || 0);
    const mediantime = Math.floor(Number(j.mediantime) || 0);
    if (!(blocks > 0)) fail("RAILS", "chain tip missing block height");
    return { blocks, mediantime };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Parse --unlock-at: absolute height ("968900"), ISO date ("2027-01-01"),
 * or relative blocks ("+52560", ~1 year). Returns the locktime + kind.
 */
export function parseUnlockAt(raw: unknown, tip: ChainTip): { locktime: number; kind: "height" | "time" } {
  const text = String(raw ?? "").trim();
  if (!text) fail("BAD_PARAM", "unlock-at required: height, ISO date, or +blocks");
  const rel = /^\+(\d+)\s*(blocks?)?$/i.exec(text);
  if (rel) {
    const locktime = tip.blocks + Math.floor(Number(rel[1]));
    if (!(locktime > tip.blocks)) fail("BAD_PARAM", "relative unlock must be at least +1 block");
    return { locktime, kind: "height" };
  }
  if (/^\d+$/.test(text)) {
    const locktime = Math.floor(Number(text));
    if (locktime >= LOCKTIME_THRESHOLD) fail("BAD_PARAM", "absolute timestamps must use ISO dates (bare numbers are heights)");
    if (!(locktime > tip.blocks)) fail("BAD_PARAM", `unlock height must be in the future (tip ${tip.blocks})`);
    return { locktime, kind: "height" };
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) fail("BAD_PARAM", "unlock-at: height, ISO date, or +blocks");
  const locktime = Math.floor(ms / 1000);
  if (locktime < LOCKTIME_THRESHOLD) fail("BAD_PARAM", "date too far past for timestamp lock (use a height instead)");
  if (!(locktime > tip.mediantime)) fail("BAD_PARAM", "unlock time must be in the future");
  return { locktime, kind: "time" };
}

/** Blocks (or seconds) remaining until unlock; <=0 means payable. */
export function remaining(c: Pick<Capsule, "locktime" | "kind">, tip: ChainTip): number {
  return c.kind === "height" ? c.locktime - tip.blocks : c.locktime - tip.mediantime;
}

export async function migrateCapsules(db: Knex): Promise<void> {
  if ((await db.schema.hasTable("capsules")) && (await db.schema.hasColumn("capsules", "script_hex"))) {
    // v1 (bare CLTV) never shipped and its outputs are unspendable — drop it.
    await db.schema.dropTable("capsules");
  }
  if (!(await db.schema.hasTable("capsules"))) {
    await db.schema.createTable("capsules", (t) => {
      t.increments("id");
      t.integer("locktime").notNullable();
      t.string("kind", 8).notNullable().defaultTo("height");
      t.string("to_address", 64).notNullable().defaultTo("");
      t.integer("amount").notNullable();
      t.text("message").notNullable().defaultTo("");
      t.string("status").notNullable().defaultTo("locked");
      t.text("reserved").notNullable().defaultTo("[]");
      t.string("claim_txid", 64).nullable();
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("reserved_utxos"))) {
    await db.schema.createTable("reserved_utxos", (t) => {
      t.string("outpoint", 128).primary();
      t.integer("capsule_id").notNullable();
      t.string("txid", 64).notNullable();
      t.integer("vout").notNullable();
      t.integer("value").notNullable();
      t.integer("created_at").notNullable();
    });
  }
}

interface CapsuleRow {
  id: number; locktime: number; kind: string; to_address: string; amount: number;
  message: string; status: string; reserved: string; claim_txid: string | null; created_at: number;
}

function toCapsule(r: CapsuleRow): Capsule {
  let reserved: string[] = [];
  try {
    const v = JSON.parse(r.reserved || "[]") as unknown;
    if (Array.isArray(v)) reserved = v.filter((x): x is string => typeof x === "string");
  } catch {
    reserved = [];
  }
  return {
    id: String(r.id), locktime: r.locktime, kind: r.kind === "time" ? "time" : "height",
    toAddress: r.to_address, amount: r.amount, message: r.message,
    status: r.status === "claimed" ? "claimed" : r.status === "cancelled" ? "cancelled" : "locked",
    reserved, claimTxid: r.claim_txid, createdAt: r.created_at,
  };
}

export async function listCapsules(db: Knex): Promise<Capsule[]> {
  const rows = (await db("capsules").select().orderBy("created_at", "desc").limit(50)) as CapsuleRow[];
  return rows.map(toCapsule);
}

export async function getCapsule(db: Knex, id: string): Promise<Capsule> {
  const row = (await db("capsules").where({ id: Math.floor(Number(id)) }).first()) as CapsuleRow | undefined;
  if (!row) fail("NOT_FOUND", `no capsule ${id}`);
  return toCapsule(row!);
}

/** Outpoints reserved by live capsules — see baskets.reservedUtxos. */
export async function capsuleReservations(db: Knex): Promise<Set<string>> {
  return reservedUtxos(db);
}

export interface LockDeps {
  db: Knex;
  chain: ChainProvider;
  fetchFn?: typeof fetch;
}

const outpointOf = (txid: string, vout: number): string => `${txid.toLowerCase()}:${vout}`;

/**
 * Lock a capsule: validate the future date, select + reserve funding
 * (inscription carriers excluded, same discipline as spendTo), gate the
 * committed total on policy. No money moves until maturity.
 */
export async function lockCapsule(
  deps: LockDeps,
  opts: { amount: number; unlockAt: unknown; to?: string; message?: string; tip?: ChainTip },
): Promise<Capsule> {
  const { db, chain } = deps;
  const amount = Math.floor(Number(opts.amount) || 0);
  if (!(amount >= 1000)) fail("BAD_PARAM", "capsule amount must be at least 1000 sats");
  const tip = opts.tip ?? (await fetchChainTip(deps.fetchFn ?? fetch));
  const { locktime, kind } = parseUnlockAt(opts.unlockAt, tip);
  const to = typeof opts.to === "string" && opts.to ? opts.to : selfAddress();
  try {
    p2pkhScript(to);
  } catch {
    fail("BAD_PARAM", "to must be a valid P2PKH address");
  }
  const message = typeof opts.message === "string" ? opts.message.replace(/[ -]/g, " ").trim().slice(0, 300) : "";

  const address = selfAddress();
  const u = await chain.utxos(address);
  const unavailable = await unavailableUtxos(db);
  const { hasOrdEnvelope } = await import("./tokens.ts");
  const fetchFn = deps.fetchFn ?? fetch;
  const candidates = u.utxos
    .filter((x) => !unavailable.has(outpointOf(x.txid, x.vout)) && x.value > 100)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const scripts = await Promise.all(
    candidates.map((x) => lockingScriptOf(x.txid, x.vout, fetchFn).catch(() => null)),
  );
  const funding: SpendableUtxo[] = [];
  let fundingTotal = 0;
  for (let i = 0; i < candidates.length && funding.length < 6; i++) {
    const s = scripts[i];
    if (!s || hasOrdEnvelope(s.scriptHex)) continue;
    const c = candidates[i]!;
    funding.push({ txid: c.txid, vout: c.vout, value: c.value, scriptHex: s.scriptHex });
    fundingTotal += c.value;
    if (fundingTotal >= amount + RESERVE_FEE_HEADROOM) break;
  }
  if (fundingTotal < amount + RESERVE_FEE_HEADROOM) {
    fail("INSUFFICIENT", `need ${amount + RESERVE_FEE_HEADROOM} sats of plain funding (have ${fundingTotal})`);
  }
  const gate = await check(db, CAPSULE_ORIGIN, amount + RESERVE_FEE_HEADROOM, "app-spend", {
    context: {
      label: `capsule lock ${amount} sats`,
      to: `timelock@${locktime}`,
      description: `time capsule: reserve ${amount} sats until ${kind} ${locktime} (no money moves yet)`,
    },
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  await recordSpend(db, CAPSULE_ORIGIN, 0);
  const now = Date.now();
  const [rowId] = (await db("capsules").insert({
    locktime, kind, to_address: to, amount, message, status: "locked",
    reserved: JSON.stringify(funding.map((f) => outpointOf(f.txid, f.vout))),
    claim_txid: null, created_at: now,
  })) as number[];
  for (const f of funding) {
    await db("reserved_utxos").insert({
      outpoint: outpointOf(f.txid, f.vout), capsule_id: rowId,
      txid: f.txid, vout: f.vout, value: f.value, created_at: now,
    });
  }
  const row = (await db("capsules").where({ id: rowId }).first()) as CapsuleRow;
  return toCapsule(row);
}

/** Owner escape hatch: release reservations, capsule never pays. */
export async function cancelCapsule(db: Knex, id: string): Promise<Capsule> {
  const c = await getCapsule(db, id);
  if (c.status !== "locked") fail("BAD_STATE", `capsule is ${c.status}`);
  await db("reserved_utxos").where({ capsule_id: Math.floor(Number(id)) }).delete();
  await db("capsules").where({ id: Math.floor(Number(id)) }).update({ status: "cancelled", reserved: "[]" });
  return getCapsule(db, id);
}

/**
 * Pay one matured capsule from its reservations with current fees, note in
 * the OP_RETURN so message and money land together. Refuses while locked.
 */
export async function claimCapsule(
  deps: LockDeps,
  id: string,
  tip?: ChainTip,
): Promise<{ txid: string; fee: number; amount: number }> {
  const { db, chain } = deps;
  const c = await getCapsule(db, id);
  if (c.status !== "locked") fail("BAD_STATE", `capsule is ${c.status}`);
  const t = tip ?? (await fetchChainTip(deps.fetchFn ?? fetch));
  const left = remaining(c, t);
  if (left > 0) {
    fail("BAD_STATE", c.kind === "height"
      ? `unlocks in ~${left} blocks (tip ${t.blocks}, unlock ${c.locktime})`
      : `unlocks in ~${Math.ceil(left / 3600)}h (median time ${t.mediantime}, unlock ${c.locktime})`);
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const { hasOrdEnvelope } = await import("./tokens.ts");
  const rows = (await db("reserved_utxos").where({ capsule_id: Math.floor(Number(id)) }).select()) as Array<{
    outpoint: string; txid: string; vout: number; value: number;
  }>;
  if (!rows.length) fail("BAD_STATE", "capsule has no reserved funding (cancelled?)");
  const scripts = await Promise.all(rows.map((r) => lockingScriptOf(r.txid, r.vout, fetchFn).catch(() => null)));
  const funding: SpendableUtxo[] = [];
  for (let i = 0; i < rows.length; i++) {
    const s = scripts[i];
    if (!s || hasOrdEnvelope(s.scriptHex)) continue;
    const r = rows[i]!;
    funding.push({ txid: r.txid, vout: r.vout, value: r.value, scriptHex: s.scriptHex });
  }
  if (!funding.length) fail("INSUFFICIENT", "reserved funding unreadable (reorg?) — cancel and relock");
  const address = selfAddress();
  const memo = ["CAPSULE-PAY", `#${c.id}`, `unlock:${c.locktime}`, ...(c.message ? [c.message] : [])];
  const built = buildTx({
    utxos: funding,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [{ address: c.toAddress, sats: c.amount }],
    opReturn: checkMemo(memo),
    changeScriptHex: p2pkhScript(address).toHex(),
  });
  const gate = await check(db, CAPSULE_ORIGIN, c.amount + built.fee, "app-spend", {
    context: { label: `capsule claim ${c.amount} sats`, to: c.toAddress, description: `time capsule #${c.id} matured — paying ${c.amount} sats` },
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await chain.broadcast(hex);
  await track(db, res.txid, `capsule claim ${c.amount} sats`, hex);
  await recordSpend(db, CAPSULE_ORIGIN, c.amount + built.fee);
  const basket = await resolveBasketForOrigin(db, CAPSULE_ORIGIN);
  const changeHex = p2pkhScript(address).toHex();
  await labelOutputs(
    db, res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  await db("reserved_utxos").where({ capsule_id: Math.floor(Number(id)) }).delete();
  await db("capsules").where({ id: Math.floor(Number(id)) }).update({ status: "claimed", claim_txid: res.txid, reserved: "[]" });
  return { txid: res.txid, fee: built.fee, amount: c.amount };
}

/**
 * Minutely ticker: pay every matured locked capsule, one failure never
 * stops the rest. Called by the daemon loop; manual claim shares the path.
 */
export async function tickCapsules(
  deps: LockDeps,
  tip?: ChainTip,
  now = Date.now(),
): Promise<Array<{ capsule: string; outcome: string; txid?: string }>> {
  void now;
  const { db } = deps;
  const t = tip ?? (await fetchChainTip(deps.fetchFn ?? fetch).catch(() => null));
  if (!t) return [];
  const rows = (await db("capsules").where({ status: "locked" }).select()) as CapsuleRow[];
  const out: Array<{ capsule: string; outcome: string; txid?: string }> = [];
  for (const r of rows) {
    const c = toCapsule(r);
    if (remaining(c, t) > 0) continue;
    try {
      const res = await claimCapsule(deps, c.id, t);
      out.push({ capsule: c.id, outcome: "paid", txid: res.txid });
    } catch (e) {
      out.push({ capsule: c.id, outcome: `failed: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 160) });
    }
  }
  return out;
}
