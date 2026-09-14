/**
 * Custody boundary (M0: locked-by-default stub; real key management lands in M1).
 *
 * INVARIANT (enforced by CI grep): raw key material (WIF/hex/seed) may only
 * appear inside this module. Everything else talks intents.
 */
export interface CustodyStatus {
  locked: boolean;
  hasWallet: boolean;
}

let locked = true;

export function getStatus(): CustodyStatus {
  return { locked, hasWallet: false };
}

export function lock(): void {
  locked = true;
}

export function assertUnlocked(): void {
  if (locked) {
    const err = new Error("wallet locked") as Error & { code: string };
    err.code = "WALLET_LOCKED";
    throw err;
  }
}
