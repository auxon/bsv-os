/**
 * Atomic Market client: the daemon side of the generic order book.
 *
 * Reads listings and posts signed offers/buys to the market worker
 * (BSV_MARKET_URL, default the EntangleIT deployment). The daemon owns
 * the wallet-side work — building offers, verifying buyer terms, signing
 * — so CLI and MCP callers just name the listing. Every write still goes
 * through policy at the caller's origin, so agent budgets and caps apply.
 */

export const DEFAULT_MARKET_URL = "https://market.entangleit.com";

export function marketUrl(): string {
  return (process.env.BSV_MARKET_URL ?? DEFAULT_MARKET_URL).replace(/\/+$/, "");
}

export interface MarketListing {
  origin: string;
  assetKind: "ordinal" | "bsv21";
  title: string;
  image: string | null;
  priceSats: number;
  seller: string;
  /** Atomic offer (v4 ordinal dual-input or v3 bsv21), opaque to callers. */
  offer: unknown | null;
  sellerUnlock: string | null;
  payScript: string | null;
  inputScript: string | null;
  tokenId: string | null;
  tokenAmount: string | null;
  feeBps: number;
  feeAddress: string;
  status: string;
  buyTxid: string | null;
  transferTxid: string | null;
}

type FetchFn = typeof fetch;

async function jfetch<T>(url: string, init: RequestInit | undefined, fetchFn: FetchFn): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw Object.assign(new Error(`market unreachable: ${e instanceof Error ? e.message : e}`), { code: "RAILS" });
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!res.ok) {
    const code = body?.error?.code ?? "RAILS";
    throw Object.assign(new Error(body?.error?.message ?? `market answered ${res.status}`), { code });
  }
  return body as T;
}

export async function fetchListings(
  kind?: "ordinal" | "bsv21",
  fetchFn: FetchFn = fetch,
): Promise<MarketListing[]> {
  const q = kind ? `?kind=${kind}` : "";
  const out = await jfetch<{ listings?: MarketListing[] }>(`${marketUrl()}/v1/market${q}`, undefined, fetchFn);
  return Array.isArray(out.listings) ? out.listings : [];
}

/** One listing, or null when the market does not know the origin. */
export async function fetchListing(origin: string, fetchFn: FetchFn = fetch): Promise<MarketListing | null> {
  try {
    const out = await jfetch<{ listing?: MarketListing }>(
      `${marketUrl()}/v1/market/listing/${encodeURIComponent(origin)}`,
      undefined,
      fetchFn,
    );
    return out.listing ?? null;
  } catch (e) {
    if ((e as { code?: string }).code === "NOT_FOUND") return null;
    throw e;
  }
}

export async function fetchOperatorFee(
  fetchFn: FetchFn = fetch,
): Promise<{ feeBps: number; feeAddress: string }> {
  return jfetch(`${marketUrl()}/v1/market/fees`, undefined, fetchFn);
}

/** Market fee for a listing price, per the listing's own terms. */
export function listingFeeSats(listing: Pick<MarketListing, "priceSats" | "feeBps">): number {
  const bps = Math.floor(Number(listing.feeBps) || 0);
  if (bps <= 0) return 0;
  return Math.max(1, Math.floor((listing.priceSats * bps) / 10000));
}

async function post(path: string, body: Record<string, unknown>, fetchFn: FetchFn): Promise<void> {
  await jfetch(
    `${marketUrl()}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    fetchFn,
  );
}

export function postListing(body: Record<string, unknown>, fetchFn: FetchFn = fetch): Promise<void> {
  return post("/v1/market/list", body, fetchFn);
}

export interface RetryOpts {
  attempts?: number;
  /** Delay before attempt N (1-based retry index); default 4s, 8s, 12s… */
  delayMs?: (retry: number) => number;
}

/**
 * Post a buy/settle with backoff, retrying only `TX_UNKNOWN`: indexers
 * lag behind a fresh broadcast by up to a couple of minutes, and that is
 * exactly the window where the market cannot verify yet. Every other
 * error (bad payment, wrong fee) is final and fails fast.
 */
async function postSettlement(path: string, body: Record<string, unknown>, fetchFn: FetchFn, retry: RetryOpts): Promise<void> {
  const attempts = Math.max(1, retry.attempts ?? 5);
  const delay = retry.delayMs ?? ((n: number) => 4000 * n);
  for (let i = 1; ; i++) {
    try {
      await post(path, body, fetchFn);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "TX_UNKNOWN" || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delay(i)));
    }
  }
}

export function markBought(
  origin: string,
  buyTxid: string,
  buyerHandle: string | undefined,
  fetchFn: FetchFn = fetch,
  retry: RetryOpts = {},
): Promise<void> {
  return postSettlement(
    "/v1/market/buy",
    { origin, buyTxid, ...(buyerHandle ? { buyerHandle } : {}) },
    fetchFn,
    retry,
  );
}

export function markSettled(
  origin: string,
  transferTxid: string,
  fetchFn: FetchFn = fetch,
  retry: RetryOpts = {},
): Promise<void> {
  return postSettlement("/v1/market/settle", { origin, transferTxid }, fetchFn, retry);
}

export function cancelListing(origin: string, seller: string, fetchFn: FetchFn = fetch): Promise<void> {
  return post("/v1/market/cancel", { origin, seller }, fetchFn);
}
