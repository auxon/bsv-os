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
import { p2pkhUnlockHook, p2pkhUnlockHookSingle, selfAddress } from "./custody.ts";
import { buildTx, p2pkhScript, signTx, type SpendableUtxo } from "./tx.ts";
import { check } from "./policy.ts";
import { recordSpend } from "./agents.ts";
import { labelOutputs, resolveBasketForOrigin } from "./baskets.ts";
import type { JevDecide } from "./jev.ts";
import { hasOrdEnvelope, splitOutpoint } from "./tokens.ts";
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

export interface SwapOfferInput {
  txid: string;
  vout: number;
  scriptHex: string;
  sequence: number;
}

export interface SwapOffer {
  input: SwapOfferInput;
  unlockHex: string;
  payScriptHex: string;
  priceSats: number;
  version: number;
  lockTime: number;
  /** Asset template: v2 ordinal (1-sat carrier) or v3 BSV21 (exact-amount token carrier). */
  kind: SwapKind;
  tokenId?: string;
  tokenAmount?: string;
}

export type SwapKind = "ordinal" | "bsv21";

/** v3 template version for BSV21 swaps (v2 stays the ordinal template). */
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
    if (!hasOrdEnvelope(carrier.scriptHex)) fail("BAD_PARAM", "carrier is not inscribed — refusing to list plain dust");
  } else {
    const env = parseBsv21Envelope(carrier.scriptHex);
    if (!env || env.protocol !== BSV20_PROTOCOL || env.contentType !== BSV20_CONTENT_TYPE || env.id !== tokenId || env.amt !== tokenAmount) {
      fail("BAD_PARAM", "carrier is not the listed token output");
    }
  }
  const gate = await check(opts.db, opts.origin, 0, "app-swap-offer");
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const payScript = p2pkhScript(address);
  const hook = p2pkhUnlockHookSingle("m/0/0", 1, Script.fromHex(carrier.scriptHex));
  const tx = new Transaction(kind === "bsv21" ? SWAP_VERSION_BSV21 : SWAP_VERSION, [], [], SWAP_LOCKTIME);
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
    input: { txid: parts.txid, vout: parts.vout, scriptHex: carrier.scriptHex, sequence: SWAP_SEQ },
    unlockHex: unlock.toHex(),
    payScriptHex: payScript.toHex(),
    priceSats: price,
    version: kind === "bsv21" ? SWAP_VERSION_BSV21 : SWAP_VERSION,
    lockTime: SWAP_LOCKTIME,
    kind,
    ...(kind === "bsv21" ? { tokenId, tokenAmount } : {}),
  };
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
  const input = (o.input ?? {}) as Record<string, unknown>;
  const parts = splitOutpoint(`${String(input.txid ?? "")}_${String(input.vout ?? "")}`);
  if (!parts) fail("BAD_OFFER", "offer input must be 64-hex txid + vout");
  const price = Math.floor(Number(o.priceSats) || 0);
  if (!(price >= 1)) fail("BAD_OFFER", "offer priceSats must be a positive sat number");
  const kind = (o.kind ?? "ordinal") as SwapKind;
  if (kind !== "ordinal" && kind !== "bsv21") fail("BAD_OFFER", "offer kind must be ordinal or bsv21");
  const wantVersion = kind === "bsv21" ? SWAP_VERSION_BSV21 : SWAP_VERSION;
  if (o.version !== wantVersion || o.lockTime !== SWAP_LOCKTIME) fail("BAD_OFFER", "offer version/locktime mismatch");
  if (input.sequence !== SWAP_SEQ) fail("BAD_OFFER", "offer sequence mismatch");
  const scriptHex = hexBlob(input.scriptHex);
  const payScriptHex = hexBlob(o.payScriptHex);
  const unlockHex = hexBlob(o.unlockHex);
  if (!scriptHex || !payScriptHex || !unlockHex) fail("BAD_OFFER", "offer scripts must be hex");
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
  // Carrier truth comes from chain, never from the offer.
  const carrier = await lockingScriptOf(parts.txid, parts.vout, fetchFn);
  if (carrier.scriptHex.toLowerCase() !== scriptHex) fail("BAD_OFFER", "offer script disagrees with chain");
  if (carrier.value !== 1) fail("BAD_OFFER", "offer carrier is not 1 sat");
  // BSV21: the indexer is the arbiter of token spend-state (bulk-validated
  // holdings, unspent only), and the envelope is re-checked locally —
  // same two-layer rule as sendBsv21. Exact-UTXO only: the listed amount
  // must equal the carrier amount (partial fills can't be atomic-safe).
  let tokenId = "";
  let tokenAmount = "";
  if (kind === "bsv21") {
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
  }
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const candidates = u.utxos
    .filter((x) => x.value > 1)
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
  const sellerKey = `${parts.txid}:${parts.vout}`;
  let unlockScript: Script;
  try {
    unlockScript = Script.fromHex(unlockHex);
  } catch {
    fail("BAD_OFFER", "offer unlock must be a script");
  }
  const payments: Array<{ address?: string; sats: number; scriptHex?: string }> = [
    { sats: price, scriptHex: payScriptHex }, // byte-exact seller terms
    kind === "bsv21"
      ? { sats: 1, scriptHex: bsv21TransferScript(address, tokenId, tokenAmount) }
      : { address, sats: 1 }, // NFT sat to buyer (plain P2PKH moves the inscription)
  ];
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
    utxos: [{ txid: parts.txid, vout: parts.vout, value: 1, scriptHex: carrier.scriptHex }, ...funding],
    unlockFor: (x) =>
      `${x.txid}:${x.vout}` === sellerKey
        ? { sign: async () => unlockScript }
        : p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments,
    opReturn: memo.length ? memo : undefined,
    changeScriptHex: lock.toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, price + feeSats + built.fee, "app-swap", {
    context: {
      label: opts.label,
      to: `${parts.txid.slice(0, 8)} listing`,
      ...(opts.description ? { description: opts.description } : {}),
    },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, kind === "bsv21"
    ? `swap buy ${tokenAmount} ${tokenId.slice(0, 8)} for ${price} sats`
    : `swap buy ${price} sats from ${parts.txid.slice(0, 8)}`, hex);
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
