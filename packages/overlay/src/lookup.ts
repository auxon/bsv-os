import type { ListingPermissions, ListingToken } from "./listing.ts";
import { outpointOf } from "./protocol.ts";

export interface StoredListing {
  outpoint: string;
  txid: string;
  vout: number;
  name: string;
  version: string;
  domain: string;
  url: string;
  category: string;
  blurb: string;
  bundleHash: string;
  manifestHash: string;
  publisherKey: string;
  priceSats: number;
  permissions: ListingPermissions;
  signature: string;
  spent: boolean;
  createdAt: number;
}

export interface StoredLicense {
  listingOutpoint: string;
  paymentTxid: string;
  buyerKey: string | null;
  bundleHash: string;
  publisherSats: number;
  storeSats: number;
  createdAt: number;
}

export interface ListingStore {
  get(outpoint: string): Promise<StoredListing | null>;
  liveByDomain(domain: string): Promise<StoredListing | null>;
  put(row: StoredListing): Promise<void>;
  markSpent(outpoint: string): Promise<void>;
  search(q: ListingQuery): Promise<StoredListing[]>;
  putLicense(row: StoredLicense): Promise<void>;
  licenseByPayment(txid: string): Promise<StoredLicense | null>;
  licensesFor(listingOutpoint: string): Promise<StoredLicense[]>;
}

export interface ListingQuery {
  name?: string;
  category?: string;
  publisher?: string;
  domain?: string;
  latest?: boolean;
  includeSpent?: boolean;
}

export function storedFromToken(
  token: ListingToken,
  txid: string,
  vout: number,
  createdAt = Date.now(),
): StoredListing {
  return {
    outpoint: outpointOf(txid, vout),
    txid: txid.toLowerCase(),
    vout,
    name: token.name,
    version: token.version,
    domain: token.domain,
    url: token.url,
    category: token.category,
    blurb: token.blurb,
    bundleHash: token.bundleHash,
    manifestHash: token.manifestHash,
    publisherKey: token.publisherKey,
    priceSats: token.priceSats,
    permissions: token.permissions,
    signature: token.signature,
    spent: false,
    createdAt,
  };
}

export function matchesQuery(row: StoredListing, q: ListingQuery): boolean {
  if (!q.includeSpent && row.spent) return false;
  if (q.domain && row.domain !== q.domain.toLowerCase()) return false;
  if (q.publisher && row.publisherKey !== q.publisher.toLowerCase()) return false;
  if (q.category && row.category !== q.category.toLowerCase()) return false;
  if (q.name) {
    const n = q.name.toLowerCase();
    if (!row.name.toLowerCase().includes(n) && row.domain !== n) return false;
  }
  return true;
}

/** Keep the highest version per domain (then newest createdAt). */
export function latestPerDomain(rows: StoredListing[]): StoredListing[] {
  const best = new Map<string, StoredListing>();
  for (const row of rows) {
    const cur = best.get(row.domain);
    if (!cur) {
      best.set(row.domain, row);
      continue;
    }
    const cmp = compareVersionThenTime(row, cur);
    if (cmp > 0) best.set(row.domain, row);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function compareVersionThenTime(a: StoredListing, b: StoredListing): number {
  const pa = a.version.split(".").map((x) => Number(x));
  const pb = b.version.split(".").map((x) => Number(x));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1;
}

export async function lookupListings(store: ListingStore, q: ListingQuery): Promise<StoredListing[]> {
  const rows = await store.search(q);
  return q.latest === false ? rows : latestPerDomain(rows);
}

export async function lookupLicense(
  store: ListingStore,
  q: { listingOutpoint?: string; paymentTxid?: string },
): Promise<{ licensed: boolean; license: StoredLicense | null }> {
  if (q.paymentTxid) {
    const license = await store.licenseByPayment(q.paymentTxid);
    return { licensed: Boolean(license), license };
  }
  if (q.listingOutpoint) {
    const rows = await store.licensesFor(q.listingOutpoint);
    return { licensed: rows.length > 0, license: rows[0] ?? null };
  }
  return { licensed: false, license: null };
}

export class MemoryListingStore implements ListingStore {
  listings = new Map<string, StoredListing>();
  licenses: StoredLicense[] = [];

  async get(outpoint: string): Promise<StoredListing | null> {
    return this.listings.get(outpoint) ?? null;
  }
  async liveByDomain(domain: string): Promise<StoredListing | null> {
    const live = [...this.listings.values()].filter((r) => r.domain === domain.toLowerCase() && !r.spent);
    return latestPerDomain(live)[0] ?? null;
  }
  async put(row: StoredListing): Promise<void> {
    this.listings.set(row.outpoint, { ...row });
  }
  async markSpent(outpoint: string): Promise<void> {
    const row = this.listings.get(outpoint);
    if (row) row.spent = true;
  }
  async search(q: ListingQuery): Promise<StoredListing[]> {
    return [...this.listings.values()].filter((r) => matchesQuery(r, q));
  }
  async putLicense(row: StoredLicense): Promise<void> {
    if (this.licenses.some((l) => l.paymentTxid === row.paymentTxid)) return;
    this.licenses.push({ ...row });
  }
  async licenseByPayment(txid: string): Promise<StoredLicense | null> {
    return this.licenses.find((l) => l.paymentTxid === txid.toLowerCase()) ?? null;
  }
  async licensesFor(listingOutpoint: string): Promise<StoredLicense[]> {
    return this.licenses.filter((l) => l.listingOutpoint === listingOutpoint);
  }
}

export const LOOKUP_DOCS = `# ls_bsvos_apps

BRC-24 lookup service for the bsvOS app store.

Query shapes (POST /lookup \`{ service: "ls_bsvos_apps", query }\`):

- \`{ latest: true }\` — live listings, highest version per domain
- \`{ name: "cast" }\` — name or domain substring
- \`{ category: "media" }\`
- \`{ publisher: "<identityKey>" }\`
- \`{ domain: "cast.localhost" }\`
- \`{ licensed: { listingOutpoint, paymentTxid? } }\` — true only when an
  admitted install payment included the store-cut output

\`store.json\` is a mirror/fallback for the wallet UI. This service is the
registry once Richard deploys the Worker and sets the store key.
`;
