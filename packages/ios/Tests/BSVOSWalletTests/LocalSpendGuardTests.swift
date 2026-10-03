import XCTest
@testable import BSVOSWallet

/// P0: the local double-spend guard. The chain index lags a broadcast, so
/// selection must exclude outputs this wallet already spent in-flight — and
/// must free them again when the transaction fails.
final class LocalSpendGuardTests: XCTestCase {
    actor GuardChain: ChainProvider {
        nonisolated let name = "stub"
        private var utxoList: [ChainUtxo]
        private var statusResult: TxStatusResult
        private var broadcastCount = 0
        private(set) var broadcasts: [String] = []

        init(utxos: [ChainUtxo], status: TxStatusResult = TxStatusResult(status: .unknown, blockHeight: 0)) {
            self.utxoList = utxos
            self.statusResult = status
        }

        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: utxoList.reduce(0) { $0 + $1.value }, unconfirmed: 0, utxos: utxoList)
        }

        func broadcast(txHex: String) async throws -> BroadcastResult {
            broadcasts.append(txHex)
            broadcastCount += 1
            return BroadcastResult(
                txid: String(repeating: "0", count: 62) + String(format: "%02x", broadcastCount),
                status: .seen
            )
        }

        func status(txid: String) async throws -> TxStatusResult { statusResult }
        func tx(txid: String) async throws -> ChainTx? { nil }
        func setStatus(_ status: TxStatusResult) { statusResult = status }
    }

    private let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let recipient = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"

    private func makeWallet(chain: GuardChain) -> LocalWalletBackend {
        LocalWalletBackend(
            vault: InMemorySeedVault(phrase: phrase),
            chain: chain,
            policy: PolicyEngine(store: InMemoryPolicyStore()),
            ledger: InMemoryLedgerStore()
        )
    }

    private func inputTxids(_ hex: String) throws -> [String] {
        try Tx.parse(try Hex.decode(hex)).inputs.map(\.txid)
    }

    func testASecondSpendCannotReuseTheFirstsOutpoints() async throws {
        let aa = String(repeating: "aa", count: 32)
        let bb = String(repeating: "bb", count: 32)
        let chain = GuardChain(utxos: [
            ChainUtxo(txid: aa, vout: 0, value: 100_000, height: 1),
            ChainUtxo(txid: bb, vout: 0, value: 90_000, height: 1),
        ])
        let wallet = makeWallet(chain: chain)
        try await wallet.unlock()

        _ = try await wallet.send(to: recipient, sats: 30_000)
        _ = try await wallet.send(to: recipient, sats: 30_000)

        let broadcasts = await chain.broadcasts
        XCTAssertEqual(broadcasts.count, 2)
        XCTAssertEqual(try inputTxids(broadcasts[0]), [aa], "the largest first")
        XCTAssertEqual(try inputTxids(broadcasts[1]), [bb], "the in-flight output is not reused")

        do {
            _ = try await wallet.send(to: recipient, sats: 30_000)
            XCTFail("both outputs are in flight")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "INSUFFICIENT")
        }
    }

    func testAFailedTransactionReleasesItsOutpoints() async throws {
        let aa = String(repeating: "aa", count: 32)
        let chain = GuardChain(utxos: [ChainUtxo(txid: aa, vout: 0, value: 100_000, height: 1)])
        let wallet = makeWallet(chain: chain)
        try await wallet.unlock()

        _ = try await wallet.send(to: recipient, sats: 30_000)
        do {
            _ = try await wallet.send(to: recipient, sats: 30_000)
            XCTFail("the only output is in flight")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "INSUFFICIENT")
        }

        // The network drops it; the monitor marks it failed; the output is
        // spendable again without waiting for an index that never saw it.
        await chain.setStatus(TxStatusResult(status: .rejected, blockHeight: 0, competing: nil, detail: "double spend"))
        let changed = await wallet.refreshPendingTransactions()
        XCTAssertEqual(changed, 1)
        _ = try await wallet.send(to: recipient, sats: 30_000)
        let retries = await chain.broadcasts
        XCTAssertEqual(retries.count, 2, "the retry went out")
    }
}
