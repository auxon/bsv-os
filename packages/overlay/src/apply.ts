import { parsePayload, publisherAddress, type InstallReceipt, type ListingToken } from "./listing.ts";
import type { ListingStore } from "./lookup.ts";
import { storedFromToken } from "./lookup.ts";
import { installSplit } from "./payment.ts";
import type { StoreConfig } from "./protocol.ts";
import { identifyAdmissibleOutputs, type OverlayTx, type PreviousListing } from "./topic-manager.ts";

export interface ApplyResult {
  ok: boolean;
  admitted: boolean;
  kind?: "listing" | "delist" | "install";
  outpoint?: string;
  reason?: string;
}

/**
 * Run admission, then persist. Installs become licenses only when the
 * store-cut output was admitted — that is the whole point of the check.
 */
export async function applyOverlayTx(
  store: ListingStore,
  tx: OverlayTx,
  cfg: StoreConfig,
): Promise<ApplyResult> {
  const found = findPayload(tx);
  if (!found.ok) return { ok: false, admitted: false, reason: found.reason };

  let previous: PreviousListing | null = null;
  let listingForInstall: { priceSats: number; publisherKey: string; bundleHash: string; outpoint: string } | null = null;

  if (found.payload.type === "listing" && found.payload.prevOutpoint) {
    const prev = await store.get(found.payload.prevOutpoint);
    previous = prev
      ? {
          outpoint: prev.outpoint,
          publisherKey: prev.publisherKey,
          domain: prev.domain,
          version: prev.version,
          spent: prev.spent,
        }
      : null;
  } else if (found.payload.type === "delist") {
    const prev = await store.get(found.payload.prevOutpoint);
    previous = prev
      ? {
          outpoint: prev.outpoint,
          publisherKey: prev.publisherKey,
          domain: prev.domain,
          version: prev.version,
          spent: prev.spent,
        }
      : null;
  } else if (found.payload.type === "install") {
    const live = await store.get(found.payload.listingOutpoint);
    listingForInstall = live
      ? {
          priceSats: live.priceSats,
          publisherKey: live.publisherKey,
          bundleHash: live.bundleHash,
          outpoint: live.outpoint,
        }
      : null;
  }

  const admit = identifyAdmissibleOutputs(tx, { cfg, previous, listingForInstall });
  if (!admit.ok) return { ok: false, admitted: false, reason: admit.reason };

  if (admit.kind === "listing") {
    const token = admit.payload as ListingToken;
    const vout = admit.outputsToAdmit[0];
    if (vout === undefined) return { ok: false, admitted: false, reason: "no listing sat admitted" };
    if (token.prevOutpoint) await store.markSpent(token.prevOutpoint);
    const row = storedFromToken(token, tx.txid, vout);
    await store.put(row);
    return { ok: true, admitted: true, kind: "listing", outpoint: row.outpoint };
  }

  if (admit.kind === "delist") {
    const token = admit.payload as { prevOutpoint: string };
    await store.markSpent(token.prevOutpoint);
    return { ok: true, admitted: true, kind: "delist", outpoint: token.prevOutpoint };
  }

  const receipt = admit.payload as InstallReceipt;
  const listing = listingForInstall!;
  const split = installSplit(listing.priceSats, cfg.storeCutBps);
  await store.putLicense({
    listingOutpoint: receipt.listingOutpoint,
    paymentTxid: tx.txid.toLowerCase(),
    buyerKey: receipt.buyerKey ?? null,
    bundleHash: receipt.bundleHash,
    publisherSats: split.publisherSats,
    storeSats: split.storeSats,
    createdAt: Date.now(),
  });
  return { ok: true, admitted: true, kind: "install", outpoint: receipt.listingOutpoint };
}

function findPayload(tx: OverlayTx): { ok: true; payload: ReturnType<typeof parsePayload> } | { ok: false; reason: string } {
  for (const o of tx.outputs) {
    if (!o.opReturn || o.opReturn[0] !== "bsvos.app" || typeof o.opReturn[1] !== "string") continue;
    try {
      return { ok: true, payload: parsePayload(JSON.parse(o.opReturn[1])) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, reason: "no bsvos.app payload" };
}

export function publisherP2pkh(publisherKey: string): string {
  return publisherAddress(publisherKey);
}
