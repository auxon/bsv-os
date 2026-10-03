import Foundation

/// A transaction this wallet made, as the phone remembers it.
///
/// The daemon has a monitor process that rebroadcasts and confirms; a phone app
/// has only the time it is open. So the status here is refreshed on demand
/// (`LocalWalletBackend.refreshPendingTransactions`) and the hint says what the
/// phone actually does, rather than promising a daemon that is not there.
public struct LocalTx: Codable, Sendable, Equatable, Identifiable {
    public var txid: String
    public var label: String
    /// seen | mined | failed — the daemon's ledger statuses.
    public var status: String
    public var detail: String?
    public var createdAt: Int
    public var lastCheck: Int
    public var attempts: Int

    public var id: String { txid }

    public init(
        txid: String, label: String, status: String, detail: String? = nil,
        createdAt: Int, lastCheck: Int, attempts: Int = 0
    ) {
        self.txid = txid
        self.label = label
        self.status = status
        self.detail = detail
        self.createdAt = createdAt
        self.lastCheck = lastCheck
        self.attempts = attempts
    }

    public var hint: String {
        switch status {
        case "mined":
            return "confirmed on-chain"
        case "failed":
            return "network dropped it (usually a lost double-spend race) — nothing moved; just re-run the action"
        default:
            return "in mempool — the wallet rechecks while the app is open"
        }
    }
}

public protocol LedgerStore: Sendable {
    func record(_ tx: LocalTx) async throws
    func all() async throws -> [LocalTx]
    func update(_ tx: LocalTx) async throws
}

public actor InMemoryLedgerStore: LedgerStore {
    private var transactions: [LocalTx]

    public init(seed: [LocalTx] = []) {
        transactions = seed
    }

    public func record(_ tx: LocalTx) async throws {
        if let index = transactions.firstIndex(where: { $0.txid == tx.txid }) {
            transactions[index] = tx
        } else {
            transactions.append(tx)
        }
    }

    public func all() async throws -> [LocalTx] {
        transactions
    }

    public func update(_ tx: LocalTx) async throws {
        if let index = transactions.firstIndex(where: { $0.txid == tx.txid }) {
            transactions[index] = tx
        }
    }
}

/// One JSON document for the ledger, written atomically — the same shape as the
/// policy store, and for the same reason: a phone's data fits in a document.
public actor FileLedgerStore: LedgerStore {
    private struct Snapshot: Codable {
        static let currentVersion = 1
        var version: Int
        var transactions: [LocalTx]

        static let empty = Snapshot(version: currentVersion, transactions: [])
    }

    private let url: URL
    private var snapshot: Snapshot

    public init(url: URL) throws {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            let loaded = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
            guard loaded.version == Snapshot.currentVersion else {
                throw PolicyStoreError.unsupportedVersion(loaded.version)
            }
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
        return directory.appendingPathComponent("ledger.json")
    }

    private func persist() throws {
        try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
    }

    public func record(_ tx: LocalTx) async throws {
        if let index = snapshot.transactions.firstIndex(where: { $0.txid == tx.txid }) {
            snapshot.transactions[index] = tx
        } else {
            snapshot.transactions.append(tx)
        }
        try persist()
    }

    public func all() async throws -> [LocalTx] {
        snapshot.transactions
    }

    public func update(_ tx: LocalTx) async throws {
        guard let index = snapshot.transactions.firstIndex(where: { $0.txid == tx.txid }) else { return }
        snapshot.transactions[index] = tx
        try persist()
    }
}
