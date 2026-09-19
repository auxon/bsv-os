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
  BSM,
  BigNumber,
  ECDSA,
  Hash,
  HD,
  KeyDeriver,
  Mnemonic,
  P2PKH,
  PrivateKey,
  Point,
  PublicKey,
  Schnorr,
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
  const cp = (counterparty === "self" || counterparty === "anyone"
    ? counterparty
    : checkPeer(counterparty)) as Counterparty;
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

/** BRC-42 public-key derivation for BRC-100 getPublicKey. */
export function derivePublicKey(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  forSelf: boolean,
): string {
  const cp = (counterparty === "self" || counterparty === "anyone"
    ? counterparty
    : checkPeer(counterparty)) as Counterparty;
  return new KeyDeriver(identityRoot()).derivePublicKey(protocolID, keyID, cp, forSelf).toString();
}

/** Generic BRC-42 symmetric encryption for BRC-100 encrypt. */
export function brc42Encrypt(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  plaintext: number[],
): number[] {
  const cp = (counterparty === "self" || counterparty === "anyone"
    ? counterparty
    : checkPeer(counterparty)) as Counterparty;
  const out = new KeyDeriver(identityRoot()).deriveSymmetricKey(protocolID, keyID, cp).encrypt(plaintext);
  return Array.from(out as number[]);
}

/** Generic BRC-42 symmetric decryption for BRC-100 decrypt. */
export function brc42Decrypt(
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  ciphertext: number[],
): number[] {
  const cp = (counterparty === "self" || counterparty === "anyone"
    ? counterparty
    : checkPeer(counterparty)) as Counterparty;
  const out = new KeyDeriver(identityRoot()).deriveSymmetricKey(protocolID, keyID, cp).decrypt(ciphertext);
  return Array.from(out as number[]);
}

export interface RevealedLinkage {
  prover: string;
  verifier: string;
  counterparty: string;
  revelationTime: string;
  encryptedLinkage: number[];
  encryptedLinkageProof: number[];
}

/**
 * BRC-69 counterparty linkage, built EXACTLY like the reference wallet
 * (SDK ProtoWallet): raw shared secret plus a Schnorr proof of the root
 * key, both AES-GCM encrypted to the verifier under the linkage protocol.
 */
export function revealCounterpartyLinkage(counterparty: string, verifier: string): RevealedLinkage {
  const root = identityRoot();
  const cp = checkPeer(counterparty);
  const vf = checkPeer(verifier);
  const kd = new KeyDeriver(root);
  const linkage = kd.revealCounterpartySecret(cp) as unknown as number[];
  const proof = new Schnorr().generateProof(root, root.toPublicKey(), PublicKey.fromString(cp), Point.fromDER(linkage));
  const proofBin = [...proof.R.encode(true), ...proof.SPrime.encode(true), ...proof.z.toArray("be", 32)] as number[];
  const revelationTime = new Date().toISOString();
  const enc = (bytes: number[]): number[] => {
    const out = kd.deriveSymmetricKey([2, "counterparty linkage revelation"], revelationTime, vf).encrypt(bytes);
    return Array.from(out as number[]);
  };
  return {
    prover: root.toPublicKey().toString(),
    verifier: vf,
    counterparty: cp,
    revelationTime,
    encryptedLinkage: enc(linkage),
    encryptedLinkageProof: enc(proofBin),
  };
}

/**
 * BRC-69 specific linkage, same reference construction: the protocol/keyID
 * offset secret plus a type-0 (empty) proof, both encrypted to the verifier.
 */
