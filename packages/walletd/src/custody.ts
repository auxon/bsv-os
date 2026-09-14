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
import { HD, Mnemonic, P2PKH, PrivateKey, Script, Transaction, type UnlockingScript } from "@bsv/sdk";
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
