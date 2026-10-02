import XCTest
@testable import BSVOSWallet

/// Serves canned HTTP so the bridge can be tested without a daemon.
private struct StubHTTP: DeviceHTTPClient {
    let status: Int
    let body: String
    let record: (@Sendable (URLRequest) -> Void)?

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        record?(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), response)
    }
}

final class RpcBridgeTests: XCTestCase {
    private let base = URL(string: "https://10.0.0.5:2121")!
    private let credential = DeviceCredential(deviceID: "dev_1", token: "t")

    private func bridge(status: Int = 200, body: String = #"{"result":{"ok":true}}"#, record: (@Sendable (URLRequest) -> Void)? = nil) -> RpcBridge {
        RpcBridge(baseURL: base, credential: credential, http: StubHTTP(status: status, body: body, record: record))
    }

    func testAnAllowlistedCallReachesTheDeviceSurface() async {
        let box = SendableBox()
        let reply = await bridge(record: { box.record($0) }).call(id: 7, method: "twetchFeed", params: ["limit": .int(10)])

        XCTAssertTrue(reply.ok)
        XCTAssertEqual(reply.id, 7)
        XCTAssertEqual(reply.result, #"{"ok":true}"#)
        let request = box.last
        XCTAssertEqual(request?.url?.path, "/v1/device/twetchFeed")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer t")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "X-Bsv-Device"), "1")
        XCTAssertNil(request?.value(forHTTPHeaderField: "Origin"), "never a browser-shaped request")
    }

    /// The allowlist is enforced natively, before anything is sent. A bundled app
    /// asking for key material gets a refusal on the phone, not a round trip.
    func testKeyMaterialIsRefusedWithoutCallingTheDaemon() async {
        let box = SendableBox()
        let sut = bridge(record: { box.record($0) })

        for method in ["createWallet", "importWallet", "recoverySetup", "twetchAccountImportFromSeed", "exportEntropy"] {
            let reply = await sut.call(id: 1, method: method, params: [:])
            XCTAssertFalse(reply.ok, "\(method) must be refused")
            XCTAssertEqual(reply.errorCode, "NOT_ALLOWED")
            XCTAssertTrue(reply.errorMessage?.contains(method) ?? false)
        }
        XCTAssertNil(box.last, "nothing reached the daemon")
    }

    func testAnUnknownMethodIsRefusedLocallyToo() async {
        let reply = await bridge().call(id: 2, method: "definitelyNotAMethod", params: [:])
        XCTAssertEqual(reply.errorCode, "NOT_ALLOWED")
    }

    /// A daemon refusal keeps its code, so a page can tell "blocked by policy"
    /// from "the wallet is locked" — the same distinction the app screens make.
    func testTheDaemonsRefusalSurvives() async {
        let reply = await bridge(status: 200, body: #"{"error":{"code":"POLICY_DENY","message":"denied: first-run approval required"}}"#)
            .call(id: 3, method: "twetchPost", params: [:])
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.errorCode, "POLICY_DENY")
        XCTAssertEqual(reply.errorMessage, "denied: first-run approval required")
    }

    func testTheOperatorTierCoversWhatTheAppsCall() {
        // The bundled apps' RPC calls, from a survey of their sources.
        let called = [
            "balance", "history", "ordList", "isAuthenticated",
            "twetchStatus", "twetchFeed", "twetchNotifications", "twetchUser", "twetchList",
            "twetchMarket", "twetchMemes", "twetchMemeFolders", "twetchPost", "twetchIndex", "twetchBuy",
            "castAdd", "castEpisodes", "castLiveGet", "castLiveStart", "castLiveStop",
            "castPlay", "castSetMedia", "castStop", "streamPause", "streamResume", "streamTicks",
            "agentMint", "agentRevoke", "anchorFile", "appInstall", "appLaunch", "appRemove", "appUpdate",
            "certRevoke", "certShow", "contactAdd", "faucetClaim", "gigClaim", "gigTrack", "gigUntrack",
            "identityConfigure", "identityLoginStart", "identityLoginStatus", "identityLogout",
            "lock", "unlock", "msgAck", "msgSend", "msgShow", "ordInscribe", "overlayLookup", "pay",
            "policyApprove", "policyDeny", "profileSet", "receiptIssue", "receiptShow", "requestCode",
            "requestCreate", "requestDecline", "requestImport", "requestPay", "send", "sweepOut",
            "torrentFetch", "torrentRemove", "twetchAccountImportFromSeed",
        ]
        let missing = called.filter { !DeviceAllowlist.isCallable($0) && $0 != "twetchAccountImportFromSeed" }
        XCTAssertEqual(missing, [], "every bundled-app call must be device-callable: \(missing)")

        // And the one that must not be.
        XCTAssertFalse(DeviceAllowlist.isCallable("twetchAccountImportFromSeed"))
    }
}

/// The fetch shim is JavaScript, so this asserts its contract rather than
/// executing it: it must answer only the RPC shape, only same-origin, and only
/// through the native bridge.
final class BundledAppShimTests: XCTestCase {
    private var shim: String { BundledAppHost.shim(for: "twetch") }

