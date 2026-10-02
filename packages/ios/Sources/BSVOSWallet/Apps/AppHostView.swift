#if canImport(WebKit)
import Foundation
import WebKit

/// Hosts one installed app in its own web view.
///
/// Differences from the desktop runner, and why they are improvements rather
/// than shortcuts:
///
/// - **No extension, no localhost relay.** The desktop needs a content script
///   and a loopback HTTP bridge because an unpacked MV3 extension cannot use
///   native messaging, and the token has to travel in a URL fragment. On iOS the
///   page talks straight to `webkit.messageHandlers.bsv`, so there is no relay
///   to attack and no token to leak.
/// - **Origin pinning is structural.** The desktop pins the app's domain from
///   the browser's `Origin` header. Here native created the web view for one
///   app and holds that identity itself, so the page cannot even attempt to
///   claim another one.
/// - **Per-app storage.** `WKWebsiteDataStore` per app where the desktop used a
///   per-app `--user-data-dir`.
@MainActor
public final class AppHostController: NSObject, ObservableObject {
    public let app: InstalledApp
    private let bridge: AppBridge
    private var webView: WKWebView?

    public init(app: InstalledApp, bridge: AppBridge) {
        self.app = app
        self.bridge = bridge
        super.init()
    }

    public func makeWebView() -> WKWebView {
        if let webView { return webView }

        let config = WKWebViewConfiguration()
        // One data store per app: no shared cookies, no shared storage.
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let handler = ScriptMessageRouter { [weak self] message in
            await self?.receive(message)
        }
        // Renamed in newer WebKit; `contentWorld: .page` puts the handler in the
        // page's own world, which is what lets the injected shim reach it.
        config.userContentController.add(handler, contentWorld: .page, name: "bsv")
        config.userContentController.addUserScript(
            WKUserScript(source: AppHostController.injectedScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = false
        webView = view

        if let url = URL(string: app.startUrl) {
            view.load(URLRequest(url: url))
        }
        return view
    }

    private func receive(_ message: WKScriptMessage) async {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let method = body["method"] as? String else {
            return
        }
        let params: [String: JSONValue]
        if let raw = body["params"] as? [String: Any] {
            params = raw.mapValues(JSONValue.from)
        } else {
            params = [:]
        }

        let reply = await bridge.handle(id: id, method: method, params: params)
        await deliver(reply)
    }

    private func deliver(_ reply: AppBridge.Reply) async {
        guard let webView else { return }
        // The page defines __bsvResolve at document start; if it is missing the
        // page tore the bridge out, and there is nobody to answer.
        let payload: String
        if reply.ok {
            payload = "__bsvResolve(\(reply.id), true, \(reply.result ?? "null"), null)"
        } else {
            let code = Self.jsonString(reply.errorCode ?? "BRIDGE")
            let message = Self.jsonString(reply.errorMessage ?? "bridge error")
            payload = "__bsvResolve(\(reply.id), false, null, { code: \(code), message: \(message) })"
        }
        _ = try? await webView.evaluateJavaScript(payload)
    }

    static func jsonString(_ value: String) -> String {
        let data = try? JSONEncoder().encode(value)
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    /// The `window.bsv` shim, injected before any page script runs.
    ///
    /// The method list, argument order and return shapes are identical to
    /// `packages/runner/extension/page.js` so an app written for the desktop
    /// runner runs here unmodified. An npm-side test parses both and fails if
    /// they diverge.
    ///
    /// What differs is only the transport: one hop to native, instead of
    /// page → content script → loopback HTTP.
    public static let injectedScript = """
    (() => {
      "use strict";
      const handlers = window.webkit && window.webkit.messageHandlers;
      const bridged = !!(handlers && handlers.bsv);
      const VERSION = "0.2.0";

      let seq = 0;
      const pending = new Map();

      // Native calls this to answer. Defined before anything can be sent.
      window.__bsvResolve = (id, ok, result, error) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (ok) {
          p.resolve(result);
        } else {
          const e = error || {};
          p.reject(new Error((e.code || "BRIDGE") + ": " + (e.message || "bridge error")));
        }
      };

      function invoke(method, params) {
        return new Promise((resolve, reject) => {
          if (!bridged) {
            reject(new Error("window.bsv needs the bsvOS app host — this page is not running in a wallet window"));
            return;
          }
          const id = ++seq;
          pending.set(id, { resolve, reject });
          try {
            handlers.bsv.postMessage({ id, method, params: params || {} });
          } catch (err) {
            pending.delete(id);
            reject(new Error("BRIDGE: " + err));
            return;
          }
          setTimeout(() => {
            if (pending.delete(id)) reject(new Error("BRIDGE_TIMEOUT: wallet bridge did not answer"));
          }, 120000);
        });
      }

      window.bsv = Object.freeze({
        version: VERSION,
        isBSVOS: bridged,
        getStatus: () => invoke("getStatus"),
        getIdentity: () => invoke("getIdentity"),
        getBalance: () => invoke("getBalance"),
        getUtxos: () => invoke("getUtxos"),
        timestamp: (sha256) => invoke("timestamp", { sha256 }),
        spend: (payments, memo, label) => invoke("spend", { payments, memo, label }),
        inscribe: (dataHex, contentType, to, fee, memo, label) => invoke("inscribe", { dataHex, contentType, to, fee, memo, label }),
        transferNft: (txid, vout, to, memo) => invoke("transferNft", { txid, vout, to, memo }),
        signSwapOffer: (txid, vout, priceSats, kind, tokenId, tokenAmount) =>
          invoke("signSwapOffer", { txid, vout, priceSats, kind, tokenId, tokenAmount }),
        completeSwap: (offer, fee, memo, buyerChecks) => invoke("completeSwap", { offer, fee, memo, buyerChecks }),
        ordlockLock: (txid, vout, priceSats) => invoke("ordlockLock", { txid, vout, priceSats }),
        ordlockBuy: (lockOutpoint, fee) => invoke("ordlockBuy", { lockOutpoint, fee }),
        ordlockCancel: (lockOutpoint) => invoke("ordlockCancel", { lockOutpoint }),
      });

      try {
        document.documentElement.setAttribute("data-bsvos", bridged ? VERSION : "absent");
      } catch (err) {
        /* document not ready; window.bsv still works */
      }
    })();
    """
}

/// Routes `postMessage` into an async handler. WebKit hands messages to a
/// delegate synchronously; the bridge needs to await the wallet, so the work
/// hops onto a task and the reply is delivered back through evaluateJavaScript.
private final class ScriptMessageRouter: NSObject, WKScriptMessageHandler {
    private let handler: @Sendable (WKScriptMessage) async -> Void

    init(handler: @escaping @Sendable (WKScriptMessage) async -> Void) {
        self.handler = handler
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        Task { await handler(message) }
    }
}
#endif
