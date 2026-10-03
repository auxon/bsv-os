import XCTest
@testable import BSVOSWallet

/// Split parsing, tick intervals, the HLS playlist and the allowlists must
/// match the daemon's `cast.ts`/`streams.ts` — including every error message,
/// because the Cast app shows them verbatim.
final class CastRulesVectorTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Failure: Decodable {
            let code: String
            let message: String
        }
        struct SplitCase: Decodable {
            let input: String
            let splits: [CastSplit]?
            let error: Failure?
        }
        struct TickCase: Decodable {
            let input: String
            let ms: Int?
            let error: Failure?
        }
        struct Playlist: Decodable {
            let segments: Int
            let ended: Bool
            let body: String
        }
        struct Validators: Decodable {
            struct LiveId: Decodable {
                let id: String
                let valid: Bool
            }
            struct LiveFile: Decodable {
                let name: String
                let valid: Bool
            }
            struct MediaFile: Decodable {
                let name: String
                let valid: Bool
            }
            struct MediaExt: Decodable {
                let mime: String
                let ext: String?
            }
            let liveIds: [LiveId]
            let liveFiles: [LiveFile]
            let mediaFiles: [MediaFile]
            let mediaExts: [MediaExt]
        }
        let splits: [SplitCase]
        let ticks: [TickCase]
        let playlists: [Playlist]
        let validators: Validators
    }

    private func load() throws -> Vectors {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/cast-rule-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func validAddress(_ address: String) -> Bool {
        (try? Address.scriptHash(from: address)) != nil
    }

    func testSplitsMatchTheDaemonIncludingMessages() throws {
        let vectors = try load()
        for testCase in vectors.splits {
            if let expected = testCase.splits {
                XCTAssertEqual(
                    try CastRules.parseSplits(testCase.input, validAddress: validAddress),
                    expected, testCase.input
                )
            } else if let failure = testCase.error {
                do {
                    _ = try CastRules.parseSplits(testCase.input, validAddress: validAddress)
                    XCTFail("expected failure for \(testCase.input)")
                } catch let error as CastRuleError {
                    XCTAssertEqual(error.code, failure.code, testCase.input)
                    XCTAssertEqual(error.message, failure.message, testCase.input)
                }
            }
        }
    }

    func testTickIntervalsMatchTheDaemonIncludingMessages() throws {
        for testCase in try load().ticks {
            if let ms = testCase.ms {
                XCTAssertEqual(try CastRules.parseTick(testCase.input), ms, testCase.input)
            } else if let failure = testCase.error {
                do {
                    _ = try CastRules.parseTick(testCase.input)
                    XCTFail("expected failure for \(testCase.input)")
                } catch let error as CastRuleError {
                    XCTAssertEqual(error.message, failure.message, testCase.input)
                }
            }
        }
    }

    func testPlaylistMatchesTheDaemon() throws {
        for testCase in try load().playlists {
            XCTAssertEqual(
                CastRules.livePlaylist(segments: testCase.segments, ended: testCase.ended),
                testCase.body,
                "segments \(testCase.segments), ended \(testCase.ended)"
            )
        }
    }

    func testAllowlistsMatchTheDaemon() throws {
        let validators = try load().validators
        for entry in validators.liveIds {
            XCTAssertEqual(CastRules.liveIdValid(entry.id), entry.valid, entry.id)
        }
        for entry in validators.liveFiles {
            XCTAssertEqual(CastRules.liveFileValid(entry.name), entry.valid, entry.name)
        }
        for entry in validators.mediaFiles {
            XCTAssertEqual(CastRules.mediaFileValid(entry.name), entry.valid, entry.name)
        }
        for entry in validators.mediaExts {
            XCTAssertEqual(CastRules.mediaExt(entry.mime), entry.ext, entry.mime)
        }
    }
}
