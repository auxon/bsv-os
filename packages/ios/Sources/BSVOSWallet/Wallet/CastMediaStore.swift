import Foundation

/// File-system errors the media routes surface, with the daemon's codes.
public struct CastMediaError: Error, Equatable, Sendable {
    public var code: String
    public var message: String
    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// Recordings and live segments on local disk. Ids are server-generated and
/// extensions come from a content-type allowlist — no client-controlled paths.
public struct CastMediaStore: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public static func defaultRoot() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        let directory = base.appendingPathComponent("BSVOS", isDirectory: true)
            .appendingPathComponent("cast-media", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    // MARK: - recordings

    public func storeRecording(data: Data, contentType: String) throws -> (name: String, url: String, bytes: Int, mime: String) {
        guard let ext = CastRules.mediaExt(contentType) else {
            throw CastMediaError(
                code: "BAD_TYPE",
                message: "recording must be video/webm, video/mp4, audio/webm, audio/mp4, audio/mpeg, or audio/ogg"
            )
        }
        guard !data.isEmpty else { throw CastMediaError(code: "BAD_PARAM", message: "empty body") }
        guard data.count <= CastRules.maxUploadBytes else {
            throw CastMediaError(code: "TOO_BIG", message: "recording exceeds 256 MiB")
        }
        let name = "\(CastRules.newMediaId())\(ext)"
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try data.write(to: root.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUnlessOpen])
        } catch {
            throw CastMediaError(code: "STORE", message: "could not store recording")
        }
        let mime = contentType.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? contentType
        return (name, "/cast/media/\(name)", data.count, mime)
    }

    public func recordingURL(name: String) -> URL? {
        guard CastRules.mediaFileValid(name) else { return nil }
        let url = root.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    // MARK: - live segments

    public func writeInit(liveId: String, data: Data) throws {
        let isMp4 = data.count > 8 && data.subdata(in: 4..<8) == Data("ftyp".utf8)
        let isWebm = data.count > 4 && data[0] == 0x1a && data[1] == 0x45 && data[2] == 0xdf && data[3] == 0xa3
        guard isMp4 || isWebm else {
            throw CastMediaError(code: "BAD_PARAM", message: "init chunk is not mp4/webm")
        }
        let directory = liveDirectory(liveId)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appendingPathComponent("init.mp4"), options: [.atomic, .completeFileProtectionUnlessOpen])
        } catch {
            throw CastMediaError(code: "STORE", message: "could not store segment")
        }
    }

    public func writeSegment(liveId: String, index: Int, data: Data) throws {
        let directory = liveDirectory(liveId)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appendingPathComponent("seg-\(index).m4s"), options: [.atomic, .completeFileProtectionUnlessOpen])
        } catch {
            throw CastMediaError(code: "STORE", message: "could not store segment")
        }
    }

    public func liveFileURL(liveId: String, name: String) -> URL? {
        guard CastRules.liveIdValid(liveId), CastRules.liveFileValid(name) else { return nil }
        if name == "index.m3u8" { return nil }
        let url = liveDirectory(liveId).appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /// Newest write in the live directory (segment mtimes), for the silence
    /// reaper. Nil when nothing has been written yet.
    public func lastActivity(liveId: String) -> Int? {
        let directory = liveDirectory(liveId)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return nil }
        var newest: Int?
        for name in names {
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(name).path),
                  let modified = attributes[.modificationDate] as? Date else { continue }
            let stamp = Int(modified.timeIntervalSince1970 * 1000)
            if newest == nil || stamp > newest! { newest = stamp }
        }
        return newest
    }

    private func liveDirectory(_ id: String) -> URL {
        root.appendingPathComponent("live-\(id)", isDirectory: true)
    }
}

/// One HTTP reply for the loopback server's cast routes.
public struct CastHTTPReply: Sendable {
    public var status: Int
    public var contentType: String
    public var body: Data
    /// Extra response headers (content-range, accept-ranges, …).
    public var headers: [String: String]

    public init(status: Int, contentType: String = "application/json", body: Data = Data(), headers: [String: String] = [:]) {
        self.status = status
        self.contentType = contentType
        self.body = body
        self.headers = headers
    }

