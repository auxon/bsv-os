import { BSM, PublicKey, Signature } from "@bsv/sdk";
import { isSha256Hex, stableStringify } from "./hash.ts";
import { isSharedIdentityHost, parseOutpoint } from "./protocol.ts";

export interface ListingPermissions {
  spendCapSats: number;
  protocols: number;
  baskets: number;
  certs: number;
  intents: string[];
}

export interface ListingToken {
  v: 1;
  type: "listing";
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
  /** Present on updates: the listing outpoint being spent. */
  prevOutpoint?: string;
  signature: string;
}

export interface DelistToken {
  v: 1;
  type: "delist";
  prevOutpoint: string;
  publisherKey: string;
  signature: string;
}

export interface InstallReceipt {
  v: 1;
  type: "install";
  listingOutpoint: string;
  bundleHash: string;
  buyerKey?: string;
}

export type AppStorePayload = ListingToken | DelistToken | InstallReceipt;

const PUBKEY = /^[0-9a-f]{66}$/;
const VERSION = /^\d{1,6}(\.\d{1,6}){0,3}$/;

export function listingSignPayload(token: Omit<ListingToken, "signature"> | ListingToken): string {
  const { signature: _s, ...rest } = token as ListingToken;
  return stableStringify(rest);
}

export function delistSignPayload(token: Omit<DelistToken, "signature"> | DelistToken): string {
  const { signature: _s, ...rest } = token as DelistToken;
  return stableStringify(rest);
}

export function signMessageBsm(priv: { toPublicKey(): { toString(): string } }, message: string): string {
  return BSM.sign(Array.from(new TextEncoder().encode(message)), priv as never, "base64") as string;
}

export function verifyBsm(publisherKey: string, message: string, sigBase64: string): boolean {
  try {
    return BSM.verify(
      Array.from(new TextEncoder().encode(message)),
      Signature.fromCompact(sigBase64, "base64"),
      PublicKey.fromString(publisherKey),
    );
  } catch {
    return false;
  }
}

export function publisherAddress(publisherKey: string): string {
  return PublicKey.fromString(publisherKey).toAddress();
}

function asInt(n: unknown, field: string, min = 0): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < min) throw new Error(`${field} must be an integer >= ${min}`);
  return v;
}

