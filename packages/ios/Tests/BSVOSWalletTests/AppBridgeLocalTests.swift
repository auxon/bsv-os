import XCTest
@testable import BSVOSWallet

/// S5: `window.bsv` answered by the phone's own wallet.
///
/// The bridge's rules were already tested; these tests are about the backend —
/// that the daemon's result shapes come back, that a spend is gated under the
/// app's *own* origin (so its cap and queue are where they would be on the
/// desktop), and that intents the phone cannot honestly serve fail closed.
final class AppBridgeLocalTests: XCTestCase {
    actor BridgeChain: ChainProvider {
        nonisolated let name = "bridge-stub"
        private let utxosToReturn: AddressUtxos
        private(set) var lastBroadcastHex: String?

        init(utxos: AddressUtxos) {
            self.utxosToReturn = utxos
        }

        func utxos(address: String) async throws -> AddressUtxos {
            utxosToReturn
        }

        func broadcast(txHex: String) async throws -> BroadcastResult {
            lastBroadcastHex = txHex
            return BroadcastResult(txid: String(repeating: "cc", count: 32), status: .seen)
        }

        func status(txid: String) async throws -> TxStatusResult {
            TxStatusResult(status: .unknown, blockHeight: 0)
        }

        func tx(txid: String) async throws -> ChainTx? {
            nil
        }
    }

    private let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let destination = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"

    private struct Harness {
        let backend: LocalAppBridgeBackend
        let engine: PolicyEngine
        let wallet: LocalWalletBackend
        let chain: BridgeChain
        let ledger: InMemoryLedgerStore
    }

