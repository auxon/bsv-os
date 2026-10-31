import type { StoreConfig } from "./protocol.ts";

export interface PaymentSplit {
  priceSats: number;
  publisherSats: number;
  storeSats: number;
}

/**
 * Store cut is computed here and required by admission + licensing.
 * A 1-sat floor on the store side means a 1-sat price pays the store only
 * (publisher gets 0 and needs no output).
 */
export function installSplit(priceSats: number, storeCutBps: number): PaymentSplit {
  const price = Math.floor(Number(priceSats));
  if (!Number.isFinite(price) || price < 0) throw new Error("priceSats must be a non-negative sat number");
  if (!Number.isFinite(storeCutBps) || storeCutBps < 0 || storeCutBps > 10_000) {
    throw new Error("storeCutBps must be 0-10000");
  }
  if (price === 0) return { priceSats: 0, publisherSats: 0, storeSats: 0 };
  let storeSats = Math.floor((price * storeCutBps) / 10_000);
  if (storeSats < 1) storeSats = 1;
  if (storeSats > price) storeSats = price;
  return { priceSats: price, publisherSats: price - storeSats, storeSats };
}

export interface TxOutput {
  satoshis: number;
  address?: string;
  opReturn?: string[];
}

export function outputTo(outputs: TxOutput[], address: string): number {
  const want = address.trim();
  if (!want) return 0;
  return outputs.filter((o) => (o.address ?? "") === want).reduce((n, o) => n + Math.floor(o.satoshis || 0), 0);
}

/** Publishing-fee output to the store address. Required to admit a listing. */
export function hasPublishingFee(outputs: TxOutput[], cfg: StoreConfig): { ok: boolean; paid: number; reason?: string } {
  if (!cfg.storeAddress) return { ok: false, paid: 0, reason: "store address is not configured" };
  const paid = outputTo(outputs, cfg.storeAddress);
  if (paid < cfg.publishingFeeSats) {
    return { ok: false, paid, reason: `publishing fee ${paid} < ${cfg.publishingFeeSats} to store` };
  }
  return { ok: true, paid };
}

/**
 * Install payment must include the store-cut output. Publisher output is
 * required only when the publisher side is > 0. This is what marks a
 * license — a payment that only hits the publisher is not licensed.
 */
export function verifyInstallPayment(
  outputs: TxOutput[],
  opts: {
    priceSats: number;
    publisherAddress: string;
    cfg: StoreConfig;
  },
): { ok: true; split: PaymentSplit } | { ok: false; split: PaymentSplit; reason: string } {
  const split = installSplit(opts.priceSats, opts.cfg.storeCutBps);
  if (split.priceSats === 0) return { ok: true, split };
  if (!opts.cfg.storeAddress) return { ok: false, split, reason: "store address is not configured" };
  const storePaid = outputTo(outputs, opts.cfg.storeAddress);
  if (storePaid < split.storeSats) {
    return { ok: false, split, reason: `store cut ${storePaid} < ${split.storeSats}` };
  }
  if (split.publisherSats > 0) {
    if (!opts.publisherAddress) return { ok: false, split, reason: "publisher address missing" };
    const pubPaid = outputTo(outputs, opts.publisherAddress);
    if (pubPaid < split.publisherSats) {
      return { ok: false, split, reason: `publisher payment ${pubPaid} < ${split.publisherSats}` };
    }
  }
  return { ok: true, split };
}
