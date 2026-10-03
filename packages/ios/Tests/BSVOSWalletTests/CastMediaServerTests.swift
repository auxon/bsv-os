import XCTest
@testable import BSVOSWallet

/// The cast half of the loopback server: the Cast app's plain-HTTP media
/// protocol — recording upload with ranged playback, and live ingest with the
/// rolling playlist — must behave like the daemon's own routes.
final class CastMediaServerTests: XCTestCase {
    private var assetsRoot: URL!
    private var mediaRoot: URL!
    private var server: BundleAssetServer!
    private var cast: InMemoryCastStore!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("bsvos-cast-\(UUID().uuidString)")
        assetsRoot = base.appendingPathComponent("assets")
        mediaRoot = base.appendingPathComponent("media")
        try FileManager.default.createDirectory(at: assetsRoot, withIntermediateDirectories: true)
        cast = InMemoryCastStore()
        server = BundleAssetServer()
        server.setCastMediaHandler(CastMediaHandler(media: CastMediaStore(root: mediaRoot), cast: cast))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: assetsRoot.deletingLastPathComponent())
    }

    private func start() async throws -> URL {
        let base = await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            server.baseURL(for: DirectoryAppAssetSource(root: assetsRoot)) { continuation.resume(returning: $0) }
        }
        return try XCTUnwrap(base)
    }

    private func post(_ url: URL, body: Data, contentType: String) async throws -> (Data, Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "content-type")
        request.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    private func get(_ url: URL, range: String? = nil) async throws -> (Data, Int, HTTPURLResponse?) {
        var request = URLRequest(url: url)
        if let range { request.setValue(range, forHTTPHeaderField: "range") }
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0, response as? HTTPURLResponse)
    }

    private func json(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func testRecordingUploadAndRangedPlayback() async throws {
        let base = try await start()
        let recorded = Data((0..<16).map { UInt8($0) })

        let (uploaded, uploadCode) = try await post(
            base.appendingPathComponent("cast/media"), body: recorded, contentType: "video/webm"
        )
        XCTAssertEqual(uploadCode, 200)
        let payload = json(uploaded)
        guard let url = payload["url"] as? String, let name = payload["id"] as? String else {
            return XCTFail("upload shape: \(payload)")
        }
        XCTAssertEqual(payload["bytes"] as? Int, 16)
        XCTAssertEqual(payload["mime"] as? String, "video/webm")
        XCTAssertTrue(CastRules.mediaFileValid(name))

        let full = try await get(base.appendingPathComponent(url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))
        XCTAssertEqual(full.1, 200)
        XCTAssertEqual(full.0, recorded)
        XCTAssertEqual(full.2?.value(forHTTPHeaderField: "accept-ranges"), "bytes")

        let ranged = try await get(
            base.appendingPathComponent(url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
            range: "bytes=2-5"
        )
        XCTAssertEqual(ranged.1, 206)
        XCTAssertEqual(Array(ranged.0), [2, 3, 4, 5])
        XCTAssertEqual(ranged.2?.value(forHTTPHeaderField: "content-range"), "bytes 2-5/16")

        let (rejectBody, rejectCode) = try await post(
            base.appendingPathComponent("cast/media"), body: Data([1, 2, 3]), contentType: "image/png"
        )
        XCTAssertEqual(rejectCode, 415)
        let reject = json(rejectBody)["error"] as? [String: Any]
        XCTAssertEqual(reject?["code"] as? String, "BAD_TYPE")
    }

    func testLiveIngestServesPlaylistInitAndSegments() async throws {
        let base = try await start()
        let liveId = "live000001"
        try await cast.saveLive(CastLive(
            id: liveId, episode: "ep_test000001", status: "live", segments: 0,
            mime: "", startedAt: 1_700_000_000_000, stoppedAt: nil, lastSegmentAt: nil
        ))
        let liveBase = base.appendingPathComponent("cast/live/\(liveId)")

        // Empty playlist: init map, no segments yet.
        var playlist = try await get(liveBase.appendingPathComponent("index.m3u8"))
        XCTAssertEqual(playlist.1, 200)
        XCTAssertTrue(String(decoding: playlist.0, as: UTF8.self).contains("#EXT-X-MAP:URI=\"init.mp4\""))
        XCTAssertFalse(String(decoding: playlist.0, as: UTF8.self).contains("seg-0.m4s"))

        // The recorder's first chunk is the container init, with its mime.
        // Build the query on the URL itself: `appendingPathComponent` would
        // encode the `?` into the path.
        let initChunk = Data([0x00, 0x00, 0x00, 0x18]) + Data("ftypisom".utf8) + Data(repeating: 0, count: 8)
        let initURL = try XCTUnwrap(URL(string: base.absoluteString + "cast/live/\(liveId)/segment?init=1&mime=video%2Fmp4"))
        let (initBody, initCode) = try await post(initURL, body: initChunk, contentType: "video/mp4")
        XCTAssertEqual(initCode, 200)
        XCTAssertEqual(json(initBody)["segment"] as? String, "init.mp4")
        let liveRowValue = try await cast.live(id: liveId)
        let liveRow = try XCTUnwrap(liveRowValue)
        XCTAssertEqual(liveRow.mime, "video/mp4")

        // One segment, then the playlist advertises it.
        let (segmentBody, segmentCode) = try await post(
            base.appendingPathComponent("cast/live/\(liveId)/segment"),
            body: Data(repeating: 7, count: 32), contentType: "video/mp4"
        )
        XCTAssertEqual(segmentCode, 200)
        XCTAssertEqual(json(segmentBody)["segment"] as? String, "seg-0.m4s")
        let bumped = try await cast.live(id: liveId)
        XCTAssertEqual(bumped?.segments, 1)

        playlist = try await get(liveBase.appendingPathComponent("index.m3u8"))
        XCTAssertTrue(String(decoding: playlist.0, as: UTF8.self).contains("seg-0.m4s"))
        XCTAssertFalse(String(decoding: playlist.0, as: UTF8.self).contains("#EXT-X-ENDLIST"))

        let (segmentFile, fileCode, _) = try await get(liveBase.appendingPathComponent("seg-0.m4s"))
        XCTAssertEqual(fileCode, 200)
        XCTAssertEqual(segmentFile, Data(repeating: 7, count: 32))

        // Ending the broadcast turns the playlist into a replayable VOD and
        // stops further ingest.
        let endedValue = try await cast.live(id: liveId)
        var ended = try XCTUnwrap(endedValue)
        ended.status = "ended"
        try await cast.saveLive(ended)
        playlist = try await get(liveBase.appendingPathComponent("index.m3u8"))
        XCTAssertTrue(String(decoding: playlist.0, as: UTF8.self).contains("#EXT-X-ENDLIST"))

        let (_, afterCode) = try await post(
            base.appendingPathComponent("cast/live/\(liveId)/segment"),
            body: Data([9]), contentType: "video/mp4"
        )
        XCTAssertEqual(afterCode, 409)
    }

    func testMissingThingsAre404s() async throws {
        let base = try await start()
        let missing = try await get(base.appendingPathComponent("cast/media/abcdefghijkl.webm"))
        XCTAssertEqual(missing.1, 404)
        let unknownLive = try await get(base.appendingPathComponent("cast/live/unknown00001/index.m3u8"))
        XCTAssertEqual(unknownLive.1, 404)
    }
}
