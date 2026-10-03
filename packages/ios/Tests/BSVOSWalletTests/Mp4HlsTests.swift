import XCTest
@testable import BSVOSWallet

/// HLS packaging: WebKit cannot progressively play the fMP4 MediaRecorder
/// writes, so recordings are split at fragment boundaries into init + segments
/// and served as a VOD playlist. The real Safari capture fixture pins it on the
/// exact container the platform produces.
final class Mp4HlsTests: XCTestCase {
    private struct Fixture: Decodable {
        let note: String
        let inputHex: String
        let bytes: Int
    }

    private func loadFixture() throws -> Fixture {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/fmp4-safari-real.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testTheRealSafariCapturePackagesIntoSegmentsThatRebuildIt() throws {
        let fixture = try loadFixture()
        let input = Data(try Hex.decode(fixture.inputHex))
        XCTAssertEqual(input.count, fixture.bytes)

        let package = try XCTUnwrap(Mp4Hls.package(input), "the real capture must package")
        // The init segment is ftyp+moov; every byte of the original survives.
        let initBytes = [UInt8](package.initSegment)
        XCTAssertEqual(String(bytes: initBytes[4..<8], encoding: .ascii), "ftyp")
        XCTAssertTrue(Mp4Hls.boxes(initBytes, in: 0..<initBytes.count).contains { $0.type == "moov" })
        let rebuilt = package.segments.reduce(into: package.initSegment) { $0.append($1) }
        XCTAssertEqual(rebuilt, input, "init + segments must rebuild the file exactly")

        // Two fragments, real (non-zero) durations, no invented lengths.
        XCTAssertEqual(package.segments.count, 2)
        XCTAssertEqual(package.durationsMs.count, 2)
        XCTAssertTrue(package.durationsMs.allSatisfy { $0 > 500 }, "\(package.durationsMs)")
        XCTAssertGreaterThan(package.totalMs, 2_000)
        XCTAssertLessThan(package.totalMs, 3_500)
    }

    func testThePlaylistIsAVodHlsList() throws {
        let package = try XCTUnwrap(Mp4Hls.package(Data(try Hex.decode(try loadFixture().inputHex))))
        let lines = package.playlist.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.first, "#EXTM3U")
        XCTAssertTrue(lines.contains("#EXT-X-MAP:URI=\"init.mp4\""))
        XCTAssertTrue(lines.contains("seg-0.m4s"))
        XCTAssertTrue(lines.contains("seg-1.m4s"))
        XCTAssertTrue(lines.contains("#EXT-X-ENDLIST"))
        XCTAssertTrue(lines.contains { $0.hasPrefix("#EXT-X-TARGETDURATION:") })
        XCTAssertEqual(lines.filter { $0.hasPrefix("#EXTINF:") }.count, 2)
    }

    func testNonFragmentedInputIsNotPackaged() throws {
        func box(_ type: String, _ payload: [UInt8] = []) -> [UInt8] {
            var out: [UInt8] = []
            let size = UInt32(8 + payload.count)
            out += [UInt8((size >> 24) & 0xff), UInt8((size >> 16) & 0xff), UInt8((size >> 8) & 0xff), UInt8(size & 0xff)]
            out += Array(type.utf8)
            out += payload
            return out
        }
        let notFragmented = Data(box("ftyp") + box("moov"))
        XCTAssertNil(Mp4Hls.package(notFragmented), "no moof, nothing to stream")
        XCTAssertNil(Mp4Hls.package(Data()))
    }
}
