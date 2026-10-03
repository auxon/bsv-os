import XCTest
@testable import BSVOSWallet

/// P3 debt: the manifest hash must be the daemon's canonical one, not a raw-body
/// hash, so the phone and the daemon agree on what "the same manifest" means.
///
/// Vectors come from `generate-manifest-hash.mjs`, which runs the daemon's own
/// `stableStringify` and `manifestSha256`.
final class ManifestHashTests: XCTestCase {
    private struct Vector: Decodable {
        let name: String
        let manifestJson: String
        let stable: String
        let sha256: String
    }

    private func load() throws -> [Vector] {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/manifest-hash-vectors.json")
        return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    }

    func testCanonicalFormAndHashMatchTheDaemon() throws {
        let vectors = try load()
        XCTAssertEqual(vectors.count, 5)
        for vector in vectors {
            let manifest = try JSONSerialization.jsonObject(with: Data(vector.manifestJson.utf8))
            XCTAssertEqual(AppManifestValidator.stableStringify(manifest), vector.stable, vector.name)
            XCTAssertEqual(AppManifestValidator.manifestSha256(manifest), vector.sha256, vector.name)
        }
    }

    func testFormattingAndKeyOrderDoNotChangeTheHash() throws {
        let compact = try JSONSerialization.jsonObject(with: Data(#"{"b":1,"a":"x"}"#.utf8))
        let spacious = try JSONSerialization.jsonObject(with: Data("{\n  \"a\": \"x\",\n  \"b\": 1\n}".utf8))
        XCTAssertEqual(
            AppManifestValidator.manifestSha256(compact),
            AppManifestValidator.manifestSha256(spacious)
        )
    }

    /// The install path stores the canonical hash: two installs of the same
    /// manifest written differently must record the same value.
    func testInstallsOfTheSameManifestAgree() async throws {
        let store = InMemoryAppRegistryStore()
        let registry = LocalAppRegistry(
            store: store,
            transport: URLSessionTransport(),
            policy: PolicyEngine(store: InMemoryPolicyStore())
        )
        let body = #"{"name":"Meme Studio","startUrl":"https://memestudio.example/","metanet":{"intents":[{"action":"spend"}]}}"#
        let reformatted = """
        {
          "metanet": { "intents": [ { "action": "spend" } ] },
          "startUrl": "https://memestudio.example/",
          "name": "Meme Studio"
        }
        """
        let first = try await registry.install(domain: "memestudio.example", manifestJson: body)
        let second = try await registry.install(domain: "memestudio.example", manifestJson: reformatted)
        XCTAssertEqual(first.manifestSha256, second.manifestSha256)
    }
}
