import Foundation

/// A recording or broadcast source in the Cast app.
public struct CastEpisode: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var feed: String
    public var mediaUrl: String
    public var live: Bool
    public var splits: [CastSplit]
    public var createdAt: Int

    public init(id: String, title: String, feed: String, mediaUrl: String, live: Bool, splits: [CastSplit], createdAt: Int) {
        self.id = id
        self.title = title
        self.feed = feed
        self.mediaUrl = mediaUrl
        self.live = live
        self.splits = splits
        self.createdAt = createdAt
    }
}

/// One listening session: what the app opens, pauses, resumes and closes.
public struct CastSession: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var episode: String
    public var title: String
    public var ratePerMin: Int
    public var everySecs: Int
    public var maxTotal: Int
    public var streamIds: [String]
    /// playing | stopped
    public var status: String
    public var startedAt: Int
    public var stoppedAt: Int?

    public init(
        id: String, episode: String, title: String, ratePerMin: Int, everySecs: Int,
        maxTotal: Int, streamIds: [String], status: String, startedAt: Int, stoppedAt: Int?
    ) {
        self.id = id
        self.episode = episode
        self.title = title
        self.ratePerMin = ratePerMin
        self.everySecs = everySecs
        self.maxTotal = maxTotal
        self.streamIds = streamIds
        self.status = status
        self.startedAt = startedAt
        self.stoppedAt = stoppedAt
    }
}

/// A pay-per-minute stream (one per split), the same shape the daemon stores.
public struct PayStream: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var payee: String
    public var ratePerMin: Int
    public var tickSecs: Int
    public var maxTotal: Int
    public var board: String
    /// active | paused | done
    public var status: String
    public var paidTotal: Int
    public var lastPaidAt: Int
    public var nextDue: Int
    public var createdAt: Int

    public init(
        id: String, name: String, payee: String, ratePerMin: Int, tickSecs: Int, maxTotal: Int,
        board: String, status: String, paidTotal: Int, lastPaidAt: Int, nextDue: Int, createdAt: Int
    ) {
        self.id = id
        self.name = name
        self.payee = payee
        self.ratePerMin = ratePerMin
        self.tickSecs = tickSecs
        self.maxTotal = maxTotal
        self.board = board
        self.status = status
        self.paidTotal = paidTotal
        self.lastPaidAt = lastPaidAt
        self.nextDue = nextDue
        self.createdAt = createdAt
    }

    /// Sats owed per tick at the stream's rate, and the assumed fee share the
    /// daemon warns about. The desktop says this out loud at creation.
    public var tickSats: Int { Int(floor(Double(ratePerMin * tickSecs) / 60)) }
    public var feeShare: Double { tickSats > 0 ? Double(CastRules.assumedFeeSats) / Double(tickSats) : 1 }
}

/// One payment decision, paid or not — what the app's meter reads.
public struct StreamTick: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var streamId: String
    public var beatId: String?
    public var amount: Int
    public var txid: String?
    /// paid | skipped | stale | closed
    public var status: String
    public var detail: String
    public var createdAt: Int

    public init(id: Int, streamId: String, beatId: String?, amount: Int, txid: String?, status: String, detail: String, createdAt: Int) {
        self.id = id
        self.streamId = streamId
        self.beatId = beatId
        self.amount = amount
        self.txid = txid
        self.status = status
        self.detail = detail
        self.createdAt = createdAt
    }
}

/// A liveness proof. On the daemon these ride a board; on the phone both the
/// proof and the tick live in the same process, so the beat is a record.
public struct StreamBeat: Codable, Sendable, Equatable {
    public var id: String
    public var streamId: String
    public var ts: Int

    public init(id: String, streamId: String, ts: Int) {
        self.id = id
        self.streamId = streamId
        self.ts = ts
    }
}

