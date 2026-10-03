#if canImport(WebKit)
import Foundation
import WebKit

/// Hosts a **bundled** app (Twetch, Cast, Explorer, Colosseum, MemeStudio,
/// AskAnything, the shell) on the phone.
///
/// These differ from the apps `AppHostController` hosts: they are served by the
/// daemon and call the daemon's JSON-RPC **same-origin** via `fetch("/")`,
/// rather than going through `window.bsv`. On the desktop that works because the
/// page is loaded from loopback. On a phone it cannot: the RPC is loopback-only,
/// and it should stay that way.
///
/// So the host does two things:
///
///   1. loads the assets from the daemon (they are public source — the same
///      reasoning as `/health`), and
///   2. injects a shim that **rewrites `fetch("/")` into a native bridge call**,
///      which forwards to the authenticated `/v1/device/<method>` surface.
///
/// The token therefore never enters the page, and the method allowlist is
/// enforced natively rather than by the page's cooperation. The alternative —
/// giving the page the token and letting it call the device surface directly —
/// would put a wallet credential in a web view, which is precisely what the
/// desktop design avoids and this one should not undo.
@MainActor
public final class BundledAppHost: NSObject, ObservableObject {
    public let app: String          // the bundle name, e.g. "twetch"
    public let title: String
    private let baseURL: URL
    private let credential: DeviceCredential
    /// When set, the assets come from the bundle instead of the daemon — the
    /// standalone path. The location is served through `loadFileURL`, and the
    /// injected shim still rewrites `fetch("/")` onto the native bridge.
    private let assetRoot: URL?
    /// The wallet behind the page: the daemon's device surface, or an
    /// in-process `LocalRpcBridge`.
    private let rpc: (any RpcCalling)?
    private var webView: WKWebView?

    public init(
        app: String,
        title: String,
        baseURL: URL,
        credential: DeviceCredential,
        rpc: (any RpcCalling)? = nil,
        assetRoot: URL? = nil
    ) {
        self.app = app
        self.title = title
        self.baseURL = baseURL
        self.credential = credential
        self.rpc = rpc
        self.assetRoot = assetRoot
        super.init()
    }

    /// The URL the web view loads: `https://host:port/<app>/`.
    public var startURL: URL? {
        URL(string: "/\(app)/", relativeTo: baseURL)?.absoluteURL
    }

