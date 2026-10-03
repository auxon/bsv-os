import XCTest
@testable import BSVOSWallet

/// Item 2: the fetch("/") dispatcher for stock apps running from the bundle,
/// now covering the wallet-core methods the desktop shell calls.
final class LocalRpcBridgeTests: XCTestCase {
    actor Chain: ChainProvider {
        nonisolated let name = "stub"
        private(set) var lastBroadcastHex: String?
        var utxoList = [
            ChainUtxo(txid: String(repeating: "aa", count: 32), vout: 0, value: 100_000, height: 1),
        ]
        var parents: [String: ChainTx] = [:]

        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: utxoList.reduce(0) { $0 + $1.value }, unconfirmed: 0, utxos: utxoList)
        }
        func broadcast(txHex: String) async throws -> BroadcastResult {
            lastBroadcastHex = txHex
            return BroadcastResult(txid: String(repeating: "cc", count: 32), status: .seen)
        }
        func status(txid: String) async throws -> TxStatusResult { TxStatusResult(status: .unknown, blockHeight: 0) }
        func tx(txid: String) async throws -> ChainTx? { parents[txid] }
        func setUtxos(_ utxos: [ChainUtxo]) { utxoList = utxos }
        func setParents(_ parents: [String: ChainTx]) { self.parents = parents }
    }

    actor Metadata: InscriptionMetadata {
        var entries: [String: InscriptionMeta] = [:]
        func isInscribed(txid: String, vout: Int) async throws -> Bool { entries["\(txid):\(vout)"] != nil }
        func metadata(txid: String, vout: Int) async throws -> InscriptionMeta? { entries["\(txid):\(vout)"] }
        func set(_ meta: InscriptionMeta, txid: String, vout: Int) { entries["\(txid):\(vout)"] = meta }
    }

    private func harness(
        inscriptions: any InscriptionMetadata = Metadata()
    ) -> (LocalRpcBridge, LocalWalletBackend, PolicyEngine, Chain) {
        let chain = Chain()
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
            chain: chain,
            policy: engine,
            ledger: InMemoryLedgerStore(),
            inscriptions: inscriptions
        )
        return (LocalRpcBridge(origin: "bsvos", wallet: wallet, chain: chain), wallet, engine, chain)
    }

    private func value(_ reply: RpcReply) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data((reply.result ?? "null").utf8))
    }

    private let destination = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"

    func testReadsAnswerFromTheLocalWallet() async throws {
        let (bridge, wallet, _, _) = harness()
        var reply = await bridge.call(id: 1, method: "getStatus", params: [:])
        XCTAssertTrue(reply.ok)
        let status = try value(reply)
        XCTAssertEqual(status, .object(["authenticated": .bool(false), "locked": .bool(true), "hasWallet": .bool(true)]))

        try await wallet.unlock()
        reply = await bridge.call(id: 2, method: "getBalance", params: [:])
        guard case .object(let balance)? = try? value(reply) else { return XCTFail("balance shape") }
        XCTAssertEqual(balance["confirmed"], .int(100_000))
        XCTAssertEqual(balance["utxos"], .int(1))

        reply = await bridge.call(id: 3, method: "getUtxos", params: [:])
        guard case .object(let utxos)? = try? value(reply), case .array(let list)? = utxos["utxos"] else {
            return XCTFail("utxos shape")
        }
        XCTAssertEqual(list.count, 1)

        reply = await bridge.call(id: 4, method: "history", params: [:])
        guard case .object(let history)? = try? value(reply) else { return XCTFail("history shape") }
        XCTAssertNotNil(history["transactions"])
    }

    func testTheDaemonSpellingsOfTheCoreReadsWork() async throws {
        let (bridge, wallet, _, _) = harness()
        try await wallet.unlock()

        var reply = await bridge.call(id: 1, method: "isAuthenticated", params: [:])
        guard case .object(let status)? = try? value(reply) else { return XCTFail("isAuthenticated shape") }
        XCTAssertEqual(status["authenticated"], .bool(true))

        reply = await bridge.call(id: 2, method: "balance", params: [:])
        guard case .object(let balance)? = try? value(reply) else { return XCTFail("balance shape") }
        XCTAssertEqual(balance["confirmed"], .int(100_000))

        reply = await bridge.call(id: 3, method: "addressQr", params: [:])
        guard case .object(let qr)? = try? value(reply),
              case .string(let address)? = qr["address"],
              case .string(let dataUrl)? = qr["dataUrl"] else { return XCTFail("addressQr shape") }
        XCTAssertEqual(JSONValue.string(address), balance["address"])
        XCTAssertTrue(dataUrl.hasPrefix("data:image/png;base64,"))

        reply = await bridge.call(id: 4, method: "getVersion", params: [:])
        guard case .object(let version)? = try? value(reply) else { return XCTFail("getVersion shape") }
        XCTAssertEqual(version["brc100"], .bool(true))
        XCTAssertEqual(version["standalone"], .bool(true))
    }

    func testSendIsPolicyGatedUnderTheAppOrigin() async throws {
        let (bridge, wallet, engine, chain) = harness()
        try await wallet.unlock()
        let params: [String: JSONValue] = ["to": .string(destination), "sats": .int(1_000)]

        var reply = await bridge.call(id: 1, method: "send", params: params)
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.errorCode, "POLICY_DENY")
        let pending = try await engine.pendingRequests()
        XCTAssertEqual(pending.map(\.origin), ["bsvos"])

        try await engine.setPolicy(origin: "bsvos", mode: .allow, capSats: 10_000)
        reply = await bridge.call(id: 2, method: "send", params: params)
        XCTAssertTrue(reply.ok, reply.errorMessage ?? "")
        let hex = await chain.lastBroadcastHex
        XCTAssertNotNil(hex)

        // The label the shell sent is the one the gate saw.
        let rows = try await wallet.history()
        XCTAssertEqual(rows.transactions.first?.label ?? "", "send 1000 sats")
    }

    func testPendingAndHistoryUseTheDaemonsFieldNames() async throws {
        let (bridge, wallet, engine, _) = harness()
        try await wallet.unlock()
        try await engine.setPolicy(origin: "bsvos", mode: .allow, capSats: 10_000)
        _ = try await bridge.call(id: 1, method: "send", params: [
            "to": .string(destination), "sats": .int(500), "label": .string("tip"),
        ])

        var reply = await bridge.call(id: 2, method: "pending", params: [:])
        guard case .object(let pending)? = try? value(reply),
              case .array(let tracked)? = pending["tracked"] else { return XCTFail("pending shape") }
        XCTAssertEqual(tracked.count, 1)
        guard case .object(let row) = tracked[0] else { return XCTFail("tracked row") }
        XCTAssertEqual(row["label"], .string("tip"))
        XCTAssertNotNil(row["last_check"], "the shell reads snake_case")

        reply = await bridge.call(id: 3, method: "history", params: [:])
        guard case .object(let history)? = try? value(reply),
              case .array(let transactions)? = history["transactions"] else { return XCTFail("history shape") }
        guard case .object(let tx) = transactions[0] else { return XCTFail("transaction row") }
        XCTAssertNotNil(tx["created_at"], "the shell's timeAgo reads created_at")
        XCTAssertEqual(tx["status"], .string("seen"))
        XCTAssertNotNil(history["summary"])
        XCTAssertNotNil(history["baskets"])
    }

    func testPolicyMutationsMatchTheDaemonShapes() async throws {
        let (bridge, _, engine, _) = harness()
        try await bridge.call(id: 1, method: "policyApprove", params: [
            "origin": .string("app.example"), "capSats": .int(1_000), "auto": .bool(false),
        ])
        var policies = try await engine.listPolicies()
        guard let allow = policies.first(where: { $0.origin == "app.example" }) else { return XCTFail("approved row") }
        XCTAssertEqual(allow.mode.rawValue, "allow")
        XCTAssertEqual(allow.spendCapSats, 1_000)

        let autoReply = await bridge.call(id: 2, method: "policyApprove", params: [
            "origin": .string("auto.example"), "capSats": .int(0), "auto": .bool(true),
        ])
        guard case .object(let approved)? = try? value(autoReply) else { return XCTFail("approve shape") }
        XCTAssertEqual(approved["mode"], .string("auto"))
        policies = try await engine.listPolicies()
        XCTAssertTrue(policies.contains { $0.origin == "auto.example" && $0.mode.rawValue == "auto" })

        let denyReply = await bridge.call(id: 3, method: "policyDeny", params: ["origin": .string("bad.example")])
        guard case .object(let denied)? = try? value(denyReply) else { return XCTFail("deny shape") }
        XCTAssertEqual(denied["mode"], .string("deny"))
    }

    func testOrdListFindsEnvelopesAndORDFSCarriers() async throws {
        let metadata = Metadata()
        let (bridge, wallet, _, chain) = harness(inscriptions: metadata)
        try await wallet.unlock()
        let selfAddress = try await wallet.balance().address
        let selfScript = Hex.encode(try Address.lockingScript(for: selfAddress))

        let inscribed = String(repeating: "dd", count: 32)
        let transferred = String(repeating: "ee", count: 32)
        let envelope = try Inscription.script(ownerAddress: selfAddress, contentType: "image/png", dataHex: "00ff")
        await chain.setUtxos([
            ChainUtxo(txid: inscribed, vout: 0, value: 1, height: 1),
            ChainUtxo(txid: transferred, vout: 1, value: 1, height: 1),
            ChainUtxo(txid: String(repeating: "bb", count: 32), vout: 0, value: 50_000, height: 1),
        ])
        await chain.setParents([
            inscribed: ChainTx(confirmations: 1, vin: [], vout: [
                .init(value: 1, addresses: nil, scriptHex: envelope),
            ]),
            transferred: ChainTx(confirmations: 1, vin: [], vout: [
                .init(value: 1, addresses: nil, scriptHex: selfScript),
                .init(value: 1, addresses: nil, scriptHex: selfScript),
            ]),
        ])
        await metadata.set(InscriptionMeta(contentType: "application/json", contentLength: 42), txid: transferred, vout: 1)

        let reply = await bridge.call(id: 1, method: "ordList", params: [:])
        guard case .object(let object)? = try? value(reply),
              case .array(let ordinals)? = object["ordinals"] else { return XCTFail("ordList shape") }
        XCTAssertEqual(ordinals.count, 2)
        guard case .object(let first) = ordinals[0], case .object(let second) = ordinals[1] else {
            return XCTFail("ordinal rows")
        }
        XCTAssertEqual(first["outpoint"], .string("\(inscribed)_0"))
        XCTAssertEqual(first["contentType"], .string("image/png"))
        XCTAssertEqual(first["contentLength"], .int(2))
        XCTAssertEqual(second["outpoint"], .string("\(transferred)_1"))
        XCTAssertEqual(second["contentType"], .string("application/json"))
        XCTAssertEqual(second["contentLength"], .int(42))
        guard case .string(let url)? = first["contentUrl"] else { return XCTFail("contentUrl") }
        XCTAssertTrue(url.hasSuffix("/content/\(inscribed)_0"))
    }

    func testDoctorReportsTheChecksAPhoneCanAnswer() async throws {
        let (bridge, _, _, _) = harness()
        let reply = await bridge.call(id: 1, method: "doctor", params: [:])
        guard case .object(let object)? = try? value(reply),
              case .array(let checks)? = object["checks"] else { return XCTFail("doctor shape") }
        XCTAssertEqual(checks.count, 3)
        let ids = checks.compactMap { check -> String? in
            guard case .object(let row) = check, case .string(let id)? = row["id"] else { return nil }
            return id
        }
        XCTAssertEqual(ids, ["wallet", "caps", "requests"])
    }

    func testPagesCannotTouchTheSessionSweepOrRegistry() async throws {
        let (bridge, _, _, _) = harness()
        for (method, fragment) in [
            ("unlock", "session lock"),
            ("lock", "session lock"),
            ("sweepOut", "terminal-only"),
            ("appList", "Apps tab"),
            ("appLaunch", "Apps tab"),
            ("storeList", "Apps tab"),
        ] {
            let reply = await bridge.call(id: 1, method: method, params: [:])
            XCTAssertFalse(reply.ok, method)
            XCTAssertEqual(reply.errorCode, "NOT_ALLOWED", method)
            XCTAssertTrue(reply.errorMessage?.contains(fragment) == true, method)
        }
    }

    func testUnknownMethodsAreRefused() async throws {
        let (bridge, _, _, _) = harness()
        let reply = await bridge.call(id: 1, method: "torrentList", params: [:])
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.errorCode, "NOT_ALLOWED")
    }
}