/// A browser broadcast: init chunk plus one file per timeslice.
public struct CastLive: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var episode: String
    /// live | ended
    public var status: String
    public var segments: Int
    public var mime: String
    public var startedAt: Int
    public var stoppedAt: Int?
    /// Newest segment write, used to reap broadcasts whose recorder went quiet.
    public var lastSegmentAt: Int?

    public init(
        id: String, episode: String, status: String, segments: Int, mime: String,
        startedAt: Int, stoppedAt: Int?, lastSegmentAt: Int?
    ) {
        self.id = id
        self.episode = episode
        self.status = status
        self.segments = segments
        self.mime = mime
        self.startedAt = startedAt
        self.stoppedAt = stoppedAt
        self.lastSegmentAt = lastSegmentAt
    }
}

/// Everything Cast remembers, in one seam so tests run without a disk.
public protocol CastStore: Sendable {
    func episodes() async throws -> [CastEpisode]
    func episode(id: String) async throws -> CastEpisode?
    func saveEpisode(_ episode: CastEpisode) async throws

    func sessions() async throws -> [CastSession]
    func session(id: String) async throws -> CastSession?
    func saveSession(_ session: CastSession) async throws

    func streams() async throws -> [PayStream]
    func stream(id: String) async throws -> PayStream?
    func saveStream(_ stream: PayStream) async throws

    /// Appends a tick, assigning its id.
    func appendTick(_ tick: StreamTick) async throws -> StreamTick
    func ticks(streamId: String, limit: Int) async throws -> [StreamTick]

    func appendBeat(_ beat: StreamBeat) async throws
    func latestBeat(streamId: String) async throws -> StreamBeat?

    func lives() async throws -> [CastLive]
    func live(id: String) async throws -> CastLive?
    func saveLive(_ live: CastLive) async throws
}

public actor InMemoryCastStore: CastStore {
    private var episodeRows: [CastEpisode] = []
    private var sessionRows: [CastSession] = []
    private var streamRows: [PayStream] = []
    private var tickRows: [StreamTick] = []
    private var beatRows: [StreamBeat] = []
    private var liveRows: [CastLive] = []
    private var nextTickId = 1

    public init() {}

    public func episodes() async throws -> [CastEpisode] {
        episodeRows.sorted { $0.createdAt > $1.createdAt }
    }
    public func episode(id: String) async throws -> CastEpisode? { episodeRows.first { $0.id == id } }
    public func saveEpisode(_ episode: CastEpisode) async throws {
        if let index = episodeRows.firstIndex(where: { $0.id == episode.id }) { episodeRows[index] = episode }
        else { episodeRows.append(episode) }
    }

    public func sessions() async throws -> [CastSession] { sessionRows.sorted { $0.startedAt > $1.startedAt } }
    public func session(id: String) async throws -> CastSession? { sessionRows.first { $0.id == id } }
    public func saveSession(_ session: CastSession) async throws {
        if let index = sessionRows.firstIndex(where: { $0.id == session.id }) { sessionRows[index] = session }
        else { sessionRows.append(session) }
    }

    public func streams() async throws -> [PayStream] { streamRows.sorted { $0.createdAt > $1.createdAt } }
    public func stream(id: String) async throws -> PayStream? { streamRows.first { $0.id == id } }
    public func saveStream(_ stream: PayStream) async throws {
        if let index = streamRows.firstIndex(where: { $0.id == stream.id }) { streamRows[index] = stream }
        else { streamRows.append(stream) }
    }

    public func appendTick(_ tick: StreamTick) async throws -> StreamTick {
        var stored = tick
        stored.id = nextTickId
        nextTickId += 1
        tickRows.append(stored)
        return stored
    }

    public func ticks(streamId: String, limit: Int) async throws -> [StreamTick] {
        tickRows
            .filter { $0.streamId == streamId }
            .sorted { $0.createdAt > $1.createdAt || ($0.createdAt == $1.createdAt && $0.id > $1.id) }
            .prefix(min(max(limit, 1), 200))
            .map { $0 }
    }

    public func appendBeat(_ beat: StreamBeat) async throws { beatRows.append(beat) }
    public func latestBeat(streamId: String) async throws -> StreamBeat? {
        beatRows.filter { $0.streamId == streamId }.max { $0.ts < $1.ts }
    }

    public func lives() async throws -> [CastLive] { liveRows.sorted { $0.startedAt > $1.startedAt } }
    public func live(id: String) async throws -> CastLive? { liveRows.first { $0.id == id } }
    public func saveLive(_ live: CastLive) async throws {
        if let index = liveRows.firstIndex(where: { $0.id == live.id }) { liveRows[index] = live }
        else { liveRows.append(live) }
    }
}

