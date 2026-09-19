/**
 * PocketPets cutover: atomic NFT swaps (SIGHASH_SINGLE | ANYONECANPAY).
 *
 * Template matches the game's `src/atomic.ts` exactly — both sides MUST
 * agree: version 2, locktime 0, seller sequence 0xffffffff, seller input
 * at index 0, payment output at index 0. Either the whole swap settles
 * or nothing does.
 *
 * Safety model (why the daemon may sign page-described swaps):
 * - Keys never leave custody — signing happens in custody.ts like every
 *   other flow; the page only ever sees the finished unlock script.
 * - The seller pre-signature commits ONLY to output 0 (SINGLE|ACP), and
 *   the daemon builds that output itself: proceeds ALWAYS pay our own
 *   wallet, at exactly the stated price. A malicious page cannot redirect
 *   funds — at worst it lists the wrong NFT, which the owner approves in
 *   the listing UI before it ever reaches us.
 * - The buyer completion re-derives every constrained byte (version,
 *   locktime, input, exact payment script+amount); the seller's unlock is
 *   only ever attached to that exact template. An invalid seller unlock
 *   makes the whole tx invalid — consensus arbitrates, buyer funds cannot
 *   move without the NFT moving to the buyer in the same tx.
 * - Policy gates both sides (offer listings prompt once per app in ask
 *   mode; buys gate on price + fee like any spend).
 */
import type { Knex } from "knex";
import { Script, Transaction } from "@bsv/sdk";
import { p2pkhUnlockHook, p2pkhUnlockHookNone, p2pkhUnlockHookSingle, selfAddress } from "./custody.ts";
import { buildTx, p2pkhScript, signTx, type SpendableUtxo } from "./tx.ts";
import { check } from "./policy.ts";
import { recordSpend } from "./agents.ts";
import { labelOutputs, resolveBasketForOrigin, spentByUs } from "./baskets.ts";
import type { JevDecide } from "./jev.ts";
import { fetchBulkMetadata, hasOrdEnvelope, splitOutpoint } from "./tokens.ts";
import {
  BSV20_CONTENT_TYPE,
  BSV20_PROTOCOL,
  bsv21TransferScript,
  normalizeTokenId,
  parseBsv21Envelope,
  parseTokenAmount,
  tokenHoldings,
} from "./tokens.ts";
import { checkMemo, lockingScriptOf } from "./engine.ts";
import { track } from "./monitor.ts";
import type { ChainProvider } from "./chain.ts";

export const SWAP_VERSION = 2;
export const SWAP_LOCKTIME = 0;
export const SWAP_SEQ = 0xffffffff;

/**
 * The on-chain transaction version every swap tx uses (pre-sign and
 * completion alike): signatures commit to it, and `buildTx` is fixed at 2.
 * Template versions (v3/v4) are offer metadata, not tx versions.
 */
export const SWAP_TX_VERSION = 2;

export interface SwapOfferInput {
  txid: string;
  vout: number;
  scriptHex: string;
  sequence: number;
}

/** v4 offer input: chain-pinned carrier plus the seller's pre-signed unlock. */
export interface SwapOfferInputV4 extends SwapOfferInput {
  unlockHex: string;
}

export interface SwapOffer {
  version: number;
  /** Asset template: v4 ordinal (dual input), v3 BSV21 (exact-amount token carrier). */
  kind: SwapKind;
  payScriptHex: string;
  priceSats: number;
  lockTime: number;
  /** v3 (bsv21): the single token carrier. */
  input?: SwapOfferInput;
  unlockHex?: string;
  /** v4 (ordinal): [1-sat plain prefix, inscribed carrier]. */
  inputs?: SwapOfferInputV4[];
  tokenId?: string;
  tokenAmount?: string;
}

export type SwapKind = "ordinal" | "bsv21";

/**
 * v4 is the indexer-safe ordinal template. The 1Sat indexer assigns the
 * inscribed sat FIFO: with the carrier at input 0 the first output gets
 * it, so v2 (payment first) silently gave the NFT back to the seller.
 * v4 puts a plain 1-sat prefix at input 0 and the carrier at input 1, so
 * the inscription lands on output 0 — a 1-sat output to the buyer — while
 * the carrier's SIGHASH_SINGLE|ACP commits byte-exact to the payment at
 * output 1. The prefix signs SIGHASH_NONE|ACP (no commitments).
 */
