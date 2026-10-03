import Foundation

/// One unspent token carrier as the indexer sees it.
public struct TokenHolding: Sendable, Equatable {
    public var txid: String
    public var vout: Int
    public var amt: String
    public var op: String
    public var id: String

    public init(txid: String, vout: Int, amt: String, op: String, id: String) {
        self.txid = txid
        self.vout = vout
        self.amt = amt
        self.op = op
        self.id = id
    }
}

/// One row of the token gallery: a token the address holds, with the
/// registry's display fields and the indexer's balance — the daemon's
/// `Bsv21Position`, field for field.
public struct TokenPosition: Codable, Sendable, Equatable {
    public var tokenId: String
    public var symbol: String
    public var decimals: Int
    public var icon: String?
    public var balance: Int
    public var utxoCount: Int

    public init(tokenId: String, symbol: String, decimals: Int, icon: String?, balance: Int, utxoCount: Int) {
        self.tokenId = tokenId
        self.symbol = symbol
        self.decimals = decimals
        self.icon = icon
        self.balance = balance
        self.utxoCount = utxoCount
    }
}

/// The BSV21 spend-state question the chain cannot answer: which of these
/// outpoints are unspent token outputs, and for how much — plus the gallery
/// sweep across the token registry.
///
/// The daemon asks the 1Sat indexer (`POST /1sat/bsv21/{id}/outputs` for
/// holdings, `GET /1sat/bsv21/tokens` + per-token balances for the gallery)
/// and treats it as the arbiter of spend state, re-checking the envelope
/// locally on top — the same two-layer rule as inscription metadata. Behind a
/// seam so tests answer without a network.
public protocol TokenIndex: Sendable {
    /// Unspent carriers of `tokenId` among `outpoints` (`txid_vout` or
    /// `txid.vout`), with amounts already canonicalized. Rows the indexer does
    /// not know, or that it marks spent, are omitted.
    func holdings(tokenId: String, outpoints: [String]) async throws -> [TokenHolding]
    /// The address's nonzero token positions, registry order.
    func positions(address: String) async throws -> [TokenPosition]
}

public extension TokenIndex {
    /// Sources that only answer the swap question (test stubs) inherit this.
    func positions(address: String) async throws -> [TokenPosition] { [] }
}

/// The daemon's `tokenHoldings` (tokens.ts), pointed at 1Sat.
public struct OnesatTokenIndex: TokenIndex {
    private let baseURL: String
    private let transport: any ChainTransport

    public init(
        baseURL: String = "https://api.1sat.app",
        transport: any ChainTransport = URLSessionTransport()
    ) {
        self.baseURL = baseURL
        self.transport = transport
    }

    private struct Row: Decodable {
        struct DataField: Decodable {
            struct Bsv21: Decodable {
                var id: String?
                var amt: String?
                var op: String?
            }
            var bsv21: Bsv21?
        }
        var spend: Bool?
        var outpoint: String?
        var data: DataField?
    }

    public func holdings(tokenId: String, outpoints: [String]) async throws -> [TokenHolding] {
        let mine = outpoints.compactMap { outpoint -> String? in
            guard let parts = Bsv21.splitOutpoint(outpoint) else { return nil }
            return "\(parts.txid)_\(parts.vout)"
        }
        guard !mine.isEmpty else { return [] }
        guard let url = URL(string: baseURL + "/1sat/bsv21/\(tokenId)/outputs") else {
            throw ChainError.badResponse("token index url")
        }
        let body: Data
        do {
            body = try JSONEncoder().encode(mine)
        } catch {
            throw ChainError.badResponse("token lookup body: \(error)")
        }
        let (data, code) = try await transport.post(url, jsonBody: body)
        guard (200..<300).contains(code) else {
            throw ChainError.badResponse("token lookup failed (\(code))")
        }

        // The indexer answers JSON null (200) when none of the outpoints are
        // known token outputs; any parse failure is "no holdings" too, as in
        // the daemon (`res.json().catch(() => [])`).
        let rows = (try? JSONDecoder().decode([Row].self, from: data)) ?? []
        var holdings: [TokenHolding] = []
        for row in rows {
            if row.spend == true { continue }
            guard let token = row.data?.bsv21, token.id == tokenId,
                  let amt = Bsv21.parseTokenAmount(token.amt),
                  let parts = Bsv21.splitOutpoint(row.outpoint ?? "") else { continue }
            holdings.append(TokenHolding(
                txid: parts.txid, vout: parts.vout, amt: amt,
                op: token.op ?? "", id: token.id ?? ""
            ))
        }
        return holdings
    }

