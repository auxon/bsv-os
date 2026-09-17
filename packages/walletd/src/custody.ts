/**
 * Custody boundary — the ONLY module allowed raw key material.
 *
 * Design (M1):
 * - 12-word recovery phrase generated with SDK entropy, kept in the OS
 *   keyring (`keytar`: Keychain on macOS, libsecret on Arch) under
 *   service `bsv-walletd` / account `master`. The OS login session is the
 *   authentication factor; TPM/PAM pinning lands in a later milestone.
 * - Session holds an in-memory HD root while unlocked. `lock()` drops the
 *   reference (best-effort wipe; JS GC caveat documented in
 *   docs/trust-boundary.md) and an idle timer re-locks automatically.
 * - Identity key = HD root compressed pubkey (hex). BRC-42 counterparty
 *   keys (below) scope every derived secret to one peer + protocol.
 */
import keytar from "keytar";
import { createHmac, timingSafeEqual } from "node:crypto";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";
import {
  BigNumber,
  ECDSA,
  Hash,
  HD,
  KeyDeriver,
  Mnemonic,
  P2PKH,
  PrivateKey,
  PublicKey,
  Script,
  Signature,
  Transaction,
  type Counterparty,
  type UnlockingScript,
  type WalletProtocol,
} from "@bsv/sdk";
import type { UnlockHook } from "./tx.ts";

// Test isolation: BSV_WALLETD_KEYCHAIN_SUFFIX partitions the keyring so
// parallel test files never share (or destroy) each other's wallets.
function svc(): { service: string; account: string } {
  const suffix = process.env.BSV_WALLETD_KEYCHAIN_SUFFIX ?? "";
  return { service: `bsv-walletd${suffix}`, account: "master" };
}
const DEFAULT_LOCK_MS = 15 * 60 * 1000;

export interface CustodyStatus {
  locked: boolean;
  hasWallet: boolean;
  identityKey: string | null;
}

export class CustodyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CustodyError";
    this.code = code;
  }
}

let session: HD | null = null;
let hasWalletCache: boolean | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;

function lockMs(): number {
  const raw = Number(process.env.BSV_WALLETD_LOCK_MS ?? DEFAULT_LOCK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCK_MS;
}

function armTimer(): void {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => {
    lock();
  }, lockMs());
  lockTimer.unref?.();
}

function identityOf(hd: HD): string {
  return hd.privKey.toPublicKey().toString();
}

export async function hasWallet(): Promise<boolean> {
  if (hasWalletCache !== null) return hasWalletCache;
  try {
    hasWalletCache = (await keytar.getPassword(svc().service, svc().account)) !== null;
  } catch {
    hasWalletCache = false;
  }
  return hasWalletCache;
}

export async function createWallet(force = false): Promise<{ identityKey: string; backup: string }> {
  if (!force && (await hasWallet())) {
    throw new CustodyError("EXISTS", "a wallet already exists (pass force to replace — destroys access to the old one)");
  }
  const phrase = Mnemonic.fromRandom().toString();
  await keytar.setPassword(svc().service, svc().account, phrase);
  hasWalletCache = true;
  session = HD.fromSeed(new Mnemonic(phrase).toSeed());
  armTimer();
  return { identityKey: identityOf(session), backup: phrase };
}

