/**
 * Wallet engine: policy-gated spends built on custody + chain + monitor.
 * First migrated flow: timestamp anchoring (PocketPets `timestamp` tool) —
 * hash in, OP_RETURN out, tracked to confirmation.
 */
import type { Knex } from "knex";
import { p2pkhUnlockHook, selfAddress } from "./custody.ts";
import { Script, Transaction } from "@bsv/sdk";
import { buildTx, p2pkhScript, signTx, type SpendableUtxo } from "./tx.ts";
import { check } from "./policy.ts";
import { recordSpend } from "./agents.ts";
import { labelOutputs, resolveBasketForOrigin, spentByUs } from "./baskets.ts";
import {
  BSV20_CONTENT_TYPE,
  BSV20_PROTOCOL,
  bsv21TransferScript,
  hasOrdEnvelope,
  inscriptionScript,
  normalizeTokenId,
  parseBsv21Envelope,
  parseTokenAmount,
  splitOutpoint,
  tokenHoldings,
  type TokenHolding,
} from "./tokens.ts";
import { track } from "./monitor.ts";
import type { ChainProvider } from "./chain.ts";
import type { JevDecide, SpendContext } from "./jev.ts";

const WOC_TX = "https://api.whatsonchain.com/v1/bsv/main/tx";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** OP_RETURN memo guard: small human-readable tags, not a data hose. */
export function checkMemo(memo: unknown): string[] {
  if (memo === undefined) return [];
  if (!Array.isArray(memo) || memo.length > 5 || memo.some((m) => typeof m !== "string" || m.length > 80)) {
    fail("BAD_PARAM", "memo must be ≤5 strings of ≤80 chars");
  }
  return memo as string[];
}

/** Locking script + value of a confirmed outpoint (sighash needs the real script). */
export async function lockingScriptOf(
  txid: string,
  vout: number,
  fetchFn: typeof fetch,
): Promise<{ scriptHex: string; value: number }> {
  let res: Response;
  try {
    res = await fetchFn(`${WOC_TX}/${txid}/hex`);
  } catch (e) {
    fail("RAILS", `tx fetch unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) fail("RAILS", `tx fetch failed (${res.status})`);
  const hex = (await res.text()).trim();
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(hex);
  } catch {
    fail("RAILS", "tx hex unparseable");
  }
  const out = tx.outputs[vout];
  if (!out || !out.lockingScript) fail("RAILS", `vout ${vout} missing from ${txid.slice(0, 12)}`);
  return { scriptHex: out.lockingScript.toHex(), value: out.satoshis ?? 0 };
}

export async function getBalance(chain: ChainProvider): Promise<{
  address: string; confirmed: number; unconfirmed: number; utxos: number;
}> {
  const address = selfAddress();
  const u = await chain.utxos(address);
  return { address, confirmed: u.confirmed, unconfirmed: u.unconfirmed, utxos: u.utxos.length };
}

/** Block-explorer link for a txid (mainnet). */
export function explorerTxUrl(txid: string): string {
  return `https://whatsonchain.com/tx/${txid}`;
}

/** Basename-only, single-line label fragment for file anchors. */
export function safeLabel(name: unknown, fallback: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\r\n\t]/g, " ").trim().slice(0, 80);
  return clean || fallback;
}

export async function anchorTip(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  sha256: string;
  label?: string;
}): Promise<{ txid: string; fee: number }> {
  if (!/^[0-9a-fA-F]{64}$/.test(opts.sha256)) {
    throw new Error("sha256 must be 64 hex chars");
  }
  // Build first so the policy gate (per-action caps, F9 agent budgets)
  // sees the real fee, not a zero estimate.
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const spent = await spentByUs(opts.db);
  const utxos: SpendableUtxo[] = u.utxos
    .filter((x) => !spent.has(`${x.txid.toLowerCase()}:${x.vout}`))
    .map((x) => ({ ...x, scriptHex: lock.toHex() }));
  const built = buildTx({
    utxos,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [],
    opReturn: ["BSVOS-ANCHOR", opts.sha256],
    changeScriptHex: lock.toHex(),
  });
  const gate = await check(opts.db, opts.origin, built.fee, "anchor");
  if (gate.verdict !== "allow") {
    const err = new Error(`denied: ${gate.reason}`) as Error & { code: string };
    err.code = "POLICY_DENY";
    throw err;
  }
  const { hex, txid } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, opts.label ?? `anchor ${opts.sha256.slice(0, 12)}`, hex);
  // F9: debit the agent budget only now — accepted broadcasts only.
  await recordSpend(opts.db, opts.origin, built.fee);
  // F4: attribute P2PKH-to-self change to the origin's basket (else default).
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const changeHex = lock.toHex();
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee };
}

