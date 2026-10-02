import XCTest
@testable import BSVOSWallet

/// Records what the bridge asked the wallet for.
private actor RecordingBackend: AppBridgeBackend {
    private(set) var calls: [(domain: String, intent: AppIntent, params: [String: JSONValue])] = []
    var failWith: WalletError?

    init(failWith: WalletError? = nil) {
        self.failWith = failWith
    }

    func invoke(app domain: String, intent: AppIntent, params: [String: JSONValue]) async throws -> String {
        calls.append((domain, intent, params))
        if let failWith { throw failWith }
        return #"{"address":"1Test","confirmed":25000}"#
    }
}

private let pocketPets = InstalledApp(
    domain: "pocketpets.entangleit.com",
    name: "Pocket Pets",
    startUrl: "https://pocketpets.entangleit.com/",
    spendCapSats: 100_000,
    intents: [DeclaredIntent(action: "app-spend", label: "PETS-SPEND", description: "fees")]
)

final class AppBridgeTests: XCTestCase {
    func testAnAllowedIntentReachesTheWalletWithTheAppsDomain() async {
        let backend = RecordingBackend()
        let bridge = AppBridge(app: pocketPets, backend: backend)

        let reply = await bridge.handle(id: 7, method: "getBalance", params: [:])

        XCTAssertTrue(reply.ok)
        XCTAssertEqual(reply.id, 7, "the reply carries the page's id")
        let calls = await backend.calls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.domain, "pocketpets.entangleit.com")
        XCTAssertEqual(calls.first?.intent, .getBalance)
        XCTAssertEqual(reply.result, #"{"address":"1Test","confirmed":25000}"#)
    }

    /// The allowlist is the boundary. A page asking for anything else is refused
    /// here, and would be refused again by the daemon with BAD_METHOD.
    func testAnIntentOutsideTheAllowlistIsRefusedWithoutCallingTheWallet() async {
        let backend = RecordingBackend()
        let bridge = AppBridge(app: pocketPets, backend: backend)

        for method in ["createWallet", "importWallet", "recoverySetup", "unlock", "send", "appInstall", "deleteEverything"] {
            let reply = await bridge.handle(id: 1, method: method, params: [:])
            XCTAssertFalse(reply.ok, "\(method) must be refused")
            XCTAssertEqual(reply.errorCode, "BAD_METHOD")
            XCTAssertTrue(reply.errorMessage?.contains(method) ?? false, "the message names the method")
        }
        let calls = await backend.calls
        XCTAssertTrue(calls.isEmpty, "nothing reached the wallet")
    }

    /// `unlock` and `send` are device-callable but NOT app-callable: an app
    /// should never be able to unlock the wallet or move sats directly. It asks
    /// to spend through its own origin policy instead.
    func testDevicePowersAreNotAppPowers() async {
        let backend = RecordingBackend()
        let bridge = AppBridge(app: pocketPets, backend: backend)
        for method in ["unlock", "lock", "send", "sweepOut", "policyApprove", "policyDeny"] {
            let reply = await bridge.handle(id: 2, method: method, params: [:])
            XCTAssertEqual(reply.errorCode, "BAD_METHOD", "\(method) is not an app intent")
        }
    }

    func testTheDaemonsRefusalKeepsItsCode() async {
        let backend = RecordingBackend(failWith: WalletError(code: "POLICY_DENY", message: "denied: first-run approval required"))
        let bridge = AppBridge(app: pocketPets, backend: backend)

        let reply = await bridge.handle(id: 3, method: "spend", params: ["payments": .array([])])

        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.errorCode, "POLICY_DENY")
        XCTAssertEqual(reply.errorMessage, "denied: first-run approval required")
        XCTAssertNil(reply.result)
    }

    func testSpendParamsSurviveTheCrossingIntact() async {
        let backend = RecordingBackend()
        let bridge = AppBridge(app: pocketPets, backend: backend)
        let params: [String: JSONValue] = [
            "payments": .array([
                .object(["to": .string("1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU"), "sats": .int(500)]),
            ]),
            "memo": .array([.string("PETS-SPEND")]),
            "label": .string("cup entry"),
            "flag": .bool(true),
            "nothing": .null,
        ]

        _ = await bridge.handle(id: 4, method: "spend", params: params)

        let calls = await backend.calls
        XCTAssertEqual(calls.first?.params["payments"], params["payments"], "the payment list is unchanged")
        XCTAssertEqual(calls.first?.params["label"], .string("cup entry"))
        XCTAssertEqual(calls.first?.params["flag"], .bool(true))
        XCTAssertEqual(calls.first?.params["nothing"], .null, "null survives rather than becoming a string")
    }

    func testTheIntentListMatchesTheDaemonsThirteen() {
        // Thirteen as of writing: four reads and nine writes. An npm-side test
        // compares this against appInvoke's cases in rpc.ts, so a change there
        // fails the suite rather than silently breaking an app.
        XCTAssertEqual(AppIntent.allCases.count, 13)
        let reads = AppIntent.allCases.filter(\.isRead).map(\.rawValue).sorted()
        XCTAssertEqual(reads, ["getBalance", "getIdentity", "getStatus", "getUtxos"])
    }
}

