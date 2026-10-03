import XCTest
@testable import BSVOSWallet

/// Item 1: the phone's own app registry, validating manifests by the daemon's
/// rules and seeding the declared intents the same way `apps.ts` does.
final class AppRegistryTests: XCTestCase {
    final class RegistryTransport: ChainTransport, @unchecked Sendable {
        var responses: [String: (Data, Int)] = [:]
        private(set) var requested: [String] = []

        func get(_ url: URL) async throws -> (Data, Int) {
            requested.append(url.absoluteString)
            guard let response = responses[url.absoluteString] else { throw URLError(.badURL) }
            return response
        }

        func post(_ url: URL, jsonBody: Data) async throws -> (Data, Int) {
            throw URLError(.badURL)
        }
    }

    private func makeRegistry(
        store: any AppRegistryStore = InMemoryAppRegistryStore(),
        transport: RegistryTransport = RegistryTransport()
    ) -> (LocalAppRegistry, PolicyEngine, RegistryTransport) {
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        return (LocalAppRegistry(store: store, transport: transport, policy: engine), engine, transport)
    }

    private let manifest = """
    {
      "name": "Example App",
      "start_url": "/",
      "icons": [{"src": "/icon.png"}, {"src": "/other.png"}],
      "metanet": {
        "intents": [
          {"action": "PULL", "label": "Pull a pet", "typical_sats": 250},
          {"action": "FEED", "description": "Feed one pet"}
        ],
        "groupPermissions": {"spendingAuthorization": {"amount": 5000}}
      }
    }
    """

    func testInstallValidatesAndPinsAManifest() async throws {
        let (registry, policy, _) = makeRegistry()
        let app = try await registry.install(domain: "App.Example", manifestJson: manifest)

        XCTAssertEqual(app.domain, "app.example")
        XCTAssertEqual(app.name, "Example App")
        XCTAssertEqual(app.startUrl, "https://app.example/")
        XCTAssertEqual(app.icon, "https://app.example/icon.png")
        XCTAssertEqual(app.spendCapSats, 5000)
        XCTAssertEqual(app.intents.map(\.action), ["PULL", "FEED"])
        XCTAssertEqual(app.intents.first?.typicalSats, 250)
        XCTAssertEqual(app.manifestSha256?.count, 64)

        // Installing is the approval ceremony for the vocabulary: each
        // declared intent is queued for the human.
        let pending = try await policy.pendingRequests()
        XCTAssertEqual(pending.map(\.origin), ["app.example", "app.example"])
        XCTAssertEqual(Set(pending.map(\.action)), ["PULL", "FEED"])
        XCTAssertEqual(pending.first { $0.action == "PULL" }?.amountSats, 250)
        XCTAssertEqual(pending.first { $0.action == "FEED" }?.amountSats, 0)
    }

    func testInstallFetchesTheManifestWhenNotProvided() async throws {
        let transport = RegistryTransport()
        transport.responses["https://app.example/manifest.json"] = (Data(manifest.utf8), 200)
        let (registry, _, _) = makeRegistry(transport: transport)

        let app = try await registry.install(domain: "app.example", manifestJson: nil)
        XCTAssertEqual(app.name, "Example App")
        XCTAssertEqual(transport.requested, ["https://app.example/manifest.json"])
    }

    func testInstallRejectsAnEscapingStartUrl() async throws {
        let (registry, _, _) = makeRegistry()
        let bad = #"{"name":"Evil","start_url":"https://evil.example/"}"#
        do {
            _ = try await registry.install(domain: "app.example", manifestJson: bad)
            XCTFail("a manifest must not escape its origin")
        } catch let AppRegistryError.badManifest(message) {
            XCTAssertTrue(message.contains("escapes"))
        }
    }

    func testInstallRejectsBadIntents() async throws {
        let (registry, _, _) = makeRegistry()
        let longAction = String(repeating: "A", count: 65)
        let bad = #"{"name":"App","start_url":"/","metanet":{"intents":[{"action":"\#(longAction)"}]}}"#
        do {
            _ = try await registry.install(domain: "app.example", manifestJson: bad)
            XCTFail("an over-long action must be rejected")
        } catch let AppRegistryError.badManifest(message) {
            XCTAssertTrue(message.contains("action"))
        }
    }

    func testInstallRejectsBadDomains() async throws {
        let (registry, _, _) = makeRegistry()
        for domain in ["bad_domain", "has space", "-leading", ""] {
            do {
                _ = try await registry.install(domain: domain, manifestJson: manifest)
                XCTFail("\(domain) should be rejected")
            } catch AppRegistryError.badDomain {
                // expected
            }
        }
    }

    func testANonOKFetchIsAnError() async throws {
        let transport = RegistryTransport()
        transport.responses["https://app.example/manifest.json"] = (Data(), 404)
        let (registry, _, _) = makeRegistry(transport: transport)
        do {
            _ = try await registry.install(domain: "app.example", manifestJson: nil)
            XCTFail("404 is not a manifest")
        } catch let AppRegistryError.fetchFailed(code) {
            XCTAssertEqual(code, 404)
        }
    }

    func testListRemoveAndReinstallKeepsTheCap() async throws {
        let (registry, _, _) = makeRegistry()
        _ = try await registry.install(domain: "app.example", manifestJson: manifest)
        _ = try await registry.install(domain: "other.example", manifestJson: manifest)
        var apps = try await registry.list()
        XCTAssertEqual(apps.map(\.domain), ["app.example", "other.example"])

        // Reinstalling re-pins the manifest but does not silently drop an
        // approval the human already made by hand.
        let capped = manifest.replacingOccurrences(of: #""amount": 5000"#, with: #""amount": 9000"#)
        let repinned = try await registry.install(domain: "app.example", manifestJson: capped)
        XCTAssertEqual(repinned.spendCapSats, 5000, "an existing cap is not overwritten")
        apps = try await registry.list()
        XCTAssertEqual(apps.count, 2)

        try await registry.remove(domain: "app.example")
        apps = try await registry.list()
        XCTAssertEqual(apps.map(\.domain), ["other.example"])
    }

    func testFileStoreRoundTrips() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("bsvos-apps-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("apps.json")

        do {
            let (registry, _, _) = makeRegistry(store: try FileAppRegistryStore(url: url))
            _ = try await registry.install(domain: "app.example", manifestJson: manifest)
        }

        let reopened = try FileAppRegistryStore(url: url)
        let apps = try await reopened.all()
        XCTAssertEqual(apps.map(\.domain), ["app.example"])
        XCTAssertEqual(apps.first?.intents.map(\.action), ["PULL", "FEED"])
    }
}
