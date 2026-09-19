/**
 * OrdLock: the 1Sat ecosystem's covenant for trustless ordinal sales.
 *
 * The seller moves the 1-sat carrier into a lock script embedding the
 * cancel address, the payout (price + P2PKH script), and the sCrypt
 * contract. A buyer then spends the lock output (input 0, so the
 * inscription lands on output 0 per the indexer's FIFO rule) with
 * outputs [0] the 1-sat ordinal to themselves, [1] the byte-exact
 * payout, [2+] fee/memo/change. The contract enforces the payment — no
 * seller signature is needed at buy time. The seller can cancel back to
 * themselves with a plain signature + OP_1.
 *
 * Template bytes are the 1Sat ecosystem's (`@1sat/templates` /
 * `@1sat/types`); ported here so the daemon stays dependency-light.
 */
import {
  BigNumber,
  Hash,
  OP,
  P2PKH,
  Script,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type Transaction,
} from "@bsv/sdk";
import type { Knex } from "knex";
import type { ChainProvider } from "./chain.ts";
import { p2pkhUnlockHook, p2pkhUnlockHookOp1, selfAddress } from "./custody.ts";
import { buildTx, p2pkhScript, signTx, type SpendableUtxo } from "./tx.ts";
import { check } from "./policy.ts";
import { recordSpend } from "./agents.ts";
import { labelOutputs, resolveBasketForOrigin, spentByUs } from "./baskets.ts";
import { checkMemo, lockingScriptOf } from "./engine.ts";
import { fetchBulkMetadata, hasOrdEnvelope } from "./tokens.ts";
import { track } from "./monitor.ts";
import type { JevDecide } from "./jev.ts";

export const ORDLOCK_PREFIX =
  "2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000";
export const ORDLOCK_SUFFIX =
  "615179547a75537a537a537a0079537a75527a527a7575615579008763567901c161517957795779210ac407f0e4bd44bfc207355a778b046225a7068fc59ee7eda43ad905aadbffc800206c266b30e6a1319c66dc401e5bd6b432ba49688eecd118297041da8074ce081059795679615679aa0079610079517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e81517a75615779567956795679567961537956795479577995939521414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff00517951796151795179970079009f63007952799367007968517a75517a75517a7561527a75517a517951795296a0630079527994527a75517a6853798277527982775379012080517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01205279947f7754537993527993013051797e527e54797e58797e527e53797e52797e57797e0079517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a756100795779ac517a75517a75517a75517a75517a75517a75517a75517a75517a7561517a75517a756169587951797e58797eaa577961007982775179517958947f7551790128947f77517a75517a75618777777777777777777767557951876351795779a9876957795779ac777777777777777767006868";

const PREFIX_BYTES = Utils.toArray(ORDLOCK_PREFIX, "hex") as number[];
const SUFFIX_BYTES = Utils.toArray(ORDLOCK_SUFFIX, "hex") as number[];