    public func makeWebView() -> WKWebView {
        if let webView { return webView }

        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()

        let router = ScriptMessageRouter { [weak self] message in
            await self?.receive(message)
        }
        config.userContentController.add(router, contentWorld: .page, name: "bsv")

        let bridge: any RpcCalling = rpc ?? RpcBridge(baseURL: baseURL, credential: credential)
        self.bridge = bridge
        config.userContentController.addUserScript(
            WKUserScript(source: BundledAppHost.shim(for: app), injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let view = WKWebView(frame: .zero, configuration: config)
        webView = view
        if let assetRoot {
            let appRoot = assetRoot.appendingPathComponent(app, isDirectory: true)
            view.loadFileURL(appRoot.appendingPathComponent("index.html"), allowingReadAccessTo: appRoot)
        } else if let startURL {
            view.load(URLRequest(url: startURL))
        }
        return view
    }

    private var bridge: (any RpcCalling)?

    private func receive(_ message: WKScriptMessage) async {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let method = body["method"] as? String,
              let bridge else { return }
        let params: [String: JSONValue] = (body["params"] as? [String: Any])?.mapValues(JSONValue.from) ?? [:]
        let reply = await bridge.call(id: id, method: method, params: params)
        await deliver(reply)
    }

    private func deliver(_ reply: RpcReply) async {
        guard let webView else { return }
        let payload: String
        if reply.ok {
            payload = "__bsvRpcResolve(\(reply.id), true, \(reply.result ?? "null"), null)"
        } else {
            let code = AppHostController.jsonString(reply.errorCode ?? "BRIDGE")
            let message = AppHostController.jsonString(reply.errorMessage ?? "bridge error")
            payload = "__bsvRpcResolve(\(reply.id), false, null, { code: \(code), message: \(message) })"
        }
        _ = try? await webView.evaluateJavaScript(payload)
    }

    /// What the page sees.
    ///
    /// Two pieces: `window.bsv` (unchanged from the app host, so an app that
    /// uses it keeps working) and a `fetch` patch for the same-origin RPC the
    /// bundled apps actually call.
    ///
    /// The patch is written to be faithful to what those apps expect: a POST to
    /// `/` with `{method, params, id}` and a JSON reply of `{result}` or
    /// `{error: {code, message}}`. It answers only that shape and only for the
    /// daemon's own origin, so nothing else in the page changes behaviour.
    /// Nonisolated: it builds a string, and a test asserting its contents
    /// should not have to hop to the main actor to do it.
    public nonisolated static func shim(for app: String) -> String {
        return appHostShim + """

        (() => {
          "use strict";
          const handlers = window.webkit && window.webkit.messageHandlers;
          if (!handlers || !handlers.bsv) return;

          const pending = new Map();
          let seq = 1000000;

          window.__bsvRpcResolve = (id, ok, result, error) => {
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            if (ok) p.resolve(result);
            else p.reject(error || { code: "BRIDGE", message: "bridge error" });
          };

          const originalFetch = window.fetch ? window.fetch.bind(window) : null;

          // Only the daemon's own origin, only POST, only the RPC path. Anything
          // else falls through to the real fetch untouched.
          window.fetch = function (input, init) {
            try {
              const url = typeof input === "string" ? input : (input && input.url) || "";
              const sameOrigin = url === "/" || url === "" || url.startsWith(location.origin + "/") && new URL(url).pathname === "/";
              const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
              if (!sameOrigin || method !== "POST" || !(init && init.body)) {
                return originalFetch ? originalFetch(input, init) : Promise.reject(new Error("no fetch"));
              }
              const body = JSON.parse(init.body);
              if (!body || typeof body.method !== "string") {
                return originalFetch ? originalFetch(input, init) : Promise.reject(new Error("no fetch"));
              }
              const id = ++seq;
              const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
              handlers.bsv.postMessage({ id, method: body.method, params: body.params || {} });
              return promise.then(
                (result) => new Response(JSON.stringify({ result: result === undefined ? null : result, id: body.id }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
                (error) => new Response(JSON.stringify({ error: { code: error.code || "BRIDGE", message: error.message || "bridge error" }, id: body.id }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              );
            } catch (err) {
              return originalFetch ? originalFetch(input, init) : Promise.reject(err);
            }
          };

          // Same marker the desktop apps check for.
          try {
            document.documentElement.setAttribute("data-bsvos-rpc", "bridged");
          } catch (err) { /* document not ready */ }
        })();
        """
    }

    /// The `window.bsv` half, shared verbatim with the app host.
    private nonisolated static var appHostShim: String { AppHostController.injectedScript }
}

/// Forwards RPC calls to the daemon's authenticated device surface.
///
/// The allowlist check happens here, natively, before anything is sent: a
/// bundled app asking for a method outside the operator tier gets a clear
/// refusal instead of reaching the wallet. This is the same list the daemon
/// enforces; checking locally means a mistyped call fails on the phone rather
/// than as a round trip.
public struct RpcBridge: Sendable, RpcCalling {
    private let client: DeviceWalletClient

    public init(baseURL: URL, credential: DeviceCredential, http: DeviceHTTPClient = URLSessionDeviceClient()) {
        self.client = DeviceWalletClient(baseURL: baseURL, credential: credential, client: http)
    }

    public func call(id: Int, method: String, params: [String: JSONValue]) async -> RpcReply {
        guard DeviceAllowlist.isCallable(method) else {
            return RpcReply(id: id, ok: false, result: nil, errorCode: "NOT_ALLOWED",
                            errorMessage: "\(method) is not available to this device")
        }
        do {
            let result: RawJSON = try await client.call(method, params: params)
            return RpcReply(id: id, ok: true, result: result.json, errorCode: nil, errorMessage: nil)
        } catch let error as WalletError {
            return RpcReply(id: id, ok: false, result: nil, errorCode: error.code, errorMessage: error.message)
        } catch {
            return RpcReply(id: id, ok: false, result: nil, errorCode: "BRIDGE",
                            errorMessage: String(describing: error))
        }
    }
}

public struct RpcReply: Sendable, Equatable {
    public let id: Int
    public let ok: Bool
    public let result: String?
    public let errorCode: String?
    public let errorMessage: String?
}
#endif
