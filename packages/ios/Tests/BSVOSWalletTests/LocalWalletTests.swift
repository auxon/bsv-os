import XCTest
@testable import BSVOSWallet

/// S4: phrase generation, the vault, and the local backend.
///
/// Generation is pinned the same way S1 pinned derivation: the daemon generated
/// the expected words (`@scure/bip39`'s `entropyToMnemonic`, the call
/// `custody.ts` makes) and the Swift must produce the same phrase *and* the same
/// `m/0/0` address from it.
final class LocalWalletTests: XCTestCase {
    struct MnemonicVectors: Decodable {
        struct Vector: Decodable {
            let entropyHex: String
            let phrase: String
            let seedHex: String
            let privateKeyHex: String
            let publicKeyHex: String
            let address: String
        }
        let vectors: [Vector]
    }

    private func loadMnemonicVectors() throws -> MnemonicVectors {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/mnemonic-vectors.json")
        return try JSONDecoder().decode(MnemonicVectors.self, from: Data(contentsOf: url))
    }

    // MARK: - generation

    func testGeneratedPhrasesMatchTheDaemon() throws {
        let vectors = try loadMnemonicVectors().vectors
        XCTAssertEqual(vectors.count, 6)
        for vector in vectors {
            let entropy = try Hex.decode(vector.entropyHex)
            XCTAssertEqual(try BIP39.mnemonic(fromEntropy: entropy), vector.phrase, "words for \(vector.entropyHex)")
            XCTAssertNoThrow(try BIP39.validate(vector.phrase))

            let seed = try BIP39.seed(fromValidated: vector.phrase)
            XCTAssertEqual(Hex.encode(seed), vector.seedHex, "seed for \(vector.entropyHex)")

            let key = try BIP32.derive("m/0/0", from: BIP32.master(fromSeed: seed))
            XCTAssertEqual(Hex.encode(key.privateKey), vector.privateKeyHex, "private key for \(vector.entropyHex)")
            let publicKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
            XCTAssertEqual(Hex.encode(publicKey), vector.publicKeyHex, "public key for \(vector.entropyHex)")
            XCTAssertEqual(Address.from(publicKey: publicKey), vector.address, "address for \(vector.entropyHex)")
        }
    }

    func testGenerateProducesAValidPhrase() throws {
        let first = try BIP39.generate()
        let second = try BIP39.generate()
        XCTAssertNoThrow(try BIP39.validate(first))
        XCTAssertEqual(first.split(separator: " ").count, 12)
        XCTAssertNotEqual(first, second, "two calls should not agree by accident")

        let long = try BIP39.generate(wordCount: 24)
        XCTAssertNoThrow(try BIP39.validate(long))
        XCTAssertEqual(long.split(separator: " ").count, 24)
    }

    // MARK: - the vault

    func testVaultRoundTripsAndRejectsBadInput() throws {
        let vault = InMemorySeedVault()
        XCTAssertFalse(vault.hasPhrase)

        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        try vault.importPhrase(phrase)
        XCTAssertTrue(vault.hasPhrase)
        XCTAssertEqual(try vault.loadPhrase(), phrase)

        // Whitespace and case are normalised on the way in.
        let messy = "  LEGAL   winner thank year wave sausage worth useful legal winner thank yellow \n"
        try vault.importPhrase(messy)
        XCTAssertEqual(
            try vault.loadPhrase(),
            "legal winner thank year wave sausage worth useful legal winner thank yellow"
        )

        // A bad checksum is refused before it can replace the stored phrase.
        XCTAssertThrowsError(try vault.importPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"))
        XCTAssertEqual(
            try vault.loadPhrase(),
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
            "the previous phrase survives a rejected import"
        )
    }

    // MARK: - the backend

    actor StubChain: ChainProvider {
        nonisolated let name = "stub"
        private let utxosToReturn: AddressUtxos
        private let broadcastResult: BroadcastResult
        private let statusResult: TxStatusResult
        private(set) var lastBroadcastHex: String?
        private(set) var lastUtxoAddress: String?

        init(
            utxos: AddressUtxos = AddressUtxos(confirmed: 0, unconfirmed: 0, utxos: []),
            broadcast: BroadcastResult = BroadcastResult(txid: "stub", status: .seen),
            status: TxStatusResult = TxStatusResult(status: .unknown, blockHeight: 0)
        ) {
            self.utxosToReturn = utxos
            self.broadcastResult = broadcast
            self.statusResult = status
        }

        func utxos(address: String) async throws -> AddressUtxos {
            lastUtxoAddress = address
            return utxosToReturn
        }

        func broadcast(txHex: String) async throws -> BroadcastResult {
            lastBroadcastHex = txHex
            return broadcastResult
        }

        func status(txid: String) async throws -> TxStatusResult {
            statusResult
        }

        func tx(txid: String) async throws -> ChainTx? {
            nil
        }
    }

    private let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    private func derived() throws -> (address: String, scriptHex: String) {
        let key = try BIP32.derive("m/0/0", from: BIP32.master(fromSeed: BIP39.seed(fromValidated: phrase)))
        let publicKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
        let address = Address.from(publicKey: publicKey)
        return (address, Hex.encode(try Address.lockingScript(for: address)))
    }

    private func makeBackend(
        chain: StubChain,
        vault: InMemorySeedVault? = nil,
        policy: PolicyEngine? = nil,
        ledger: InMemoryLedgerStore = InMemoryLedgerStore()
    ) -> LocalWalletBackend {
        let seedVault = vault ?? InMemorySeedVault(phrase: phrase)
        let engine = policy ?? PolicyEngine(store: InMemoryPolicyStore())
        return LocalWalletBackend(vault: seedVault, chain: chain, policy: engine, ledger: ledger)
    }

    func testALockedWalletAnswersAsLocked() async throws {
        let backend = makeBackend(chain: StubChain())
        let status = try await backend.isAuthenticated()
        XCTAssertTrue(status.hasWallet)
        XCTAssertTrue(status.locked)
        XCTAssertTrue(status.authenticated)

        do {
            _ = try await backend.balance()
            XCTFail("balance should be refused while locked")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "WALLET_LOCKED")
        }
    }

