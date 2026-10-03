import XCTest
@testable import BSVOSWallet

/// P1's backend acceptance test: the ordlock/swap operations on the phone must
/// broadcast the daemon's own transactions, gate with the daemon's action
/// names, and refuse what the daemon refuses (plain dust, foreign locks,
/// in-flight carriers).
final class OrdlockBackendTests: XCTestCase {
    // MARK: - fixtures from the generator

    private struct Vector: Decodable {
        struct U: Decodable {
            let txid: String
            let vout: UInt32
            let value: Int
            let scriptHex: String
        }
        struct O: Decodable {
            let txid: String
            let vout: Int
        }
        struct P: Decodable {
            let to: String
            let sats: Int
        }
        struct Tx: Decodable {
            let signedHex: String
            let txid: String
            let fee: Int
            let lockScriptHex: String?
            let lockOutpoint: O?
            let priceSats: Int?
            let payoutScriptHex: String?
            let feePayment: P?
            let carrier: U?
            let funding: U?
        }
        struct Offer: Decodable {
            struct I: Decodable {
                let txid: String
                let vout: Int
                let scriptHex: String
                let sequence: Int
                let unlockHex: String
            }
            let payScriptHex: String
            let priceSats: Int
            let inputs: [I]
        }
        let phrase: String
        let selfAddress: String
        let selfScriptHex: String
        let lock: Tx
        let cancel: Tx
        let buy: Tx
        let complete: Tx
        let offer: Offer

        enum CodingKeys: String, CodingKey {
            case phrase, lock, cancel, buy, complete, offer
            case selfAddress = "self"
            case selfScriptHex
        }
    }

    private func loadVector() throws -> Vector {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/ordlock-vectors.json")
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    // MARK: - stubs

    actor StubChain: ChainProvider {
        nonisolated let name = "stub"
        var parents: [String: ChainTx]
        var utxoList: [ChainUtxo]
        private(set) var broadcasts: [String] = []

        init(parents: [String: ChainTx] = [:], utxos: [ChainUtxo] = []) {
            self.parents = parents
            self.utxoList = utxos
        }

        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: 0, unconfirmed: 0, utxos: utxoList)
        }

        func tx(txid: String) async throws -> ChainTx? { parents[txid.lowercased()] }

        func broadcast(txHex: String) async throws -> BroadcastResult {
            broadcasts.append(txHex)
            let txid = Tx.txid(ofSignedBytes: try Hex.decode(txHex))
            return BroadcastResult(txid: txid, status: .seen)
        }

        func status(txid: String) async throws -> TxStatusResult {
            TxStatusResult(status: .unknown, blockHeight: 0)
        }

