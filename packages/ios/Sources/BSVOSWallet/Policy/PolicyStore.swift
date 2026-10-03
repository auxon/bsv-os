import Foundation

/// The two policy stores: one for tests, one for the phone.
///
/// The daemon's version of this is two SQLite tables. A phone wallet holds a
/// handful of origins and a queue capped at 100, so a JSON document written
/// atomically is the right size — no database engine, nothing to migrate beyond
/// changing the document's version field.
public enum PolicyStoreError: Error, Equatable {
    case unsupportedVersion(Int)
}

/// For tests and previews. Behaviour mirrors the daemon's tables, including
/// auto-increment ids starting at 1 and newest-first pending order.
public actor InMemoryPolicyStore: PolicyStore {
    private var policies: [String: PolicyRowRecord] = [:]
    private var requests: [PolicyRequestRecord] = []
    private var nextRequestID = 1

    public init() {}

    public func policy(origin: String) async throws -> PolicyRowRecord? {
        policies[origin]
    }

    public func savePolicy(_ row: PolicyRowRecord) async throws {
        policies[row.origin] = row
    }

    public func request(origin: String, action: String) async throws -> PolicyRequestRecord? {
        requests.first { $0.origin == origin && $0.action == action }
    }

    @discardableResult
    public func insertRequest(
        origin: String, amountSats: Int, action: String, createdAt: Int, score: SpendScore?
    ) async throws -> PolicyRequestRecord {
        let record = PolicyRequestRecord(
            id: nextRequestID, origin: origin, amountSats: amountSats,
            action: action, createdAt: createdAt, score: score
        )
        nextRequestID += 1
        requests.append(record)
        return record
    }

    public func updateScore(id: Int, score: SpendScore) async throws {
        guard let index = requests.firstIndex(where: { $0.id == id }) else { return }
        requests[index].score = score
    }

    public func pendingRequests(limit: Int) async throws -> [PolicyRequestRecord] {
        // The daemon orders by created_at only; equal timestamps come back in
        // whatever order the database chooses. Ties break by id here so the
        // phone's answer is at least deterministic.
        requests
            .sorted { $0.createdAt == $1.createdAt ? $0.id > $1.id : $0.createdAt > $1.createdAt }
            .prefix(limit)
            .map { $0 }
    }

    public func deleteRequests(origin: String) async throws {
        requests.removeAll { $0.origin == origin }
    }

    public func allPolicies() async throws -> [PolicyRowRecord] {
        policies.values.sorted { $0.origin < $1.origin }
    }
}

/// The app's store: one JSON document, written atomically.
///
/// Kept an actor so concurrent window.bsv calls serialise at the store, which
/// is the same guarantee the daemon's single connection gives it.
public actor FilePolicyStore: PolicyStore {
    private struct Snapshot: Codable {
        var version: Int
        var policies: [PolicyRowRecord]
        var requests: [PolicyRequestRecord]
        var nextRequestID: Int

        static let empty = Snapshot(version: currentVersion, policies: [], requests: [], nextRequestID: 1)
        static let currentVersion = 1
    }

    private let url: URL
    private var snapshot: Snapshot

    /// Loads the document if it exists; an absent file is an empty wallet, not
    /// an error.
    public init(url: URL) throws {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url)
            let loaded = try JSONDecoder().decode(Snapshot.self, from: data)
            guard loaded.version == Snapshot.currentVersion else {
                throw PolicyStoreError.unsupportedVersion(loaded.version)
            }
            self.snapshot = loaded
        } else {
            self.snapshot = .empty
        }
    }

    /// `<Application Support>/BSVOS/policy.json`, creating the directory.
    public static func defaultURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        let directory = base.appendingPathComponent("BSVOS", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("policy.json")
    }

    private func persist() throws {
        let data = try JSONEncoder().encode(snapshot)
        try data.write(to: url, options: .atomic)
    }

    public func policy(origin: String) async throws -> PolicyRowRecord? {
        snapshot.policies.first { $0.origin == origin }
    }

    public func savePolicy(_ row: PolicyRowRecord) async throws {
        if let index = snapshot.policies.firstIndex(where: { $0.origin == row.origin }) {
            snapshot.policies[index] = row
        } else {
            snapshot.policies.append(row)
        }
        try persist()
    }

    public func request(origin: String, action: String) async throws -> PolicyRequestRecord? {
        snapshot.requests.first { $0.origin == origin && $0.action == action }
    }

    @discardableResult
    public func insertRequest(
        origin: String, amountSats: Int, action: String, createdAt: Int, score: SpendScore?
    ) async throws -> PolicyRequestRecord {
        let record = PolicyRequestRecord(
            id: snapshot.nextRequestID, origin: origin, amountSats: amountSats,
            action: action, createdAt: createdAt, score: score
        )
        snapshot.nextRequestID += 1
        snapshot.requests.append(record)
        try persist()
        return record
    }

    public func updateScore(id: Int, score: SpendScore) async throws {
        guard let index = snapshot.requests.firstIndex(where: { $0.id == id }) else { return }
        snapshot.requests[index].score = score
        try persist()
    }

    public func pendingRequests(limit: Int) async throws -> [PolicyRequestRecord] {
        snapshot.requests
            .sorted { $0.createdAt == $1.createdAt ? $0.id > $1.id : $0.createdAt > $1.createdAt }
            .prefix(limit)
            .map { $0 }
    }

    public func deleteRequests(origin: String) async throws {
        snapshot.requests.removeAll { $0.origin == origin }
        try persist()
    }

    public func allPolicies() async throws -> [PolicyRowRecord] {
        snapshot.policies.sorted { $0.origin < $1.origin }
    }
}
