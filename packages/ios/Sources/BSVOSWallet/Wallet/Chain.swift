import Foundation

/// Chain access behind one interface, ported from the daemon's `chain.ts`.
///
/// Production pairs ARC (writes) with WhatsOnChain (reads); tests inject a
/// transport and answer with canned payloads. The field names below are the
/// daemon's own, because they are the contract of the endpoints, not something
/// invented here.
///
/// One rule carried over verbatim: **broadcast-accepted is not confirmed.**
/// Every write returns a txid that still has to be watched to a terminal state.
public enum TxStatus: String, Codable, Sendable {
    case unknown = "UNKNOWN"
    case seen = "SEEN"
    case mined = "MINED"
    case rejected = "REJECTED"
}

public struct ChainUtxo: Equatable, Sendable {
    public var txid: String
    public var vout: Int
    public var value: Int
    public var height: Int

    public init(txid: String, vout: Int, value: Int, height: Int) {
        self.txid = txid
        self.vout = vout
        self.value = value
        self.height = height
    }
}

public struct ChainTx: Equatable, Sendable {
    public struct Vin: Equatable, Sendable {
        public var txid: String?
        public var vout: Int?
        public init(txid: String?, vout: Int?) {
            self.txid = txid
            self.vout = vout
        }
    }
    public struct Vout: Equatable, Sendable {
        public var value: Int?
        public var addresses: [String]?
        /// The output's script, when the provider gave one. The inscription
        /// paths need it: skipping ordinal carriers means reading scripts, and
        /// an address index cannot see a script that maps to no address.
        public var scriptHex: String?
        public init(value: Int?, addresses: [String]?, scriptHex: String? = nil) {
            self.value = value
            self.addresses = addresses
            self.scriptHex = scriptHex
        }
    }
    public var confirmations: Int
    public var vin: [Vin]
    public var vout: [Vout]

    public init(confirmations: Int, vin: [Vin], vout: [Vout]) {
        self.confirmations = confirmations
        self.vin = vin
        self.vout = vout
    }
}

public struct BroadcastResult: Equatable, Sendable {
    public var txid: String
    public var status: TxStatus
    public var detail: String?
    public init(txid: String, status: TxStatus, detail: String? = nil) {
        self.txid = txid
        self.status = status
        self.detail = detail
    }
}

public struct TxStatusResult: Equatable, Sendable {
    public var status: TxStatus
    public var blockHeight: Int
    public var competing: [String]?
    public var detail: String?
    public init(status: TxStatus, blockHeight: Int, competing: [String]? = nil, detail: String? = nil) {
        self.status = status
        self.blockHeight = blockHeight
        self.competing = competing
        self.detail = detail
    }
}

public struct AddressUtxos: Equatable, Sendable {
    public var confirmed: Int
    public var unconfirmed: Int
    public var utxos: [ChainUtxo]
    public init(confirmed: Int, unconfirmed: Int, utxos: [ChainUtxo]) {
        self.confirmed = confirmed
        self.unconfirmed = unconfirmed
        self.utxos = utxos
    }
}

/// Writes. ARC is the production implementation.
public protocol ChainWriter: Sendable {
    var name: String { get }
    func broadcast(txHex: String) async throws -> BroadcastResult
    func status(txid: String) async throws -> TxStatusResult
}

/// Reads. WhatsOnChain is the production implementation.
public protocol ChainReader: Sendable {
    var name: String { get }
    func utxos(address: String) async throws -> AddressUtxos
    func tx(txid: String) async throws -> ChainTx?
}

/// The full interface, the daemon's `ChainProvider`. `CombinedProvider` is the
/// only production type that implements both halves.
public protocol ChainProvider: ChainWriter & ChainReader {}

public enum ChainError: Error, Equatable, LocalizedError {
    case broadcastRejected(String)
    case notFound(String)
    case badResponse(String)

    public var errorDescription: String? {
        switch self {
        case .broadcastRejected(let detail): return "broadcast rejected: \(detail)"
        case .notFound(let detail): return "NOT_FOUND: \(detail)"
        case .badResponse(let detail): return "bad response: \(detail)"
        }
    }
}

// MARK: - transport

/// The HTTP seam. Injecting this is what lets the parsers be tested against
/// canned payloads instead of the live network.
public protocol ChainTransport: Sendable {
    /// Returns the body and the HTTP status code.
    func get(_ url: URL) async throws -> (Data, Int)
    func post(_ url: URL, jsonBody: Data) async throws -> (Data, Int)
}