    // MARK: - the gallery

    private struct RegistryEntry: Decodable {
        var token_id: String?
        var symbol: String?
        var decimals: Double?
        var icon: String?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            token_id = try? c.decode(String.self, forKey: .token_id)
            symbol = try? c.decode(String.self, forKey: .symbol)
            icon = try? c.decode(String.self, forKey: .icon)
            // The daemon runs `Number(t.decimals)`: accept the string spelling
            // some registries use.
            if let value = try? c.decode(Double.self, forKey: .decimals) {
                decimals = value
            } else if let text = try? c.decode(String.self, forKey: .decimals) {
                decimals = Double(text)
            } else {
                decimals = nil
            }
        }

        enum CodingKeys: String, CodingKey {
            case token_id, symbol, decimals, icon
        }
    }

    private struct BalanceRow: Decodable {
        var balance: Double?
        var utxoCount: Double?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            balance = Self.number(c, .balance)
            utxoCount = Self.number(c, .utxoCount)
        }

        enum CodingKeys: String, CodingKey {
            case balance, utxoCount
        }

        private static func number(
            _ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
        ) -> Double? {
            if let value = try? container.decode(Double.self, forKey: key) { return value }
            if let text = try? container.decode(String.self, forKey: key) { return Double(text) }
            return nil
        }
    }

    /// The daemon's `bsv21For`: the registry in order, batches of ten balance
    /// calls, nonzero balances only. A per-token failure is skipped; a
    /// registry failure is not.
    public func positions(address: String) async throws -> [TokenPosition] {
        let registry = try await registryEntries()
        var positions: [TokenPosition] = []
        let entries = Array(registry.prefix(300))
        for start in stride(from: 0, to: entries.count, by: 10) {
            let batch = entries[start..<min(start + 10, entries.count)]
            let results = await withTaskGroup(of: (Int, TokenPosition?).self) { group -> [(Int, TokenPosition?)] in
                for (offset, entry) in batch.enumerated() {
                    group.addTask { (offset, await self.position(for: entry, address: address)) }
                }
                var collected: [(Int, TokenPosition?)] = []
                for await result in group { collected.append(result) }
                return collected.sorted { $0.0 < $1.0 }
            }
            positions.append(contentsOf: results.compactMap { $0.1 })
        }
        return positions
    }

    private func registryEntries() async throws -> [RegistryEntry] {
        guard let url = URL(string: baseURL + "/1sat/bsv21/tokens") else {
            throw ChainError.badResponse("bsv21 registry url")
        }
        let (data, code) = try await transport.get(url)
        guard (200..<300).contains(code) else {
            throw ChainError.badResponse("bsv21 registry failed (\(code))")
        }
        do {
            return try JSONDecoder().decode([RegistryEntry].self, from: data)
        } catch {
            throw ChainError.badResponse("bsv21 registry: \(error)")
        }
    }

    private func position(for entry: RegistryEntry, address: String) async -> TokenPosition? {
        guard let tokenId = entry.token_id, !tokenId.isEmpty,
              let url = URL(string: baseURL + "/1sat/bsv21/\(tokenId)/ordlock/\(address)/balance") else {
            return nil
        }
        guard let (data, code) = try? await transport.get(url), (200..<300).contains(code),
              let row = try? JSONDecoder().decode(BalanceRow.self, from: data) else { return nil }
        let balance = Self.exactInt(row.balance)
        guard balance > 0 else { return nil }
        let symbol = entry.symbol.flatMap { $0.isEmpty ? nil : $0 } ?? String(tokenId.prefix(12))
        return TokenPosition(
            tokenId: tokenId,
            symbol: symbol,
            decimals: Self.exactInt(entry.decimals),
            icon: entry.icon,
            balance: balance,
            utxoCount: Self.exactInt(row.utxoCount)
        )
    }

    /// JS numbers lose precision past 2^53; cap there rather than trap or
    /// wrap, and floor like the daemon's `Math.floor`.
    static func exactInt(_ value: Double?) -> Int {
        guard let value, value.isFinite, value > 0 else { return 0 }
        return Int(min(value.rounded(.down), 9_007_199_254_740_991))
    }
}