        func setParents(_ parents: [String: ChainTx]) { self.parents = parents }
        func setUtxos(_ utxos: [ChainUtxo]) { self.utxoList = utxos }
    }

    actor StubMetadata: InscriptionMetadata {
        var inscribed: Set<String>
        var fail = false
        init(inscribed: Set<String> = []) { self.inscribed = inscribed }
        func isInscribed(txid: String, vout: Int) async throws -> Bool {
            if fail { throw ChainError.badResponse("stub ordfs down") }
            return inscribed.contains("\(txid):\(vout)")
        }
        func setFail(_ value: Bool) { fail = value }
    }

    private func parent(scriptHex: String, value: Int, voutCount: Int = 1) -> ChainTx {
        ChainTx(
            confirmations: 1, vin: [],
            vout: (0..<voutCount).map { _ in ChainTx.Vout(value: value, addresses: nil, scriptHex: scriptHex) }
        )
    }

    private func makeWallet(
        chain: StubChain,
        metadata: StubMetadata = StubMetadata()
    ) -> (LocalWalletBackend, PolicyEngine) {
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: vector.phrase),
            chain: chain,
            policy: engine,
            ledger: InMemoryLedgerStore(),
            inscriptions: metadata
        )
        return (wallet, engine)
    }

    private var vector: Vector!

    override func setUpWithError() throws {
        vector = try loadVector()
    }

    // MARK: - the operations broadcast the daemon's bytes

    func testLockBroadcastsTheDaemonsTransaction() async throws {
        let v = vector!
        let chain = StubChain(
            parents: [
                v.lock.carrier!.txid: parent(scriptHex: v.lock.carrier!.scriptHex, value: 1),
                v.lock.funding!.txid: parent(scriptHex: v.lock.funding!.scriptHex, value: v.lock.funding!.value, voutCount: 2),
            ],
            utxos: [chainUtxo(v.lock.carrier!), chainUtxo(v.lock.funding!)]
        )
        let metadata = StubMetadata()
        let (wallet, engine) = makeWallet(chain: chain, metadata: metadata)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)

        let result = try await wallet.ordlockLock(
            origin: "app.example", txid: v.lock.carrier!.txid, vout: 0, priceSats: 25_000
        )
        XCTAssertEqual(result.txid, v.lock.txid)
        XCTAssertEqual(result.lockOutpoint, "\(v.lock.txid).0")
        XCTAssertEqual(result.fee, v.lock.fee)
        let broadcasts = await chain.broadcasts
        XCTAssertEqual(broadcasts.last, v.lock.signedHex, "the lock tx is the daemon's byte for byte")
        let expectedLockScript = try Ordlock.lockScript(cancelAddress: v.selfAddress, payAddress: v.selfAddress, priceSats: 25_000)
        XCTAssertEqual(v.lock.lockScriptHex, expectedLockScript)
    }

    func testBuyBroadcastsTheDaemonsPurchase() async throws {
        let v = vector!
        let lockOutpoint = try XCTUnwrap(v.buy.lockOutpoint)
        let chain = StubChain(
            parents: [
                lockOutpoint.txid: parent(scriptHex: v.buy.lockScriptHex!, value: 1),
                v.buy.funding!.txid: parent(scriptHex: v.buy.funding!.scriptHex, value: v.buy.funding!.value, voutCount: 2),
            ],
            utxos: [chainUtxo(v.buy.funding!)]
        )
        let (wallet, engine) = makeWallet(chain: chain)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)

        let result = try await wallet.ordlockBuy(
            origin: "app.example",
            lockOutpoint: "\(lockOutpoint.txid).\(lockOutpoint.vout)",
            fee: v.buy.feePayment.map { LocalWalletBackend.AppPayment(to: $0.to, sats: $0.sats) },
            memo: ["MARKET-BUY", "\(lockOutpoint.txid).\(lockOutpoint.vout)"],
            label: "market buy \(lockOutpoint.txid).\(lockOutpoint.vout)"
        )
        XCTAssertEqual(result.txid, v.buy.txid)
        XCTAssertEqual(result.priceSats, v.buy.priceSats)
        XCTAssertEqual(result.fee, v.buy.fee)
        let broadcasts = await chain.broadcasts
        XCTAssertEqual(broadcasts.last, v.buy.signedHex, "the covenant purchase is the daemon's byte for byte")
    }

    func testCancelBroadcastsTheDaemonsOperation() async throws {
        let v = vector!
        let lockOutpoint = try XCTUnwrap(v.cancel.lockOutpoint)
        let chain = StubChain(
            parents: [
                lockOutpoint.txid: parent(scriptHex: v.cancel.lockScriptHex!, value: 1),
                v.cancel.funding!.txid: parent(scriptHex: v.cancel.funding!.scriptHex, value: v.cancel.funding!.value, voutCount: 2),
            ],
            utxos: [chainUtxo(v.cancel.funding!)]
        )
        let (wallet, engine) = makeWallet(chain: chain)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)

        let result = try await wallet.ordlockCancel(
            origin: "app.example", lockOutpoint: "\(lockOutpoint.txid).\(lockOutpoint.vout)"
        )
        XCTAssertEqual(result.txid, v.cancel.txid)
        let broadcasts = await chain.broadcasts
        XCTAssertEqual(broadcasts.last, v.cancel.signedHex)
        // The cancel path selector is OP_1 at the end of input 0's script.
    }

    func testSwapOfferMatchesTheDaemonsPreSignatures() async throws {
        let v = vector!
        let chain = swapChain(v)
        let metadata = StubMetadata()
        let (wallet, engine) = makeWallet(chain: chain, metadata: metadata)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)

        let offer = try await wallet.signSwapOffer(
            origin: "app.example", txid: v.offer.inputs[1].txid, vout: v.offer.inputs[1].vout, priceSats: v.offer.priceSats
        )
        XCTAssertEqual(offer.version, 4)
        XCTAssertEqual(offer.kind, "ordinal")
        XCTAssertEqual(offer.payScriptHex, v.offer.payScriptHex)
        XCTAssertEqual(offer.priceSats, v.offer.priceSats)
        XCTAssertEqual(offer.lockTime, 0)
        let theirInputs = v.offer.inputs.map {
            Ordlock.SwapOfferInput(txid: $0.txid, vout: $0.vout, scriptHex: $0.scriptHex, sequence: $0.sequence, unlockHex: $0.unlockHex)
        }
        XCTAssertEqual(offer.inputs, theirInputs, "both pre-signed unlocks are byte-identical")
    }

    func testCompleteSwapBroadcastsTheDaemonsCompletion() async throws {
        let v = vector!
        let chain = swapChain(v)
        let (wallet, engine) = makeWallet(chain: chain, metadata: StubMetadata())
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)

        let offer = try await wallet.signSwapOffer(
            origin: "app.example", txid: v.offer.inputs[1].txid, vout: v.offer.inputs[1].vout, priceSats: v.offer.priceSats
        )
        let result = try await wallet.completeSwap(origin: "app.example", offer: offer)
        XCTAssertEqual(result.txid, v.complete.txid)
        XCTAssertEqual(result.fee, v.complete.fee)
        let broadcasts = await chain.broadcasts
        XCTAssertEqual(broadcasts.last, v.complete.signedHex, "the completion is the daemon's byte for byte")
    }

    // MARK: - policy and refusals

    func testTheActionsQueueUnderTheDaemonsNames() async throws {
        let v = vector!
        let chain = swapChain(v)
        let (wallet, engine) = makeWallet(chain: chain, metadata: StubMetadata())
        try await wallet.unlock()

        _ = try? await wallet.ordlockLock(origin: "app.example", txid: v.lock.carrier!.txid, vout: 0, priceSats: 25_000)
        _ = try? await wallet.signSwapOffer(origin: "app.example", txid: v.offer.inputs[1].txid, vout: v.offer.inputs[1].vout, priceSats: v.offer.priceSats)
        let queued = try await engine.pendingRequests()
        XCTAssertEqual(Set(queued.map(\.action)), ["ordlock-lock", "app-swap-offer"])
    }

    func testPlainDustIsRefusedWithoutAnEnvelopeOrMetadata() async throws {
        let v = vector!
        // The carrier's script as *plain* dust: no envelope, and ORDFS says
        // nothing is inscribed there either.
        let chain = StubChain(
            parents: [
                v.lock.carrier!.txid: parent(scriptHex: v.selfScriptHex, value: 1),
                v.lock.funding!.txid: parent(scriptHex: v.lock.funding!.scriptHex, value: v.lock.funding!.value, voutCount: 2),
            ],
            utxos: [chainUtxo(v.lock.funding!)]
        )
        let (wallet, engine) = makeWallet(chain: chain, metadata: StubMetadata())
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)
        do {
            _ = try await wallet.ordlockLock(origin: "app.example", txid: v.lock.carrier!.txid, vout: 0, priceSats: 25_000)
            XCTFail("plain dust must not lock")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_PARAM")
            XCTAssertTrue(error.message.contains("not inscribed"))
        }
    }

    func testAnUnreachableIndexerFailsClosedAsRails() async throws {
        let v = vector!
        let chain = StubChain(
            parents: [
                v.lock.carrier!.txid: parent(scriptHex: v.selfScriptHex, value: 1),
                v.lock.funding!.txid: parent(scriptHex: v.lock.funding!.scriptHex, value: v.lock.funding!.value, voutCount: 2),
            ],
            utxos: [chainUtxo(v.lock.funding!)]
        )
        let metadata = StubMetadata()
        await metadata.setFail(true)
        let (wallet, engine) = makeWallet(chain: chain, metadata: metadata)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)
        do {
            _ = try await wallet.ordlockLock(origin: "app.example", txid: v.lock.carrier!.txid, vout: 0, priceSats: 25_000)
            XCTFail("an unreachable indexer must fail closed")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "RAILS")
        }
    }

    func testACarrierSpentInFlightIsRefused() async throws {
        let v = vector!
        let chain = StubChain(
            parents: [
                v.lock.carrier!.txid: parent(scriptHex: v.lock.carrier!.scriptHex, value: 1),
                v.lock.funding!.txid: parent(scriptHex: v.lock.funding!.scriptHex, value: v.lock.funding!.value, voutCount: 2),
            ],
            utxos: [chainUtxo(v.lock.carrier!), chainUtxo(v.lock.funding!)]
        )
        let (wallet, engine) = makeWallet(chain: chain)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)
        _ = try await wallet.ordlockLock(origin: "app.example", txid: v.lock.carrier!.txid, vout: 0, priceSats: 25_000)
        // The broadcast is `seen`; the same carrier is now spoken for even
        // though the index still lists it.
        do {
            _ = try await wallet.ordlockLock(origin: "app.example", txid: v.lock.carrier!.txid, vout: 0, priceSats: 30_000)
            XCTFail("an in-flight carrier must not be locked twice")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_PARAM")
            XCTAssertTrue(error.message.contains("in-flight"))
        }
    }

    func testBuyerChecksRefuseARedirectedPayout() async throws {
        let v = vector!
        let lockOutpoint = try XCTUnwrap(v.buy.lockOutpoint)
        let chain = StubChain(
            parents: [
                lockOutpoint.txid: parent(scriptHex: v.buy.lockScriptHex!, value: 1),
                v.buy.funding!.txid: parent(scriptHex: v.buy.funding!.scriptHex, value: v.buy.funding!.value, voutCount: 2),
            ],
            utxos: [chainUtxo(v.buy.funding!)]
        )
        let (wallet, engine) = makeWallet(chain: chain)
        try await wallet.unlock()
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 10_000_000)
        do {
            _ = try await wallet.ordlockBuy(
                origin: "app.example", lockOutpoint: "\(lockOutpoint.txid).\(lockOutpoint.vout)",
                expectedSeller: "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
            )
            XCTFail("a lock that pays someone else must be refused")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_OFFER")
            XCTAssertTrue(error.message.contains("expected seller"))
        }
    }

    // MARK: - helpers

    private func swapChain(_ v: Vector) -> StubChain {
        StubChain(
            parents: [
                v.offer.inputs[0].txid: parent(scriptHex: v.offer.inputs[0].scriptHex, value: 1),
                v.offer.inputs[1].txid: parent(scriptHex: v.offer.inputs[1].scriptHex, value: 1),
                v.complete.funding!.txid: parent(scriptHex: v.complete.funding!.scriptHex, value: v.complete.funding!.value, voutCount: 2),
            ],
            utxos: [
                ChainUtxo(txid: v.offer.inputs[0].txid, vout: v.offer.inputs[0].vout, value: 1, height: 1),
                ChainUtxo(txid: v.offer.inputs[1].txid, vout: v.offer.inputs[1].vout, value: 1, height: 1),
                chainUtxo(v.complete.funding!),
            ]
        )
    }

    private func chainUtxo(_ u: Vector.U) -> ChainUtxo {
        ChainUtxo(txid: u.txid, vout: Int(u.vout), value: u.value, height: 1)
    }
}