export const SWAP_VERSION_ORDINAL = 4;

/** v3 template version for BSV21 swaps (token outputs carry envelopes, so FIFO does not apply). */
export const SWAP_VERSION_BSV21 = 3;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function isP2PKH(hex: string): boolean {
  return /^[0-9a-fA-F]{50}$/.test(hex) && hex.toLowerCase().startsWith("76a914") && hex.toLowerCase().endsWith("88ac");
}

function hexBlob(v: unknown): string {
  return typeof v === "string" && /^[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : "";
}

/**
 * Seller: pre-sign a swap offer on one of OUR 1-sat carriers. Proceeds
 * always pay our own wallet — the page names the outpoint and the price,
 * never the payee. Off-chain (no broadcast, nothing tracked).
 *
 * Kinds: `ordinal` lists any 1-sat inscribed carrier; `bsv21` lists a
 * token carrier holding exactly `tokenAmount` of `tokenId` (exact-UTXO
 * rule — partial fills can't be atomic-safe, so split first with a
 * normal send and list the exact piece).
 */
export async function signSwapOffer(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  txid: string;
  vout: number;
  priceSats: number;
  kind?: SwapKind;
  tokenId?: string;
  tokenAmount?: string;
  fetchFn?: typeof fetch;
}): Promise<SwapOffer> {
  const parts = splitOutpoint(`${opts.txid}_${opts.vout}`);
  if (!parts) fail("BAD_PARAM", "outpoint must be 64-hex txid + vout");
  const price = Math.floor(Number(opts.priceSats) || 0);
  if (!(price >= 1)) fail("BAD_PARAM", "priceSats must be a positive sat number");
  const kind = opts.kind ?? "ordinal";
  if (kind !== "ordinal" && kind !== "bsv21") fail("BAD_PARAM", "kind must be ordinal or bsv21");
  let tokenId = "";
  let tokenAmount = "";
  if (kind === "bsv21") {
    const id = normalizeTokenId(opts.tokenId);
    if (!id) fail("BAD_PARAM", "tokenId must be <64-hex-txid>_<vout>");
    const amt = parseTokenAmount(opts.tokenAmount);
    if (!amt) fail("BAD_PARAM", "tokenAmount must be a positive base-unit integer string");
    tokenId = id;
    tokenAmount = amt;
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const address = selfAddress();
  const ours = p2pkhScript(address).toHex().slice(0, 50);
  const carrier = await lockingScriptOf(parts.txid, parts.vout, fetchFn);
  if (!carrier.scriptHex.toLowerCase().startsWith(ours.toLowerCase())) {
    fail("NOT_OURS", "swap carrier is not ours (P2PKH prefix mismatch)");
  }
  if (carrier.value !== 1) fail("BAD_PARAM", `swap carrier must be exactly 1 sat (found ${carrier.value})`);
  if (kind === "ordinal") {
    if (!hasOrdEnvelope(carrier.scriptHex)) {
      // Transferred inscriptions move the 1-sat carrier to a plain P2PKH
      // output; the envelope stays at the origin. Ask ORDFS whether this
      // outpoint is the current location of an inscription — absent or
      // empty metadata means plain dust, which must not list.
      const key = `${parts.txid}_${parts.vout}`;
      let meta: Record<string, { contentType?: string } | null>;
      try {
        meta = (await fetchBulkMetadata([key], { fetchFn })) as Record<string, { contentType?: string } | null>;
      } catch {
        fail("RAILS", "inscription lookup unreachable — cannot verify the carrier");
      }
      const m = meta![key] ?? meta![key.replace("_", ".")] ?? null;
      if (!m || !m.contentType) fail("BAD_PARAM", "carrier is not inscribed — refusing to list plain dust");
    }
  } else {
    const env = parseBsv21Envelope(carrier.scriptHex);
    if (!env || env.protocol !== BSV20_PROTOCOL || env.contentType !== BSV20_CONTENT_TYPE || env.id !== tokenId || env.amt !== tokenAmount) {
      fail("BAD_PARAM", "carrier is not the listed token output");
    }
  }
  const gate = await check(opts.db, opts.origin, 0, "app-swap-offer");
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const payScript = p2pkhScript(address);
  if (kind === "bsv21") {
    const hook = p2pkhUnlockHookSingle("m/0/0", 1, Script.fromHex(carrier.scriptHex));
    const tx = new Transaction(SWAP_TX_VERSION, [], [], SWAP_LOCKTIME);
    tx.addInput({
      unlockingScriptTemplate: {
        sign: (t: Transaction, i: number) => hook.sign(t, i),
        estimateLength: async () => 108,
      },
      sourceTXID: parts.txid,
      sourceOutputIndex: parts.vout,
      sequence: SWAP_SEQ,
    });
    tx.addOutput({ lockingScript: payScript, satoshis: price });
    await tx.sign();
    const unlock = tx.inputs[0]?.unlockingScript;
    if (!unlock) fail("INTERNAL", "signing produced no script");
    return {
      version: SWAP_VERSION_BSV21,
      kind,
      input: { txid: parts.txid, vout: parts.vout, scriptHex: carrier.scriptHex, sequence: SWAP_SEQ },
      unlockHex: unlock.toHex(),
      payScriptHex: payScript.toHex(),
      priceSats: price,
      lockTime: SWAP_LOCKTIME,
      tokenId,
      tokenAmount,
    };
  }
  // v4 ordinal: a plain 1-sat prefix input shifts the carrier to input 1
  // (see SWAP_VERSION_ORDINAL). The prefix must not itself be inscribed.
  const dust = await findPlainDust(opts.db, opts.chain, address, `${parts.txid}:${parts.vout}`, fetchFn);
  const dustHook = p2pkhUnlockHookNone("m/0/0", 1, Script.fromHex(dust.scriptHex));
  const carrierHook = p2pkhUnlockHookSingle("m/0/0", 1, Script.fromHex(carrier.scriptHex));
  const tx = new Transaction(SWAP_TX_VERSION, [], [], SWAP_LOCKTIME);
  tx.addInput({
    unlockingScriptTemplate: {
      sign: (t: Transaction, i: number) => dustHook.sign(t, i),
      estimateLength: async () => 108,
    },
    sourceTXID: dust.txid,
    sourceOutputIndex: dust.vout,
    sequence: SWAP_SEQ,
  });
  tx.addInput({
    unlockingScriptTemplate: {
      sign: (t: Transaction, i: number) => carrierHook.sign(t, i),
      estimateLength: async () => 108,
    },
    sourceTXID: parts.txid,
    sourceOutputIndex: parts.vout,
    sequence: SWAP_SEQ,
  });
  // Placeholder output so the carrier's SINGLE signature (input index 1)
  // has an output index 1 to commit to. The buyer replaces output 0 with
  // the 1-sat NFT and keeps output 1 byte-exact as the payment.
  tx.addOutput({ lockingScript: new Script([{ op: 0x00 }, { op: 0x6a }]), satoshis: 0 });
  tx.addOutput({ lockingScript: payScript, satoshis: price });
  await tx.sign();
  const dustUnlock = tx.inputs[0]?.unlockingScript?.toHex() ?? "";
  const carrierUnlock = tx.inputs[1]?.unlockingScript?.toHex() ?? "";
  if (!dustUnlock || !carrierUnlock) fail("INTERNAL", "signing produced no script");
  return {
    version: SWAP_VERSION_ORDINAL,
    kind: "ordinal",
    inputs: [
      { txid: dust.txid, vout: dust.vout, scriptHex: dust.scriptHex, sequence: SWAP_SEQ, unlockHex: dustUnlock },
      { txid: parts.txid, vout: parts.vout, scriptHex: carrier.scriptHex, sequence: SWAP_SEQ, unlockHex: carrierUnlock },
    ],
    payScriptHex: payScript.toHex(),
    priceSats: price,
    lockTime: SWAP_LOCKTIME,
  };
}

/**
 * A plain 1-sat UTXO of ours for the v4 prefix: 1 sat, not spent, not the
 * carrier, and ORDFS-clean (no inscription). Fails closed when the indexer
 * cannot confirm plainness — an inscribed prefix would burn its origin.
 */
async function findPlainDust(
  db: Knex,
  chain: ChainProvider,
  address: string,
  exclude: string,
  fetchFn: typeof fetch,
): Promise<{ txid: string; vout: number; scriptHex: string }> {
  const ours = p2pkhScript(address).toHex().slice(0, 50).toLowerCase();
  const u = await chain.utxos(address);
  const spent = await spentByUs(db);
  const candidates = u.utxos
    .filter((x) => x.value === 1 && `${x.txid}:${x.vout}` !== exclude && !spent.has(`${x.txid.toLowerCase()}:${x.vout}`))
    .slice(0, 10);
  if (!candidates.length) {
    fail("BAD_PARAM", "need a plain 1-sat UTXO as the offer prefix (swap change provides one)");
  }
  for (const c of candidates) {
    const key = `${c.txid}_${c.vout}`;
    let meta: Record<string, { contentType?: string } | null>;
    try {
      meta = (await fetchBulkMetadata([key], { fetchFn })) as Record<string, { contentType?: string } | null>;
    } catch {
      fail("RAILS", "inscription lookup unreachable — cannot pick a safe prefix input");
    }
    const m = meta![key] ?? meta![key.replace("_", ".")] ?? null;
    if (m && m.contentType) continue; // inscribed: hands off
    const s = await lockingScriptOf(c.txid, c.vout, fetchFn);
    if (s.value !== 1) continue;
    if (!s.scriptHex.toLowerCase().startsWith(ours)) continue;
    return { txid: c.txid, vout: c.vout, scriptHex: s.scriptHex };
  }
  fail("BAD_PARAM", "need a plain 1-sat UTXO as the offer prefix (swap change provides one)");
}

/**
 * Buyer: complete a seller's offer — payment to the seller plus the NFT
 * sat to us in one tx, funded and ALL-signed by us, broadcast + tracked.
 * Every constrained byte is re-derived; anything off-template aborts
 * before a single input is signed.
 */
export interface SwapBuyerChecks {
  /** Payment output must be exactly this seller's P2PKH (kills market-served payee redirect). */
  expectedSeller?: string;
  /** Offer priceSats must not exceed this. */
  maxPrice?: number;
}

export async function completeSwap(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  offer: unknown;
  fee?: { to: string; sats: number };
  memo?: string[];
  label?: string;
  /** Human meaning of the spend for the Jev decision state (from the app memo). */
  description?: string;
  /** Buyer-side offer verification: checked before any funding is touched. */
  buyerChecks?: SwapBuyerChecks;
  fetchFn?: typeof fetch;
  /** Test/embedding Jev override, passed to the policy gate. */
  jev?: JevDecide;
}): Promise<{ txid: string; fee: number }> {
  const o = (opts.offer ?? {}) as Record<string, unknown>;
  const price = Math.floor(Number(o.priceSats) || 0);
  if (!(price >= 1)) fail("BAD_OFFER", "offer priceSats must be a positive sat number");
  const kind = (o.kind ?? "ordinal") as SwapKind;
  if (kind !== "ordinal" && kind !== "bsv21") fail("BAD_OFFER", "offer kind must be ordinal or bsv21");
  const version = Number(o.version);
  if (o.lockTime !== SWAP_LOCKTIME) fail("BAD_OFFER", "offer version/locktime mismatch");
  if (kind === "ordinal" && version === SWAP_VERSION) {
    fail("BAD_OFFER", "v2 offers are not indexer-safe (the inscribed sat lands on the payment output) — re-list to upgrade");
  }
  const payScriptHex = hexBlob(o.payScriptHex);
  if (!isP2PKH(payScriptHex)) fail("BAD_OFFER", "offer payment must be a plain P2PKH script");
  // Buyer-side verification: the market serves the offer, so confirm it
  // pays who we think and costs what we saw before touching funding.
  const buyerChecks = opts.buyerChecks ?? {};
  if (buyerChecks.expectedSeller !== undefined) {
    let want = "";
    try {
      want = p2pkhScript(buyerChecks.expectedSeller).toHex();
    } catch {
      fail("BAD_PARAM", "buyerChecks.expectedSeller must be a valid P2PKH address");
    }
    if (payScriptHex.toLowerCase() !== want.toLowerCase()) {
      fail("BAD_OFFER", "offer payment does not pay the expected seller");
    }
  }
  if (buyerChecks.maxPrice !== undefined) {
    const max = Math.floor(Number(buyerChecks.maxPrice));
    if (!Number.isFinite(max) || max < 0) fail("BAD_PARAM", "buyerChecks.maxPrice must be a non-negative sat number");
    if (price > max) fail("BAD_OFFER", `offer price ${price} exceeds buyer max ${max}`);
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const spent = await spentByUs(opts.db);
  const candidates = u.utxos
    .filter((x) => x.value > 1 && !spent.has(`${x.txid.toLowerCase()}:${x.vout}`))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const scripts = await Promise.all(
    candidates.map((x) => lockingScriptOf(x.txid, x.vout, fetchFn).catch(() => null)),
  );
  const funding: SpendableUtxo[] = [];
  for (let i = 0; i < candidates.length && funding.length < 6; i++) {
    const s = scripts[i];
    if (!s || hasOrdEnvelope(s.scriptHex)) continue; // inscription carrier — hands off
    const c = candidates[i]!;
    funding.push({ txid: c.txid, vout: c.vout, value: c.value, scriptHex: s.scriptHex });
  }

  const sellerUnlocks = new Map<string, Script>();
  const parseUnlock = (hex: string): Script => {
    try {
      return Script.fromHex(hex);
    } catch {
      fail("BAD_OFFER", "offer unlock must be a script");
    }
  };
  const spendInputs: SpendableUtxo[] = [];
  const payments: Array<{ address?: string; sats: number; scriptHex?: string }> = [];
  let carrierShort = "";
  let tokenId = "";
  let tokenAmount = "";

  if (kind === "ordinal") {
    if (version !== SWAP_VERSION_ORDINAL) fail("BAD_OFFER", "offer version/locktime mismatch");
    const inputs = Array.isArray(o.inputs) ? (o.inputs as Array<Record<string, unknown>>) : [];
    if (inputs.length !== 2) fail("BAD_OFFER", "v4 offer must carry exactly two inputs (1-sat prefix + carrier)");
    for (let i = 0; i < 2; i++) {
      const it = inputs[i]!;
      const parts = splitOutpoint(`${String(it.txid ?? "")}_${String(it.vout ?? "")}`);
      if (!parts) fail("BAD_OFFER", "offer input must be 64-hex txid + vout");
      if (it.sequence !== SWAP_SEQ) fail("BAD_OFFER", "offer sequence mismatch");
      const scriptHex = hexBlob(it.scriptHex);
      const unlockHex = hexBlob(it.unlockHex);
      if (!scriptHex || !unlockHex) fail("BAD_OFFER", "offer scripts must be hex");
      const carrier = await lockingScriptOf(parts.txid, parts.vout, fetchFn);
      if (carrier.scriptHex.toLowerCase() !== scriptHex) fail("BAD_OFFER", "offer script disagrees with chain");
      if (carrier.value !== 1) fail("BAD_OFFER", "offer inputs must be exactly 1 sat");
      spendInputs.push({ txid: parts.txid, vout: parts.vout, value: 1, scriptHex: carrier.scriptHex });
      sellerUnlocks.set(`${parts.txid}:${parts.vout}`, parseUnlock(unlockHex));
    }
    carrierShort = spendInputs[1]!.txid.slice(0, 8);
    // NFT output FIRST: FIFO assigns the inscribed sat here (input 1's
    // offset is the prefix's 1 sat, which lands exactly on output 0).
    payments.push({ address, sats: 1 }, { sats: price, scriptHex: payScriptHex });
  } else {
    if (version !== SWAP_VERSION_BSV21) fail("BAD_OFFER", "offer version/locktime mismatch");
    const input = (o.input ?? {}) as Record<string, unknown>;
    const parts = splitOutpoint(`${String(input.txid ?? "")}_${String(input.vout ?? "")}`);
    if (!parts) fail("BAD_OFFER", "offer input must be 64-hex txid + vout");
    if (input.sequence !== SWAP_SEQ) fail("BAD_OFFER", "offer sequence mismatch");
    const scriptHex = hexBlob(input.scriptHex);
    const unlockHex = hexBlob(o.unlockHex);
    if (!scriptHex || !unlockHex) fail("BAD_OFFER", "offer scripts must be hex");
    // Carrier truth comes from chain, never from the offer.
    const carrier = await lockingScriptOf(parts.txid, parts.vout, fetchFn);
    if (carrier.scriptHex.toLowerCase() !== scriptHex) fail("BAD_OFFER", "offer script disagrees with chain");
    if (carrier.value !== 1) fail("BAD_OFFER", "offer carrier is not 1 sat");
    // BSV21: the indexer is the arbiter of token spend-state (bulk-validated
    // holdings, unspent only), and the envelope is re-checked locally —
    // same two-layer rule as sendBsv21. Exact-UTXO only: the listed amount
    // must equal the carrier amount (partial fills can't be atomic-safe).
    const id = normalizeTokenId(o.tokenId);
    if (!id) fail("BAD_OFFER", "offer tokenId must be <64-hex-txid>_<vout>");
    const amt = parseTokenAmount(o.tokenAmount);
    if (!amt) fail("BAD_OFFER", "offer tokenAmount must be a positive base-unit integer string");
    tokenId = id;
    tokenAmount = amt;
    const holdings = await tokenHoldings(tokenId, [`${parts.txid}_${parts.vout}`], { fetchFn });
    const holding = holdings.find((h) => h.txid === parts.txid && h.vout === parts.vout);
    if (!holding || holding.amt !== tokenAmount) {
      fail("BAD_OFFER", "offer token output is spent or disagrees with the indexer");
    }
    const env = parseBsv21Envelope(carrier.scriptHex);
    if (!env || env.protocol !== BSV20_PROTOCOL || env.contentType !== BSV20_CONTENT_TYPE || env.id !== tokenId || env.amt !== tokenAmount) {
      fail("BAD_OFFER", "offer script is not the listed token output");
    }
    spendInputs.push({ txid: parts.txid, vout: parts.vout, value: 1, scriptHex: carrier.scriptHex });
    sellerUnlocks.set(`${parts.txid}:${parts.vout}`, parseUnlock(unlockHex));
    carrierShort = parts.txid.slice(0, 8);
    payments.push(
      { sats: price, scriptHex: payScriptHex },
      { sats: 1, scriptHex: bsv21TransferScript(address, tokenId, tokenAmount) },
    );
  }
  spendInputs.push(...funding);
  let feeSats = 0;
  if (opts.fee !== undefined) {
    try {
      p2pkhScript(opts.fee.to);
    } catch {
      fail("BAD_PARAM", "fee.to must be a valid P2PKH address");
    }
    feeSats = Math.floor(Number(opts.fee.sats) || 0);
    if (!(feeSats > 0)) fail("BAD_PARAM", "fee.sats must be positive");
    payments.push({ address: opts.fee.to, sats: feeSats });
  }
  const memo = checkMemo(opts.memo);
  const built = buildTx({
    utxos: spendInputs,
    unlockFor: (x) => {
      const pre = sellerUnlocks.get(`${x.txid}:${x.vout}`);
      return pre ? { sign: async () => pre } : p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!));
    },
    payments,
    opReturn: memo.length ? memo : undefined,
    changeScriptHex: lock.toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, price + feeSats + built.fee, "app-swap", {
    context: {
      label: opts.label,
      to: `${carrierShort} listing`,
      ...(opts.description ? { description: opts.description } : {}),
    },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, opts.label ?? (kind === "bsv21"
    ? `swap buy ${tokenAmount} ${tokenId.slice(0, 8)} for ${price} sats`
    : `swap buy ${price} sats from ${carrierShort}`), hex);
  await recordSpend(opts.db, opts.origin, price + built.fee);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const ours = new Set([lock.toHex()]); // NFT output + sat change (payment output is the seller's)
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((out, vout) => ({ vout, script: out.lockingScript?.toHex(), value: out.satoshis ?? 0 }))
      .filter((x) => x.script !== undefined && ours.has(x.script))
      .map((x) => ({ vout: x.vout, value: x.value, basket })),
  );
  return { txid: res.txid, fee: built.fee };
}
