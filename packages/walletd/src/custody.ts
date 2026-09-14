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
 * - Identity key = HD root compressed pubkey (hex). BRC-42 keyDeriver
 *   paths replace this in M2; nothing here is protocol-stable yet.
 */
import keytar from "keytar";
import { HD, Mnemonic } from "@bsv/sdk";

const SERVICE = "bsv-walletd";
const ACCOUNT = "master";
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
    hasWalletCache = (await keytar.getPassword(SERVICE, ACCOUNT)) !== null;
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
  await keytar.setPassword(SERVICE, ACCOUNT, phrase);
  hasWalletCache = true;
  session = HD.fromSeed(new Mnemonic(phrase).toSeed());
  armTimer();
  return { identityKey: identityOf(session), backup: phrase };
}

export async function unlock(): Promise<{ identityKey: string }> {
  const stored = await keytar.getPassword(SERVICE, ACCOUNT).catch(() => null);
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

/** Factory reset: wipes the enrolled secret. Caller must have a backup. */
export async function destroyWallet(): Promise<void> {
  lock();
  try {
    await keytar.deletePassword(SERVICE, ACCOUNT);
  } catch {
    /* ignore */
  }
  hasWalletCache = false;
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