public struct URLSessionTransport: ChainTransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionTransport.defaultSession) {
        self.session = session
    }

    /// 15 seconds, matching the daemon's `jfetch` timeout.
    public static let defaultSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration)
    }()

    public func get(_ url: URL) async throws -> (Data, Int) {
        let (data, response) = try await session.data(from: url)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    public func post(_ url: URL, jsonBody: Data) async throws -> (Data, Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = jsonBody
        let (data, response) = try await session.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

private func isOK(_ statusCode: Int) -> Bool {
    (200..<300).contains(statusCode)
}

// MARK: - ARC (writes)

/// Production writes: GorillaPool ARC.
public struct ArcProvider: ChainWriter {
    public let name = "arc-gorillapool"
    private let baseURL: String
    private let transport: any ChainTransport

    public init(baseURL: String = "https://arc.gorillapool.io/v1", transport: any ChainTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.transport = transport
    }

    private func url(_ path: String) -> URL {
        URL(string: baseURL + path)!
    }

    private struct BroadcastResponse: Decodable {
        var txid: String?
        var txStatus: String?
        var detail: String?
        var title: String?
        var extraInfo: String?
    }

    private struct StatusResponse: Decodable {
        var txStatus: String?
        var blockHeight: Int?
        var competingTxs: [String]?
        var extraInfo: String?
    }

    /// The daemon's mapping, branch for branch.
    static func mapStatus(_ raw: String?) -> TxStatus {
        switch (raw ?? "").uppercased() {
        case "MINED":
            return .mined
        case "SEEN_ON_NETWORK", "SENT_TO_NETWORK", "ACCEPTED":
            return .seen
        case "REJECTED", "DOUBLE_SPEND":
            return .rejected
        default:
            return .unknown
        }
    }

    public func broadcast(txHex: String) async throws -> BroadcastResult {
        let body = try JSONEncoder().encode(["rawTx": txHex])
        let (data, code) = try await transport.post(url("/tx"), jsonBody: body)
        // A rejected broadcast often carries an error body, and a body that is
        // not JSON at all is possible. Both land in the same throw, as they do
        // in the daemon, so an operator sees the reason instead of a decoder error.
        let decoded = (try? JSONDecoder().decode(BroadcastResponse.self, from: data)) ?? BroadcastResponse()
        guard isOK(code), let txid = decoded.txid else {
            let reason = decoded.detail ?? decoded.extraInfo ?? decoded.title ?? String(code)
            throw ChainError.broadcastRejected(String(reason.prefix(200)))
        }
        return BroadcastResult(txid: txid, status: Self.mapStatus(decoded.txStatus), detail: decoded.extraInfo)
    }

    public func status(txid: String) async throws -> TxStatusResult {
        let (data, code) = try await transport.get(url("/tx/\(txid)"))
        guard isOK(code) else {
            return TxStatusResult(status: .unknown, blockHeight: 0, competing: nil, detail: nil)
        }
        let decoded: StatusResponse
        do {
            decoded = try JSONDecoder().decode(StatusResponse.self, from: data)
        } catch {
            throw ChainError.badResponse("arc status: \(error)")
        }
        return TxStatusResult(
            status: Self.mapStatus(decoded.txStatus),
            blockHeight: decoded.blockHeight ?? 0,
            competing: decoded.competingTxs,
            detail: decoded.extraInfo
        )
    }
}

// MARK: - WhatsOnChain (reads)

/// Production reads: WhatsOnChain (keyless endpoints).
public struct WocProvider: ChainReader {
    public let name = "woc"
    private let baseURL: String
    private let transport: any ChainTransport

    public init(baseURL: String = "https://api.whatsonchain.com/v1/bsv/main", transport: any ChainTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.transport = transport
    }

    private func url(_ path: String) -> URL {
        URL(string: baseURL + path)!
    }

    private struct Unspent: Decodable {
        var height: Int
        var tx_pos: Int
        var tx_hash: String
        var value: Int
    }

    private struct Balance: Decodable {
        var confirmed: Int?
        var unconfirmed: Int?
    }

    public func utxos(address: String) async throws -> AddressUtxos {
        async let unspentCall = transport.get(url("/address/\(address)/unspent"))
        async let balanceCall = transport.get(url("/address/\(address)/balance"))
        let (unspentData, unspentCode) = try await unspentCall
        let (balanceData, balanceCode) = try await balanceCall

        // A non-OK read becomes an empty list, not an error: an address with no
        // history is a normal state, and the daemon makes the same choice. A
        // transport failure still throws, because that is not a balance of zero.
        var list: [Unspent] = []
        if isOK(unspentCode) {
            do {
                list = try JSONDecoder().decode([Unspent].self, from: unspentData)
            } catch {
                throw ChainError.badResponse("woc unspent: \(error)")
            }
        }
        var balance = Balance(confirmed: nil, unconfirmed: nil)
        if isOK(balanceCode) {
            do {
                balance = try JSONDecoder().decode(Balance.self, from: balanceData)
            } catch {
                throw ChainError.badResponse("woc balance: \(error)")
            }
        }
        return AddressUtxos(
            confirmed: balance.confirmed ?? 0,
            unconfirmed: balance.unconfirmed ?? 0,
            utxos: list.map { ChainUtxo(txid: $0.tx_hash, vout: $0.tx_pos, value: $0.value, height: $0.height) }
        )
    }

    private struct TxResponse: Decodable {
        struct Vin: Decodable {
            var txid: String?
            var vout: Int?
        }
        struct Vout: Decodable {
            struct ScriptPubKey: Decodable {
                var addresses: [String]?
                var hex: String?
            }
            var value: Int?
            var scriptPubKey: ScriptPubKey?
        }
        var confirmations: Int?
        var vin: [Vin]?
        var vout: [Vout]?
    }

    public func tx(txid: String) async throws -> ChainTx? {
        let (data, code) = try await transport.get(url("/tx/hash/\(txid)"))
        guard isOK(code) else { return nil }
        let decoded: TxResponse
        do {
            decoded = try JSONDecoder().decode(TxResponse.self, from: data)
        } catch {
            throw ChainError.badResponse("woc tx: \(error)")
        }
        return ChainTx(
            confirmations: decoded.confirmations ?? 0,
            vin: (decoded.vin ?? []).map { ChainTx.Vin(txid: $0.txid, vout: $0.vout) },
            vout: (decoded.vout ?? []).map {
                ChainTx.Vout(value: $0.value, addresses: $0.scriptPubKey?.addresses, scriptHex: $0.scriptPubKey?.hex)
            }
        )
    }
}

// MARK: - combined

/// Production pair: ARC writes, WhatsOnChain reads.
public struct CombinedProvider: ChainProvider {
    public let name = "arc+woc"
    private let write: any ChainWriter
    private let read: any ChainReader

    public init(write: any ChainWriter = ArcProvider(), read: any ChainReader = WocProvider()) {
        self.write = write
        self.read = read
    }

    public func broadcast(txHex: String) async throws -> BroadcastResult {
        try await write.broadcast(txHex: txHex)
    }

    public func status(txid: String) async throws -> TxStatusResult {
        try await write.status(txid: txid)
    }

    public func utxos(address: String) async throws -> AddressUtxos {
        try await read.utxos(address: address)
    }

    public func tx(txid: String) async throws -> ChainTx? {
        try await read.tx(txid: txid)
    }
}

// MARK: - outpoint resolution

public struct ResolvedOutpoint: Equatable, Sendable {
    public var txid: String
    public var vout: Int
    public var value: Int
    public var unconfirmed: Bool
    /// False when resolved via the parent transaction (index-blind scripts such
    /// as inscription envelopes, which address UTXO indexes cannot show).
    public var indexed: Bool

    public init(txid: String, vout: Int, value: Int, unconfirmed: Bool, indexed: Bool) {
        self.txid = txid
        self.vout = vout
        self.value = value
        self.unconfirmed = unconfirmed
        self.indexed = indexed
    }
}

/// Locate a live outpoint. Address UTXO indexes cannot see scripts that map to
/// no address, so absence there means nothing. The parent transaction is the
/// source of truth: missing means not yet visible; zero-conf is safe to chain
/// behind; confirmed means resolve — only the key holder can move it, and
/// callers track their own spends.
public func resolveOutpoint(
    chain: any ChainReader,
    address: String,
    txid: String,
    vout: Int
) async throws -> ResolvedOutpoint {
    var index: AddressUtxos? = nil
    do {
        index = try await chain.utxos(address: address)
    } catch {
        index = nil
    }
    if let live = index?.utxos.first(where: { $0.txid == txid && $0.vout == vout }) {
        return ResolvedOutpoint(txid: txid, vout: vout, value: live.value, unconfirmed: live.height <= 0, indexed: true)
    }
    var parent: ChainTx? = nil
    do {
        parent = try await chain.tx(txid: txid)
    } catch {
        parent = nil
    }
    guard let parent else {
        throw ChainError.notFound("parent tx not visible yet — wait and retry")
    }
    if parent.confirmations <= 0 {
        return ResolvedOutpoint(txid: txid, vout: vout, value: 1, unconfirmed: true, indexed: false)
    }
    return ResolvedOutpoint(txid: txid, vout: vout, value: 1, unconfirmed: false, indexed: false)
}