export function revealSpecificLinkage(
  counterparty: string,
  verifier: string,
  protocolID: WalletProtocol,
  keyID: string,
): RevealedLinkage & { protocolID: WalletProtocol; keyID: string; proofType: number } {
  const root = identityRoot();
  const cp = (counterparty === "self" || counterparty === "anyone"
    ? counterparty
    : checkPeer(counterparty)) as Counterparty;
  const vf = checkPeer(verifier);
  const kd = new KeyDeriver(root);
  const linkage = kd.revealSpecificSecret(cp, protocolID, keyID);
  const revelationTime = new Date().toISOString();
  const encProto: WalletProtocol = [2, `specific linkage revelation ${protocolID[0]} ${protocolID[1]}`];
  const enc = (bytes: number[]): number[] => {
    const out = kd.deriveSymmetricKey(encProto, keyID, vf).encrypt(bytes);
    return Array.from(out as number[]);
  };
  return {
    prover: root.toPublicKey().toString(),
    verifier: vf,
    counterparty: typeof cp === "string" ? cp : (cp as PublicKey).toString(),
    revelationTime,
    encryptedLinkage: enc(linkage),
    encryptedLinkageProof: enc([0]),
    protocolID,
    keyID,
    proofType: 0,
  };
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

// ── Twetch account key ────────────────────────────────────────────────
//
// The Twetch wallet key is external (owned by the user's Twetch account,
// not derived from this wallet's seed). It is imported explicitly, lives
// in the same keyring under its own account entry, and only ever signs:
// AIP post authorship and Twetch API auth headers. It never funds and
// never touches bsvOS identity.

const TWETCH_KEY_ACCOUNT = "twetch-account";

async function twetchKey(): Promise<PrivateKey | null> {
  const wif = await keytar.getPassword(svc().service, TWETCH_KEY_ACCOUNT).catch(() => null);
  if (!wif) return null;
  try {
    return PrivateKey.fromWif(wif);
  } catch {
    return null;
  }
}

export interface TwetchAccountStatus {
  imported: boolean;
  address: string | null;
  publicKey: string | null;
}

export async function twetchAccountStatus(): Promise<TwetchAccountStatus> {
  const key = await twetchKey();
  return key
    ? {
        imported: true,
        address: key.toPublicKey().toAddress("mainnet"),
        publicKey: key.toPublicKey().toString(),
      }
    : { imported: false, address: null, publicKey: null };
}

/** Import the Twetch account key (WIF). The secret is never returned. */
export async function twetchAccountImport(wif: string): Promise<{ address: string }> {
  const trimmed = wif.trim();
  let key: PrivateKey;
  try {
    key = PrivateKey.fromWif(trimmed);
  } catch {
    throw new CustodyError("BAD_WIF", "that is not a valid private key (WIF)");
  }
  await keytar.setPassword(svc().service, TWETCH_KEY_ACCOUNT, key.toWif());
  return { address: key.toPublicKey().toAddress("mainnet") };
}

/** Standard BIP44 path for the Twetch wallet key ("conventional wallet"). */
export const TWETCH_DEFAULT_PATH = "m/44'/0'/0'/0/0";

/**
 * Bounded candidate paths tried when the caller knows the expected public
 * key (the OIDC session's twetch_pubkey claim): the standard path first,
 * then the usual BIP44/BIP32 homes. Purely local derivation; nothing is
 * stored unless one of them actually matches.
 */
const TWETCH_SCAN_PATHS = [
  "m/44'/0'/0'/0/0",
  "m/44'/0'/0'/0/1",
  "m/44'/0'/0'/0/2",
  "m/44'/0'/0'/1/0",
  "m/44'/0'/0'/1/1",
  "m/44'/236'/0'/0/0",
  "m/44'/236'/0'/0/1",
  "m/44'/0'/0'",
  "m/44'/236'/0'",
  "m/0'/0'",
  "m/0'/0'/0'",
  "m/0/0",
  "m/0",
  "m/1",
  "m",
];

function deriveAt(hd: HD, path: string): PrivateKey {
  return path === "m" ? hd.privKey : hd.derive(path).privKey;
}

/**
 * One-tap import: derive the Twetch account key from the enrolled BIP39
 * phrase and store it as the Twetch account key. With a target public key
 * (the signed-in account's Twetch key from the OIDC session) the bounded
 * path scan above runs and the key is stored only on a match — so a seed
 * that does not actually hold the Twetch key fails loudly instead of
 * importing a key the account cannot use. The seed and the resulting WIF
 * never leave this module.
 */
async function importTwetchFromPhrase(
  phrase: string,
  path: string,
  targetPubkey: string | undefined,
  source: "seed" | "phrase",
): Promise<{ address: string; publicKey: string; path: string; scanned: number }> {
  const p = String(path ?? TWETCH_DEFAULT_PATH).trim();
  if (!/^m(\/[0-9]+'?)+$/.test(p)) {
    throw new CustodyError("BAD_PARAM", "derivation path must look like m/44'/0'/0'/0/0");
  }
  const target =
    typeof targetPubkey === "string" && /^[0-9a-fA-F]{66}$/.test(targetPubkey)
      ? targetPubkey.toLowerCase()
      : null;

  let hd: HD;
  try {
    hd = HD.fromSeed(new Mnemonic(phrase).toSeed());
  } catch {
    throw new CustodyError("BAD_PHRASE", "could not derive from that recovery phrase");
  }

  let child: PrivateKey | null = null;
  let matchedPath: string | null = null;
  let scanned = 0;
  if (target) {
    for (const candidate of [p, ...TWETCH_SCAN_PATHS.filter((c) => c !== p)]) {
      scanned++;
      let key: PrivateKey;
      try {
        key = deriveAt(hd, candidate);
      } catch {
        continue;
      }
      if (key.toPublicKey().toString().toLowerCase() === target) {
        child = key;
        matchedPath = candidate;
        break;
      }
    }
    if (!child) {
      const label = source === "seed" ? "this wallet seed" : "that phrase";
      const advice =
        source === "seed"
          ? "import the Twetch account WIF, or its recovery phrase with: bsv twetch account import-phrase"
          : "double-check the phrase, or import the Twetch account WIF";
      throw new CustodyError(
        "NOT_FOUND",
        `${label} does not derive your Twetch key (${scanned} paths tried) — ${advice}`,
      );
    }
  } else {
    try {
      child = deriveAt(hd, p);
    } catch {
      throw new CustodyError("BAD_PHRASE", `could not derive a key from that phrase at ${p}`);
    }
    matchedPath = p;
    scanned = 1;
  }

  await keytar.setPassword(svc().service, TWETCH_KEY_ACCOUNT, child.toWif());
  return {
    address: child.toPublicKey().toAddress("mainnet"),
    publicKey: child.toPublicKey().toString(),
    path: matchedPath ?? p,
    scanned,
  };
}

export async function twetchAccountImportFromSeed(
  path = TWETCH_DEFAULT_PATH,
  targetPubkey?: string,
): Promise<{ address: string; publicKey: string; path: string; scanned: number }> {
  const stored = await keytar.getPassword(svc().service, svc().account).catch(() => null);
  if (!stored) {
    throw new CustodyError("NO_WALLET", "no wallet enrolled — create or import one first");
  }
  const phrase = normalizePhrase(stored);
  if (!Mnemonic.isValid(phrase)) {
    throw new CustodyError("BAD_PHRASE", "the stored recovery phrase is invalid");
  }
  return importTwetchFromPhrase(phrase, path, targetPubkey, "seed");
}

/**
 * Import the Twetch account key from an explicitly supplied BIP39 phrase
 * (a separate Twetch wallet, not the enrolled bsvOS seed). Same bounded
 * path scan against the expected account key; the phrase and the derived
 * WIF never leave this module.
 */
export async function twetchAccountImportFromPhrase(
  phrase: string,
  path = TWETCH_DEFAULT_PATH,
  targetPubkey?: string,
): Promise<{ address: string; publicKey: string; path: string; scanned: number }> {
  const normalized = normalizePhrase(phrase);
  if (!normalized || !Mnemonic.isValid(normalized)) {
    throw new CustodyError("BAD_PHRASE", "that is not a valid 12/24-word recovery phrase");
  }
  return importTwetchFromPhrase(normalized, path, targetPubkey, "phrase");
}

/** Public key of the imported Twetch key (public information), or null. */
export async function twetchPublicKey(): Promise<string | null> {
  const key = await twetchKey();
  return key ? key.toPublicKey().toString() : null;
}

export async function twetchAccountRemove(): Promise<void> {
  await keytar.deletePassword(svc().service, TWETCH_KEY_ACCOUNT).catch(() => false);
}

/**
 * BSM (Bitcoin Signed Message) over raw bytes with the Twetch account key.
 * Used for AIP post authorship and x-twetch-sig API auth. Returns base64.
 */
export async function twetchSignBytes(message: number[]): Promise<string> {
  const key = await twetchKey();
  if (!key) {
    throw new CustodyError("NO_TWETCH_ACCOUNT", "no Twetch key imported — run: bsv twetch account import");
  }
  return BSM.sign(message, key, "base64") as string;
}

/** P2PKH address of the imported Twetch key, or null when not imported. */
export async function twetchAddress(): Promise<string | null> {
  const key = await twetchKey();
  return key ? key.toPublicKey().toAddress("mainnet") : null;
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

/**
 * SIGHASH_NONE | ANYONECANPAY: authorizes spending this input without
 * committing to any output. Used for the v4 swap's 1-sat prefix input —
 * the seller donates one plain sat to shift the carrier to input 1 (so
 * the 1Sat indexer's FIFO assigns the inscription to the NFT output),
 * and commits nothing else.
 */
export function p2pkhUnlockHookNone(path: string, satoshis: number, lockingScript: Script): UnlockHook {
  const priv = childPriv(path);
  const template = new P2PKH().unlock(priv, "none", true, satoshis, lockingScript);
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
