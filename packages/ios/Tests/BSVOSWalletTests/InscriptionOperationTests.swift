import XCTest
@testable import BSVOSWallet

/// Item 3: the inscribe operation — envelope output, carrier-free funding,
/// policy gate under the app origin.
final class InscriptionOperationTests: XCTestCase {
    actor StubChain: ChainProvider {
        nonisolated let name = "stub"
        private let utxoList: [ChainUtxo]
        private let parents: [String: ChainTx]
        private(set) var lastBroadcastHex: String?

        init(utxos: [ChainUtxo], parents: [String: ChainTx]) {
            self.utxoList = utxos
            self.parents = parents
        }

        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: utxoList.reduce(0) { $0 + $1.value }, unconfirmed: 0, utxos: utxoList)
        }
        func broadcast(txHex: String) async throws -> BroadcastResult {
            lastBroadcastHex = txHex
            return BroadcastResult(txid: String(repeating: "cc", count: 32), status: .seen)
        }
        func status(txid: String) async throws -> TxStatusResult { TxStatusResult(status: .unknown, blockHeight: 0) }
        func tx(txid: String) async throws -> ChainTx? { parents[txid] }
    }

    private let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let recipient = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"

    private func harness() throws -> (LocalWalletBackend, PolicyEngine, StubChain, String, String) {
        let key = try BIP32.derive("m/0/0", from: BIP32.master(fromSeed: BIP39.seed(fromValidated: phrase)))
        let selfKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
        let selfAddress = Address.from(publicKey: selfKey)
        let selfScript = Hex.encode(try Address.lockingScript(for: selfAddress))
        let envelope = try Inscription.script(ownerAddress: recipient, contentType: "text/plain", dataHex: "6869")

        let plainTxid = String(repeating: "aa", count: 32)
        let carrierTxid = String(repeating: "bb", count: 32)
        let chain = StubChain(
            utxos: [
                ChainUtxo(txid: plainTxid, vout: 0, value: 100_000, height: 1),
                ChainUtxo(txid: carrierTxid, vout: 0, value: 90_000, height: 1),
            ],
            parents: [
                plainTxid: ChainTx(confirmations: 1, vin: [], vout: [ChainTx.Vout(value: 100_000, addresses: nil, scriptHex: selfScript)]),
                carrierTxid: ChainTx(confirmations: 1, vin: [], vout: [ChainTx.Vout(value: 90_000, addresses: nil, scriptHex: envelope)]),
            ]
        )
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: phrase), chain: chain, policy: engine, ledger: InMemoryLedgerStore()
        )
        return (wallet, engine, chain, selfScript, envelope)
    }

    func testInscribeSpendsOnlyPlainFundingAndMakesTheEnvelopeOutput() async throws {
        let (wallet, engine, chain, selfScript, envelope) = try harness()
        try await wallet.unlock()

        do {
            _ = try await wallet.appInscribe(origin: "app.example", to: recipient, contentType: "text/plain", dataHex: "6869")
            XCTFail("an unknown origin must not inscribe")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "POLICY_DENY")
            XCTAssertTrue(error.message.hasPrefix("denied: "))
        }
        let queued = try await engine.pendingRequests()
        XCTAssertEqual(queued.map(\.action), ["app-inscribe"])

        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 50_000)
        let result = try await wallet.appInscribe(origin: "app.example", to: recipient, contentType: "text/plain", dataHex: "6869")
        XCTAssertGreaterThan(result.fee, 0)

        let broadcastHex = await chain.lastBroadcastHex
        let hex = try XCTUnwrap(broadcastHex)
        let tx = try Tx.parse(try Hex.decode(hex))
        XCTAssertEqual(tx.inputs.map(\.txid), [String(repeating: "aa", count: 32)], "the carrier is never spent")
        XCTAssertEqual(tx.outputs.first?.sats, 1)
        XCTAssertEqual(Hex.encode(tx.outputs.first?.script ?? []), envelope)
        XCTAssertEqual(Hex.encode(tx.outputs.last?.script ?? []), selfScript, "change returns to the wallet")
    }

    func testInscribeRefusesWhenEverythingIsInscribed() async throws {
        let key = try BIP32.derive("m/0/0", from: BIP32.master(fromSeed: BIP39.seed(fromValidated: phrase)))
        let selfKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
        let carrierScript = try Inscription.script(ownerAddress: Address.from(publicKey: selfKey), contentType: "text/plain", dataHex: "6869")
        let txid = String(repeating: "bb", count: 32)
        let chain = StubChain(
            utxos: [ChainUtxo(txid: txid, vout: 0, value: 90_000, height: 1)],
            parents: [txid: ChainTx(confirmations: 1, vin: [], vout: [ChainTx.Vout(value: 90_000, addresses: nil, scriptHex: carrierScript)])]
        )
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: phrase), chain: chain,
            policy: PolicyEngine(store: InMemoryPolicyStore()), ledger: InMemoryLedgerStore()
        )
        try await wallet.unlock()
        do {
            _ = try await wallet.appInscribe(origin: "app.example", to: recipient, contentType: "text/plain", dataHex: "6869")
            XCTFail("nothing plain to spend")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "INSUFFICIENT")
        }
    }
}