/**
 * PocketPets cutover: multi-payment app spends with an optional OP_RETURN
 * memo (the game's action ledger rides in memos). Daemon-built from
 * page-supplied descriptions, funded only from inscription-free UTXOs,
 * policy-gated on the total leaving the wallet. Unlike sendSats (which
 * assumes plain P2PKH funding for the hot path), this verifies funding
 * scripts so an app can never melt the user's NFTs into fees.
 */
export async function spendTo(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  payments: Array<{ to: string; sats: number }>;
  memo?: string[];
  label?: string;
  /** Human meaning of the spend for the Jev decision state (from the app memo). */
  description?: string;
  fetchFn?: typeof fetch;
  /** Test/embedding Jev override, passed to the policy gate. */
  jev?: JevDecide;
}): Promise<{ txid: string; fee: number; hex: string }> {
  if (!Array.isArray(opts.payments) || !opts.payments.length) fail("BAD_PARAM", "payments required");
  const pays = opts.payments.map((p) => {
    try {
      p2pkhScript(p.to);
    } catch {
      fail("BAD_PARAM", "payment address must be a valid P2PKH address");
    }
    const sats = Math.floor(Number(p.sats) || 0);
    if (!(sats > 0)) fail("BAD_PARAM", "payment sats must be positive");
    return { address: p.to, sats };
  });
  const memo = checkMemo(opts.memo);
  const fetchFn = opts.fetchFn ?? fetch;
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const spent = await spentByUs(opts.db);
  const candidates = u.utxos
    .filter((x) => !spent.has(`${x.txid.toLowerCase()}:${x.vout}`) && x.value > 1)
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
  if (!funding.length) fail("INSUFFICIENT", "no plain funding UTXOs (everything is inscribed?)");
  const built = buildTx({
    utxos: funding,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: pays,
    opReturn: memo.length ? memo : undefined,
    changeScriptHex: lock.toHex(),
  });
  const total = pays.reduce((a, p) => a + p.sats, 0) + built.fee;
  const gate = await check(opts.db, opts.origin, total, "app-spend", {
    context: {
      label: opts.label,
      to: pays.length === 1 ? pays[0]!.address : `${pays.length} recipients`,
      ...(opts.description ? { description: opts.description } : {}),
    },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, opts.label ?? `app spend ${total} sats`, hex);
  await recordSpend(opts.db, opts.origin, total);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const changeHex = lock.toHex();
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee, hex };
}

/**
 * F5 ordinal send: move one inscribed sat to a P2PKH address. FIFO is
 * structural — the ordinal UTXO is inputs[0] and the 1-sat recipient
 * output is outputs[0], so the inscribed sat provably lands with the
 * recipient (no other 1-sat input is allowed in funding). Policy-gated
 * on the real fee like anchors; budgets debit on accept only.
 */
