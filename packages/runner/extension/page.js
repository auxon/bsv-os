/* BSV OS wallet bridge — MAIN-world page script.
 *
 * Defines the capability-scoped `window.bsv` the runner injects into
 * installed Metanet apps. Ten intents, nothing else: reads (status,
 * identity, balance, UTXOs) plus policy-gated writes (timestamp, spend,
 * inscribe, NFT transfer, atomic-swap offer/buy). Every call is relayed
 * to the isolated content script, which POSTs it to the per-window
 * loopback bridge; the daemon enforces the app's origin policy and the
 * custody lock. Keys are never exposed — there is no method that returns
 * one, and pages describe intents (outpoints, amounts, data) while the
 * daemon fetches and verifies every script itself.
 *
 * Outside the runner (plain browser, no bridge fragment) every method
 * rejects with a plain-English error instead of failing silently.
 */
(() => {
  "use strict";
  const frag = new URLSearchParams(window.location.hash.slice(1));
  const port = frag.get("bsv-port");
  const token = frag.get("bsv-token");
  const bridged = /^\d+$/.test(port ?? "") && !!token;

  let seq = 0;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "bsv-os-content" || typeof d.id !== "number") return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) {
      p.resolve(d.result);
    } else {
      const err = d.error ?? {};
      p.reject(new Error(`${err.code ?? "BRIDGE"}: ${err.message ?? "bridge error"}`));
    }
  });

  function invoke(method, params) {
    return new Promise((resolve, reject) => {
      if (!bridged) {
        reject(new Error("window.bsv needs the BSV OS runner — open this app with `bsv app open`"));
        return;
      }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      window.postMessage({ source: "bsv-os-page", id, method, params: params ?? {} }, "*");
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error("BRIDGE_TIMEOUT: wallet bridge did not answer"));
      }, 120000);
    });
  }

  window.bsv = Object.freeze({
    version: "0.2.0",
    /** True when the bridge fragment is present (running inside the runner). */
    isBSVOS: bridged,
    /** { authenticated, locked, hasWallet } — never keys. */
    getStatus: () => invoke("getStatus"),
    /** { identityKey, locked } — public key only. */
    getIdentity: () => invoke("getIdentity"),
    /** { address, confirmed, unconfirmed, utxos } in sats. */
    getBalance: () => invoke("getBalance"),
    /** { address, confirmed, unconfirmed, utxos[] } — outpoints/values only, never scripts. */
    getUtxos: () => invoke("getUtxos"),
    /** Timestamp 64-hex on-chain under this app's origin policy. Returns { txid, fee }. */
    timestamp: (sha256) => invoke("timestamp", { sha256 }),
    /** Daemon-built payments under this app's policy. Returns { txid, fee, hex }. */
    spend: (payments, memo, label) => invoke("spend", { payments, memo, label }),
    /** Mint a 1-sat inscription (≤256KB), optional operator fee. Returns { txid, fee, hex }. */
    inscribe: (dataHex, contentType, to, fee, memo, label) => invoke("inscribe", { dataHex, contentType, to, fee, memo, label }),
    /** Move one inscribed sat to an address. Returns { txid, fee }. */
    transferNft: (txid, vout, to, memo) => invoke("transferNft", { txid, vout, to, memo }),
    /** Pre-sign an atomic-swap listing on our carrier (ordinal or bsv21 exact amount). Returns the market offer. */
    signSwapOffer: (txid, vout, priceSats, kind, tokenId, tokenAmount) =>
      invoke("signSwapOffer", { txid, vout, priceSats, kind, tokenId, tokenAmount }),
    /** Buy a listing: payment + asset move in one tx. Optional buyerChecks { expectedSeller, maxPrice } refuse redirected/overpriced offers. Returns { txid, fee }. */
    completeSwap: (offer, fee, memo, buyerChecks) => invoke("completeSwap", { offer, fee, memo, buyerChecks }),
  });

  // Visible-in-DOM proof of injection (works with --dump-dom and scrapers).
  try {
    document.documentElement.setAttribute("data-bsvos", bridged ? "0.2.0" : "absent");
  } catch {
    /* document not ready in exotic contexts; window.bsv still works */
  }
})();