    static func json(_ status: Int, _ object: [String: Any]) -> CastHTTPReply {
        let body = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return CastHTTPReply(status: status, contentType: "application/json", body: body)
    }

    /// The error envelope the daemon's media routes use; the app reads
    /// `error.message` or `error` and shows it either way.
    static func failure(_ status: Int, code: String, message: String) -> CastHTTPReply {
        json(status, ["error": ["code": code, "message": message]])
    }
}

/// The cast half of the loopback server: what the Cast app's HTTP calls mean.
public protocol CastMediaServing: Sendable {
    /// `durationMs` is the recorder's wall-clock length, when it reported one:
    /// the server re-runs the MP4 duration repair with it so a file whose
    /// client-side patch was skipped still lands playable.
    func uploadRecording(data: Data, contentType: String, durationMs: Int?) async -> CastHTTPReply
    func recording(name: String, range: String?) async -> CastHTTPReply
    func appendSegment(liveId: String, data: Data, isInit: Bool, mime: String?) async -> CastHTTPReply
    func livePlaylist(liveId: String) async -> CastHTTPReply
    func liveFile(liveId: String, name: String, range: String?) async -> CastHTTPReply
}

/// Implements the daemon's `/cast/media` and `/cast/live` routes over the
/// phone's cast store and media directory. Loopback-only by construction, the
/// same as the daemon's own routes.
public struct CastMediaHandler: CastMediaServing {
    private let media: CastMediaStore
    private let cast: any CastStore
    private let now: @Sendable () -> Int

    public init(
        media: CastMediaStore,
        cast: any CastStore,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.media = media
        self.cast = cast
        self.now = now
    }

    public func uploadRecording(data: Data, contentType: String, durationMs: Int?) async -> CastHTTPReply {
        var payload = data
        var patched = false
        if let durationMs, durationMs > 0,
           CastRules.mediaExt(contentType) == ".mp4",
           Mp4Duration.looksLikeMp4(payload) {
            let fixed = Mp4Duration.fix(payload, durationMs: durationMs)
            patched = fixed != payload
            payload = fixed
        }
        do {
            let stored = try media.storeRecording(data: payload, contentType: contentType)
            return .json(200, [
                "id": stored.name,
                "url": stored.url,
                "bytes": stored.bytes,
                "mime": stored.mime,
                "durationMs": durationMs ?? 0,
                "patched": patched,
            ])
        } catch let error as CastMediaError {
            return .failure(error.code == "BAD_TYPE" ? 415 : error.code == "TOO_BIG" ? 413 : error.code == "BAD_PARAM" ? 400 : 500,
                            code: error.code, message: error.message)
        } catch {
            return .failure(500, code: "STORE", message: "could not store recording")
        }
    }

    public func recording(name: String, range: String?) async -> CastHTTPReply {
        guard let url = media.recordingURL(name: name) else {
            return .failure(404, code: "NOT_FOUND", message: "not found")
        }
        return Self.serveFile(url, contentType: CastRules.mediaMime(for: name), range: range)
    }

    public func appendSegment(liveId: String, data: Data, isInit: Bool, mime: String?) async -> CastHTTPReply {
        guard CastRules.liveIdValid(liveId), let live = try? await cast.live(id: liveId) else {
            return .failure(404, code: "NOT_FOUND", message: "not found")
        }
        guard live.status == "live" else {
            return .failure(409, code: "BAD_STATE", message: "broadcast ended")
        }
        guard !data.isEmpty, data.count <= CastRules.maxSegmentBytes else {
            return .failure(data.isEmpty ? 400 : 413, code: "BAD_PARAM", message: "bad segment")
        }
        if isInit {
            do {
                try media.writeInit(liveId: liveId, data: data)
            } catch let error as CastMediaError {
                return .failure(400, code: error.code, message: error.message)
            } catch {
                return .failure(500, code: "STORE", message: "could not store segment")
            }
            var updated = live
            if let mime {
                let clean = mime.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
                let pattern = /^(video|audio)\/[a-z0-9.+-]+$/
                if clean.count <= 64, (try? pattern.wholeMatch(in: clean)) != nil {
                    updated.mime = clean
                }
            }
            updated.lastSegmentAt = now()
            try? await cast.saveLive(updated)
            return .json(200, ["segment": "init.mp4", "bytes": data.count])
        }
        guard live.segments < CastRules.maxLiveSegments else {
            return .failure(409, code: "BAD_STATE", message: "segment cap reached — stop and start a new broadcast")
        }
        let index = live.segments
        do {
            try media.writeSegment(liveId: liveId, index: index, data: data)
        } catch {
            return .failure(500, code: "STORE", message: "could not store segment")
        }
        var updated = live
        updated.segments = index + 1
        updated.lastSegmentAt = now()
        try? await cast.saveLive(updated)
        return .json(200, ["segment": "seg-\(index).m4s", "bytes": data.count])
    }