/// One JSON document, written atomically — the same shape as the ledger and
/// policy stores, and for the same reason: a phone's data fits in a document.
public actor FileCastStore: CastStore {
    private struct Snapshot: Codable {
        static let currentVersion = 1
        var version: Int
        var episodes: [CastEpisode]
        var sessions: [CastSession]
        var streams: [PayStream]
        var ticks: [StreamTick]
        var beats: [StreamBeat]
        var lives: [CastLive]
        var nextTickId: Int

        static let empty = Snapshot(
            version: currentVersion, episodes: [], sessions: [], streams: [],
            ticks: [], beats: [], lives: [], nextTickId: 1
        )
    }

    private let url: URL
    private var snapshot: Snapshot

    public init(url: URL) throws {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            let loaded = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
            snapshot = loaded
        } else {
            snapshot = .empty
        }
    }

    public static func defaultURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        let directory = base.appendingPathComponent("BSVOS", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("cast.json")
    }

    private func persist() throws {
        try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
    }

    public func episodes() async throws -> [CastEpisode] {
        snapshot.episodes.sorted { $0.createdAt > $1.createdAt }
    }
    public func episode(id: String) async throws -> CastEpisode? { snapshot.episodes.first { $0.id == id } }
    public func saveEpisode(_ episode: CastEpisode) async throws {
        if let index = snapshot.episodes.firstIndex(where: { $0.id == episode.id }) { snapshot.episodes[index] = episode }
        else { snapshot.episodes.append(episode) }
        try persist()
    }

    public func sessions() async throws -> [CastSession] {
        snapshot.sessions.sorted { $0.startedAt > $1.startedAt }
    }
    public func session(id: String) async throws -> CastSession? { snapshot.sessions.first { $0.id == id } }
    public func saveSession(_ session: CastSession) async throws {
        if let index = snapshot.sessions.firstIndex(where: { $0.id == session.id }) { snapshot.sessions[index] = session }
        else { snapshot.sessions.append(session) }
        try persist()
    }

    public func streams() async throws -> [PayStream] {
        snapshot.streams.sorted { $0.createdAt > $1.createdAt }
    }
    public func stream(id: String) async throws -> PayStream? { snapshot.streams.first { $0.id == id } }
    public func saveStream(_ stream: PayStream) async throws {
        if let index = snapshot.streams.firstIndex(where: { $0.id == stream.id }) { snapshot.streams[index] = stream }
        else { snapshot.streams.append(stream) }
        try persist()
    }

    public func appendTick(_ tick: StreamTick) async throws -> StreamTick {
        var stored = tick
        stored.id = snapshot.nextTickId
        snapshot.nextTickId += 1
        snapshot.ticks.append(stored)
        try persist()
        return stored
    }

    public func ticks(streamId: String, limit: Int) async throws -> [StreamTick] {
        snapshot.ticks
            .filter { $0.streamId == streamId }
            .sorted { $0.createdAt > $1.createdAt || ($0.createdAt == $1.createdAt && $0.id > $1.id) }
            .prefix(min(max(limit, 1), 200))
            .map { $0 }
    }

    public func appendBeat(_ beat: StreamBeat) async throws {
        snapshot.beats.append(beat)
        try persist()
    }

    public func latestBeat(streamId: String) async throws -> StreamBeat? {
        snapshot.beats.filter { $0.streamId == streamId }.max { $0.ts < $1.ts }
    }

    public func lives() async throws -> [CastLive] {
        snapshot.lives.sorted { $0.startedAt > $1.startedAt }
    }
    public func live(id: String) async throws -> CastLive? { snapshot.lives.first { $0.id == id } }
    public func saveLive(_ live: CastLive) async throws {
        if let index = snapshot.lives.firstIndex(where: { $0.id == live.id }) { snapshot.lives[index] = live }
        else { snapshot.lives.append(live) }
        try persist()
    }
}