function indexOf(arr: number[], sub: number[], from = 0): number {
  for (let i = from; i <= arr.length - sub.length; i++) {
    let found = true;
    for (let j = 0; j < sub.length; j++) {
      if (arr[i + j] !== sub[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

/** Serialized transaction output: 8-byte LE satoshis + varint script length + script. */
export function serializeOutput(satoshis: number, scriptBin: number[]): number[] {
  const writer = new Utils.Writer();
  writer.writeUInt64LEBn(new BigNumber(satoshis));
  writer.writeVarIntNum(scriptBin.length);
  writer.write(scriptBin);
  return writer.toArray();
}

/** Lock script embedding cancel address, payout, and the covenant. */
export function ordlockLockScript(cancelAddress: string, payAddress: string, price: number): Script {
  const cancelPkh = Utils.fromBase58Check(cancelAddress).data as number[];
  const payPkh = Utils.fromBase58Check(payAddress).data as number[];
  return new Script()
    .writeScript(Script.fromBinary(PREFIX_BYTES))
    .writeBin(cancelPkh)
    .writeBin(serializeOutput(price, new P2PKH().lock(payPkh).toBinary()))
    .writeScript(Script.fromBinary(SUFFIX_BYTES));
}

export interface OrdLockData {
  /** Address that may cancel (the seller). */
  cancelAddress: string;
  /** Price in sats the covenant enforces. */
  price: number;
  /** Byte-exact payout script (P2PKH to the seller). */
  payoutScriptHex: string;
  payout: number[];
}

export function isOrdLock(scriptHex: string): boolean {
  const bin = Utils.toArray(scriptHex, "hex") as number[];
  const p = indexOf(bin, PREFIX_BYTES);
  return p !== -1 && indexOf(bin, SUFFIX_BYTES, p + PREFIX_BYTES.length) !== -1;
}

/** Decode an OrdLock script; null when it is not one or is malformed. */
export function decodeOrdLock(scriptHex: string, mainnet = true): OrdLockData | null {
  try {
    const bin = Utils.toArray(scriptHex, "hex") as number[];
    const p = indexOf(bin, PREFIX_BYTES);
    if (p === -1) return null;
    const s = indexOf(bin, SUFFIX_BYTES, p + PREFIX_BYTES.length);
    if (s === -1) return null;
    const dataScript = Script.fromBinary(bin.slice(p + PREFIX_BYTES.length, s));
    const chunks = dataScript.chunks;
    if (chunks.length < 2) return null;
    const cancelChunk = chunks[0];
    if (!cancelChunk?.data || cancelChunk.data.length !== 20) return null;
    const payoutChunk = chunks[1];
    if (!payoutChunk?.data || payoutChunk.data.length < 9) return null;
    const payout = payoutChunk.data;
    let price = 0n;
    for (let i = 0; i < 8; i++) price |= BigInt(payout[i]!) << BigInt(i * 8);
    // varint script length after the 8-byte value
    let offset = 8;
    let scriptLen = payout[offset++]!;
    if (scriptLen >= 0xfd) {
      const bytes = scriptLen === 0xfd ? 2 : scriptLen === 0xfe ? 4 : 8;
      scriptLen = 0;
      for (let i = 0; i < bytes; i++) scriptLen += payout[offset + i]! * 2 ** (8 * i);
      offset += bytes;
    }
    if (scriptLen <= 0 || offset + scriptLen > payout.length) return null;
    const payoutScriptHex = payout
      .slice(offset, offset + scriptLen)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const prefix = mainnet ? [0x00] : [0x6f];
    return {
      cancelAddress: Utils.toBase58Check(cancelChunk.data, prefix),
      price: Number(price),
      payoutScriptHex,
      payout: Array.from(payout),
    };
  } catch {
    return null;
  }
}

/**
 * Purchase unlock: no signature. Serializes output 0, outputs 2+, and the
 * SIGHASH_ALL|ANYONECANPAY preimage so the contract can verify the payment.
 */
export function ordlockPurchaseUnlock(
  tx: Transaction,
  inputIndex: number,
  sourceSatoshis: number,
  lockingScript: Script,
): UnlockingScript {
  if (tx.outputs.length < 2) throw new Error("ordlock purchase needs at least 2 outputs");
  const script = new UnlockingScript().writeBin(
    serializeOutput(tx.outputs[0]!.satoshis ?? 0, tx.outputs[0]!.lockingScript!.toBinary()),
  );
  if (tx.outputs.length > 2) {
    const writer = new Utils.Writer();
    for (const output of tx.outputs.slice(2)) {
      writer.write(serializeOutput(output.satoshis ?? 0, output.lockingScript!.toBinary()));
    }
    script.writeBin(writer.toArray());
  } else {
    script.writeOpCode(OP.OP_0);
  }
  const input = tx.inputs[inputIndex]!;
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id("hex");
  if (!sourceTXID) throw new Error("ordlock purchase input has no source txid");
  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: [],
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: lockingScript,
    lockTime: tx.lockTime,
    scope: TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_ANYONECANPAY | TransactionSignature.SIGHASH_FORKID,
  });
  return script.writeBin(preimage).writeOpCode(OP.OP_0);
}

/** Funding: plain UTXOs, largest first, never inscribed carriers. */
async function plainFunding(
  db: Knex,
  chain: ChainProvider,
  fetchFn: typeof fetch,
  max = 6,
): Promise<SpendableUtxo[]> {
  const address = selfAddress();
  const u = await chain.utxos(address);
  const spent = await spentByUs(db);
  const candidates = u.utxos
    .filter((x) => x.value > 1 && !spent.has(`${x.txid.toLowerCase()}:${x.vout}`))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const scripts = await Promise.all(candidates.map((x) => lockingScriptOf(x.txid, x.vout, fetchFn).catch(() => null)));
  const funding: SpendableUtxo[] = [];
  for (let i = 0; i < candidates.length && funding.length < max; i++) {
    const s = scripts[i];
    if (!s || s.scriptHex.toLowerCase().includes("0063036f7264")) continue; // inscribed — hands off
    const c = candidates[i]!;
    funding.push({ txid: c.txid, vout: c.vout, value: c.value, scriptHex: s.scriptHex });
  }
  return funding;
}

/**
 * Seller: move the carrier into the lock script (an on-chain tx, miner
 * fee only). Returns the lock outpoint the market lists.
 */
export async function lockOrdinal(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  txid: string;
  vout: number;
  priceSats: number;
  cancelAddress?: string;
  payAddress?: string;
  fetchFn?: typeof fetch;
  jev?: JevDecide;
}): Promise<{ txid: string; lockOutpoint: string; fee: number }> {
  const parts = /^([0-9a-fA-F]{64})$/.exec(String(opts.txid ?? ""));
  const price = Math.floor(Number(opts.priceSats) || 0);
  if (!parts) fail("BAD_PARAM", "txid must be 64-hex");
  if (!(price >= 1)) fail("BAD_PARAM", "priceSats must be a positive sat number");
  const fetchFn = opts.fetchFn ?? fetch;
  const self = selfAddress();
  const cancelAddress = opts.cancelAddress ?? self;
  const payAddress = opts.payAddress ?? self;
  if (cancelAddress !== self) fail("BAD_PARAM", "cancelAddress must be this wallet (the daemon holds its key)");
  const carrier = await lockingScriptOf(parts![1]!.toLowerCase(), opts.vout, fetchFn);
  const ours = p2pkhScript(self).toHex().slice(0, 50).toLowerCase();
  if (!carrier.scriptHex.toLowerCase().startsWith(ours)) fail("NOT_OURS", "carrier is not ours");
  if (carrier.value !== 1) fail("BAD_PARAM", `carrier must be exactly 1 sat (found ${carrier.value})`);
  const spent = await spentByUs(opts.db);
  if (spent.has(`${parts![1]!.toLowerCase()}:${opts.vout}`)) {
    fail("BAD_PARAM", "carrier already spent by an in-flight transaction (indexers may not show it yet)");
  }
  if (!hasOrdEnvelope(carrier.scriptHex)) {
    // transferred inscriptions: the envelope stays at the origin, so ask ORDFS
    const key = `${parts![1]!.toLowerCase()}_${opts.vout}`;
    let meta: Record<string, { contentType?: string } | null>;
    try {
      meta = (await fetchBulkMetadata([key], { fetchFn })) as Record<string, { contentType?: string } | null>;
    } catch {
      fail("RAILS", "inscription lookup unreachable — cannot verify the carrier");
    }
    const m = meta![key] ?? meta![key.replace("_", ".")] ?? null;
    if (!m || !m.contentType) fail("BAD_PARAM", "carrier is not inscribed — refusing to lock plain dust");
  }
  const funding = await plainFunding(opts.db, opts.chain, fetchFn);
  const lockScript = ordlockLockScript(cancelAddress, payAddress, price);
  const built = buildTx({
    utxos: [
      { txid: parts![1]!.toLowerCase(), vout: opts.vout, value: 1, scriptHex: carrier.scriptHex },
      ...funding,
    ],
    unlockFor: (x) =>
      x.txid === parts![1]!.toLowerCase() && x.vout === opts.vout
        ? p2pkhUnlockHook("m/0/0", 1, Script.fromHex(carrier.scriptHex))
        : p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [{ sats: 1, scriptHex: lockScript.toHex() }],
    changeScriptHex: p2pkhScript(self).toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, built.fee, "ordlock-lock", {
    context: {
      label: `ordlock ${price} sats`,
      to: "ordlock",
      ...(opts.jev ? {} : {}),
    },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, `ordlock lock ${price} sats`, hex);
  await recordSpend(opts.db, opts.origin, built.fee);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((out, vout) => ({ vout, script: out.lockingScript?.toHex(), value: out.satoshis ?? 0 }))
      .filter((x) => x.script === p2pkhScript(self).toHex())
      .map((x) => ({ vout: x.vout, value: x.value, basket })),
  );
  return { txid: res.txid, lockOutpoint: `${res.txid}.0`, fee: built.fee };
}

/**
 * Buyer: spend the lock output. The covenant enforces the payout; the
 * daemon re-checks the decoded seller/price before funding anything.
 */
export async function buyOrdLock(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  lockOutpoint: string;
  fee?: { to: string; sats: number };
  memo?: string[];
  label?: string;
  description?: string;
  buyerChecks?: { expectedSeller?: string; maxPrice?: number };
  fetchFn?: typeof fetch;
  jev?: JevDecide;
}): Promise<{ txid: string; fee: number; priceSats: number }> {
  const parts = /^([0-9a-fA-F]{64})[._](\d+)$/.exec(String(opts.lockOutpoint ?? ""));
  if (!parts) fail("BAD_PARAM", "lockOutpoint must be <64-hex-txid>.<vout>");
  const fetchFn = opts.fetchFn ?? fetch;
  const lockTxid = parts![1]!.toLowerCase();
  const lockVout = Number(parts![2]);
  const lock = await lockingScriptOf(lockTxid, lockVout, fetchFn);
  if (lock.value !== 1) fail("BAD_OFFER", "lock output must be exactly 1 sat");
  const decoded = decodeOrdLock(lock.scriptHex);
  if (!decoded) fail("BAD_OFFER", "lock output is not a valid OrdLock");
  const price = decoded!.price;
  if (!(price >= 1)) fail("BAD_OFFER", "lock price must be positive");
  const checks = opts.buyerChecks ?? {};
  if (checks.expectedSeller !== undefined) {
    let want = "";
    try {
      want = p2pkhScript(checks.expectedSeller).toHex();
    } catch {
      fail("BAD_PARAM", "buyerChecks.expectedSeller must be a valid P2PKH address");
    }
    if (decoded!.payoutScriptHex.toLowerCase() !== want.toLowerCase()) {
      fail("BAD_OFFER", "lock payout does not pay the expected seller");
    }
  }
  if (checks.maxPrice !== undefined) {
    const max = Math.floor(Number(checks.maxPrice));
    if (!Number.isFinite(max) || max < 0) fail("BAD_PARAM", "buyerChecks.maxPrice must be a non-negative sat number");
    if (price > max) fail("BAD_OFFER", `lock price ${price} exceeds buyer max ${max}`);
  }
  const self = selfAddress();
  const funding = await plainFunding(opts.db, opts.chain, fetchFn);
  const lockScript = Script.fromHex(lock.scriptHex);
  const payments: Array<{ address?: string; sats: number; scriptHex?: string }> = [
    { address: self, sats: 1 }, // [0] the ordinal (FIFO: lock is input 0)
    { sats: price, scriptHex: decoded!.payoutScriptHex }, // [1] byte-exact payout
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
    utxos: [{ txid: lockTxid, vout: lockVout, value: 1, scriptHex: lock.scriptHex }, ...funding],
    unlockFor: (x) =>
      x.txid === lockTxid && x.vout === lockVout
        ? {
            sign: async (tx: Transaction, i: number) => ordlockPurchaseUnlock(tx, i, 1, lockScript),
          }
        : p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments,
    opReturn: memo.length ? memo : undefined,
    changeScriptHex: p2pkhScript(self).toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, price + feeSats + built.fee, "ordlock-buy", {
    context: {
      label: opts.label,
      to: `${lockTxid.slice(0, 8)} lock`,
      ...(opts.description ? { description: opts.description } : {}),
    },
    ...(opts.jev ? { jev: opts.jev } : {}),
  });
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, opts.label ?? `ordlock buy ${price} sats from ${lockTxid.slice(0, 8)}`, hex);
  await recordSpend(opts.db, opts.origin, price + built.fee);
  const basket = await resolveBasketForOrigin(opts.db, opts.origin);
  const ours = new Set([p2pkhScript(self).toHex()]);
  await labelOutputs(
    opts.db,
    res.txid,
    built.tx.outputs
      .map((out, vout) => ({ vout, script: out.lockingScript?.toHex(), value: out.satoshis ?? 0 }))
      .filter((x) => x.script !== undefined && ours.has(x.script))
      .map((x) => ({ vout: x.vout, value: x.value, basket })),
  );
  return { txid: res.txid, fee: built.fee, priceSats: price };
}

/** Seller: cancel the lock back to the wallet (miner fee only). */
export async function cancelOrdLock(opts: {
  db: Knex;
  chain: ChainProvider;
  origin: string;
  lockOutpoint: string;
  fetchFn?: typeof fetch;
}): Promise<{ txid: string; fee: number }> {
  const parts = /^([0-9a-fA-F]{64})[._](\d+)$/.exec(String(opts.lockOutpoint ?? ""));
  if (!parts) fail("BAD_PARAM", "lockOutpoint must be <64-hex-txid>.<vout>");
  const fetchFn = opts.fetchFn ?? fetch;
  const lockTxid = parts![1]!.toLowerCase();
  const lockVout = Number(parts![2]);
  const lock = await lockingScriptOf(lockTxid, lockVout, fetchFn);
  const decoded = decodeOrdLock(lock.scriptHex);
  if (!decoded) fail("BAD_OFFER", "lock output is not a valid OrdLock");
  const self = selfAddress();
  if (decoded!.cancelAddress !== self) fail("NOT_OURS", "lock is not cancellable by this wallet");
  const funding = await plainFunding(opts.db, opts.chain, fetchFn);
  const lockScript = Script.fromHex(lock.scriptHex);
  const built = buildTx({
    utxos: [{ txid: lockTxid, vout: lockVout, value: 1, scriptHex: lock.scriptHex }, ...funding],
    unlockFor: (x) =>
      x.txid === lockTxid && x.vout === lockVout
        ? p2pkhUnlockHookOp1("m/0/0", 1, lockScript)
        : p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!)),
    payments: [{ address: self, sats: 1 }],
    changeScriptHex: p2pkhScript(self).toHex(),
    keepOrder: true,
  });
  const gate = await check(opts.db, opts.origin, built.fee, "ordlock-cancel");
  if (gate.verdict !== "allow") fail("POLICY_DENY", `denied: ${gate.reason}`);
  const { hex } = await signTx(built.tx);
  const res = await opts.chain.broadcast(hex);
  await track(opts.db, res.txid, `ordlock cancel ${lockTxid.slice(0, 8)}`, hex);
  await recordSpend(opts.db, opts.origin, built.fee);
  return { txid: res.txid, fee: built.fee };
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