export async function sendOrdinal(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  txid: string;
  vout: number;
  to: string;
  memo?: string[];
}): Promise<{ txid: string; fee: number }> {
  const parts = splitOutpoint(`${opts.txid}_${opts.vout}`);
  if (!parts) throw Object.assign(new Error("outpoint must be 64-hex txid + vout"), { code: "BAD_PARAM" });
  let toScript: string;
  try {
    toScript = p2pkhScript(opts.to).toHex();
  } catch {
    throw Object.assign(new Error("recipient must be a valid P2PKH address"), { code: "BAD_PARAM" });
  }
  void toScript; // validated here; buildTx re-derives the script for the output
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const spent = await spentByUs(opts.db);
  const ordinal = u.utxos.find((x) => x.txid === parts.txid && x.vout === parts.vout && !spent.has(`${x.txid.toLowerCase()}:${x.vout}`));
  if (!ordinal) {
    throw Object.assign(new Error("ordinal not in wallet (unknown or already spent)"), { code: "NOT_FOUND" });
  }
  if (ordinal.value !== 1) {
    throw Object.assign(new Error(`ordinal carrier must be exactly 1 sat (found ${ordinal.value})`), { code: "BAD_PARAM" });
  }
  const funding = u.utxos.filter(
    (x) => !(x.txid === parts.txid && x.vout === parts.vout) && !spent.has(`${x.txid.toLowerCase()}:${x.vout}`) && x.value > 1,
  );
  const utxos: SpendableUtxo[] = [
    { ...ordinal, scriptHex: lock.toHex() },
    ...funding.map((x) => ({ ...x, scriptHex: lock.toHex() })),
  ];
  const memo = checkMemo(opts.memo);
  const built = buildTx({
    utxos,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [{ address: opts.to, sats: 1 }],
    opReturn: memo.length ? memo : undefined,
    changeScriptHex: lock.toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, built.fee, "ordinal-send", {
    context: { to: opts.to, label: `ordinal ${parts.txid.slice(0, 8)}:${parts.vout}` },
  });
  if (gate.verdict !== "allow") {
    const err = new Error(`denied: ${gate.reason}`) as Error & { code: string };
    err.code = "POLICY_DENY";
    throw err;
  }
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, `send ${parts.txid.slice(0, 8)} to ${opts.to.slice(0, 8)}`, hex);
  await recordSpend(opts.db, opts.origin, built.fee);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const changeHex = lock.toHex();
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee };
}

/**
 * F14 generic payment: move N sats to a P2PKH address. Policy and budgets
 * see the TOTAL leaving the wallet (payment + fee) — caps are per-action
 * ceilings on spend, not on fees. Tracked, labeled, and debited exactly
 * like every other accepted broadcast.
 */
export async function sendSats(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  to: string;
  sats: number;
  label?: string;
  context?: Partial<Omit<SpendContext, "origin" | "action" | "amountSats">>;
  jev?: JevDecide;
}): Promise<{ txid: string; fee: number; hex: string }> {
  const amount = Math.floor(Number(opts.sats) || 0);
  if (!(amount > 0)) throw Object.assign(new Error("amount must be a positive sat number"), { code: "BAD_PARAM" });
  try {
    p2pkhScript(opts.to);
  } catch {
    throw Object.assign(new Error("recipient must be a valid P2PKH address"), { code: "BAD_PARAM" });
  }
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const spent = await spentByUs(opts.db);
  const utxos: SpendableUtxo[] = u.utxos
    .filter((x) => !spent.has(`${x.txid.toLowerCase()}:${x.vout}`))
    .map((x) => ({ ...x, scriptHex: lock.toHex() }));
  const built = buildTx({
    utxos,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [{ address: opts.to, sats: amount }],
    changeScriptHex: lock.toHex(),
  });
  const total = amount + built.fee;
  const gate = await check(opts.db, opts.origin, total, "send", {
    context: { label: opts.label, to: opts.to, ...opts.context },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  if (gate.verdict !== "allow") {
    const err = new Error(`denied: ${gate.reason}`) as Error & { code: string };
    err.code = "POLICY_DENY";
    throw err;
  }
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, opts.label ?? `send ${amount} sats to ${opts.to.slice(0, 8)}`, hex);
  await recordSpend(opts.db, opts.origin, total);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const changeHex = lock.toHex();
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee, hex };
}

/**
 * F5 BSV21 send: move `amt` base units of one token to a P2PKH address.
 *
 * Protocol-aware per the bsv-20 spec (docs.1satordinals.com): the indexer
 * is the arbiter of spend state (bulk-validated holdings, unspent only),
 * every token output carries its own `transfer` inscription, and token
 * conservation is structural — recipient output first, token change
 * second, so outputs can never exceed inputs (any remainder we forgot
 * would burn, so the change output is mandatory, not optional).
 *
 * Sighash commits to the real carrier scripts (fetched, then cross-checked
 * against the indexer's amounts), and funding inputs are verified
 * inscription-free so we never melt an NFT or another token into fees.
 * Policy-gated on the fee like ordinal sends; tracked + labeled the same.
 */
