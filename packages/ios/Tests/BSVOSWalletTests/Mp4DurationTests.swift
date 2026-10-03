import XCTest
@testable import BSVOSWallet

/// The server's MP4 duration repair must produce the same bytes as the page's
/// `cast/mp4.js` — the page patches first, the server again on upload, and the
/// two must agree byte for byte or a file could be patched twice into a
/// different shape.
final class Mp4DurationTests: XCTestCase {
    private struct Vector: Decodable {
        let name: String
        let inputHex: String
        let durationMs: Int
        let expectedHex: String
    }

    private func load() throws -> [Vector] {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/mp4-duration-vectors.json")
        return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    }

    func testFixMatchesThePagesPatcherByteForByte() throws {
        let vectors = try load()
        XCTAssertEqual(vectors.count, 5)
        XCTAssertTrue(vectors.contains { $0.inputHex != $0.expectedHex }, "one patched case at least")
        XCTAssertTrue(vectors.contains { $0.inputHex == $0.expectedHex }, "one untouched case at least")
        for vector in vectors {
            let input = Data(try Hex.decode(vector.inputHex))
            let output = Mp4Duration.fix(input, durationMs: vector.durationMs)
            XCTAssertEqual(Hex.encode(Array(output)), vector.expectedHex, vector.name)
        }
    }

    func testItOnlyClaimsMp4Files() throws {
        let vectors = try load()
        for vector in vectors {
            let bytes = Data(try Hex.decode(vector.inputHex))
            XCTAssertTrue(Mp4Duration.looksLikeMp4(bytes), vector.name)
        }
        XCTAssertFalse(Mp4Duration.looksLikeMp4(Data([1, 2, 3])))
        XCTAssertFalse(Mp4Duration.looksLikeMp4(Data()))
    }
}
