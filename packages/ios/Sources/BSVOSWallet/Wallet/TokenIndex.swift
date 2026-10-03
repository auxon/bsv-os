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

/// The BSV21 spend-state question the chain cannot answer: which of these
/// outpoints are unspent token outputs, and for how much.
///
/// The daemon asks the 1Sat indexer (`POST /1sat/bsv21/{id}/outputs`) and
/// treats it as the arbiter of spend state, re-checking the envelope locally
/// on top — the same two-layer rule as inscription metadata. Behind a seam so
/// tests answer without a network.
public protocol TokenIndex: Sendable {
    /// Unspent carriers of `tokenId` among `outpoints` (`txid_vout` or
    /// `txid.vout`), with amounts already canonicalized. Rows the indexer does
    /// not know, or that it marks spent, are omitted.
    func holdings(tokenId: String, outpoints: [String]) async throws -> [TokenHolding]
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
}
