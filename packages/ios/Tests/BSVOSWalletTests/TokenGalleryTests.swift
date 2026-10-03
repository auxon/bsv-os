import XCTest
@testable import BSVOSWallet

/// The shell's Tokens view: `bsv21List` must fan the registry out to balances
/// exactly as the daemon's `bsv21For` does — registry order, nonzero balances
/// only, a per-token failure skipped rather than fatal, and a registry failure
/// surfaced.
final class TokenGalleryTests: XCTestCase {
    actor CannedTransport: ChainTransport {
        private var exact: [String: (Data, Int)] = [:]
        private(set) var requested: [String] = []

        func get(_ url: URL) async throws -> (Data, Int) {
            let key = url.absoluteString
            requested.append(key)
            return exact[key] ?? (Data("null".utf8), 404)
        }

        func post(_ url: URL, jsonBody: Data) async throws -> (Data, Int) {
            requested.append(url.absoluteString)
            return (Data("null".utf8), 404)
        }

        func set(_ path: String, _ body: String, code: Int = 200) {
            exact["https://indexer.test" + path] = (Data(body.utf8), code)
        }
    }

    private let base = "https://indexer.test"
    private let address = "13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz"
    private let tokenA = String(repeating: "aa", count: 32) + "_0"
    private let tokenB = String(repeating: "bb", count: 32) + "_7"

    private func index(_ transport: CannedTransport) -> OnesatTokenIndex {
        OnesatTokenIndex(baseURL: base, transport: transport)
    }

    private func balancePath(_ tokenId: String) -> String {
        "/1sat/bsv21/\(tokenId)/ordlock/\(address)/balance"
    }

    func testTheGalleryFollowsRegistryOrderAndSkipsZeroAndEmpty() async throws {
        let transport = CannedTransport()
        await transport.set("/1sat/bsv21/tokens", """
        [
          {"token_id":"\(tokenB)","symbol":"","decimals":0},
          {"token_id":"\(tokenA)","symbol":"MEME","decimals":2,"icon":"https://x/icon.png"},
          {"token_id":"","symbol":"SELF"},
          {"token_id":"\(String(repeating: "cc", count: 32))_0","symbol":"GONE"}
        ]
        """)
        await transport.set(balancePath(tokenB), #"{"balance":"9007199254740993","utxoCount":"3"}"#)
        await transport.set(balancePath(tokenA), #"{"balance":500,"utxoCount":2}"#)
        // The third entry has no token id; the fourth gets no balance response
        // (404) and must be skipped, not fail the sweep.

        let positions = try await index(transport).positions(address: address)
        // Registry order kept, display fields mapped, JS-number cap applied,
        // symbol falls back to the id prefix.
        XCTAssertEqual(positions, [
            TokenPosition(
                tokenId: tokenB, symbol: String(tokenB.prefix(12)), decimals: 0,
                icon: nil, balance: 9_007_199_254_740_991, utxoCount: 3
            ),
            TokenPosition(
                tokenId: tokenA, symbol: "MEME", decimals: 2,
                icon: "https://x/icon.png", balance: 500, utxoCount: 2
            ),
        ])
    }

    func testAZeroBalanceIsNotAPosition() async throws {
        let transport = CannedTransport()
        await transport.set("/1sat/bsv21/tokens", #"[{"token_id":"\#(tokenA)","symbol":"MEME"}]"#)
        await transport.set(balancePath(tokenA), #"{"balance":0,"utxoCount":0}"#)
        let positions = try await index(transport).positions(address: address)
        XCTAssertTrue(positions.isEmpty)
    }

    func testRegistryFailureIsSurfaced() async throws {
        let transport = CannedTransport()
        await transport.set("/1sat/bsv21/tokens", "down", code: 503)
        do {
            _ = try await index(transport).positions(address: address)
            XCTFail("a registry failure is not an empty gallery")
        } catch let error as ChainError {
            guard case .badResponse(let detail) = error else { return XCTFail("badResponse expected") }
            XCTAssertTrue(detail.contains("registry failed (503)"))
        }
    }

    func testPositionsAreDecodedFromStringNumbers() async throws {
        let transport = CannedTransport()
        await transport.set("/1sat/bsv21/tokens", #"[{"token_id":"\#(tokenA)","symbol":"MEME","decimals":"2"}]"#)
        await transport.set(balancePath(tokenA), #"{"balance":"42","utxoCount":"1"}"#)
        let positions = try await index(transport).positions(address: address)
        XCTAssertEqual(positions.first?.decimals, 2)
        XCTAssertEqual(positions.first?.balance, 42)
        XCTAssertEqual(positions.first?.utxoCount, 1)
    }
}
