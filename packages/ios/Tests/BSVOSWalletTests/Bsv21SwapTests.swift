import XCTest
@testable import BSVOSWallet

/// The bsv21 half of P1: the offer pre-signature, the indexer-checked
/// completion, and the refusals around a spent or mismatched token output.
/// The transactions themselves are pinned to the daemon's bytes in
/// Bsv21VectorTests; these drive the operations that produce them.
final class Bsv21SwapTests: XCTestCase {
    private struct Vector: Decodable {
        struct Utxo: Decodable {
            let txid: String
            let vout: UInt32
            let value: Int
            let scriptHex: String
        }
        struct OfferInput: Decodable {
            let txid: String
            let vout: UInt32
            let scriptHex: String
            let sequence: Int
        }
        struct Offer: Decodable {
            let version: Int
            let kind: String
            let payScriptHex: String
            let priceSats: Int
            let lockTime: Int
            let input: OfferInput
            let unlockHex: String
            let tokenId: String
            let tokenAmount: String
        }
        struct Complete: Decodable {
            let funding: Utxo
            let unsignedHex: String
            let signedHex: String
            let txid: String
            let fee: Int
        }
        let transfers: [Transfer]
        struct Transfer: Decodable {
            let name: String
            let owner: String
            let tokenId: String
            let amt: String
            let scriptHex: String
        }
        let selfAddress: String
        let offer: Offer
        let complete: Complete

        enum CodingKeys: String, CodingKey {
            case transfers, offer, complete
            case selfAddress = "self"
        }
    }