    private func makeHarness(utxos: AddressUtxos? = nil) -> Harness {
        let chain = BridgeChain(utxos: utxos ?? AddressUtxos(
            confirmed: 100_000,
            unconfirmed: 0,
            utxos: [ChainUtxo(txid: String(repeating: "aa", count: 32), vout: 0, value: 100_000, height: 800_000)]
        ))
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let ledger = InMemoryLedgerStore()
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: phrase),
            chain: chain,
            policy: engine,
            ledger: ledger
        )
        return Harness(
            backend: LocalAppBridgeBackend(wallet: wallet, chain: chain),
            engine: engine,
            wallet: wallet,
            chain: chain,
            ledger: ledger
        )
    }

    private func decoded(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    // MARK: - reads

    func testReadsMatchTheDaemonShapes() async throws {
        let harness = makeHarness()
        try await harness.wallet.unlock()

        let status = try await decoded(harness.backend.invoke(app: "app.example", intent: .getStatus, params: [:]))
        XCTAssertEqual(status, .object([
            "authenticated": .bool(true),
            "locked": .bool(false),
            "hasWallet": .bool(true),
        ]))

        // The daemon's identity key is the master public key of the same
        // phrase (custody.identityOf), so both front ends show one identity.
        let master = try BIP32.master(fromSeed: BIP39.seed(fromValidated: phrase))
        let expectedIdentity = Hex.encode(try Secp256k1.publicKey(fromPrivateKey: master.privateKey))
        let identity = try await decoded(harness.backend.invoke(app: "app.example", intent: .getIdentity, params: [:]))
        XCTAssertEqual(identity, .object([
            "identityKey": .string(expectedIdentity),
            "locked": .bool(false),
        ]))

        let balance = try await decoded(harness.backend.invoke(app: "app.example", intent: .getBalance, params: [:]))
        guard case .object(let balanceObject) = balance else { return XCTFail("balance is not an object") }
        XCTAssertEqual(balanceObject["confirmed"], .int(100_000))
        XCTAssertEqual(balanceObject["unconfirmed"], .int(0))
        XCTAssertEqual(balanceObject["utxos"], .int(1))
        let derivedAddress = balanceObject["address"]?.stringValue
        XCTAssertNotNil(derivedAddress)

        let utxos = try await decoded(harness.backend.invoke(app: "app.example", intent: .getUtxos, params: [:]))
        guard case .object(let utxoObject) = utxos,
              case .array(let list)? = utxoObject["utxos"],
              case .object(let first)? = list.first else {
            return XCTFail("utxos shape unexpected: \(utxos)")
        }
        XCTAssertEqual(utxoObject["address"]?.stringValue, derivedAddress)
        XCTAssertEqual(first["txid"], .string(String(repeating: "aa", count: 32)))
        XCTAssertEqual(first["vout"], .int(0))
        XCTAssertEqual(first["value"], .int(100_000))
        XCTAssertEqual(first["height"], .int(800_000))
    }

    // MARK: - the gated write

    func testSpendIsGatedUnderTheAppsOwnOrigin() async throws {
        let harness = makeHarness()
        try await harness.wallet.unlock()

        let spendParams: [String: JSONValue] = [
            "payments": .array([.object(["to": .string(destination), "sats": .int(1_000)])]),
            "memo": .array([.string("tip")]),
        ]

        // Unknown origin: refused, and the request is queued under the app so
        // the human can approve it in Policy.
        do {
            _ = try await harness.backend.invoke(app: "app.example", intent: .spend, params: spendParams)
            XCTFail("an unknown origin should not spend")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "POLICY_DENY")
            XCTAssertTrue(error.message.contains("first-run approval required"))
        }
        let pending = try await harness.engine.pendingRequests()
        XCTAssertEqual(pending.map(\.origin), ["app.example"])
        let broadcastBeforeApproval = await harness.chain.lastBroadcastHex
        XCTAssertNil(broadcastBeforeApproval, "nothing was broadcast")

        // The human approves with a cap; the same call now spends.
        try await harness.engine.setPolicy(origin: "app.example", mode: .allow, capSats: 50_000)
        let result = try await harness.backend.invoke(app: "app.example", intent: .spend, params: spendParams)
        guard case .object(let object) = try decoded(result) else { return XCTFail("result is not an object") }
        XCTAssertEqual(object["txid"], .string(String(repeating: "cc", count: 32)))
        XCTAssertNotNil(object["fee"]?.intValue)

        // The spend is signed, pays the destination, and is labelled with the
        // action the policy gate saw.
        let hex = await harness.chain.lastBroadcastHex
        let tx = try Tx.parse(try Hex.decode(try XCTUnwrap(hex)))
        XCTAssertEqual(tx.inputs.count, 1)
        XCTAssertEqual(tx.outputs.first?.sats, 1_000)

        let rows = try await harness.ledger.all()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.label, "tip")
        XCTAssertEqual(rows.first?.status, "seen")
    }

    func testTheAppsCapBinds() async throws {
        let harness = makeHarness()
        try await harness.wallet.unlock()
        try await harness.engine.setPolicy(origin: "app.example", mode: .allow, capSats: 100)

        do {
            _ = try await harness.backend.invoke(app: "app.example", intent: .spend, params: [
                "payments": .array([.object(["to": .string(destination), "sats": .int(500)])]),
            ])
            XCTFail("over the cap should not spend")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "POLICY_DENY")
            XCTAssertEqual(error.message, "over spend cap (100 sats)")
        }
    }

    // MARK: - the honest refusals

    func testUnsupportedIntentsFailClosed() async throws {
        let harness = makeHarness()
        try await harness.wallet.unlock()

        for intent in [AppIntent.signSwapOffer, .completeSwap, .ordlockLock, .ordlockBuy, .ordlockCancel] {
            do {
                _ = try await harness.backend.invoke(app: "app.example", intent: intent, params: [:])
                XCTFail("\(intent.rawValue) should be unavailable on the phone")
            } catch let error as WalletError {
                XCTAssertEqual(error.code, "UNAVAILABLE", intent.rawValue)
                XCTAssertTrue(error.message.contains(intent.rawValue))
            }
        }
    }

    func testSpendWithoutAWalletIsRefused() async throws {
        let chain = BridgeChain(utxos: AddressUtxos(confirmed: 0, unconfirmed: 0, utxos: []))
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(),
            chain: chain,
            policy: PolicyEngine(store: InMemoryPolicyStore()),
            ledger: InMemoryLedgerStore()
        )
        let backend = LocalAppBridgeBackend(wallet: wallet, chain: chain)
        do {
            _ = try await backend.invoke(app: "app.example", intent: .getBalance, params: [:])
            XCTFail("no wallet, no balance")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "NO_WALLET")
        }
    }

    func testSpendRequiresUnlocked() async throws {
        let harness = makeHarness()
        do {
            _ = try await harness.backend.invoke(app: "app.example", intent: .spend, params: [
                "payments": .array([.object(["to": .string(destination), "sats": .int(1_000)])]),
            ])
            XCTFail("locked means no spend")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "WALLET_LOCKED")
        }
    }
}
