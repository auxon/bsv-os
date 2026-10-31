/**
 * bsvOS app-store overlay constants and config.
 *
 * One listing token type (`bsvos.app`). Updates spend the previous listing
 * output. Publishing-fee and store-cut checks live here — nothing on-chain
 * enforces the 10% cut, so third-party wallets can pay only the publisher;
 * the topic manager refuses those txs and the lookup never marks them licensed.
 */

export const TOPIC = "tm_bsvos_apps";
export const LOOKUP = "ls_bsvos_apps";
export const PROTOCOL = "bsvos.app";

/** Hosts that are a shared identity slot — rejected for real listings. */
export const SHARED_IDENTITY_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const DEFAULT_PUBLISHING_FEE_SATS = 1000;
export const DEFAULT_STORE_CUT_BPS = 1000;

export interface StoreConfig {
  storeAddress: string;
  storePubkey: string;
  publishingFeeSats: number;
  storeCutBps: number;
}

export function storeConfig(raw: Partial<StoreConfig> = {}): StoreConfig {
  const publishingFeeSats = Math.floor(Number(raw.publishingFeeSats ?? DEFAULT_PUBLISHING_FEE_SATS));
  const storeCutBps = Math.floor(Number(raw.storeCutBps ?? DEFAULT_STORE_CUT_BPS));
  if (!Number.isFinite(publishingFeeSats) || publishingFeeSats < 1) {
    throw new Error("publishingFeeSats must be a positive sat number");
  }
  if (!Number.isFinite(storeCutBps) || storeCutBps < 0 || storeCutBps > 10_000) {
    throw new Error("storeCutBps must be 0-10000");
  }
  return {
    storeAddress: String(raw.storeAddress ?? "").trim(),
    storePubkey: String(raw.storePubkey ?? "").trim().toLowerCase(),
    publishingFeeSats,
    storeCutBps,
  };
}

export function configFromEnv(env: Record<string, string | undefined>): StoreConfig {
  return storeConfig({
    storeAddress: env.STORE_ADDRESS,
    storePubkey: env.STORE_PUBKEY,
    publishingFeeSats: env.PUBLISHING_FEE_SATS ? Number(env.PUBLISHING_FEE_SATS) : undefined,
    storeCutBps: env.STORE_CUT_BPS ? Number(env.STORE_CUT_BPS) : undefined,
  });
}

export function isSharedIdentityHost(host: string): boolean {
  return SHARED_IDENTITY_HOSTS.has(host.trim().toLowerCase());
}

/** True for `cast.localhost` (one label + .localhost). Not `localhost` itself. */
export function isAppLocalhost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h.endsWith(".localhost")) return false;
  const label = h.slice(0, -".localhost".length);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

export function outpointOf(txid: string, vout: number): string {
  return `${txid.toLowerCase()}.${vout}`;
}

export function parseOutpoint(raw: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-fA-F]{64})\.(\d+)$/.exec((raw ?? "").trim());
  if (!m) return null;
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) };
}
