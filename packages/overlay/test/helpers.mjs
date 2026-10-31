import { PrivateKey } from "@bsv/sdk";
import { listingSignPayload, delistSignPayload, parseListing, signMessageBsm, publisherAddress } from "../src/listing.ts";
import { PROTOCOL } from "../src/protocol.ts";

export function publisher() {
  const priv = PrivateKey.fromRandom();
  const publisherKey = priv.toPublicKey().toString();
  return { priv, publisherKey, address: publisherAddress(publisherKey) };
}

export function signedListing(priv, fields = {}) {
  const publisherKey = priv.toPublicKey().toString();
  const unsigned = {
    v: 1,
    type: "listing",
    name: "Cast",
    version: "1.0.0",
    domain: "cast.localhost",
    url: "https://cast.localhost:2121/",
    category: "media",
    blurb: "player",
    bundleHash: "ab".repeat(32),
    manifestHash: "cd".repeat(32),
    publisherKey,
    priceSats: 0,
    permissions: { spendCapSats: 0, protocols: 0, baskets: 0, certs: 0, intents: [] },
    ...fields,
    publisherKey: fields.publisherKey ?? publisherKey,
  };
  const signature = signMessageBsm(priv, listingSignPayload(unsigned));
  return parseListing({ ...unsigned, signature });
}

export function signedDelist(priv, prevOutpoint) {
  const publisherKey = priv.toPublicKey().toString();
  const unsigned = { v: 1, type: "delist", prevOutpoint, publisherKey };
  const signature = signMessageBsm(priv, delistSignPayload(unsigned));
  return { ...unsigned, signature };
}

export function listingTx(token, opts = {}) {
  const pubAddr = opts.publisherAddress ?? publisherAddress(token.publisherKey);
  const storeAddress = opts.storeAddress;
  const fee = opts.feeSats ?? 1000;
  const outputs = [
    { satoshis: 1, address: pubAddr },
    { satoshis: 0, opReturn: [PROTOCOL, JSON.stringify(token)] },
  ];
  if (storeAddress) outputs.push({ satoshis: fee, address: storeAddress });
  return {
    txid: opts.txid ?? "aa".repeat(32),
    inputs: opts.inputs ?? [],
    outputs,
  };
}

export function installTx(receipt, opts) {
  const outputs = [{ satoshis: 0, opReturn: [PROTOCOL, JSON.stringify(receipt)] }];
  if (opts.publisherSats > 0) outputs.push({ satoshis: opts.publisherSats, address: opts.publisherAddress });
  if (opts.storeSats > 0) outputs.push({ satoshis: opts.storeSats, address: opts.storeAddress });
  return {
    txid: opts.txid ?? "bb".repeat(32),
    inputs: [],
    outputs,
  };
}