    func testUnlockThenBalanceUsesTheDerivedAddress() async throws {
        let expected = try derived()
        let chain = StubChain(utxos: AddressUtxos(
            confirmed: 12_345,
            unconfirmed: 500,
            utxos: [
                ChainUtxo(txid: String(repeating: "aa", count: 32), vout: 0, value: 12_345, height: 800_000),
                ChainUtxo(txid: String(repeating: "bb", count: 32), vout: 1, value: 500, height: 0),
            ]
        ))
        let backend = makeBackend(chain: chain)
        try await backend.unlock()

        let balance = try await backend.balance()
        XCTAssertEqual(balance.address, expected.address)
        XCTAssertEqual(balance.confirmed, 12_345)
        XCTAssertEqual(balance.unconfirmed, 500)
        XCTAssertEqual(balance.utxos, 2)
        let asked = await chain.lastUtxoAddress
        XCTAssertEqual(asked, expected.address)
    }

    func testAWalletWithoutAPhraseRefusesToUnlock() async throws {
        let backend = makeBackend(chain: StubChain(), vault: InMemorySeedVault())
        let status = try await backend.isAuthenticated()
        XCTAssertFalse(status.hasWallet)
        XCTAssertTrue(status.locked)
        do {
            try await backend.unlock()
            XCTFail("there is nothing to unlock")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "NO_WALLET")
        }
    }

    func testSendBuildsSignsAndBroadcastsASpendableTransaction() async throws {
        let expected = try derived()
        let chain = StubChain(
            utxos: AddressUtxos(
                confirmed: 150_000,
                unconfirmed: 0,
                utxos: [
                    ChainUtxo(txid: String(repeating: "aa", count: 32), vout: 0, value: 100_000, height: 800_000),
                    ChainUtxo(txid: String(repeating: "bb", count: 32), vout: 3, value: 50_000, height: 800_001),
                ]
            ),
            broadcast: BroadcastResult(txid: String(repeating: "cc", count: 32), status: .seen, detail: nil)
        )
        let ledger = InMemoryLedgerStore()
        let backend = makeBackend(chain: chain, ledger: ledger)
        try await backend.unlock()

        let response = try await backend.send(to: "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA", sats: 120_000)
        XCTAssertEqual(response.txid, String(repeating: "cc", count: 32))
        XCTAssertGreaterThan(response.fee, 0)

        // The broadcast bytes parse, spend both inputs, pay the destination and
        // send change back to the wallet — and the arithmetic closes.
        let lastHex = await chain.lastBroadcastHex
        let hex = try XCTUnwrap(lastHex)
        let tx = try Tx.parse(try Hex.decode(hex))
        XCTAssertEqual(tx.inputs.count, 2)
        XCTAssertEqual(Set(tx.inputs.map(\.txid)), [String(repeating: "aa", count: 32), String(repeating: "bb", count: 32)])
        XCTAssertTrue(tx.inputs.allSatisfy { !$0.unlockingScript.isEmpty }, "every input is signed")

        let destination = Hex.encode(try Address.lockingScript(for: "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"))
        XCTAssertEqual(tx.outputs.first?.sats, 120_000)
        XCTAssertEqual(Hex.encode(tx.outputs.first?.script ?? []), destination)
        XCTAssertEqual(Hex.encode(tx.outputs.last?.script ?? []), expected.scriptHex, "change returns to the wallet")
        XCTAssertEqual(tx.outputs.reduce(0) { $0 + $1.sats } + response.fee, 150_000)

        // And the ledger remembers it as in flight.
        let rows = try await ledger.all()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.status, "seen")
        XCTAssertEqual(rows.first?.txid, response.txid)
    }

    func testSendSurfacesInsufficientFundsAsAWalletError() async throws {
        let chain = StubChain(utxos: AddressUtxos(
            confirmed: 500, unconfirmed: 0,
            utxos: [ChainUtxo(txid: String(repeating: "aa", count: 32), vout: 0, value: 500, height: 1)]
        ))
        let backend = makeBackend(chain: chain)
        try await backend.unlock()

        do {
            _ = try await backend.send(to: "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA", sats: 1_000)
            XCTFail("expected a funds error")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "INSUFFICIENT")
        }
    }

    func testThePendingMonitorMovesATransactionToMined() async throws {
        let chain = StubChain(status: TxStatusResult(status: .mined, blockHeight: 800_123))
        let ledger = InMemoryLedgerStore(seed: [
            LocalTx(txid: "dd", label: "send 1 sats", status: "seen", createdAt: 1, lastCheck: 1),
            LocalTx(txid: "ee", label: "send 2 sats", status: "mined", createdAt: 2, lastCheck: 2),
        ])
        let backend = makeBackend(chain: chain, ledger: ledger)
        try await backend.unlock()

        let changed = await backend.refreshPendingTransactions()
        XCTAssertEqual(changed, 1, "only the in-flight row is rechecked")

        let rows = try await ledger.all()
        XCTAssertEqual(rows.first { $0.txid == "dd" }?.status, "mined")
        XCTAssertEqual(rows.first { $0.txid == "dd" }?.attempts, 1)
        XCTAssertEqual(rows.first { $0.txid == "ee" }?.attempts, 0, "a mined row is left alone")
    }

    func testPolicySurfacesMapBothWays() async throws {
        let store = InMemoryPolicyStore()
        let engine = PolicyEngine(store: store)
        let backend = makeBackend(chain: StubChain(), policy: engine)

        // An app-originated spend of zero (so no advisor is needed) queues.
        _ = try await engine.check(origin: "app.example", amountSats: 0, action: "send")
        let pending = try await backend.policyPending()
        XCTAssertEqual(pending.requests.count, 1)
        XCTAssertEqual(pending.requests.first?.origin, "app.example")
        XCTAssertEqual(pending.requests.first?.action, "send")

        let approved = try await backend.policyApprove(origin: "app.example", capSats: 2_000)
        XCTAssertEqual(approved.mode, "allow")
        let policies = try await backend.policyList()
        XCTAssertEqual(policies.policies.map(\.origin), ["app.example"])
        XCTAssertEqual(policies.policies.first?.spendCapSats, 2_000)
        let afterApproval = try await backend.policyPending()
        XCTAssertEqual(afterApproval.requests.count, 0, "approval clears the queue")

        _ = try await backend.policyDeny(origin: "bad.example")
        let history = try await backend.history()
        XCTAssertEqual(history.policies.count, 2)
        XCTAssertEqual(history.summary.allowedOrigins, 1)
        XCTAssertEqual(history.summary.deniedOrigins, 1)
    }

    func testHistoryCountsAndHints() async throws {
        let ledger = InMemoryLedgerStore(seed: [
            LocalTx(txid: "aa", label: "send 10 sats", status: "seen", createdAt: 3, lastCheck: 3),
            LocalTx(txid: "bb", label: "send 20 sats", status: "mined", createdAt: 2, lastCheck: 2),
            LocalTx(txid: "cc", label: "send 30 sats", status: "failed", detail: "double spend", createdAt: 1, lastCheck: 1),
        ])
        let backend = makeBackend(chain: StubChain(), ledger: ledger)
        let history = try await backend.history()

        XCTAssertEqual(history.transactions.map(\.txid), ["aa", "bb", "cc"], "newest first")
        XCTAssertEqual(history.summary.inFlight, 1)
        XCTAssertEqual(history.summary.mined, 1)
        XCTAssertEqual(history.summary.failed, 1)
        XCTAssertEqual(history.transactions.first?.hint, "in mempool — the wallet rechecks while the app is open")
        XCTAssertEqual(history.transactions[1].hint, "confirmed on-chain")
        XCTAssertTrue(history.transactions[2].hint?.contains("nothing moved") == true)
    }

    func testCreateWalletStoresAUsablePhrase() async throws {
        let vault = InMemorySeedVault()
        let backend = makeBackend(chain: StubChain(), vault: vault)

        let created = try await backend.createWallet()
        XCTAssertNoThrow(try BIP39.validate(created))
        let stored = try vault.loadPhrase()
        XCTAssertEqual(stored, created)
        let status = try await backend.isAuthenticated()
        XCTAssertTrue(status.hasWallet)
    }

    // MARK: - launch precedence

    func testLaunchModePrefersTheLocalWallet() {
        // A phone with both must not silently spend from the other wallet.
        XCTAssertEqual(WalletLaunchMode.decide(hasLocalPhrase: true, hasDaemonCredential: true), .standalone)
        XCTAssertEqual(WalletLaunchMode.decide(hasLocalPhrase: true, hasDaemonCredential: false), .standalone)
        XCTAssertEqual(WalletLaunchMode.decide(hasLocalPhrase: false, hasDaemonCredential: true), .daemon)
        XCTAssertEqual(WalletLaunchMode.decide(hasLocalPhrase: false, hasDaemonCredential: false), .unconfigured)
    }
}