export async function sendBsv21(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  tokenId: string;
  to: string;
  amt: string | number;
  fetchFn?: typeof fetch;
}): Promise<{ txid: string; fee: number; sent: string; change: string; tokenId: string }> {
  const tokenId = normalizeTokenId(opts.tokenId);
  if (!tokenId) fail("BAD_PARAM", "tokenId must be <64-hex-txid>_<vout>");
  try {
    p2pkhScript(opts.to);
  } catch {
    fail("BAD_PARAM", "recipient must be a valid P2PKH address");
  }
  const amtStr = parseTokenAmount(opts.amt);
  if (!amtStr) fail("BAD_PARAM", "amt must be a positive base-unit integer (no decimals)");
  const amt = BigInt(amtStr);
  const fetchFn = opts.fetchFn ?? fetch;

  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);

  // 1. Token carriers: the indexer decides what is unspent and ours.
  const holdings = await tokenHoldings(
    tokenId,
    u.utxos.map((x) => `${x.txid}_${x.vout}`),
    { fetchFn },
  );
  if (!holdings.length) fail("NOT_FOUND", `no unspent ${tokenId.slice(0, 12)} tokens in wallet`);
  holdings.sort((a, b) => (BigInt(b.amt) === BigInt(a.amt) ? 0 : BigInt(b.amt) > BigInt(a.amt) ? 1 : -1));
  const picked: TokenHolding[] = [];
  let have = BigInt(0);
  for (const h of holdings) {
    picked.push(h);
    have += BigInt(h.amt);
    if (have >= amt) break;
  }
  if (have < amt) fail("INSUFFICIENT", `have ${have} need ${amt} base units of ${tokenId.slice(0, 12)}`);

  // 2. Real carrier scripts (sighash commits to the envelope), verified
  // against the indexer's amounts; plain funding verified inscription-free.
  const taken = new Set(picked.map((h) => `${h.txid}:${h.vout}`));
  const spent = await spentByUs(opts.db);
  const fundCandidates = u.utxos
    .filter((x) => !taken.has(`${x.txid}:${x.vout}`) && !spent.has(`${x.txid.toLowerCase()}:${x.vout}`) && x.value > 1)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const [tokenScripts, fundScripts] = await Promise.all([
    Promise.all(picked.map((h) => lockingScriptOf(h.txid, h.vout, fetchFn))),
    Promise.all(fundCandidates.map((x) => lockingScriptOf(x.txid, x.vout, fetchFn).catch(() => null))),
  ]);
  const tokenInputs: SpendableUtxo[] = picked.map((h, i) => {
    const s = tokenScripts[i]!;
    const env = parseBsv21Envelope(s.scriptHex);
    if (
      !env || env.protocol !== BSV20_PROTOCOL || env.contentType !== BSV20_CONTENT_TYPE ||
      env.id !== tokenId || env.amt !== h.amt || s.value < 1
    ) {
      fail("RAILS", `carrier ${h.txid.slice(0, 8)}:${h.vout} disagrees with the indexer — aborted`);
    }
    return { txid: h.txid, vout: h.vout, value: s.value, scriptHex: s.scriptHex };
  });
  const funding: SpendableUtxo[] = [];
  for (let i = 0; i < fundCandidates.length && funding.length < 6; i++) {
    const s = fundScripts[i];
    if (!s || hasOrdEnvelope(s.scriptHex)) continue; // inscription carrier — hands off
    const c = fundCandidates[i]!;
    funding.push({ txid: c.txid, vout: c.vout, value: c.value, scriptHex: s.scriptHex });
  }

  // 3. Recipient output first, token change second (mandatory), sat change last.
  const remainder = have - amt;
  const recipientScript = bsv21TransferScript(opts.to, tokenId, amtStr);
  const payments: Array<{ address: string; sats: number; scriptHex?: string }> = [
    { address: opts.to, sats: 1, scriptHex: recipientScript },
  ];
  let tokenChangeScript: string | null = null;
  if (remainder > BigInt(0)) {
    tokenChangeScript = bsv21TransferScript(address, tokenId, remainder.toString());
    payments.push({ address, sats: 1, scriptHex: tokenChangeScript });
  }
  const built = buildTx({
    utxos: [...tokenInputs, ...funding],
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments,
    changeScriptHex: lock.toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, built.fee, "bsv21-send", {
    context: { to: opts.to, label: `bsv21 ${amtStr} ${tokenId.slice(0, 8)}` },
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, `bsv21 send ${amtStr} ${tokenId.slice(0, 8)} to ${opts.to.slice(0, 8)}`, hex);
  await recordSpend(opts.db, opts.origin, built.fee);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const ours = new Set([lock.toHex(), ...(tokenChangeScript ? [tokenChangeScript] : [])]);
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script !== undefined && ours.has(o.script))
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee, sent: amtStr, change: remainder.toString(), tokenId };
}

