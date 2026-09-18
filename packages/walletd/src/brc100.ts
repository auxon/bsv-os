/**
 * BRC-100 WalletInterface façade: the OS wallet speaks the standard
 * wallet-to-application contract
 * (https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md)
 * over its own custody, policy, chain, and storage — one wallet, one pot,
 * one approval model, no second key universe.
 *
 * Transport: the daemon serves standard binary wire frames
 * (`WalletWireProcessor`) at POST /w/:call. Third-party apps use an
 * off-the-shelf `WalletClient` pointed at the loopback URL; the Origin
 * header (browser-stamped, unspoofable) is the policy originator, and any
 * frame originator that disagrees with it is rejected.
 *
 * Coverage notes (honest deltas from a from-scratch reference wallet):
 * - spends: every sat leaving the wallet (outputs not paying us, plus
 *   fees) is policy-gated under the originator and tracked+labeled like
 *   any other daemon spend. Reads, receives, crypto, and cert holds are
 *   free once the wallet is unlocked.
 * - `sendWith` / `noSendChange` batching: rejected, not silently mangled.
 *   `noSend` staging, sign-later references, and `randomizeOutputs` work.
 * - change lands in a `change` basket (BRC-99 forbids `default`); labels
 *   and tags are trimmed, baskets trimmed+lowercased per the reference.
 * - `privileged` mode: rejected everywhere (single keyring by design).
 * - certificates map onto the cert wallet: `direct` acquisition only
 *   (no issuance round-trips), plaintext selective disclosure (no BRC-52
 *   field encryption), local revocation (zero revocation outpoint).
 * - `trustSelf`/`knownTxids` accepted trivially: scripts resolve through
 *   our own chain source, the same trust anchor as every other flow.
 * - key linkage revelations use the exact reference construction
 *   (raw secret + Schnorr proof, AES-GCM to the verifier).
 * - error messages are prefixed with our code (`CODE: detail`) because
 *   the wire flattens codes to numeric; the RPC layer keeps them
 *   structured.
 */
import type { Knex } from "knex";
import { randomBytes } from "node:crypto";
import { Beef, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import {
  brc42Decrypt,
  brc42Encrypt,
  brc42Hmac,
  brc42SignData,
  brc42SignHash,
  brc42Verify,
  brc42VerifyDigest,
  brc42VerifyHmac,
  derivePublicKey,
  getStatus,
  identityPubkeyHex,
  p2pkhUnlockHook,
  revealCounterpartyLinkage,
  revealSpecificLinkage,
  selfAddress,
} from "./custody.ts";
import type { Counterparty, WalletProtocol } from "@bsv/sdk";
import type { ChainProvider } from "./chain.ts";
import { buildTx, p2pkhScript, signTx, type SpendableUtxo } from "./tx.ts";
import { check } from "./policy.ts";
import { labelOutputs, resolveBasketForOrigin } from "./baskets.ts";
import { getCert, listCerts, putCert, revokeCert, showCert } from "./certs.ts";
import { checkMemo, lockingScriptOf } from "./engine.ts";
import { hasOrdEnvelope } from "./tokens.ts";
import { track } from "./monitor.ts";

export const BRC100_VERSION = "bsvos-0.1.0";
const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const STAGED_TTL_MS = 30 * 60 * 1000;

type FetchFn = typeof fetch;

function brcErr(code: string, description: string): never {
  throw Object.assign(new Error(`${code}: ${description}`), { code });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s);
}

function isTxid(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

function isPubkey(s: string): boolean {
  return /^[0-9a-fA-F]{66}$/.test(s);
}

function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-fA-F]{64})[_.](\d+)$/.exec((outpoint ?? "").trim());
  if (!m) return null;
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) };
}

const dotOutpoint = (txid: string, vout: number): string => `${txid.toLowerCase()}.${vout}`;

function checkCounterparty(v: unknown, field: string): string {
  const s = str(v);
  if (s === "self" || s === "anyone") return s;
  if (!isPubkey(s)) brcErr("BAD_PARAM", `${field} must be self, anyone, or a 33-byte compressed pubkey`);
  return s.toLowerCase();
}

function checkProtocolID(v: unknown): WalletProtocol {
  if (!Array.isArray(v) || v.length !== 2) brcErr("BAD_PARAM", "protocolID must be [securityLevel, name]");
  const [level, name] = v as unknown[];
  if (level !== 0 && level !== 1 && level !== 2) brcErr("BAD_PARAM", "protocolID security level must be 0, 1, or 2");
  const n = str(name);
  if (n.length < 5 || n.length > 400) brcErr("BAD_PARAM", "protocolID name must be 5-400 chars");
  if (n !== n.toLowerCase() || /[^a-z0-9 ]/.test(n)) brcErr("BAD_PARAM", "protocolID name must be lowercase letters, numbers, spaces");
  if (/  /.test(n)) brcErr("BAD_PARAM", "protocolID name must not contain consecutive spaces");
  if (n.endsWith(" protocol")) brcErr("BAD_PARAM", "protocolID name must not end with ' protocol'");
  if (n.startsWith("p ")) brcErr("BAD_PARAM", "protocolID name must not start with 'p '");
  return [level, n] as WalletProtocol;
}

function checkKeyID(v: unknown): string {
  const s = str(v);
  const len = Buffer.byteLength(s, "utf8");
  if (len < 1 || len > 800) brcErr("BAD_PARAM", "keyID must be 1-800 bytes");
  return s;
}

function checkBasket(v: unknown): string {
  const s = str(v).trim().toLowerCase();
  if (s.length < 5 || s.length > 300) brcErr("BAD_PARAM", "basket must be 5-300 chars");
  if (/[^a-z0-9 ]/.test(s)) brcErr("BAD_PARAM", "basket must be lowercase letters, numbers, spaces");
  if (/  /.test(s)) brcErr("BAD_PARAM", "basket must not contain consecutive spaces");
  if (s.endsWith(" basket")) brcErr("BAD_PARAM", "basket must not end with ' basket'");
  if (s.startsWith("admin") || s === "default" || s.startsWith("p ")) {
    brcErr("BAD_PARAM", "basket name is reserved");
  }
  return s;
}

function checkLabelList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) brcErr("BAD_PARAM", `${field} must be an array`);
  return (v as unknown[]).map((l) => {
    const s = str(l).trim();
    if (!s || Buffer.byteLength(s, "utf8") > 300) brcErr("BAD_PARAM", `${field} entries must be 1-300 bytes`);
    return s;
  });
}

function checkDescription(v: unknown, min: number, max: number, field: string): string {
  const s = str(v);
  if (s.length < min || s.length > max) brcErr("BAD_PARAM", `${field} must be ${min}-${max} chars`);
  return s;
}

function checkSats(v: unknown, field: string): number {
  const n = num(v);
  if (!Number.isInteger(n) || n < 0 || n > 2100000000000000) brcErr("BAD_PARAM", `${field} must be 0-2.1e15 sats`);
  return n;
}

function checkBytes(v: unknown, field: string): number[] {
  if (!Array.isArray(v)) brcErr("BAD_PARAM", `${field} must be a byte array`);
  const arr = v as unknown[];
  if (arr.some((b) => typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255)) {
    brcErr("BAD_PARAM", `${field} must be bytes 0-255`);
  }
  return arr as number[];
}

function noPrivileged(args: Record<string, unknown>): void {
  if (args.privileged === true) brcErr("NOT_SUPPORTED", "privileged mode is not supported (single keyring by design)");
}

