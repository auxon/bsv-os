import XCTest
@testable import BSVOSWallet

/// Item 3, first pin: the inscription envelope must be byte-identical to the
/// daemon's `inscriptionScript` at every push boundary.
final class InscriptionTests: XCTestCase {
    struct Vectors: Decodable {
        struct Vector: Decodable {
            let name: String
            let owner: String
            let contentType: String
            let dataHex: String
            let scriptHex: String
        }
        let vectors: [Vector]
    }

    func testEnvelopeMatchesTheDaemonsBytes() throws {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/inscription-vectors.json")
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        XCTAssertEqual(vectors.vectors.count, 5)

        for vector in vectors.vectors {
            let script = try Inscription.script(
                ownerAddress: vector.owner,
                contentType: vector.contentType,
                dataHex: vector.dataHex
            )
            XCTAssertEqual(script, vector.scriptHex, vector.name)
        }
    }

    func testTheEnvelopeStartsAfterTheOwnersP2PKH() throws {
        let owner = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        let script = try Inscription.script(ownerAddress: owner, contentType: "text/plain", dataHex: "6869")
        let prefix = try Address.lockingScript(for: owner)
        let bytes = try Hex.decode(script)
        XCTAssertTrue(bytes.starts(with: prefix), "the owner's script comes first, as on chain")
        XCTAssertTrue(Hex.encode(Array(bytes.dropFirst(prefix.count))).hasPrefix("0063"), "OP_0 OP_IF follows")
    }

    func testItRefusesWhatTheDaemonRefuses() throws {
        let owner = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "", dataHex: "00"))
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "text plain", dataHex: "00"))
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "text/plain", dataHex: ""))
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "text/plain", dataHex: "zz"))
    }
}