function normalizePhrase(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Restore from a recovery phrase (new machine, reinstall). Same storage and
 * session handling as creation; the phrase is never logged or returned.
 */
export async function importWallet(rawPhrase: string, force = false): Promise<{ identityKey: string }> {
  if (!force && (await hasWallet())) {
    throw new CustodyError("EXISTS", "a wallet already exists (pass force to replace — destroys access to the old one)");
  }
  const phrase = normalizePhrase(rawPhrase);
  if (!Mnemonic.isValid(phrase)) {
    throw new CustodyError("BAD_PHRASE", "that is not a valid 12-word recovery phrase");
  }
  await keytar.setPassword(svc().service, svc().account, phrase);
  hasWalletCache = true;
  session = HD.fromSeed(new Mnemonic(phrase).toSeed());
  armTimer();
  return { identityKey: identityOf(session) };
}

export async function unlock(): Promise<{ identityKey: string }> {
  const stored = await keytar.getPassword(svc().service, svc().account).catch(() => null);
  if (!stored) {
    hasWalletCache = false;
    throw new CustodyError("NO_WALLET", "no wallet enrolled — call createWallet first");
  }
  hasWalletCache = true;
  session = HD.fromSeed(new Mnemonic(stored).toSeed());
  armTimer();
  return { identityKey: identityOf(session) };
}

export function lock(): void {
  session = null;
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
}

/**
 * Spend path for the daemon's own coins (M3 spike path `m/0/0`; BRC-43
 * derivation replaces hard paths in M4). Returns only public info.
 */
export function selfAddress(path = "m/0/0"): string {
  if (!session) throw new CustodyError("WALLET_LOCKED", "wallet locked");
  return childPriv(path).toPublicKey().toAddress();
}

function childPriv(path: string): PrivateKey {
  if (!session) throw new CustodyError("WALLET_LOCKED", "wallet locked");
  const child = session.derive(path);
  if (!child.privKey) throw new CustodyError("INTERNAL", `cannot derive ${path}`);
  return child.privKey;
}

/**
 * F6 messaging crypto. The identity root never leaves this module —
 * callers get ciphertext, plaintext, and signatures, never keys.
 *
 * - DM key: BRC-42 symmetric key scoped to [protocol, keyID, counterparty],
 *   so each peer pair shares exactly one key and a compromise is contained.
 * - Signatures: BRC-42 private-key derivation with the caller's exact
 *   protocol/keyID/counterparty (BRC-104 handshake scope).
 */
export const DM_PROTOCOL: WalletProtocol = [2, "bsv os dm v1"];
export const DM_KEY_ID = "dm";
export const MAX_DM_BYTES = 32 * 1024;

function identityRoot(): PrivateKey {
  if (!session?.privKey) throw new CustodyError("WALLET_LOCKED", "wallet locked");
  return session.privKey;
}

function checkPeer(hex: unknown): string {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{66}$/.test(hex)) {
    throw new CustodyError("BAD_PARAM", "peer must be a 33-byte compressed pubkey hex");
  }
  try {
    return PublicKey.fromString(hex).toString();
  } catch {
    throw new CustodyError("BAD_PARAM", "peer is not a valid secp256k1 public key");
  }
}

function dmKey(peerHex: string) {
  const peer = checkPeer(peerHex);
  return new KeyDeriver(identityRoot()).deriveSymmetricKey(DM_PROTOCOL, DM_KEY_ID, peer as Counterparty);
}

/** Encrypt a DM for a peer. Returns hex envelope body. */
export function dmEncrypt(peerHex: string, plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new CustodyError("BAD_PARAM", "message must not be empty");
  }
  if (Buffer.byteLength(plaintext, "utf8") > MAX_DM_BYTES) {
    throw new CustodyError("BAD_PARAM", `message over ${MAX_DM_BYTES} bytes`);
  }
  const out = dmKey(peerHex).encrypt(plaintext) as number[];
  return Buffer.from(out).toString("hex");
}

/** Decrypt a DM from a peer. Throws on tamper or wrong key. */
export function dmDecrypt(peerHex: string, bodyHex: string): string {
  if (typeof bodyHex !== "string" || !/^[0-9a-fA-F]+$/.test(bodyHex)) {
    throw new CustodyError("BAD_PARAM", "message body must be hex");
  }
  const out = dmKey(peerHex).decrypt(Array.from(Buffer.from(bodyHex, "hex")), "utf8");
  return typeof out === "string" ? out : Buffer.from(out as number[]).toString("utf8");
}

/** Our identity pubkey hex. Throws WALLET_LOCKED like selfAddress. */
export function identityPubkeyHex(): string {
  if (!session) throw new CustodyError("WALLET_LOCKED", "wallet locked");
  return identityOf(session);
}

/**
 * BRC-42 scoped signature for auth handshakes (BRC-104). Signs
 * SHA-256(data) — the reference digest — with the exact protocol/keyID/
 * counterparty the caller passes; the verifier mirrors the same scope.
 */
export function brc42SignData(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  data: number[],
): number[] {
  return brc42SignDigest(protocolID, keyID, counterparty, Hash.sha256(data));
}

/** Sign a precomputed 32-byte digest directly (no double hash). */
export function brc42SignHash(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  hash: number[],
): number[] {
  if (hash.length !== 32) throw new CustodyError("BAD_PARAM", "digest must be 32 bytes");
  return brc42SignDigest(protocolID, keyID, counterparty, hash);
}

function brc42SignDigest(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  digest: number[],
): number[] {
  const root = identityRoot();
  const cp = (counterparty === "self" ? "self" : checkPeer(counterparty)) as Counterparty;
  const key = new KeyDeriver(root).derivePrivateKey(protocolID, keyID, cp);
  const sig = ECDSA.sign(BigNumber.fromString(Buffer.from(digest).toString("hex"), 16), key);
  return Array.from(sig.toDER() as number[]);
}

/** BRC-42 verification mirror of brc42SignData. Always needs the session:
 * both derivation directions combine our root key with the counterparty
 * point (ECDH is symmetric, but one private side is mandatory) — there is
 * no sessionless verification of counterparty signatures by design. */
export function brc42Verify(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  forSelf: boolean,
  data: number[],
  sigBytes: number[],
): boolean {
  return brc42VerifyDigest(protocolID, keyID, counterparty, forSelf, Hash.sha256(data), sigBytes);
}

