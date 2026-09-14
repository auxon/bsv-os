/* BSV OS wallet bridge — MAIN-world page script.
 *
 * Defines the capability-scoped `window.bsv` the runner injects into
 * installed Metanet apps. Four intents, nothing else: status, identity
 * (public key only), balance, and timestamping. Every call is relayed to
 * the isolated content script, which POSTs it to the per-window loopback
 * bridge; the daemon enforces the app's origin policy and the custody
 * lock. Keys are never exposed — there is no method that returns one.
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
    version: "0.1.0",
    /** True when the bridge fragment is present (running inside the runner). */
    isBSVOS: bridged,
    /** { authenticated, locked, hasWallet } — never keys. */
    getStatus: () => invoke("getStatus"),
    /** { identityKey, locked } — public key only. */
    getIdentity: () => invoke("getIdentity"),
    /** { address, confirmed, unconfirmed, utxos } in sats. */
    getBalance: () => invoke("getBalance"),
    /** Timestamp 64-hex on-chain under this app's origin policy. Returns { txid, fee }. */
    timestamp: (sha256) => invoke("timestamp", { sha256 }),
  });

  // Visible-in-DOM proof of injection (works with --dump-dom and scrapers).
  try {
    document.documentElement.setAttribute("data-bsvos", bridged ? "0.1.0" : "absent");
  } catch {
    /* document not ready in exotic contexts; window.bsv still works */
  }
})();
