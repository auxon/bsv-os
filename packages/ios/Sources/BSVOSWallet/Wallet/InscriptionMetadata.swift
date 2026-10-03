import Foundation

/// "Is this outpoint an inscription?" — the one indexer question ordinal
/// flows on the phone cannot answer from the chain alone.
///
/// A transferred inscription moves the 1-sat carrier to a plain P2PKH output
/// and leaves the envelope at the origin; the chain script is then
/// indistinguishable from plain dust. The daemon asks ORDFS (1Sat's metadata
/// endpoint) before it will lock or list such a carrier, and this is that
/// call behind a seam so tests answer it without a network.
public protocol InscriptionMetadata: Sendable {
    /// True when the indexer knows a contentType for the outpoint.
    func isInscribed(txid: String, vout: Int) async throws -> Bool
}

/// The daemon's `fetchBulkMetadata` (tokens.ts), pointed at 1Sat.
public struct OnesatInscriptionMetadata: InscriptionMetadata {
    private let baseURL: String
    private let transport: any ChainTransport

    public init(
        baseURL: String = "https://api.1sat.app",
        transport: any ChainTransport = URLSessionTransport()
    ) {
        self.baseURL = baseURL
        self.transport = transport
    }

    private struct Meta: Decodable {
        var contentType: String?
    }

    private struct Request: Encodable {
        var outpoints: [String]
    }

    public func isInscribed(txid: String, vout: Int) async throws -> Bool {
        let key = "\(txid)_\(vout)"
        guard let url = URL(string: baseURL + "/1sat/ordfs/metadata") else {
            throw ChainError.badResponse("ordfs metadata url")
        }
        let body = try JSONEncoder().encode(Request(outpoints: [key]))
        let (data, code) = try await transport.post(url, jsonBody: body)
        guard (200..<300).contains(code) else {
            throw ChainError.badResponse("ordfs metadata failed (\(code))")
        }
        let decoded: [String: Meta?]
        do {
            decoded = try JSONDecoder().decode([String: Meta?].self, from: data)
        } catch {
            throw ChainError.badResponse("ordfs metadata: \(error)")
        }
        // The daemon accepts either key spelling; the bulk endpoint returns
        // whichever it prefers.
        let meta = decoded[key] ?? decoded[key.replacingOccurrences(of: "_", with: ".")]
        return !((meta ?? nil)?.contentType ?? "").isEmpty
    }
}
