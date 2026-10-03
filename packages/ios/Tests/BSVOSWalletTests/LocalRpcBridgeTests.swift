import XCTest
@testable import BSVOSWallet

/// Item 2: the fetch("/") dispatcher for stock apps running from the bundle.
final class LocalRpcBridgeTests: XCTestCase {
    actor Chain: ChainProvider {
        nonisolated let name = "stub"
        private(set) var lastBroadcastHex: String?
        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: 100_000, unconfirmed: 0, utxos: [
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

    private func harness() -> (LocalRpcBridge, LocalWalletBackend, PolicyEngine, Chain) {
        let chain = Chain()
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
            chain: chain,
            policy: engine,
            ledger: InMemoryLedgerStore()
        )
        return (LocalRpcBridge(origin: "bsvos", wallet: wallet, chain: chain), wallet, engine, chain)
    }

    private func value(_ reply: RpcReply) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data((reply.result ?? "null").utf8))
    }

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

    func testSendIsPolicyGatedUnderTheAppOrigin() async throws {
        let (bridge, wallet, engine, chain) = harness()
        try await wallet.unlock()
        let params: [String: JSONValue] = ["to": .string("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"), "sats": .int(1_000)]

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
    }

    func testUnknownMethodsAreRefused() async throws {
        let (bridge, _, _, _) = harness()
        let reply = await bridge.call(id: 1, method: "sweepOut", params: [:])
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.errorCode, "NOT_ALLOWED")
    }
}