/** Cap on inscription payloads (apps mint pixel-art NFTs, not archives). */
export const MAX_INSCRIPTION_BYTES = 256 * 1024;

/**
 * F5/PocketPets inscribe: mint a 1-sat ordinal inscription (arbitrary
 * content-type + data) to an address, defaulting to self. Daemon-built
 * from page-supplied data, policy-gated on dust + fee, funded only from
 * inscription-free UTXOs. The page never touches keys.
 */
export async function inscribeMint(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  dataHex: string;
  contentType: string;
  to?: string;
  fee?: { to: string; sats: number };
  memo?: string[];
  label?: string;
  /** Human meaning of the spend for the Jev decision state (from the app memo). */
  description?: string;
  fetchFn?: typeof fetch;
  /** Test/embedding Jev override, passed to the policy gate. */
  jev?: JevDecide;
}): Promise<{ txid: string; fee: number; hex: string }> {
  const data = String(opts.dataHex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(data) || data.length < 2 || data.length > MAX_INSCRIPTION_BYTES * 2) {
    fail("BAD_PARAM", `dataHex must be hex, 1B-${MAX_INSCRIPTION_BYTES / 1024}KB`);
  }
  const contentType = String(opts.contentType ?? "").trim();
  if (!/^[\x21-\x7e]{1,128}$/.test(contentType) || contentType.includes(" ")) {
    fail("BAD_PARAM", "contentType must be 1-128 printable ASCII chars without spaces");
  }
  const to = (opts.to ?? "").trim() || selfAddress();
  try {
    p2pkhScript(to);
  } catch {
    fail("BAD_PARAM", "recipient must be a valid P2PKH address");
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const address = selfAddress();
  const lock = p2pkhScript(address);
  const u = await opts.chain.utxos(address);
  const spent = await spentByUs(opts.db);
  const candidates = u.utxos
    .filter((x) => !spent.has(`${x.txid.toLowerCase()}:${x.vout}`) && x.value > 1)
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
  if (!funding.length) fail("INSUFFICIENT", "no plain funding UTXOs (everything is inscribed?)");
  const script = inscriptionScript(to, contentType, data);
  const pays: Array<{ address: string; sats: number; scriptHex?: string }> = [
    { address: to, sats: 1, scriptHex: script },
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
    pays.push({ address: opts.fee.to, sats: feeSats });
  }
  const memo = checkMemo(opts.memo);
  const built = buildTx({
    utxos: funding,
    unlockFor: (x) => p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: pays,
    opReturn: memo.length ? memo : undefined,
    changeScriptHex: lock.toHex(),
  });
  const gate = await check(opts.db, opts.origin, 1 + feeSats + built.fee, "app-inscribe", {
    context: {
      label: opts.label, to,
      ...(opts.description ? { description: opts.description } : {}),
    },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, opts.label ?? `inscribe ${contentType} to ${to.slice(0, 8)}`, hex);
  await recordSpend(opts.db, opts.origin, built.fee);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const changeHex = lock.toHex();
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((o, vout) => ({ vout, script: o.lockingScript?.toHex(), value: o.satoshis ?? 0 }))
      .filter((o) => o.script === changeHex)
      .map((o) => ({ vout: o.vout, value: o.value, basket })),
  );
  return { txid: res.txid, fee: built.fee, hex };
}