    public func livePlaylist(liveId: String) async -> CastHTTPReply {
        guard CastRules.liveIdValid(liveId), let live = try? await cast.live(id: liveId) else {
            return .failure(404, code: "NOT_FOUND", message: "not found")
        }
        let body = CastRules.livePlaylist(segments: live.segments, ended: live.status == "ended")
        return CastHTTPReply(status: 200, contentType: "application/vnd.apple.mpegurl", body: Data(body.utf8))
    }

    public func liveFile(liveId: String, name: String, range: String?) async -> CastHTTPReply {
        guard let url = media.liveFileURL(liveId: liveId, name: name) else {
            return .failure(404, code: "NOT_FOUND", message: "not found")
        }
        let mime = name.hasSuffix(".m4s") ? "video/iso.segment" : "video/mp4"
        // The daemon serves live files whole (no range), so this does too.
        guard let body = try? Data(contentsOf: url) else {
            return .failure(404, code: "NOT_FOUND", message: "not found")
        }
        return CastHTTPReply(status: 200, contentType: mime, body: body)
    }

    // MARK: - range serving

    /// The daemon's `castMediaHttp`: full or ranged reads with 416 handling.
    static func serveFile(_ url: URL, contentType: String, range: String?) -> CastHTTPReply {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attributes[.size] as? NSNumber)?.intValue, size > 0 else {
            return .failure(404, code: "NOT_FOUND", message: "not found")
        }
        let match = firstRange(range)
        guard let match else {
            guard let body = try? Data(contentsOf: url) else {
                return .failure(404, code: "NOT_FOUND", message: "not found")
            }
            return CastHTTPReply(
                status: 200, contentType: contentType, body: body,
                headers: ["accept-ranges": "bytes", "cache-control": "no-store"]
            )
        }
        let start = match.start ?? 0
        let end = min(match.end ?? size - 1, size - 1)
        guard start <= end, start < size else {
            return CastHTTPReply(
                status: 416, contentType: contentType, body: Data(),
                headers: ["content-range": "bytes */\(size)"]
            )
        }
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            return .failure(404, code: "NOT_FOUND", message: "not found")
        }
        defer { try? handle.close() }
        try? handle.seek(toOffset: UInt64(start))
        let body = (try? handle.read(upToCount: end - start + 1)) ?? Data()
        return CastHTTPReply(
            status: 206, contentType: contentType, body: body,
            headers: [
                "content-range": "bytes \(start)-\(end)/\(size)",
                "accept-ranges": "bytes",
                "cache-control": "no-store",
            ]
        )
    }

    /// `bytes=(\d*)-(\d*)`; both ends optional, as in the daemon.
    static func firstRange(_ header: String?) -> (start: Int?, end: Int?)? {
        guard let header, let regex = try? NSRegularExpression(pattern: "bytes=(\\d*)-(\\d*)") else { return nil }
        let text = header as NSString
        guard let match = regex.firstMatch(in: header, range: NSRange(location: 0, length: text.length)) else { return nil }
        func group(_ index: Int) -> Int? {
            let range = match.range(at: index)
            guard range.location != NSNotFound else { return nil }
            let value = text.substring(with: range)
            return value.isEmpty ? nil : Int(value)
        }
        return (group(1), group(2))
    }
}
