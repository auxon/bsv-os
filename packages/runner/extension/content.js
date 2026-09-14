/* BSV OS wallet bridge — isolated-world content script.
 *
 * Injects page.js into the MAIN world (isolated scripts cannot set
 * window.bsv for page code) and relays namespaced postMessage calls to
 * the per-window loopback bridge. Only messages tagged `bsv-os-page`
 * from this window are honored; only the bridge fragment's own port is
 * ever contacted; the daemon allowlists methods and stamps the app's
 * origin server-side, so page claims are never trusted.
 */
(() => {
  "use strict";
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  const frag = new URLSearchParams(window.location.hash.slice(1));
  const port = frag.get("bsv-port");
  const token = frag.get("bsv-token");
  const bridged = /^\d+$/.test(port ?? "") && !!token;

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "bsv-os-page" || typeof d.method !== "string" || typeof d.id !== "number") return;
    const reply = (msg) => window.postMessage({ source: "bsv-os-content", id: d.id, ...msg }, "*");
    if (!bridged) {
      reply({ ok: false, error: { code: "NO_BRIDGE", message: "not running inside the BSV OS runner" } });
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, method: d.method, params: d.params ?? {} }),
      });
      let body = {};
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      if (!res.ok || body.error) {
        reply({ ok: false, error: body.error ?? { code: "HTTP", message: `bridge answered ${res.status}` } });
      } else {
        reply({ ok: true, result: body.result });
      }
    } catch (e) {
      reply({ ok: false, error: { code: "BRIDGE_DOWN", message: String((e && e.message) || e) } });
    }
  });
})();