    func testTheShimRoutesTheRpcThroughTheNativeBridge() {
        XCTAssertTrue(shim.contains("messageHandlers"), "it posts to native")
        XCTAssertTrue(shim.contains("__bsvRpcResolve"), "and native answers through it")
        XCTAssertTrue(shim.contains("window.fetch ="), "it patches fetch")
        XCTAssertTrue(shim.contains("handlers.bsv.postMessage"), "an RPC call becomes a bridge message")
    }

    /// The credential must never reach the page. This is the property that makes
    /// the rewrite worth doing at all.
    ///
    /// Note the shape of this test: asserting "the word token does not appear"
    /// fails on `tokenId`, which is a BSV21 identifier in the `window.bsv` API
    /// and nothing to do with credentials. So the assertion names the actual
    /// credential forms, and then checks that every remaining `token…` mention
    /// is one of the two API parameters.
    func testTheShimCarriesNoCredential() {
        for forbidden in ["Bearer", "Authorization", "bsv-token", "/v1/device/", "127.0.0.1", "bsv-port"] {
            XCTAssertFalse(shim.contains(forbidden), "the shim must not contain \(forbidden)")
        }
        let tokenWords = Set(shim.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init))
            .filter { $0.hasPrefix("token") }
        XCTAssertEqual(tokenWords, ["tokenid", "tokenamount"], "only the API's own tokenId/tokenAmount remain")
    }

    /// It must answer the JSON envelope the bundled apps parse, and leave every
    /// other request alone — a blanket fetch patch would break the apps' own
    /// network calls (Twetch's media, the market's images).
    func testTheShimOnlyInterceptsTheRpcShape() {
        XCTAssertTrue(shim.contains(#"url === "/""#), "same-origin RPC only")
        XCTAssertTrue(shim.contains(#"method !== "POST""#), "POST only")
        XCTAssertTrue(shim.contains("originalFetch"), "everything else falls through")
        XCTAssertTrue(shim.contains(#"JSON.stringify({ result:"#), "answers with the result envelope")
        XCTAssertTrue(shim.contains(#"JSON.stringify({ error:"#), "and the error envelope")
    }

    /// It also carries `window.bsv`, so a bundled app that uses the bridge keeps
    /// working alongside one that uses same-origin RPC.
    func testTheShimStillProvidesWindowBsv() {
        XCTAssertTrue(shim.contains("window.bsv = Object.freeze"), "window.bsv is present")
        XCTAssertTrue(shim.contains("isBSVOS"), "with the marker apps check")
    }
}

/// Collects requests across concurrency domains without a data race.
private final class SendableBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [URLRequest] = []
    func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        items.append(request)
    }
    var last: URLRequest? {
        lock.lock(); defer { lock.unlock() }
        return items.last
    }
}
