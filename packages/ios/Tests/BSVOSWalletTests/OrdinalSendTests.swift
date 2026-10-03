import XCTest
@testable import BSVOSWallet

/// Item 3: ordinal transfer — the carrier is spent first and stays the sat in
/// output 0, and the policy gate sees the action `ordinal-send`.
final class OrdinalSendTests: XCTestCase {
    actor StubChain: ChainProvider {
        nonisolated let name = "stub"
        let ordinalTxid = String(repeating: "dd", count: 32)
        private let ordinalValue: Int
        private(set) var lastBroadcastHex: String?

        init(ordinalValue: Int = 1) {
            self.ordinalValue = ordinalValue
        }

        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: 0, unconfirmed: 0, utxos: [
                ChainUtxo(txid: ordinalTxid, vout: 0, value: ordinalValue, height: 1),
                ChainUtxo(txid: String(repeating: "aa", count: 32), vout: 0, value: 100_000, height: 1),
            ])
        }
        func broadcast(txHex: String) async throws -> BroadcastResult {
            lastBroadcastHex = txHex
            return BroadcastResult(txid: String(repeating: "cc", count: 32), status: .seen)
        }
        func status(txid: String) async throws -> TxStatusResult { TxStatusResult(status: .unknown, blockHeight: 0) }
        func tx(txid: String) async throws -> ChainTx? { nil }
    }

    private let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let recipient = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"

    private func harness(ordinalValue: Int = 1) -> (LocalWalletBackend, PolicyEngine, StubChain) {
        let chain = StubChain(ordinalValue: ordinalValue)
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: phrase), chain: chain, policy: engine, ledger: InMemoryLedgerStore()
        )
        return (wallet, engine, chain)
    }

    func testTransferMovesTheOneSatAndKeepsFIFOOrder() async throws {
        let (wallet, engine, chain) = harness()
        try await wallet.unlock()

        do {
            _ = try await wallet.appSendOrdinal(origin: "app.example", txid: chain.ordinalTxid, vout: 0, to: recipient)
            XCTFail("an unknown origin must not transfer")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "POLICY_DENY")
            XCTAssertTrue(error.message.hasPrefix("denied: "))
        }
        let queued = try await engine.pendingRequests()
        XCTAssertEqual(queued.map(\.action), ["ordinal-send"])

        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 5_000)
        let result = try await wallet.appSendOrdinal(origin: "app.example", txid: chain.ordinalTxid, vout: 0, to: recipient)
        XCTAssertGreaterThan(result.fee, 0)

        let broadcastHex = await chain.lastBroadcastHex
        let tx = try Tx.parse(try Hex.decode(try XCTUnwrap(broadcastHex)))
        XCTAssertEqual(tx.inputs.first?.txid, chain.ordinalTxid, "the carrier is spent first, so FIFO keeps its sat in output 0")
        XCTAssertEqual(tx.inputs.first?.vout, 0)
        XCTAssertEqual(tx.outputs.first?.sats, 1)
        XCTAssertEqual(Hex.encode(tx.outputs.first?.script ?? []), Hex.encode(try Address.lockingScript(for: recipient)))
    }

    func testAnOrdinalThatIsNotInTheWalletIsNotFound() async throws {
        let (wallet, _, _) = harness()
        try await wallet.unlock()
        do {
            _ = try await wallet.appSendOrdinal(origin: "app.example", txid: String(repeating: "ee", count: 32), vout: 0, to: recipient)
            XCTFail("unknown outpoint")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "NOT_FOUND")
        }
    }

    func testACarrierThatIsNotOneSatIsRefused() async throws {
        let (wallet, _, chain) = harness(ordinalValue: 500)
        try await wallet.unlock()
        do {
            _ = try await wallet.appSendOrdinal(origin: "app.example", txid: chain.ordinalTxid, vout: 0, to: recipient)
            XCTFail("a carrier must be exactly 1 sat")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_PARAM")
            XCTAssertTrue(error.message.contains("exactly 1 sat"))
        }
    }
}