final class JSONValueTests: XCTestCase {
    /// The page hands over Foundation objects; the boundary converts once so
    /// nothing downstream is `Any`.
    func testFoundationValuesConvertFaithfully() {
        XCTAssertEqual(JSONValue.from(NSNull()), .null)
        XCTAssertEqual(JSONValue.from(NSNumber(value: true)), .bool(true))
        XCTAssertEqual(JSONValue.from("hello"), .string("hello"))

        // Integers must stay integral. A sats amount that crossed the bridge as
        // 500.0 could be truncated or rejected by the daemon, and NSNumber
        // bridges to Int before the Number case is reached — which is the
        // behaviour worth pinning rather than the one I first expected.
        XCTAssertEqual(JSONValue.from(NSNumber(value: 42)), .int(42))
        XCTAssertEqual(JSONValue.from(NSNumber(value: 500)), .int(500))
        XCTAssertEqual(JSONValue.from([1, 2]), .array([.int(1), .int(2)]))
        XCTAssertEqual(
            JSONValue.from(["a": 1, "b": ["c": true]]),
            .object(["a": .int(1), "b": .object(["c": .bool(true)])])
        )
        // A genuine fractional value still survives as one.
        XCTAssertEqual(JSONValue.from(NSNumber(value: 1.5)), .double(1.5))
    }

    /// `true` must not arrive as the number 1, which is a real hazard because
    /// NSNumber covers both.
    func testBooleansAreNotNumbers() {
        XCTAssertEqual(JSONValue.from(NSNumber(value: true)), .bool(true))
        XCTAssertEqual(JSONValue.from(NSNumber(value: false)), .bool(false))
        XCTAssertNotEqual(JSONValue.from(NSNumber(value: true)), .double(1))
    }

    func testRoundTripsThroughJSON() throws {
        let value = JSONValue.object([
            "sats": .int(500),
            "to": .string("1Addr"),
            "ok": .bool(true),
            "none": .null,
            "list": .array([.int(1), .string("two")]),
        ])
        let data = try JSONEncoder().encode(value)
        let back = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(back, value)
    }
}

final class InstalledAppTests: XCTestCase {
    /// Taken from a live `appList` response.
    func testDecodesTheDaemonsShape() throws {
        let json = """
        {"apps":[{
          "domain":"pocketpets.entangleit.com",
          "name":"Pocket Pets",
          "startUrl":"https://pocketpets.entangleit.com/",
          "icon":null,
          "spendCapSats":100000000,
          "installedAt":1790482244193,
          "manifestSha256":"70495e9f",
          "updatedAt":1790482244193,
          "intents":[{"action":"app-spend","label":"PETS-SPEND","description":"fees"}]
        }]}
        """
        let response = try JSONDecoder().decode(AppListResponse.self, from: Data(json.utf8))
        let app = try XCTUnwrap(response.apps.first)
        XCTAssertEqual(app.domain, "pocketpets.entangleit.com")
        XCTAssertEqual(app.spendCapSats, 100_000_000)
        XCTAssertEqual(app.intents.first?.action, "app-spend")
        XCTAssertNil(app.icon)
        XCTAssertTrue(app.isHostable)
    }

    /// A hosted app must serve https on its own domain. The daemon enforces
    /// this at install; the host refuses to open anything else rather than
    /// trusting the registry blindly.
    func testOnlyOwnDomainHttpsAppsAreHosted() {
        func app(_ url: String, domain: String = "example.com") -> InstalledApp {
            InstalledApp(domain: domain, name: "x", startUrl: url, spendCapSats: 0)
        }
        XCTAssertTrue(app("https://example.com/").isHostable)
        XCTAssertTrue(app("https://example.com/path/").isHostable)
        XCTAssertFalse(app("http://example.com/").isHostable, "plain http is refused")
        XCTAssertFalse(app("https://evil.example.com/").isHostable, "another host is refused")
        XCTAssertFalse(app("https://example.com.evil.test/").isHostable, "a suffix trick is refused")
        XCTAssertFalse(app("javascript:alert(1)").isHostable)
    }
}
