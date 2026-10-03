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
        let envelopeCases: [EnvelopeCase]?

        struct EnvelopeCase: Decodable {
            let name: String
            let scriptHex: String
            let hasEnvelope: Bool
        }
    }

    private func loadVectors() throws -> Vectors {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/inscription-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testTheCarrierCheckMatchesTheDaemon() throws {
        let cases = try loadVectors().envelopeCases ?? []
        XCTAssertEqual(cases.count, 12)
        for testCase in cases {
            XCTAssertEqual(
                Inscription.hasOrdEnvelope(testCase.scriptHex),
                testCase.hasEnvelope,
                testCase.name
            )
        }
    }

    func testEnvelopeMatchesTheDaemonsBytes() throws {
        let vectors = try loadVectors()
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

    func testTheSizeLimitMatchesTheDaemonsGate() throws {
        let owner = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        XCTAssertEqual(Inscription.maxDataBytes, 256 * 1024)
        let atLimit = String(repeating: "ab", count: Inscription.maxDataBytes)
        XCTAssertNoThrow(try Inscription.script(ownerAddress: owner, contentType: "application/octet-stream", dataHex: atLimit))
        let overLimit = String(repeating: "ab", count: Inscription.maxDataBytes + 1)
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "application/octet-stream", dataHex: overLimit))
    }

    func testEnvelopeMetadataReadsWhatTheBuilderWrote() throws {
        let owner = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        // Direct push, and a data push large enough for OP_PUSHDATA1, so both
        // readers are exercised: the content type and the byte length.
        for dataHex in ["68656c6c6f", String(repeating: "ab", count: 100)] {
            let script = try Inscription.script(ownerAddress: owner, contentType: "text/plain", dataHex: dataHex)
            let meta = try XCTUnwrap(Inscription.envelopeMetadata(script))
            XCTAssertEqual(meta.contentType, "text/plain")
            XCTAssertEqual(meta.contentLength, dataHex.count / 2)
        }
        let plain = Hex.encode(try Address.lockingScript(for: owner))
        XCTAssertNil(Inscription.envelopeMetadata(plain))
        XCTAssertFalse(Inscription.hasOrdEnvelope(plain))
    }

    func testTheVectorsCarryTheirMetadata() throws {
        for vector in try loadVectors().vectors {
            let meta = try XCTUnwrap(Inscription.envelopeMetadata(vector.scriptHex), vector.name)
            XCTAssertEqual(meta.contentType, vector.contentType, vector.name)
            XCTAssertEqual(meta.contentLength, vector.dataHex.count / 2, vector.name)
        }
    }

    func testItRefusesWhatTheDaemonRefuses() throws {
        let owner = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "", dataHex: "00"))
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "text plain", dataHex: "00"))
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "text/plain", dataHex: ""))
        XCTAssertThrowsError(try Inscription.script(ownerAddress: owner, contentType: "text/plain", dataHex: "zz"))
    }
}