function asText(n: unknown, field: string, max: number): string {
  const s = String(n ?? "").trim();
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} too long`);
  return s;
}

export function parsePermissions(raw: unknown): ListingPermissions {
  if (!raw || typeof raw !== "object") throw new Error("permissions must be an object");
  const p = raw as Record<string, unknown>;
  const intents = Array.isArray(p.intents)
    ? p.intents.map((x, i) => {
        const s = String(x ?? "").trim();
        if (!s || s.length > 64) throw new Error(`permissions.intents[${i}] invalid`);
        return s;
      })
    : [];
  if (intents.length > 32) throw new Error("permissions.intents at most 32");
  return {
    spendCapSats: asInt(p.spendCapSats, "permissions.spendCapSats"),
    protocols: asInt(p.protocols, "permissions.protocols"),
    baskets: asInt(p.baskets, "permissions.baskets"),
    certs: asInt(p.certs, "permissions.certs"),
    intents,
  };
}

function parseUrl(raw: string, domain: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("url is not a URL");
  }
  if (u.protocol !== "https:") throw new Error("url must be https");
  if (u.hostname.toLowerCase() !== domain) throw new Error("url must stay on the listing domain");
  if (u.search || u.hash) throw new Error("url must not carry query or fragment");
  if (!u.pathname.endsWith("/")) u.pathname = `${u.pathname}/`;
  return u.toString();
}

export function parseListing(raw: unknown): ListingToken {
  if (!raw || typeof raw !== "object") throw new Error("listing is not an object");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) throw new Error("listing.v must be 1");
  if (o.type !== "listing") throw new Error("listing.type must be listing");
  const domain = asText(o.domain, "domain", 253).toLowerCase();
  if (isSharedIdentityHost(domain)) {
    throw new Error("domain is a shared identity host — use a per-app subdomain before the first real listing");
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)) throw new Error("domain is not a hostname");
  const publisherKey = asText(o.publisherKey, "publisherKey", 66).toLowerCase();
  if (!PUBKEY.test(publisherKey)) throw new Error("publisherKey must be a 33-byte compressed pubkey");
  const bundleHash = asText(o.bundleHash, "bundleHash", 64).toLowerCase();
  const manifestHash = asText(o.manifestHash, "manifestHash", 64).toLowerCase();
  if (!isSha256Hex(bundleHash)) throw new Error("bundleHash must be 64 hex chars");
  if (!isSha256Hex(manifestHash)) throw new Error("manifestHash must be 64 hex chars");
  const version = asText(o.version, "version", 32);
  if (!VERSION.test(version)) throw new Error("version must be dotted numbers (e.g. 1.0.0)");
  const url = parseUrl(asText(o.url, "url", 512), domain);
  let prevOutpoint: string | undefined;
  if (o.prevOutpoint !== undefined && o.prevOutpoint !== null && o.prevOutpoint !== "") {
    const prev = parseOutpoint(String(o.prevOutpoint));
    if (!prev) throw new Error("prevOutpoint must look like txid.vout");
    prevOutpoint = `${prev.txid}.${prev.vout}`;
  }
  const token: ListingToken = {
    v: 1,
    type: "listing",
    name: asText(o.name, "name", 80),
    version,
    domain,
    url,
    category: typeof o.category === "string" ? o.category.trim().toLowerCase().slice(0, 32) : "",
    blurb: typeof o.blurb === "string" ? o.blurb.trim().slice(0, 280) : "",
    bundleHash,
    manifestHash,
    publisherKey,
    priceSats: asInt(o.priceSats, "priceSats"),
    permissions: parsePermissions(o.permissions),
    signature: asText(o.signature, "signature", 200),
  };
  if (prevOutpoint) token.prevOutpoint = prevOutpoint;
  return token;
}

export function parseDelist(raw: unknown): DelistToken {
  if (!raw || typeof raw !== "object") throw new Error("delist is not an object");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || o.type !== "delist") throw new Error("delist.v/type");
  const prev = parseOutpoint(String(o.prevOutpoint ?? ""));
  if (!prev) throw new Error("delist.prevOutpoint must look like txid.vout");
  const publisherKey = asText(o.publisherKey, "publisherKey", 66).toLowerCase();
  if (!PUBKEY.test(publisherKey)) throw new Error("publisherKey must be a 33-byte compressed pubkey");
  return {
    v: 1,
    type: "delist",
    prevOutpoint: `${prev.txid}.${prev.vout}`,
    publisherKey,
    signature: asText(o.signature, "signature", 200),
  };
}

export function parseInstallReceipt(raw: unknown): InstallReceipt {
  if (!raw || typeof raw !== "object") throw new Error("install is not an object");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || o.type !== "install") throw new Error("install.v/type");
  const listing = parseOutpoint(String(o.listingOutpoint ?? ""));
  if (!listing) throw new Error("listingOutpoint must look like txid.vout");
  const bundleHash = asText(o.bundleHash, "bundleHash", 64).toLowerCase();
  if (!isSha256Hex(bundleHash)) throw new Error("bundleHash must be 64 hex chars");
  const rec: InstallReceipt = {
    v: 1,
    type: "install",
    listingOutpoint: `${listing.txid}.${listing.vout}`,
    bundleHash,
  };
  if (typeof o.buyerKey === "string" && o.buyerKey) {
    const k = o.buyerKey.trim().toLowerCase();
    if (!PUBKEY.test(k)) throw new Error("buyerKey must be a 33-byte compressed pubkey");
    rec.buyerKey = k;
  }
  return rec;
}

export function parsePayload(raw: unknown): AppStorePayload {
  if (!raw || typeof raw !== "object") throw new Error("payload is not an object");
  const type = (raw as { type?: unknown }).type;
  if (type === "listing") return parseListing(raw);
  if (type === "delist") return parseDelist(raw);
  if (type === "install") return parseInstallReceipt(raw);
  throw new Error("payload.type must be listing, delist, or install");
}

export function verifyListingSignature(token: ListingToken): boolean {
  return verifyBsm(token.publisherKey, listingSignPayload(token), token.signature);
}

export function verifyDelistSignature(token: DelistToken): boolean {
  return verifyBsm(token.publisherKey, delistSignPayload(token), token.signature);
}

/** Compare dotted numeric versions. a < b → -1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x));
  const pb = b.split(".").map((x) => Number(x));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function decodePayloadJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
