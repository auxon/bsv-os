/**
 * Overlay-backed app store client for walletd.
 *
 * store.json stays the mirror/fallback. When BSV_APPSTORE_OVERLAY is set
 * and the lookup answers, those listings win. Paid installs are only
 * treated as licensed when the payment includes the store-cut output;
 * walletd checks the same split before it pins a bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  bundleHash,
  installSplit,
  isSharedIdentityHost,
  sha256Hex,
  stableStringify,
  verifyInstallPayment,
  type ListingPermissions,
} from "../../overlay/src/index.ts";
import { spendTo } from "./engine.ts";

function listingManifestHash(manifest: unknown): string {
  return createHash("sha256").update(stableStringify(manifest), "utf8").digest("hex");
}

export const DEFAULT_STORE_CUT_BPS = 1000;

export interface OverlayListing {
  outpoint: string;
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
  source: "overlay";
}

export function overlayBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.BSV_APPSTORE_OVERLAY ?? "").trim().replace(/\/+$/, "");
  return raw || null;
}

export function storeAddress(env: Record<string, string | undefined> = process.env): string {
  return (env.BSV_APPSTORE_STORE_ADDRESS ?? "").trim();
}

export function storeCutBps(env: Record<string, string | undefined> = process.env): number {
  const n = Math.floor(Number(env.BSV_APPSTORE_STORE_CUT_BPS ?? DEFAULT_STORE_CUT_BPS));
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : DEFAULT_STORE_CUT_BPS;
}

function asListing(row: Record<string, unknown>): OverlayListing | null {
  if (typeof row.domain !== "string" || typeof row.name !== "string") return null;
  if (typeof row.bundleHash !== "string" || typeof row.manifestHash !== "string") return null;
  if (typeof row.outpoint !== "string") return null;
  const permissions = (row.permissions ?? {}) as ListingPermissions;
  return {
    outpoint: row.outpoint,
    name: String(row.name).slice(0, 80),
    version: typeof row.version === "string" ? row.version : "0",
    domain: row.domain.toLowerCase(),
    url: typeof row.url === "string" ? row.url : `https://${row.domain}/`,
    category: typeof row.category === "string" ? row.category : "",
    blurb: typeof row.blurb === "string" ? row.blurb.slice(0, 280) : "",
    bundleHash: row.bundleHash.toLowerCase(),
    manifestHash: row.manifestHash.toLowerCase(),
    publisherKey: typeof row.publisherKey === "string" ? row.publisherKey.toLowerCase() : "",
    priceSats: Math.max(0, Math.floor(Number(row.priceSats) || 0)),
    permissions: {
      spendCapSats: Math.max(0, Math.floor(Number(permissions.spendCapSats) || 0)),
      protocols: Math.max(0, Math.floor(Number(permissions.protocols) || 0)),
      baskets: Math.max(0, Math.floor(Number(permissions.baskets) || 0)),
      certs: Math.max(0, Math.floor(Number(permissions.certs) || 0)),
      intents: Array.isArray(permissions.intents) ? permissions.intents.map(String) : [],
    },
    source: "overlay",
  };
}

export async function fetchOverlayCatalog(
  opts: { base?: string | null; fetchFn?: typeof fetch } = {},
): Promise<OverlayListing[] | null> {
  const base = opts.base === undefined ? overlayBaseUrl() : opts.base;
  if (!base) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(`${base}/lookup`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ service: "ls_bsvos_apps", query: { latest: true } }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    const rows = Array.isArray(body.result) ? body.result : [];
    const out: OverlayListing[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const listing = asListing(row as Record<string, unknown>);
      if (listing && !isSharedIdentityHost(listing.domain)) out.push(listing);
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchOverlayListing(
  domainOrOutpoint: string,
  opts: { base?: string | null; fetchFn?: typeof fetch } = {},
): Promise<OverlayListing | null> {
  const rows = await fetchOverlayCatalog(opts);
  if (!rows) return null;
  const key = domainOrOutpoint.trim().toLowerCase();
  return rows.find((r) => r.domain === key || r.outpoint === key || r.url === domainOrOutpoint) ?? null;
}

export async function hashAppDirectory(dir: string): Promise<{ hash: string; files: Array<{ path: string; sha256: string }> }> {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(dir, next)));
        files.push({ path: next, sha256: await sha256Hex(bytes) });
      }
    }
  };
  await walk("");
  return { hash: await bundleHash(files), files };
}

export async function fetchAndHashBundle(
  baseUrl: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<{ hash: string; files: Array<{ path: string; sha256: string }> }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const dir = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const res = await fetchFn(new URL("bundle.json", dir).toString(), { headers: { accept: "application/json" } });
  if (!res.ok) throw Object.assign(new Error("overlay listing has no bundle.json — cannot verify who shipped the code"), { code: "BUNDLE" });
  const body = (await res.json()) as { files?: Array<{ path?: unknown; sha256?: unknown }> };
  if (!Array.isArray(body.files) || body.files.length === 0) throw Object.assign(new Error("bundle.json lists no files"), { code: "BUNDLE" });
  const files: Array<{ path: string; sha256: string }> = [];
  for (const f of body.files) {
    const rel = String(f.path ?? "");
    const listed = String(f.sha256 ?? "").toLowerCase();
    const fileRes = await fetchFn(new URL(rel, dir).toString());
    if (!fileRes.ok) throw Object.assign(new Error(`bundle file missing: ${rel}`), { code: "BUNDLE" });
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    const sha = await sha256Hex(bytes);
    if (listed && listed !== sha) throw Object.assign(new Error(`bundle file hash mismatch: ${rel}`), { code: "BUNDLE" });
    files.push({ path: rel, sha256: sha });
  }
  return { hash: await bundleHash(files), files };
}

export async function verifyListingHashes(opts: {
  listing: OverlayListing;
  manifest: unknown;
  bundle?: { hash: string };
}): Promise<void> {
  const pinned = listingManifestHash(opts.manifest);
  if (pinned !== opts.listing.manifestHash) {
    throw Object.assign(new Error("manifest hash does not match the listing"), { code: "HASH" });
  }
  if (!opts.bundle) {
    throw Object.assign(new Error("bundle hash required before install of an overlay listing"), { code: "HASH" });
  }
  if (opts.bundle.hash !== opts.listing.bundleHash) {
    throw Object.assign(new Error(`bundle hash mismatch (${opts.bundle.hash.slice(0, 12)}…)`), { code: "HASH" });
  }
}

export function verifyPaidInstall(opts: {
  outputs: Array<{ address?: string; satoshis: number }>;
  priceSats: number;
  publisherAddress: string;
  storeAddr?: string;
  cutBps?: number;
}): { publisherSats: number; storeSats: number } {
  const cfg = {
    storeAddress: opts.storeAddr ?? storeAddress(),
    storePubkey: "",
    publishingFeeSats: 1000,
    storeCutBps: opts.cutBps ?? storeCutBps(),
  };
  const r = verifyInstallPayment(opts.outputs, {
    priceSats: opts.priceSats,
    publisherAddress: opts.publisherAddress,
    cfg,
  });
  if (!r.ok) throw Object.assign(new Error(r.reason), { code: "PAYMENT" });
  return { publisherSats: r.split.publisherSats, storeSats: r.split.storeSats };
}

export function quoteInstall(priceSats: number, cutBps = storeCutBps()) {
  return installSplit(priceSats, cutBps);
}

export async function payForAppInstall(opts: {
  db: Parameters<typeof spendTo>[0]["db"];
  chain: Parameters<typeof spendTo>[0]["chain"];
  origin: string;
  listing: OverlayListing;
  publisherAddress: string;
  storeAddr?: string;
}): Promise<{ txid: string; fee: number; hex: string; split: ReturnType<typeof installSplit> }> {
  const storeAddr = opts.storeAddr ?? storeAddress();
  if (!storeAddr) throw Object.assign(new Error("BSV_APPSTORE_STORE_ADDRESS is not set — cannot take a licensed paid install"), { code: "SETUP" });
  const split = quoteInstall(opts.listing.priceSats);
  const payments: Array<{ to: string; sats: number }> = [];
  if (split.publisherSats > 0) payments.push({ to: opts.publisherAddress, sats: split.publisherSats });
  if (split.storeSats > 0) payments.push({ to: storeAddr, sats: split.storeSats });
  if (payments.length === 0) {
    return { txid: "", fee: 0, hex: "", split };
  }
  const sent = await spendTo({
    db: opts.db,
    chain: opts.chain,
    origin: opts.origin,
    payments,
    memo: ["BSVOS-INSTALL", opts.listing.outpoint.slice(0, 80), opts.listing.bundleHash.slice(0, 80)],
    label: `install ${opts.listing.name}`,
  });
  return { ...sent, split };
}