    private func load() throws -> Vector {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/bsv21-vectors.json")
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    actor StubChain: ChainProvider {
        nonisolated let name = "stub"
        var parents: [String: ChainTx]
        var utxos: [ChainUtxo]
        private(set) var broadcasts: [String] = []
        init(parents: [String: ChainTx] = [:], utxos: [ChainUtxo] = []) {
            self.parents = parents
            self.utxos = utxos
        }
        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: 0, unconfirmed: 0, utxos: utxos)
        }
        func tx(txid: String) async throws -> ChainTx? { parents[txid.lowercased()] }
        func broadcast(txHex: String) async throws -> BroadcastResult {
            broadcasts.append(txHex)
            return BroadcastResult(txid: Tx.txid(ofSignedBytes: try Hex.decode(txHex)), status: .seen)
        }
        func status(txid: String) async throws -> TxStatusResult { TxStatusResult(status: .unknown, blockHeight: 0) }
    }

    actor StubTokens: TokenIndex {
        var rows: [TokenHolding] = []
        var fail = false
        func holdings(tokenId: String, outpoints: [String]) async throws -> [TokenHolding] {
            if fail { throw ChainError.badResponse("stub indexer down") }
            return rows
        }
        func set(_ rows: [TokenHolding]) { self.rows = rows }
        func setFail(_ value: Bool) { fail = value }
    }

    private func parent(scriptHex: String, value: Int, voutCount: Int) -> ChainTx {
        ChainTx(
            confirmations: 1, vin: [],
            vout: (0..<voutCount).map { _ in ChainTx.Vout(value: value, addresses: nil, scriptHex: scriptHex) }
        )
    }

    private func makeWallet(chain: StubChain, tokens: StubTokens) -> (LocalWalletBackend, PolicyEngine) {
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
            chain: chain,
            policy: engine,
            ledger: InMemoryLedgerStore(),
            inscriptions: StubMetadata(),
            tokens: tokens
        )
        return (wallet, engine)
    }

    actor StubMetadata: InscriptionMetadata {
        func isInscribed(txid: String, vout: Int) async throws -> Bool { false }
    }

    // MARK: - offer

    func testSignSwapOfferBsv21MatchesTheDaemonsOffer() async throws {
        let v = try load()
        let chain = StubChain(
            parents: [v.offer.input.txid: parent(scriptHex: v.offer.input.scriptHex, value: 1, voutCount: 2)],
            utxos: []
        )
        let (wallet, engine) = makeWallet(chain: chain, tokens: StubTokens())
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)

        let offer = try await wallet.signSwapOffer(
            origin: "app.example",
            txid: v.offer.input.txid,
            vout: Int(v.offer.input.vout),
            priceSats: v.offer.priceSats,
            kind: "bsv21",
            tokenId: v.offer.tokenId,
            tokenAmount: v.offer.tokenAmount
        )
        XCTAssertEqual(offer.version, 3)
        XCTAssertEqual(offer.kind, "bsv21")
        XCTAssertEqual(offer.payScriptHex, v.offer.payScriptHex)
        XCTAssertEqual(offer.priceSats, v.offer.priceSats)
        XCTAssertEqual(offer.lockTime, 0)
        XCTAssertEqual(offer.input?.txid, v.offer.input.txid)
        XCTAssertEqual(offer.input?.vout, Int(v.offer.input.vout))
        XCTAssertEqual(offer.input?.scriptHex, v.offer.input.scriptHex)
        XCTAssertEqual(offer.input?.sequence, v.offer.input.sequence)
        XCTAssertEqual(offer.input?.unlockHex, v.offer.unlockHex)
        XCTAssertEqual(offer.tokenId, v.offer.tokenId)
        XCTAssertEqual(offer.tokenAmount, v.offer.tokenAmount)
        XCTAssertNil(offer.inputs, "the v3 shape carries a single input, not the v4 pair")
    }

    func testBsv21OfferRefusesACarrierThatIsNotTheListedOutput() async throws {
        let v = try load()
        // The carrier holds 1000, but the page lists it as 999.
        let chain = StubChain(
            parents: [v.offer.input.txid: parent(scriptHex: v.offer.input.scriptHex, value: 1, voutCount: 2)],
            utxos: []
        )
        let (wallet, engine) = makeWallet(chain: chain, tokens: StubTokens())
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)
        do {
            _ = try await wallet.signSwapOffer(
                origin: "app.example", txid: v.offer.input.txid, vout: Int(v.offer.input.vout),
                priceSats: v.offer.priceSats, kind: "bsv21",
                tokenId: v.offer.tokenId, tokenAmount: "999"
            )
            XCTFail("the envelope says 1000")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_PARAM")
            XCTAssertTrue(error.message.contains("not the listed token output"))
        }
    }

    func testAnUnknownKindIsRefusedWithTheDaemonsMessage() async throws {
        let (wallet, _) = makeWallet(chain: StubChain(), tokens: StubTokens())
        try await wallet.unlock()
        do {
            _ = try await wallet.signSwapOffer(
                origin: "app.example", txid: String(repeating: "aa", count: 32), vout: 0,
                priceSats: 1, kind: "ordinal2"
            )
            XCTFail("unknown kind")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_PARAM")
            XCTAssertEqual(error.message, "kind must be ordinal or bsv21")
        }
    }

    // MARK: - completion

    func testCompleteSwapBsv21BroadcastsTheDaemonsTransaction() async throws {
        let v = try load()
        let chain = StubChain(
            parents: [
                v.offer.input.txid: parent(scriptHex: v.offer.input.scriptHex, value: 1, voutCount: 2),
                v.complete.funding.txid: parent(scriptHex: v.complete.funding.scriptHex, value: v.complete.funding.value, voutCount: 2),
            ],
            utxos: [ChainUtxo(
                txid: v.complete.funding.txid, vout: Int(v.complete.funding.vout),
                value: v.complete.funding.value, height: 1
            )]
        )
        let tokens = StubTokens()
        await tokens.set([TokenHolding(
            txid: v.offer.input.txid, vout: Int(v.offer.input.vout),
            amt: v.offer.tokenAmount, op: "transfer", id: v.offer.tokenId
        )])
        let (wallet, engine) = makeWallet(chain: chain, tokens: tokens)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)

        let offer = Ordlock.SwapOffer(
            version: v.offer.version, kind: v.offer.kind,
            payScriptHex: v.offer.payScriptHex, priceSats: v.offer.priceSats, lockTime: v.offer.lockTime,
            input: Ordlock.SwapOfferInput(
                txid: v.offer.input.txid, vout: Int(v.offer.input.vout),
                scriptHex: v.offer.input.scriptHex, sequence: v.offer.input.sequence,
                unlockHex: v.offer.unlockHex
            ),
            tokenId: v.offer.tokenId, tokenAmount: v.offer.tokenAmount
        )
        let result = try await wallet.completeSwap(origin: "app.example", offer: offer)
        XCTAssertEqual(result.txid, v.complete.txid)
        XCTAssertEqual(result.fee, v.complete.fee)
        let broadcasts = await chain.broadcasts
        XCTAssertEqual(broadcasts.last, v.complete.signedHex, "the completion is the daemon's byte for byte")
    }

    func testBsv21CompletionRefusesASpentOrMismatchedOffer() async throws {
        let v = try load()
        let chain = StubChain(
            parents: [v.offer.input.txid: parent(scriptHex: v.offer.input.scriptHex, value: 1, voutCount: 2)],
            utxos: []
        )
        let tokens = StubTokens()
        let (wallet, engine) = makeWallet(chain: chain, tokens: tokens)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)
        let offer = Ordlock.SwapOffer(
            version: v.offer.version, kind: v.offer.kind,
            payScriptHex: v.offer.payScriptHex, priceSats: v.offer.priceSats, lockTime: v.offer.lockTime,
            input: Ordlock.SwapOfferInput(
                txid: v.offer.input.txid, vout: Int(v.offer.input.vout),
                scriptHex: v.offer.input.scriptHex, sequence: v.offer.input.sequence,
                unlockHex: v.offer.unlockHex
            ),
            tokenId: v.offer.tokenId, tokenAmount: v.offer.tokenAmount
        )
        // The indexer knows nothing unspent there.
        do {
            _ = try await wallet.completeSwap(origin: "app.example", offer: offer)
            XCTFail("a spent token output must not complete")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_OFFER")
            XCTAssertTrue(error.message.contains("spent or disagrees with the indexer"))
        }
        // And an unreachable indexer fails closed.
        await tokens.setFail(true)
        do {
            _ = try await wallet.completeSwap(origin: "app.example", offer: offer)
            XCTFail("an unreachable indexer must fail closed")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "RAILS")
        }
    }
}