/** Verify against a precomputed 32-byte digest (no double hash). */
export function brc42VerifyDigest(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  forSelf: boolean,
  digest: number[],
  sigBytes: number[],
): boolean {
  try {
    const cp = (counterparty === "self" ? "self" : checkPeer(counterparty)) as Counterparty;
    const pub = new KeyDeriver(identityRoot()).derivePublicKey(protocolID, keyID, cp, forSelf);
    const sig = Signature.fromDER(sigBytes);
    return ECDSA.verify(BigNumber.fromString(Buffer.from(digest).toString("hex"), 16), sig, pub);
  } catch {
    return false;
  }
}
/** BRC-42 HMAC-SHA256 for handshake nonces (BRC-104). */
export function brc42Hmac(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  data: number[],
): number[] {
  const root = identityRoot();
  const cp = (counterparty === "self" ? "self" : checkPeer(counterparty)) as Counterparty;
  const key = new KeyDeriver(root).deriveSymmetricKey(protocolID, keyID, cp);
  const keyBytes = key.toArray("be", 32);
  return Array.from(createHmac("sha256", Buffer.from(keyBytes)).update(Buffer.from(data)).digest());
}

/** Constant-time HMAC check for handshake nonces. */
export function brc42VerifyHmac(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  data: number[],
  hmac: number[],
): boolean {
  try {
    const computed = Buffer.from(brc42Hmac(protocolID, keyID, counterparty, data));
    const given = Buffer.from(hmac);
    return computed.length === given.length && timingSafeEqual(computed, given);
  } catch {
    return false;
  }
}

/**
 * An unlocking hook bound to a derived key. The key never leaves this
 * module — callers get signatures, not secrets. Matches tx.ts UnlockHook.
 */
export function p2pkhUnlockHook(path: string, satoshis: number, lockingScript: Script): UnlockHook {
  const priv = childPriv(path);
  const template = new P2PKH().unlock(priv, "all", false, satoshis, lockingScript);
  return {
    sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
      return template.sign(tx, inputIndex);
    },
  };
}

/**
 * Atomic-swap variant: SIGHASH_SINGLE | ANYONECANPAY commits only to the
 * output at the same index, so a pre-signature can never authorize any
 * other payment. Same key custody as above — signatures, not secrets.
 * Callers must enforce the fixed swap template (version, locktime,
 * input/output positions) before signing.
 */
export function p2pkhUnlockHookSingle(path: string, satoshis: number, lockingScript: Script): UnlockHook {
  const priv = childPriv(path);
  const template = new P2PKH().unlock(priv, "single", true, satoshis, lockingScript);
  return {
    sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
      return template.sign(tx, inputIndex);
    },
  };
}

/** Factory reset: wipes the enrolled secret. Caller must have a backup. */
export async function destroyWallet(): Promise<void> {
  lock();
  try {
    await keytar.deletePassword(svc().service, svc().account);
  } catch {
    /* ignore */
  }
  hasWalletCache = false;
}

/**
 * F10 recovery bridge. Raw entropy leaves this module ONLY as Shamir
 * shares printed once (setup/rotate) or re-enters via restore — it is
 * never stored, logged, or sent anywhere by the daemon.
 */
async function enrolledPhrase(): Promise<string> {
  const stored = await keytar.getPassword(svc().service, svc().account).catch(() => null);
  if (!stored) {
    hasWalletCache = false;
    throw new CustodyError("NO_WALLET", "no wallet enrolled — call createWallet first");
  }
  return stored;
}

/** 16-byte wallet entropy. Requires the wallet UNLOCKED (human present). */
export async function exportEntropy(): Promise<Uint8Array> {
  if (!session) throw new CustodyError("WALLET_LOCKED", "wallet locked");
  // English wordlist verified identical to the SDK's bundled list
  // (same seeds for random entropy) — never mix wordlists.
  const entropy = mnemonicToEntropy(await enrolledPhrase(), englishWordlist);
  if (entropy.length !== 16) throw new CustodyError("INTERNAL", "unexpected entropy length");
  return entropy;
}

/** Re-enroll from recovery entropy (ceremony calls importWallet). */
export async function restoreFromEntropy(entropy: Uint8Array, force = false): Promise<{ identityKey: string }> {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 16) {
    throw new CustodyError("BAD_PARAM", "entropy must be 16 bytes");
  }
  return importWallet(entropyToMnemonic(entropy, englishWordlist), force);
}

export async function getStatus(): Promise<CustodyStatus> {
  return {
    locked: session === null,
    hasWallet: await hasWallet(),
    identityKey: session ? identityOf(session) : null,
  };
}

/** Test hook: forget cached keyring presence (forces a re-read). */
export function __resetCache(): void {
  hasWalletCache = null;
}
