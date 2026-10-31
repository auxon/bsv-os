import {
  parsePayload,
  publisherAddress,
  verifyDelistSignature,
  verifyListingSignature,
  type AppStorePayload,
  type InstallReceipt,
  type ListingToken,
} from "./listing.ts";
import { hasPublishingFee, verifyInstallPayment, type TxOutput } from "./payment.ts";
import { PROTOCOL, type StoreConfig, outpointOf } from "./protocol.ts";

export interface OverlayInput {
  txid: string;
  vout: number;
}

export interface OverlayTx {
  txid: string;
  inputs: OverlayInput[];
  outputs: TxOutput[];
}

export interface PreviousListing {
  outpoint: string;
  publisherKey: string;
  domain: string;
  version: string;
  spent?: boolean;
}

export interface AdmitResult {
  ok: boolean;
  outputsToAdmit: number[];
  coinsToRetain: string[];
  kind?: "listing" | "delist" | "install";
  payload?: AppStorePayload;
  reason?: string;
}

function payloadFromOutputs(
  outputs: TxOutput[],
): { ok: true; index: number; payload: AppStorePayload } | { ok: false; reason: string } {
  for (let i = 0; i < outputs.length; i++) {
    const parts = outputs[i]?.opReturn;
    if (!parts || parts[0] !== PROTOCOL || typeof parts[1] !== "string") continue;
    try {
      return { ok: true, index: i, payload: parsePayload(JSON.parse(parts[1])) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, reason: `no ${PROTOCOL} OP_RETURN payload` };
}

function reject(reason: string): AdmitResult {
  return { ok: false, outputsToAdmit: [], coinsToRetain: [], reason };
}

/**
 * BRC-22 admission for tm_bsvos_apps.
 *
 * Listing: valid signed token, publisher-locked sat, publishing fee to the
 * store address. Updates must spend the previous listing; only that
 * publisher can update or delist.
 *
 * Install: not a second listing type — a receipt. Admitted only when the
 * store-cut output is present so the lookup can mark a license.
 */
export function identifyAdmissibleOutputs(
  tx: OverlayTx,
  opts: {
    cfg: StoreConfig;
    previous?: PreviousListing | null;
    listingForInstall?: { priceSats: number; publisherKey: string; bundleHash: string; outpoint: string } | null;
  },
): AdmitResult {
  const found = payloadFromOutputs(tx.outputs);
  if (!found.ok) return reject(found.reason);
  const { payload } = found;

  if (payload.type === "listing") return admitListing(tx, payload, opts.cfg, opts.previous ?? null);
  if (payload.type === "delist") return admitDelist(tx, payload, opts.cfg, opts.previous ?? null);
  return admitInstall(tx, payload, opts.cfg, opts.listingForInstall ?? null);
}

function listingSatIndex(tx: OverlayTx, publisherKey: string): number {
  let addr: string;
  try {
    addr = publisherAddress(publisherKey);
  } catch {
    return -1;
  }
  return tx.outputs.findIndex((o) => (o.address ?? "") === addr && (o.satoshis ?? 0) >= 1 && !o.opReturn);
}

function spendsPrevious(tx: OverlayTx, prevOutpoint: string): boolean {
  return tx.inputs.some((i) => outpointOf(i.txid, i.vout) === prevOutpoint);
}

function admitListing(
  tx: OverlayTx,
  token: ListingToken,
  cfg: StoreConfig,
  previous: PreviousListing | null,
): AdmitResult {
  if (!verifyListingSignature(token)) return reject("listing signature invalid");
  const fee = hasPublishingFee(tx.outputs, cfg);
  if (!fee.ok) return reject(fee.reason ?? "publishing fee missing");
  const sat = listingSatIndex(tx, token.publisherKey);
  if (sat < 0) return reject("listing sat must be locked to the publisher key");

  if (token.prevOutpoint) {
    if (!previous) return reject("update spends an unknown listing");
    if (previous.spent) return reject("previous listing already spent");
    if (previous.outpoint !== token.prevOutpoint) return reject("prevOutpoint does not match spent listing");
    if (!spendsPrevious(tx, token.prevOutpoint)) return reject("update must spend the previous listing output");
    if (previous.publisherKey !== token.publisherKey) return reject("only the publisher can update");
    if (previous.domain !== token.domain) return reject("update cannot change domain");
  } else if (tx.inputs.some((i) => previous && outpointOf(i.txid, i.vout) === previous.outpoint)) {
    return reject("spending a listing requires prevOutpoint on the new token");
  }

  return {
    ok: true,
    outputsToAdmit: [sat],
    coinsToRetain: token.prevOutpoint ? [token.prevOutpoint] : [],
    kind: "listing",
    payload: token,
  };
}

function admitDelist(
  tx: OverlayTx,
  token: ReturnType<typeof parsePayload> & { type: "delist" },
  cfg: StoreConfig,
  previous: PreviousListing | null,
): AdmitResult {
  void cfg;
  if (!verifyDelistSignature(token)) return reject("delist signature invalid");
  if (!previous) return reject("delist spends an unknown listing");
  if (previous.spent) return reject("previous listing already spent");
  if (previous.outpoint !== token.prevOutpoint) return reject("delist prevOutpoint mismatch");
  if (!spendsPrevious(tx, token.prevOutpoint)) return reject("delist must spend the previous listing output");
  if (previous.publisherKey !== token.publisherKey) return reject("only the publisher can delist");
  return {
    ok: true,
    outputsToAdmit: [],
    coinsToRetain: [token.prevOutpoint],
    kind: "delist",
    payload: token,
  };
}

function admitInstall(
  tx: OverlayTx,
  receipt: InstallReceipt,
  cfg: StoreConfig,
  listing: { priceSats: number; publisherKey: string; bundleHash: string; outpoint: string } | null,
): AdmitResult {
  if (!listing) return reject("install refers to an unknown listing");
  if (listing.outpoint !== receipt.listingOutpoint) return reject("install listingOutpoint mismatch");
  if (listing.bundleHash !== receipt.bundleHash) return reject("install bundleHash does not match listing");
  let publisherAddr = "";
  try {
    publisherAddr = publisherAddress(listing.publisherKey);
  } catch {
    return reject("listing publisher key is not an address");
  }
  const paid = verifyInstallPayment(tx.outputs, {
    priceSats: listing.priceSats,
    publisherAddress: publisherAddr,
    cfg,
  });
  if (!paid.ok) return reject(paid.reason);
  return {
    ok: true,
    outputsToAdmit: [],
    coinsToRetain: [],
    kind: "install",
    payload: receipt,
  };
}

export const TOPIC_MANAGER_DOCS = `# tm_bsvos_apps

BRC-22 topic manager for the bsvOS app store.

Admits one listing token type (\`bsvos.app\` OP_RETURN):

- name, version, domain/URL, bundle hash, manifest hash, publisher
  identity key (BRC-100), price in sats, requested permissions,
  signature by that key
- a sat locked to the publisher (the output that must be spent to update
  or delist)
- a publishing-fee output to the store address (anti-spam)

Updates spend the previous listing output. Only the publisher can update
or delist.

Install receipts ride the same topic but are not a second listing type.
They are admitted only when the payment includes the configured store-cut
output. The lookup service marks a license only for admitted receipts.

Shared identity hosts (\`localhost\`, \`127.0.0.1\`) are rejected. Per-app
subdomains (\`cast.localhost\`) or public hosts are required before the
first real listing, because otherwise the publisher key cannot prove who
shipped the code.
`;