function b64decode(raw: string, field: string): string {
  if (!raw) brcErr("BAD_PARAM", `${field} must be base64`);
  try {
    const s = Buffer.from(raw, "base64").toString("utf8");
    if (!s) brcErr("BAD_PARAM", `${field} must be base64`);
    return s;
  } catch {
    brcErr("BAD_PARAM", `${field} must be base64`);
  }
}

function b64encode(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64");
}

interface WalletCertView {
  id: string;
  type: string;
  certifier: string;
  subject: string;
  fields: Record<string, string>;
  signature: string | null;
  revoked: boolean;
}

/**
 * Our cert rows onto the wire certificate shape. Documented deltas: the
 * serial number IS the deterministic store id (base64), and revocation is
 * local (zero revocation outpoint) rather than UTXO-anchored.
 */
function toWalletCert(c: WalletCertView): Record<string, unknown> {
  return {
    type: b64encode(c.type),
    subject: c.subject,
    serialNumber: b64encode(c.id),
    certifier: c.certifier,
    revocationOutpoint: `${"0".repeat(64)}.0`,
    signature: c.signature ?? "",
    fields: { ...c.fields },
  };
}

export async function migrateBrc100(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable("brc100_pending"))) {
    await db.schema.createTable("brc100_pending", (t) => {
      t.string("reference", 64).primary();
      t.text("tx_hex").notNullable();
      t.text("context").notNullable(); // staged construction JSON
      t.string("status").notNullable().defaultTo("unsigned"); // unsigned|nosend
      t.string("description").notNullable().defaultTo("");
      t.text("labels").notNullable().defaultTo("[]");
      t.string("originator").notNullable().defaultTo("");
      t.integer("created_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("brc100_actions"))) {
    await db.schema.createTable("brc100_actions", (t) => {
      t.string("txid", 64).primary();
      t.string("description").notNullable().defaultTo("");
      t.text("labels").notNullable().defaultTo("[]");
      t.string("status").notNullable().defaultTo("sending"); // sending|completed|failed|nosend
      t.integer("satoshis").notNullable().defaultTo(0);
      t.integer("is_outgoing").notNullable().defaultTo(1);
      t.integer("version").notNullable().defaultTo(2);
      t.integer("locktime").notNullable().defaultTo(0);
      t.text("context").nullable(); // inputs/outputs JSON for listActions includes
      t.string("originator").notNullable().defaultTo("");
      t.integer("created_at").notNullable();
      t.integer("updated_at").notNullable();
    });
  }
  if (!(await db.schema.hasTable("brc100_outputs"))) {
    await db.schema.createTable("brc100_outputs", (t) => {
      t.string("outpoint", 80).primary(); // txid_vout canonical
      t.string("txid", 64).notNullable();
      t.integer("vout").notNullable();
      t.integer("satoshis").notNullable();
      t.text("script_hex").notNullable();
      t.string("basket").notNullable();
      t.text("tags").notNullable().defaultTo("[]");
      t.text("custom_instructions").nullable();
      t.integer("mine").notNullable().defaultTo(1);
      t.string("spent_by", 64).nullable();
      t.string("originator").notNullable().defaultTo("");
      t.integer("created_at").notNullable();
    });
  }
}

export interface Brc100Context {
  db: Knex;
  chain: ChainProvider;
  fetchFn: FetchFn;
}

interface StagedInput {
  txid: string;
  vout: number;
  scriptHex: string;
  value: number;
  unlockHex: string | null;
  unlockingScriptLength?: number;
  sequence: number;
  description: string;
  mine: boolean;
}

interface StagedOutput {
  scriptHex: string;
  sats: number;
  basket: string;
  tags: string[];
  customInstructions: string;
  description: string;
  mine: boolean;
}

interface StagedContext {
  inputs: StagedInput[];
  outputs: StagedOutput[];
  funding: Array<{ txid: string; vout: number; value: number; scriptHex: string }>;
  version: number;
  lockTime: number;
  labels: string[];
  description: string;
  origin: string;
  external: number;
  fee: number;
}

async function wocJson(fetchFn: FetchFn, path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${WOC}${path}`);
  } catch (e) {
    brcErr("RAILS", `chain read unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) brcErr("RAILS", `chain read failed (${res.status})`);
  return res.json().catch(() => ({}));
}

/** True when the script pays our wallet (plain or inscribed to us). */
function isOurScript(scriptHex: string, oursPrefix: string): boolean {
  return scriptHex.toLowerCase().startsWith(oursPrefix.toLowerCase());
}

function ourPrefix(address: string): string {
  return p2pkhScript(address).toHex().slice(0, 50);
}

function toAtomicBeef(tx: Transaction): number[] {
  return Array.from(tx.toAtomicBEEF(true));
}

/** Materialize empty scripts so partial txs serialize (templates don't). */
function ensureScripts(tx: Transaction): void {
  for (const input of tx.inputs) {
    if (!input.unlockingScript) input.unlockingScript = new UnlockingScript();
  }
}

function parseAtomicBeef(raw: unknown): Transaction {
  const bytes = checkBytes(raw, "tx");
  let beef: Beef;
  try {
    beef = Beef.fromBinary(bytes);
  } catch {
    brcErr("BAD_PARAM", "tx must be AtomicBEEF bytes");
  }
  if (!beef.txs.length) brcErr("BAD_PARAM", "BEEF has no transactions");
  const subject = beef.txs[beef.txs.length - 1]!;
  if (!subject.tx) brcErr("BAD_PARAM", "BEEF subject has no transaction");
  return beef.findTransactionForSigning(subject.txid)!;
}

function randomReference(): string {
  return randomBytes(32).toString("base64");
}

export interface Brc100Wallet {
  [method: string]: (args: Record<string, unknown>, originator?: string) => Promise<unknown>;
}

export function createBrc100Wallet(ctx: Brc100Context): Brc100Wallet {
  const { db, chain, fetchFn } = ctx;

  async function needUnlocked(): Promise<{ address: string }> {
    const s = await getStatus();
    if (!s.hasWallet) brcErr("NO_WALLET", "no wallet enrolled — call createWallet first");
    if (s.locked) brcErr("WALLET_LOCKED", "wallet locked");
    return { address: selfAddress() };
  }

  async function monitorStatus(txid: string): Promise<string | null> {
    const row = (await db("pending_txs").where({ txid }).first()) as { status?: string } | undefined;
    return row?.status ?? null;
  }

  function displayStatus(stored: string | null, txid: string, monitor: string | null): string {
    if (stored === "unsigned") return "unsigned";
    if (stored === "nosend") return "nosend";
    if (monitor === "mined") return "completed";
    if (monitor === "failed") return "failed";
    if (monitor === "seen") return "sending";
    void txid;
    return "unproven";
  }

  async function markSpent(inputs: Array<{ txid: string; vout: number }>, byTxid: string): Promise<void> {
    for (const i of inputs) {
      await db("brc100_outputs").where({ outpoint: `${i.txid}_${i.vout}` }).update({ spent_by: byTxid });
    }
  }

  async function afterBroadcast(
    txid: string,
    hex: string,
    context: StagedContext,
    status: string,
    built: { fee: number; changeSats: number; changeVout: number },
    opts: { recordOutputs: boolean } = { recordOutputs: true },
  ): Promise<void> {
    const now = Date.now();
    const ours = ourPrefix(selfAddress());
    if (opts.recordOutputs) {
      await track(db, txid, `brc100 ${context.description.slice(0, 40)}`, hex);
      await markSpent(context.inputs.map((i) => ({ txid: i.txid, vout: i.vout })), txid);
    }
    const tx = Transaction.fromHex(hex);
    let outSum = 0;
    let outgoing = false;
    for (let i = 0; i < context.outputs.length; i++) {
      const o = context.outputs[i]!;
      outSum += o.sats;
      if (!isOurScript(o.scriptHex, ours)) outgoing = true;
      if (!o.basket || !opts.recordOutputs) continue;
      await db("brc100_outputs")
        .insert({
          outpoint: `${txid}_${i}`, txid, vout: i, satoshis: o.sats, script_hex: o.scriptHex,
          basket: o.basket, tags: JSON.stringify(o.tags),
          custom_instructions: o.customInstructions || null,
          mine: o.mine ? 1 : 0,
          spent_by: null, originator: context.origin, created_at: now,
        })
        .onConflict("outpoint")
        .merge();
    }
    const labeled: Array<{ vout: number; value: number; basket: string }> = [];
    const basket = await resolveBasketForOrigin(db, context.origin);
    if (built.changeVout >= 0) {
      // Change row comes from the context loop above (appended at build);
      // only the money-basket label needs the built index.
      const changeOut = tx.outputs[built.changeVout];
      labeled.push({ vout: built.changeVout, value: changeOut?.satoshis ?? 0, basket });
    }
    await labelOutputs(db, txid, labeled);
    await db("brc100_actions")
      .insert({
        txid, description: context.description, labels: JSON.stringify(context.labels),
        status, satoshis: outSum, is_outgoing: outgoing ? 1 : 0,
        version: context.version, locktime: context.lockTime,
        context: JSON.stringify({ inputs: context.inputs, outputs: context.outputs }),
        originator: context.origin, created_at: now, updated_at: now,
      })
      .onConflict("txid")
      .merge({ status, updated_at: now });
  }

  const wallet: Brc100Wallet = {
    isAuthenticated: async () => {
      const s = await getStatus();
      return { authenticated: s.hasWallet && !s.locked };
    },
    waitForAuthentication: async (args) => {
      const timeoutMs = args.timeoutMs === undefined ? 60000 : Math.floor(Number(args.timeoutMs) || 0);
      if (!(timeoutMs >= 0)) brcErr("BAD_PARAM", "timeoutMs must be non-negative");
      const deadline = Date.now() + Math.min(timeoutMs, 300000);
      for (;;) {
        const s = await getStatus();
        if (s.hasWallet && !s.locked) return {};
        if (Date.now() >= deadline) brcErr("TIMEOUT", "authentication timed out");
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    getVersion: async () => ({ version: BRC100_VERSION }),
    getNetwork: async () => ({ network: "mainnet" }),
    getHeight: async () => {
      const info = (await wocJson(fetchFn, "/chain/info")) as { blocks?: unknown };
      const height = Math.floor(Number(info.blocks) || 0);
      if (!(height > 0)) brcErr("RAILS", "chain height unavailable");
      return { height };
    },
    getHeader: async (args) => {
      const height = Math.floor(Number(args.height) || 0);
      if (!(height > 0)) brcErr("BAD_PARAM", "height must be positive");
      const b = (await wocJson(fetchFn, `/block/height/${height}`)) as Record<string, unknown>;
      const num = (k: string): number => Math.floor(Number(b[k]) || 0);
      const hex = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");
      const version = num("version");
      const prev = hex("previousblockhash");
      const root = hex("merkleroot");
      const time = num("time");
      const nonce = num("nonce");
      let bits = 0;
      if (typeof b.bits === "string" && /^[0-9a-fA-F]+$/.test(b.bits)) bits = parseInt(b.bits, 16);
      else bits = num("bits");
      if (!isTxid(prev) || !isTxid(root) || !(time > 0) || !(bits > 0)) brcErr("RAILS", "chain header unavailable");
      const w = Buffer.alloc(80);
      w.writeUInt32LE(version, 0);
      Buffer.from(prev, "hex").reverse().copy(w, 4);
      Buffer.from(root, "hex").reverse().copy(w, 36);
      w.writeUInt32LE(time, 68);
      w.writeUInt32LE(bits >>> 0, 72);
      w.writeUInt32LE(nonce >>> 0, 76);
      return { header: w.toString("hex") };
    },
    getPublicKey: async (args) => {
      noPrivileged(args);
      if (args.identityKey === true) return { publicKey: identityPubkeyHex() };
      if (args.protocolID === undefined || args.keyID === undefined || args.keyID === "") {
        brcErr("BAD_PARAM", "protocolID and keyID are required if identityKey is false or undefined");
      }
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const counterparty = args.counterparty === undefined ? "self" : checkCounterparty(args.counterparty, "counterparty");
      return { publicKey: derivePublicKey(protocolID, keyID, counterparty, args.forSelf === true) };
    },
    revealCounterpartyKeyLinkage: async (args) => {
      noPrivileged(args);
      const counterparty = checkCounterparty(args.counterparty, "counterparty");
      const verifier = checkCounterparty(args.verifier, "verifier");
      if (counterparty === "self" || counterparty === "anyone") brcErr("BAD_PARAM", "counterparty must be a public key");
      const r = revealCounterpartyLinkage(counterparty, verifier);
      return {
        prover: r.prover, verifier: r.verifier, counterparty: r.counterparty,
        revelationTime: r.revelationTime,
        encryptedLinkage: r.encryptedLinkage, encryptedLinkageProof: r.encryptedLinkageProof,
      };
    },
    revealSpecificKeyLinkage: async (args) => {
      noPrivileged(args);
      const counterparty = checkCounterparty(args.counterparty, "counterparty");
      const verifier = checkCounterparty(args.verifier, "verifier");
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const r = revealSpecificLinkage(counterparty, verifier, protocolID, keyID);
      return {
        prover: r.prover, verifier: r.verifier, counterparty: r.counterparty,
        protocolID: r.protocolID, keyID: r.keyID,
        encryptedLinkage: r.encryptedLinkage, encryptedLinkageProof: r.encryptedLinkageProof,
        proofType: r.proofType,
      };
    },
    encrypt: async (args) => {
      noPrivileged(args);
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const counterparty = args.counterparty === undefined ? "self" : checkCounterparty(args.counterparty, "counterparty");
      const plaintext = checkBytes(args.plaintext, "plaintext");
      await needUnlocked();
      return { ciphertext: brc42Encrypt(protocolID, keyID, counterparty, plaintext) };
    },
    decrypt: async (args) => {
      noPrivileged(args);
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const counterparty = args.counterparty === undefined ? "self" : checkCounterparty(args.counterparty, "counterparty");
      const ciphertext = checkBytes(args.ciphertext, "ciphertext");
      await needUnlocked();
      try {
        return { plaintext: brc42Decrypt(protocolID, keyID, counterparty, ciphertext) };
      } catch {
        brcErr("INVALID_CIPHERTEXT", "decryption failed (wrong key or tampered data)");
      }
    },
    createHmac: async (args) => {
      noPrivileged(args);
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const counterparty = args.counterparty === undefined ? "self" : checkCounterparty(args.counterparty, "counterparty");
      const data = checkBytes(args.data, "data");
      await needUnlocked();
      return { hmac: brc42Hmac(protocolID, keyID, counterparty, data) };
    },
    verifyHmac: async (args) => {
      noPrivileged(args);
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const counterparty = args.counterparty === undefined ? "self" : checkCounterparty(args.counterparty, "counterparty");
      const data = checkBytes(args.data, "data");
      const hmac = checkBytes(args.hmac, "hmac");
      await needUnlocked();
      if (!brc42VerifyHmac(protocolID, keyID, counterparty, data, hmac)) {
        brcErr("INVALID_HMAC", "HMAC is not valid");
      }
      return { valid: true };
    },
    createSignature: async (args) => {
      noPrivileged(args);
      if (args.hashToDirectlySign === undefined && args.data === undefined) {
        brcErr("BAD_PARAM", "args.data or args.hashToDirectlySign must be valid");
      }
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const counterparty = args.counterparty === undefined ? "anyone" : checkCounterparty(args.counterparty, "counterparty");
      await needUnlocked();
      if (args.hashToDirectlySign !== undefined) {
        const hash = checkBytes(args.hashToDirectlySign, "hashToDirectlySign");
        if (hash.length !== 32) brcErr("BAD_PARAM", "hashToDirectlySign must be 32 bytes");
        return { signature: brc42SignHash(protocolID, keyID, counterparty, hash) };
      }
      return { signature: brc42SignData(protocolID, keyID, counterparty, checkBytes(args.data, "data")) };
    },
    verifySignature: async (args) => {
      noPrivileged(args);
      if (args.hashToDirectlyVerify === undefined && args.data === undefined) {
        brcErr("BAD_PARAM", "args.data or args.hashToDirectlyVerify must be valid");
      }
      const protocolID = checkProtocolID(args.protocolID);
      const keyID = checkKeyID(args.keyID);
      const counterparty = args.counterparty === undefined ? "anyone" : checkCounterparty(args.counterparty, "counterparty");
      const signature = checkBytes(args.signature, "signature");
      await needUnlocked();
      let valid = false;
      try {
        valid = args.hashToDirectlyVerify !== undefined
          ? brc42VerifyDigest(protocolID, keyID, counterparty, args.forSelf === true, checkBytes(args.hashToDirectlyVerify, "hashToDirectlyVerify"), signature)
          : brc42Verify(protocolID, keyID, counterparty, args.forSelf === true, checkBytes(args.data, "data"), signature);
      } catch {
        valid = false;
      }
      if (!valid) brcErr("INVALID_SIGNATURE", "Signature is not valid");
      return { valid: true };
    },
    createAction: async (args, originator) => {
      const origin = str(originator) || "unknown";
      const description = checkDescription(args.description, 5, 2000, "description");
      const labels = checkLabelList(args.labels, "labels");
      const options = (args.options && typeof args.options === "object" ? args.options : {}) as Record<string, unknown>;
      if (options.sendWith !== undefined || options.noSendChange !== undefined) {
        brcErr("NOT_SUPPORTED", "sendWith/noSendChange batching is not supported (single actions only)");
      }
      if (options.trustSelf !== undefined && options.trustSelf !== "known") {
        brcErr("BAD_PARAM", "trustSelf must be 'known'");
      }
      const rawInputs = Array.isArray(args.inputs) ? (args.inputs as Record<string, unknown>[]) : [];
      if (rawInputs.length > 30) brcErr("BAD_PARAM", "at most 30 explicit inputs supported");
      const shaped: Array<{
        txid: string; vout: number; inputDescription: string;
        sequence: number; unlockHex: string | null; unlockingScriptLength?: number;
      }> = [];
      for (const [i, raw] of rawInputs.entries()) {
        if (!raw || typeof raw !== "object") brcErr("BAD_PARAM", `inputs[${i}] must be an object`);
        const parts = splitOutpoint(str(raw.outpoint));
        if (!parts || !Number.isInteger(parts.vout) || parts.vout > 0xffffffff) brcErr("BAD_PARAM", `inputs[${i}].outpoint must be <txid>.<vout>`);
        if (shaped.some((s) => s.txid === parts.txid && s.vout === parts.vout)) brcErr("BAD_PARAM", `inputs[${i}] duplicates an outpoint`);
        const inputDescription = checkDescription(raw.inputDescription, 5, 2000, `inputs[${i}].inputDescription`);
        const sequence = raw.sequenceNumber === undefined ? 0xffffffff : Math.floor(Number(raw.sequenceNumber) || 0);
        if (!(sequence >= 0 && sequence <= 0xffffffff)) brcErr("BAD_PARAM", `inputs[${i}].sequenceNumber out of range`);
        const unlockHex = raw.unlockingScript === undefined ? null : str(raw.unlockingScript).toLowerCase();
        if (unlockHex !== null && (!isHex(unlockHex) || unlockHex.length % 2 !== 0)) brcErr("BAD_PARAM", `inputs[${i}].unlockingScript must be hex`);
        const unlockingScriptLength = raw.unlockingScriptLength === undefined ? undefined : num(raw.unlockingScriptLength);
        if (unlockingScriptLength !== undefined) {
          if (!Number.isInteger(unlockingScriptLength) || unlockingScriptLength < 1 || unlockingScriptLength > 0xffffffff) {
            brcErr("BAD_PARAM", `inputs[${i}].unlockingScriptLength must be an integer from 1 to 4294967295`);
          }
          if (unlockHex !== null && unlockHex.length / 2 > unlockingScriptLength) {
            brcErr("BAD_PARAM", `inputs[${i}].unlockingScript exceeds unlockingScriptLength`);
          }
        }
        shaped.push({ txid: parts.txid, vout: parts.vout, inputDescription, sequence, unlockHex, unlockingScriptLength });
      }
      // Explicit outputs.
      const rawOutputs = Array.isArray(args.outputs) ? (args.outputs as Record<string, unknown>[]) : [];
      const outs: StagedOutput[] = [];
      for (const [i, raw] of rawOutputs.entries()) {
        if (!raw || typeof raw !== "object") brcErr("BAD_PARAM", `outputs[${i}] must be an object`);
        const scriptHex = str(raw.lockingScript).toLowerCase();
        if (!isHex(scriptHex) || !scriptHex) brcErr("BAD_PARAM", `outputs[${i}].lockingScript must be hex`);
        try {
          Script.fromHex(scriptHex);
        } catch {
          brcErr("BAD_PARAM", `outputs[${i}].lockingScript is not a valid script`);
        }
        const sats = checkSats(raw.satoshis, `outputs[${i}].satoshis`);
        const outputDescription = checkDescription(raw.outputDescription, 5, 2000, `outputs[${i}].outputDescription`);
        const basket = raw.basket === undefined ? "" : checkBasket(raw.basket);
        const tags = checkLabelList(raw.tags, `outputs[${i}].tags`);
        const customInstructions = raw.customInstructions === undefined ? "" : str(raw.customInstructions);
        outs.push({ scriptHex, sats, basket, tags, customInstructions, description: outputDescription, mine: false });
      }
      const version = args.version === undefined ? 2 : Math.floor(Number(args.version) || 0);
      if (!(version >= 0 && version <= 0xffffffff)) brcErr("BAD_PARAM", "version out of range");
      const lockTime = args.lockTime === undefined ? 0 : Math.floor(Number(args.lockTime) || 0);
      if (!(lockTime >= 0 && lockTime <= 0xffffffff)) brcErr("BAD_PARAM", "lockTime out of range");
      const { address } = await needUnlocked();
      const ours = ourPrefix(address);
      const lock = p2pkhScript(address);
      for (const o of outs) o.mine = isOurScript(o.scriptHex, ours);
      const parents = new Map<string, Transaction>();
      if (args.inputBEEF !== undefined) {
        const bytes = checkBytes(args.inputBEEF, "inputBEEF");
        try {
          const beef = Beef.fromBinary(bytes);
          for (const entry of beef.txs) {
            if (entry.isTxidOnly) continue;
            const parent = Transaction.fromBinary(entry.rawTx!);
            if (parent.id("hex") !== entry.txid) throw new Error("parent txid mismatch");
            parents.set(entry.txid, parent);
          }
        } catch {
          brcErr("BAD_PARAM", "inputBEEF must contain valid txid-matching transaction data");
        }
      }
      const explicit: StagedInput[] = [];
      for (const [i, s] of shaped.entries()) {
        const parent = parents.get(s.txid);
        const output = parent?.outputs[s.vout];
        if (parent && (!output?.lockingScript || !Number.isSafeInteger(output.satoshis) || output.satoshis! < 0 || output.satoshis! > 2100000000000000)) {
          brcErr("BAD_PARAM", `inputs[${i}] has no valid source output in inputBEEF`);
        }
        const resolved = output
          ? { scriptHex: output.lockingScript.toHex(), value: output.satoshis! }
          : await lockingScriptOf(s.txid, s.vout, fetchFn);
        const mine = s.unlockHex === null && isOurScript(resolved.scriptHex, ours);
        if (s.unlockHex === null && !mine && s.unlockingScriptLength === undefined) {
          brcErr("CANNOT_SIGN", `inputs[${i}] is not ours and carries no unlocking script or deferred length`);
        }
        explicit.push({
          txid: s.txid, vout: s.vout,
          scriptHex: resolved.scriptHex,
          value: resolved.value,
          unlockHex: s.unlockHex, unlockingScriptLength: s.unlockingScriptLength,
          sequence: s.sequence, description: s.inputDescription,
          mine,
        });
      }
      if (options.randomizeOutputs !== false) {
        for (let i = outs.length - 1; i > 0; i--) {
          const j = Math.floor((randomBytes(4).readUInt32BE(0) / 0x100000000) * (i + 1));
          const t = outs[i]!;
          outs[i] = outs[j]!;
          outs[j] = t;
        }
      }
      // Funding from our plain UTXOs (fee counts inscription-skip protection).
      const u = await chain.utxos(address);
      const taken = new Set(explicit.map((e) => `${e.txid}:${e.vout}`));
      const candidates = u.utxos
        .filter((x) => !taken.has(`${x.txid}:${x.vout}`) && x.value > 1)
        .sort((a, b) => b.value - a.value)
        .slice(0, 12);
      const scripts = await Promise.all(
        candidates.map((x) => lockingScriptOf(x.txid, x.vout, fetchFn).catch(() => null)),
      );
      const funding: SpendableUtxo[] = [];
      for (let i = 0; i < candidates.length && funding.length < 6; i++) {
        const s = scripts[i];
        if (!s || hasOrdEnvelope(s.scriptHex)) continue;
        const c = candidates[i]!;
        funding.push({ txid: c.txid, vout: c.vout, value: c.value, scriptHex: s.scriptHex });
      }
      // Caller legs without scripts stay empty here by design (the page
      // signs them later via signAction); templates never serialize.
      const utxos: SpendableUtxo[] = [
        ...explicit.map((e) => ({
          txid: e.txid, vout: e.vout, value: e.value, scriptHex: e.scriptHex,
          unlockingScriptLength: e.mine ? Math.max(108, e.unlockingScriptLength ?? 0)
            : e.unlockingScriptLength ?? (e.unlockHex === null ? 108 : e.unlockHex.length / 2),
        })),
        ...funding,
      ];
      const unsigned = explicit.some((e) => !e.unlockHex);
      const noSend = options.noSend === true;
      const built = buildTx({
        utxos,
        unlockFor: (x) => {
          const found = explicit.find((e) => e.txid === x.txid && e.vout === x.vout);
          if (found) {
            if (found.unlockHex) return { sign: async () => Script.fromHex(found.unlockHex as string) };
            return { sign: async () => new UnlockingScript() };
          }
          return p2pkhUnlockHook("m/0/0", x.value, Script.fromHex(x.scriptHex!));
        },
        payments: outs.map((o) => ({ sats: o.sats, scriptHex: o.scriptHex })),
        changeScriptHex: lock.toHex(),
        keepOrder: true,
        requiredInputs: explicit.length,
      });
      built.tx.version = version;
      built.tx.lockTime = lockTime;
      for (const [i, e] of explicit.entries()) {
        const input = built.tx.inputs[i]!;
        input.sequence = e.sequence;
        input.sourceTransaction = parents.get(e.txid);
        if (e.unlockHex !== null) input.unlockingScript = UnlockingScript.fromHex(e.unlockHex);
      }
      // Policy on every sat leaving the wallet (non-ours outputs + fee).
      const external = outs.filter((o) => !isOurScript(o.scriptHex, ours)).reduce((a, o) => a + o.sats, 0);
      const gate = await check(db, origin, external + built.fee, "brc100-action");
      if (gate.verdict !== "allow") brcErr("POLICY_DENY", `denied: ${gate.reason}`);
      const reference = randomReference();
      if (built.changeVout >= 0) {
        outs.push({
          scriptHex: lock.toHex(), sats: built.changeSats, basket: "change",
          tags: [], customInstructions: "", description: "change", mine: true,
        });
      }
      const context: StagedContext = {
        inputs: explicit.map((e) => ({ ...e })),
        outputs: outs.map((o) => ({ ...o })),
        funding: funding.slice(0, built.tx.inputs.length - explicit.length).map((f) => ({ txid: f.txid, vout: f.vout, value: f.value, scriptHex: f.scriptHex })),
        version, lockTime, labels, description, origin,
        external, fee: built.fee,
      };
      if (unsigned || options.signAndProcess === false) {
        ensureScripts(built.tx);
        const atomic = toAtomicBeef(built.tx);
        await db("brc100_pending").insert({
          reference,
          tx_hex: Buffer.from(atomic).toString("hex"),
          context: JSON.stringify(context),
          status: "unsigned",
          description, labels: JSON.stringify(labels), originator: origin,
          created_at: Date.now(),
        });
        return { signableTransaction: { tx: atomic, reference } };
      }
      const { hex, txid } = await signTx(built.tx);
      if (noSend) {
        await afterBroadcast(txid, hex, context, "nosend", { fee: built.fee, changeSats: 0, changeVout: -1 }, { recordOutputs: false });
        return { txid, rawTx: hex };
      }
      const res = await chain.broadcast(hex);
      await afterBroadcast(res.txid, hex, context, "sending", built);
      if (options.returnTXIDOnly === true) return { txid: res.txid };
      return { txid: res.txid, rawTx: hex };
    },
    signAction: async (args, originator) => {
      void originator;
      const reference = str(args.reference);
      if (!reference) brcErr("BAD_PARAM", "reference required");
      const options = (args.options && typeof args.options === "object" ? args.options : {}) as Record<string, unknown>;
      if (options.sendWith !== undefined) brcErr("NOT_SUPPORTED", "sendWith batching is not supported");
      const staged = (await db("brc100_pending").where({ reference }).first()) as
        | { tx_hex: string; context: string; status: string }
        | undefined;
      if (!staged) brcErr("NOT_FOUND", "unknown action reference");
      const context = JSON.parse((staged as { context: string }).context) as StagedContext;
      // Policy binds to the action's owner, not the caller's claim: the
      // reference is the capability, the staged origin pays.
      const origin = context.origin || "unknown";
      const spends = (args.spends && typeof args.spends === "object" ? args.spends : {}) as Record<string, unknown>;
      await needUnlocked();
      const tx = parseAtomicBeef(Array.from(Buffer.from(str((staged as { tx_hex: string }).tx_hex), "hex")));
      const nExplicit = context.inputs.length;
      const isOursIdx = (idx: number): boolean => idx < nExplicit
        ? context.inputs[idx]!.mine === true
        : true; // picked funding is always ours
      // Attach caller unlocks (sequences honored everywhere; scripts on
      // OUR inputs are ignored — we always sign our own).
      for (const [idxRaw, raw] of Object.entries(spends)) {
        const idx = Number(idxRaw);
        if (!/^(0|[1-9]\d*)$/.test(idxRaw) || !Number.isInteger(idx) || !(idx >= 0 && idx < tx.inputs.length)) brcErr("BAD_PARAM", `spend index ${idxRaw} out of range`);
        const s = (raw ?? {}) as Record<string, unknown>;
        if (!isOursIdx(idx)) {
          const unlockHex = str(s.unlockingScript).toLowerCase();
          if (!isHex(unlockHex) || unlockHex.length % 2 !== 0) brcErr("BAD_PARAM", `spends[${idx}].unlockingScript must be hex`);
          const input = context.inputs[idx]!;
          const maxLength = input.unlockingScriptLength ?? (input.unlockHex ? input.unlockHex.length / 2 : 108);
          if (unlockHex.length / 2 > maxLength) brcErr("BAD_PARAM", `spends[${idx}].unlockingScript exceeds unlockingScriptLength`);
          let unlock: Script;
          try {
            unlock = Script.fromHex(unlockHex);
          } catch {
            brcErr("BAD_PARAM", `spends[${idx}].unlockingScript is not a script`);
          }
          tx.inputs[idx]!.unlockingScript = unlock;
          if (idx < nExplicit) context.inputs[idx]!.unlockHex = unlockHex;
        }
        if (s.sequenceNumber !== undefined) {
          const seq = Math.floor(Number(s.sequenceNumber) || 0);
          if (!(seq >= 0 && seq <= 0xffffffff)) brcErr("BAD_PARAM", `spends[${idx}].sequenceNumber out of range`);
          tx.inputs[idx]!.sequence = seq;
          if (idx < nExplicit) context.inputs[idx]!.sequence = seq;
        }
      }
      // Sign every ours-input that is still open (scripts resolve from the
      // staged context — no chain reads on this path).
      const hasScript = (idx: number): boolean => {
        const sc = tx.inputs[idx]?.unlockingScript;
        return !!sc && sc.toHex() !== "";
      };
      for (let idx = 0; idx < tx.inputs.length; idx++) {
        if (hasScript(idx)) continue;
        const scriptHex = idx < nExplicit
          ? context.inputs[idx]!.scriptHex
          : (context.funding[idx - nExplicit]?.scriptHex ?? "");
        const value = idx < nExplicit
          ? context.inputs[idx]!.value
          : (context.funding[idx - nExplicit]?.value ?? 0);
        if (!scriptHex || !isOursIdx(idx)) continue; // caller legs stay open
        const hook = p2pkhUnlockHook("m/0/0", value, Script.fromHex(scriptHex));
        tx.inputs[idx]!.unlockingScript = await hook.sign(tx, idx);
        if (idx < nExplicit) context.inputs[idx]!.unlockHex = tx.inputs[idx]!.unlockingScript!.toHex();
      }
      const stillOpen = (() => {
        for (let idx = 0; idx < tx.inputs.length; idx++) {
          if (!hasScript(idx)) return true;
        }
        return false;
      })();
      const noSend = options.noSend === true;
      if (stillOpen || noSend) {
        ensureScripts(tx);
        const atomic = toAtomicBeef(tx);
        await db("brc100_pending").where({ reference }).update({
          tx_hex: Buffer.from(atomic).toString("hex"),
          context: JSON.stringify(context),
          status: stillOpen ? "unsigned" : "nosend",
        });
        if (stillOpen) return { signableTransaction: { tx: atomic, reference } };
        await afterBroadcast(tx.id("hex"), tx.toHex(), context, "nosend", { fee: context.fee, changeSats: 0, changeVout: -1 }, { recordOutputs: false });
        await db("brc100_pending").where({ reference }).del();
        return { txid: tx.id("hex") };
      }
      const gate = await check(db, origin, context.external + context.fee, "brc100-action");
      if (gate.verdict !== "allow") brcErr("POLICY_DENY", `denied: ${gate.reason}`);
      const hex = tx.toHex();
      const res = await chain.broadcast(hex);
      await afterBroadcast(res.txid, hex, context, "sending", { fee: context.fee, changeSats: 0, changeVout: -1 });
      await db("brc100_pending").where({ reference }).del();
      if (options.returnTXIDOnly === true) return { txid: res.txid };
      return { txid: res.txid };
    },
    abortAction: async (args) => {
      const reference = str(args.reference);
      if (!reference) brcErr("BAD_PARAM", "reference required");
      const n = await db("brc100_pending").where({ reference }).del();
      if (n) return { aborted: true };
      // References may also be broadcast txids of nosend actions.
      const m = await db("brc100_actions").where({ txid: reference, status: "nosend" }).del();
      if (m) return { aborted: true };
      brcErr("NOT_FOUND", "unknown action reference");
    },
    listActions: async (args) => {
      const labels = checkLabelList(args.labels, "labels");
      const mode = args.labelQueryMode === undefined || args.labelQueryMode === "any" ? "any" : "all";
      if (args.labelQueryMode !== undefined && args.labelQueryMode !== "any" && args.labelQueryMode !== "all") {
        brcErr("BAD_PARAM", "labelQueryMode must be any or all");
      }
      const limit = args.limit === undefined ? 10 : Math.floor(Number(args.limit) || 0);
      if (!(limit >= 1 && limit <= 10000)) brcErr("BAD_PARAM", "limit must be 1-10000");
      const offset = args.offset === undefined ? 0 : Math.floor(Number(args.offset) || 0);
      if (!(offset >= 0)) brcErr("BAD_PARAM", "offset must be non-negative");
      const rows = (await db("brc100_actions").select().orderBy("created_at", "desc")) as Array<Record<string, unknown>>;
      const kept = rows.filter((r) => {
        if (!labels.length) return true;
        const have = JSON.parse(str(r.labels) || "[]") as string[];
        return mode === "any" ? labels.some((l) => have.includes(l)) : labels.every((l) => have.includes(l));
      });
      const totalActions = kept.length;
      const page = kept.slice(offset, offset + limit);
      const actions = [];
      for (const r of page) {
        const txid = str(r.txid);
        const monitor = await monitorStatus(txid);
        const status = displayStatus(str(r.status), txid, monitor);
        const entry: Record<string, unknown> = {
          txid,
          satoshis: Number(r.satoshis),
          status,
          isOutgoing: Number(r.is_outgoing) === 1,
          description: str(r.description),
          version: Number(r.version),
          lockTime: Number(r.locktime),
        };
        if (args.includeLabels === true) entry.labels = JSON.parse(str(r.labels) || "[]");
        if (args.includeInputs === true || args.includeOutputs === true) {
          const context = JSON.parse(str(r.context) || "{}") as Partial<StagedContext>;
          const wantInScript = args.includeInputSourceLockingScripts === true;
          const wantUnlock = args.includeInputUnlockingScripts === true;
          if (args.includeInputs === true) {
            entry.inputs = (context.inputs ?? []).map((e) => {
              const row: Record<string, unknown> = {
                sourceOutpoint: dotOutpoint(e.txid, e.vout),
                sourceSatoshis: e.value,
                inputDescription: e.description,
                sequenceNumber: e.sequence,
              };
              if (wantInScript) row.sourceLockingScript = e.scriptHex;
              if (wantUnlock && e.unlockHex) row.unlockingScript = e.unlockHex;
              return row;
            });
          }
          if (args.includeOutputs === true) {
            const wantOutScript = args.includeOutputLockingScripts === true;
            const spent = async (outpoint: string): Promise<boolean> => {
              const row = (await db("brc100_outputs").where({ outpoint }).first()) as
                | { spent_by?: string | null }
                | undefined;
              return !!row?.spent_by;
            };
            const outs = [];
            const ctxOuts = context.outputs ?? [];
            for (let i = 0; i < ctxOuts.length; i++) {
              const o = ctxOuts[i]!;
              const row: Record<string, unknown> = {
                satoshis: o.sats,
                spendable: o.mine === true && !(await spent(`${txid}_${i}`)),
                outpoint: dotOutpoint(txid, i),
              };
              if (wantOutScript) row.lockingScript = o.scriptHex;
              if (o.customInstructions) row.customInstructions = o.customInstructions;
              if (o.tags.length) row.tags = [...o.tags];
              outs.push(row);
            }
            entry.outputs = outs;
          }
        }
        actions.push(entry);
      }
      return { totalActions, actions };
    },
    internalizeAction: async (args, originator) => {
      const origin = str(originator) || "unknown";
      const description = checkDescription(args.description, 5, 50, "description");
      const labels = checkLabelList(args.labels, "labels");
      const rawOutputs = Array.isArray(args.outputs) ? (args.outputs as Record<string, unknown>[]) : [];
      if (!rawOutputs.length) brcErr("BAD_PARAM", "outputs required");
      const { address } = await needUnlocked();
      const ours = ourPrefix(address);
      const tx = parseAtomicBeef(args.tx);
      const txid = tx.id("hex");
      const now = Date.now();
      for (const [i, raw] of rawOutputs.entries()) {
        if (!raw || typeof raw !== "object") brcErr("BAD_PARAM", `outputs[${i}] must be an object`);
        const vout = Math.floor(Number(raw.outputIndex) || 0);
        const chainOut = tx.outputs[vout];
        if (!chainOut || !chainOut.lockingScript) brcErr("BAD_PARAM", `outputs[${i}].outputIndex out of range`);
        const protocol = str(raw.protocol);
        if (protocol !== "wallet payment" && protocol !== "basket insertion") {
          brcErr("BAD_PARAM", `outputs[${i}].protocol must be 'wallet payment' or 'basket insertion'`);
        }
        let basket = "";
        let tags: string[] = [];
        let customInstructions = "";
        if (protocol === "wallet payment") {
          if (!isOurScript(chainOut.lockingScript.toHex(), ours)) {
            brcErr("NOT_OURS", `outputs[${i}] does not pay this wallet`);
          }
        } else {
          const rem = (raw.insertionRemittance ?? {}) as Record<string, unknown>;
          basket = checkBasket(rem.basket);
          tags = checkLabelList(rem.tags, `outputs[${i}].tags`);
          customInstructions = str(rem.customInstructions);
        }
        await db("brc100_outputs")
          .insert({
            outpoint: `${txid}_${vout}`, txid, vout,
            satoshis: chainOut.satoshis ?? 0, script_hex: chainOut.lockingScript.toHex(),
            basket, tags: JSON.stringify(tags),
            custom_instructions: customInstructions || null,
            mine: 1,
            spent_by: null, originator: origin, created_at: now,
          })
          .onConflict("outpoint")
          .merge();
      }
      await track(db, txid, `brc100 ${description.slice(0, 40)}`, tx.toHex());
      await db("brc100_actions")
        .insert({
          txid, description, labels: JSON.stringify(labels), status: "sending",
          satoshis: tx.outputs.reduce((a, o) => a + (o.satoshis ?? 0), 0),
          is_outgoing: 0, version: tx.version, locktime: tx.lockTime,
          context: JSON.stringify({ inputs: [], outputs: [] }),
          originator: origin, created_at: now, updated_at: now,
        })
        .onConflict("txid")
        .merge({ updated_at: now });
      return { accepted: true };
    },
    listOutputs: async (args) => {
      const basket = checkBasket(args.basket);
      const tags = checkLabelList(args.tags, "tags");
      const mode = args.tagQueryMode === undefined || args.tagQueryMode === "any" ? "any" : "all";
      if (args.tagQueryMode !== undefined && args.tagQueryMode !== "any" && args.tagQueryMode !== "all") {
        brcErr("BAD_PARAM", "tagQueryMode must be any or all");
      }
      const limit = args.limit === undefined ? 10 : Math.floor(Number(args.limit) || 0);
      if (!(limit >= 1 && limit <= 10000)) brcErr("BAD_PARAM", "limit must be 1-10000");
      let offset = args.offset === undefined ? 0 : Math.floor(Number(args.offset) || 0);
      if (!Number.isInteger(offset)) brcErr("BAD_PARAM", "offset must be an integer");
      const rows = (await db("brc100_outputs")
        .where({ basket })
        .select()) as Array<Record<string, unknown>>;
      let kept = rows.filter((r) => {
        if (!tags.length) return true;
        const have = JSON.parse(str(r.tags) || "[]") as string[];
        return mode === "any" ? tags.some((t) => have.includes(t)) : tags.every((t) => have.includes(t));
      });
      kept.sort((a, b) => Number(a.created_at) - Number(b.created_at));
      if (offset < 0) {
        kept = kept.reverse();
        offset = -offset - 1;
      }
      const totalOutputs = kept.length;
      const page = kept.slice(offset, offset + limit);
      const wantScripts = args.include === "locking scripts" || args.include === "entire transactions";
      const outputs = [];
      for (const r of page) {
        const row: Record<string, unknown> = {
          satoshis: Number(r.satoshis),
          spendable: Number(r.mine) === 1 && !r.spent_by,
          outpoint: dotOutpoint(str(r.txid), Number(r.vout)),
        };
        if (wantScripts) row.lockingScript = str(r.script_hex);
        if (args.includeCustomInstructions === true && r.custom_instructions) {
          row.customInstructions = str(r.custom_instructions);
        }
        if (args.includeTags === true) row.tags = JSON.parse(str(r.tags) || "[]");
        if (args.includeLabels === true) {
          const action = (await db("brc100_actions").where({ txid: str(r.txid) }).first()) as
            | { labels?: string }
            | undefined;
          row.labels = JSON.parse(action?.labels || "[]");
        }
        outputs.push(row);
      }
      const result: Record<string, unknown> = { totalOutputs, outputs };
      if (args.include === "entire transactions") {
        const hexes = new Map<string, string>();
        for (const r of page) {
          const txid = str(r.txid);
          if (hexes.has(txid)) continue;
          try {
            const res = await fetchFn(`${WOC}/tx/${txid}/hex`);
            if (res.ok) hexes.set(txid, (await res.text()).trim());
          } catch {
            /* skip missing */
          }
        }
        const beef = new Beef();
        for (const hex of hexes.values()) {
          try {
            beef.mergeRawTx(Array.from(Buffer.from(hex, "hex")));
          } catch {
            /* skip unparseable */
          }
        }
        result.BEEF = Array.from(beef.toBinary());
      }
      return result;
    },
    relinquishOutput: async (args) => {
      const basket = checkBasket(args.basket);
      const parts = splitOutpoint(str(args.output));
      if (!parts) brcErr("BAD_PARAM", "output must be <txid>.<vout>");
      const n = await db("brc100_outputs").where({ basket, outpoint: `${parts.txid}_${parts.vout}` }).del();
      if (!n) brcErr("NOT_FOUND", "output not tracked in basket");
      return { relinquished: true };
    },
    acquireCertificate: async (args) => {
      noPrivileged(args);
      if (args.acquisitionProtocol !== "direct") {
        brcErr("NOT_SUPPORTED", "only direct certificate acquisition is supported (no issuance round-trips)");
      }
      const type = b64decode(str(args.type), "type");
      const certifier = str(args.certifier);
      if (!isPubkey(certifier)) brcErr("BAD_PARAM", "certifier must be a 33-byte compressed pubkey");
      const fields = args.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        brcErr("BAD_PARAM", "fields must be an object");
      }
      for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
        if (typeof v !== "string") brcErr("BAD_PARAM", `field ${k} must be a string`);
      }
      const { address: _addr } = await needUnlocked();
      void _addr;
      const subject = identityPubkeyHex();
      const view = await putCert(db, {
        type,
        certifier: certifier.toLowerCase(),
        subject,
        fields,
        signature: args.signature === undefined ? undefined : str(args.signature),
      });
      return toWalletCert(view);
    },
    listCertificates: async (args) => {
      noPrivileged(args);
      const certifiers = Array.isArray(args.certifiers)
        ? (args.certifiers as unknown[]).map((c) => str(c).toLowerCase())
        : [];
      const types = Array.isArray(args.types)
        ? (args.types as unknown[]).map((t) => b64decode(str(t), "types[]"))
        : [];
      const limit = args.limit === undefined ? 10 : Math.floor(Number(args.limit) || 0);
      if (!(limit >= 1 && limit <= 10000)) brcErr("BAD_PARAM", "limit must be 1-10000");
      const offset = args.offset === undefined ? 0 : Math.floor(Number(args.offset) || 0);
      if (!(offset >= 0)) brcErr("BAD_PARAM", "offset must be non-negative");
      const all = await listCerts(db);
      const kept = all.filter((c) => {
        if (c.revoked) return false;
        if (certifiers.length && !certifiers.includes(c.certifier.toLowerCase())) return false;
        if (types.length && !types.includes(c.type)) return false;
        return true;
      });
      return {
        totalCertificates: kept.length,
        certificates: kept.slice(offset, offset + limit).map(toWalletCert),
      };
    },
    discoverByIdentityKey: async (args) => {
      const identityKey = str(args.identityKey);
      if (!isPubkey(identityKey)) brcErr("BAD_PARAM", "identityKey must be a 33-byte compressed pubkey");
      const limit = args.limit === undefined ? 10 : Math.floor(Number(args.limit) || 0);
      if (!(limit >= 1 && limit <= 10000)) brcErr("BAD_PARAM", "limit must be 1-10000");
      const offset = args.offset === undefined ? 0 : Math.floor(Number(args.offset) || 0);
      if (!(offset >= 0)) brcErr("BAD_PARAM", "offset must be non-negative");
      const all = await listCerts(db);
      const kept = all.filter((c) => !c.revoked && c.subject.toLowerCase() === identityKey.toLowerCase());
      return {
        totalCertificates: kept.length,
        certificates: kept.slice(offset, offset + limit).map(toWalletCert),
      };
    },
    discoverByAttributes: async (args) => {
      const attributes = args.attributes;
      if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
        brcErr("BAD_PARAM", "attributes must be an object");
      }
      const limit = args.limit === undefined ? 10 : Math.floor(Number(args.limit) || 0);
      if (!(limit >= 1 && limit <= 10000)) brcErr("BAD_PARAM", "limit must be 1-10000");
      const offset = args.offset === undefined ? 0 : Math.floor(Number(args.offset) || 0);
      if (!(offset >= 0)) brcErr("BAD_PARAM", "offset must be non-negative");
      const all = await listCerts(db);
      const kept = all.filter((c) => {
        if (c.revoked) return false;
        return Object.entries(attributes as Record<string, unknown>).every(
          ([k, v]) => (c.fields as Record<string, string>)[k] === v,
        );
      });
      return {
        totalCertificates: kept.length,
        certificates: kept.slice(offset, offset + limit).map(toWalletCert),
      };
    },
    proveCertificate: async (args) => {
      noPrivileged(args);
      const verifier = checkCounterparty(args.verifier, "verifier");
      if (verifier === "self" || verifier === "anyone") brcErr("BAD_PARAM", "verifier must be a public key");
      const cert = (args.certificate ?? {}) as Record<string, unknown>;
      const type = cert.type === undefined ? undefined : b64decode(str(cert.type), "certificate.type");
      const serial = cert.serialNumber === undefined ? undefined : b64decode(str(cert.serialNumber), "certificate.serialNumber");
      const certifier = cert.certifier === undefined ? undefined : str(cert.certifier).toLowerCase();
      const all = await listCerts(db);
      const found = all.find((c) => {
        if (c.revoked) return false;
        if (type !== undefined && c.type !== type) return false;
        if (certifier !== undefined && c.certifier.toLowerCase() !== certifier) return false;
        if (serial !== undefined && c.id !== serial.toLowerCase()) return false;
        return true;
      });
      if (!found) brcErr("NOT_FOUND", "certificate not held");
      const fieldsToReveal = args.fieldsToReveal;
      if (!Array.isArray(fieldsToReveal) || !fieldsToReveal.length) {
        brcErr("BAD_PARAM", "fieldsToReveal must be a non-empty list");
      }
      const shown = await showCert(db, (found as { id: string }).id, {
        fields: (fieldsToReveal as unknown[]).map((f) => str(f)),
        to: verifier,
      });
      const keyring: Record<string, string> = {};
      for (const [k, v] of Object.entries(shown.disclosed)) {
        keyring[k] = Buffer.from(String(v), "utf8").toString("base64");
      }
      return { keyringForVerifier: keyring, certificate: toWalletCert(found), verifier };
    },
    relinquishCertificate: async (args) => {
      const type = b64decode(str(args.type), "type");
      const serial = b64decode(str(args.serialNumber), "serialNumber");
      const certifier = str(args.certifier);
      if (!isPubkey(certifier)) brcErr("BAD_PARAM", "certifier must be a 33-byte compressed pubkey");
      const all = await listCerts(db);
      const found = all.find(
        (c) => c.id === serial.toLowerCase() && c.type === type && c.certifier.toLowerCase() === certifier.toLowerCase(),
      );
      if (!found) brcErr("NOT_FOUND", "certificate not held");
      await revokeCert(db, (found as { id: string }).id);
      return { relinquished: true };
    },
  };
  return wallet;
}
