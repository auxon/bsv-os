import XCTest
@testable import BSVOSWallet

/// The chain client's parsers, pinned against canned payloads shaped like the
/// real ARC and WhatsOnChain responses. No network in tests; the transport is
/// the seam.
final class ChainTests: XCTestCase {
    // MARK: - doubles

    final class MockTransport: ChainTransport, @unchecked Sendable {
        struct Response {
            var data: Data
            var code: Int
        }
        var getResponses: [String: Response] = [:]
        var postResponses: [String: Response] = [:]
        private(set) var requested: [(method: String, url: String)] = []

        static func json(_ raw: String, code: Int = 200) -> Response {
            Response(data: Data(raw.utf8), code: code)
        }

        func get(_ url: URL) async throws -> (Data, Int) {
            requested.append(("GET", url.absoluteString))
            guard let response = getResponses[url.absoluteString] else { throw URLError(.badURL) }
            return (response.data, response.code)
        }

        func post(_ url: URL, jsonBody: Data) async throws -> (Data, Int) {
            requested.append(("POST", url.absoluteString))
            guard let response = postResponses[url.absoluteString] else { throw URLError(.badURL) }
            return (response.data, response.code)
        }
    }

    struct StubChain: ChainReader {
        var name = "stub"
        var utxosResult: Result<AddressUtxos, Error> = .success(AddressUtxos(confirmed: 0, unconfirmed: 0, utxos: []))
        var txResult: Result<ChainTx?, Error> = .success(nil)

        func utxos(address: String) async throws -> AddressUtxos {
            try utxosResult.get()
        }
        func tx(txid: String) async throws -> ChainTx? {
            try txResult.get()
        }
    }

    // MARK: - ARC

    func testArcBroadcastParsesTheTxidAndMapsTheStatus() async throws {
        let transport = MockTransport()
        transport.postResponses["https://arc.gorillapool.io/v1/tx"] = MockTransport.json(
            #"{"txid":"ab12","txStatus":"SEEN_ON_NETWORK","extraInfo":"queued"}"#
        )
        let arc = ArcProvider(transport: transport)

        let result = try await arc.broadcast(txHex: "01000000")
        XCTAssertEqual(result.txid, "ab12")
        XCTAssertEqual(result.status, .seen)
        XCTAssertEqual(result.detail, "queued")
        XCTAssertEqual(transport.requested.first?.method, "POST")
    }

    func testArcBroadcastRejectionSurfacesTheReason() async throws {
        let transport = MockTransport()
        transport.postResponses["https://arc.gorillapool.io/v1/tx"] = MockTransport.json(
            #"{"detail":"bad-txns-inputs-missingorspent"}"#, code: 400
        )
        let arc = ArcProvider(transport: transport)

        do {
            _ = try await arc.broadcast(txHex: "01000000")
            XCTFail("expected a rejection")
        } catch let ChainError.broadcastRejected(detail) {
            XCTAssertEqual(detail, "bad-txns-inputs-missingorspent")
        }
    }

    func testArcBroadcastNonJSONBodyStillThrowsAReadableError() async throws {
        let transport = MockTransport()
        transport.postResponses["https://arc.gorillapool.io/v1/tx"] = MockTransport.json("<html>gateway</html>", code: 502)
        let arc = ArcProvider(transport: transport)

        do {
            _ = try await arc.broadcast(txHex: "01000000")
            XCTFail("expected a rejection")
        } catch let ChainError.broadcastRejected(detail) {
            XCTAssertEqual(detail, "502")
        }
    }

    /// Every branch of the daemon's mapping, including the case fold.
    func testArcStatusMappingCoversEveryBranch() {
        XCTAssertEqual(ArcProvider.mapStatus("MINED"), .mined)
        XCTAssertEqual(ArcProvider.mapStatus("accepted"), .seen)
        XCTAssertEqual(ArcProvider.mapStatus("seen_on_network"), .seen)
        XCTAssertEqual(ArcProvider.mapStatus("SENT_TO_NETWORK"), .seen)
        XCTAssertEqual(ArcProvider.mapStatus("REJECTED"), .rejected)
        XCTAssertEqual(ArcProvider.mapStatus("DOUBLE_SPEND"), .rejected)
        XCTAssertEqual(ArcProvider.mapStatus(nil), .unknown)
        XCTAssertEqual(ArcProvider.mapStatus("SOMETHING_NEW"), .unknown)
    }

    func testArcStatusReadsHeightAndCompetingTxs() async throws {
        let transport = MockTransport()
        transport.getResponses["https://arc.gorillapool.io/v1/tx/deadbeef"] = MockTransport.json(
            #"{"txStatus":"MINED","blockHeight":812345,"competingTxs":["aa","bb"],"extraInfo":"ok"}"#
        )
        let arc = ArcProvider(transport: transport)

        let result = try await arc.status(txid: "deadbeef")
        XCTAssertEqual(result.status, .mined)
        XCTAssertEqual(result.blockHeight, 812345)
        XCTAssertEqual(result.competing, ["aa", "bb"])
        XCTAssertEqual(result.detail, "ok")
    }

    func testArcStatusReturnsUnknownWhenTheEndpointDislikesTheTxid() async throws {
        let transport = MockTransport()
        transport.getResponses["https://arc.gorillapool.io/v1/tx/nope"] = MockTransport.json("{}", code: 404)
        let arc = ArcProvider(transport: transport)

        let result = try await arc.status(txid: "nope")
        XCTAssertEqual(result, TxStatusResult(status: .unknown, blockHeight: 0))
    }

    // MARK: - WhatsOnChain

    func testWocUtxosParsesTheListAndTheBalance() async throws {
        let transport = MockTransport()
        let base = "https://api.whatsonchain.com/v1/bsv/main/address/1Example"
        transport.getResponses[base + "/unspent"] = MockTransport.json(
            #"[{"height":800001,"tx_pos":0,"tx_hash":"aa11","value":546},{"height":0,"tx_pos":2,"tx_hash":"bb22","value":1000}]"#
        )
        transport.getResponses[base + "/balance"] = MockTransport.json(#"{"confirmed":546,"unconfirmed":1000}"#)
        let woc = WocProvider(transport: transport)

        let result = try await woc.utxos(address: "1Example")
        XCTAssertEqual(result.confirmed, 546)
        XCTAssertEqual(result.unconfirmed, 1000)
        XCTAssertEqual(result.utxos, [
            ChainUtxo(txid: "aa11", vout: 0, value: 546, height: 800001),
            ChainUtxo(txid: "bb22", vout: 2, value: 1000, height: 0),
        ])
    }

    /// A non-OK read is an empty address, not a failed call — the daemon's
    /// choice, kept because a fresh address is a normal state.
    func testWocUtxosTreatsNonOKReadsAsEmpty() async throws {
        let transport = MockTransport()
        let base = "https://api.whatsonchain.com/v1/bsv/main/address/1Empty"
        transport.getResponses[base + "/unspent"] = MockTransport.json(#"{"error":"not found"}"#, code: 404)
        transport.getResponses[base + "/balance"] = MockTransport.json("", code: 500)
        let woc = WocProvider(transport: transport)

        let result = try await woc.utxos(address: "1Empty")
        XCTAssertEqual(result, AddressUtxos(confirmed: 0, unconfirmed: 0, utxos: []))
    }

    func testWocTransactionParsesVinVoutAndAddresses() async throws {
        let transport = MockTransport()
        transport.getResponses["https://api.whatsonchain.com/v1/bsv/main/tx/hash/ff00"] = MockTransport.json(
            #"{"confirmations":3,"vin":[{"txid":"cc","vout":1}],"vout":[{"value":5000,"scriptPubKey":{"addresses":["1Dest"]}}]}"#
        )
        let woc = WocProvider(transport: transport)

        let tx = try await woc.tx(txid: "ff00")
        XCTAssertEqual(tx, ChainTx(
            confirmations: 3,
            vin: [ChainTx.Vin(txid: "cc", vout: 1)],
            vout: [ChainTx.Vout(value: 5000, addresses: ["1Dest"])]
        ))
    }

    func testWocTransactionIsNilWhenUnknown() async throws {
        let transport = MockTransport()
        transport.getResponses["https://api.whatsonchain.com/v1/bsv/main/tx/hash/ghost"] = MockTransport.json("", code: 404)
        let woc = WocProvider(transport: transport)
        let ghost = try await woc.tx(txid: "ghost")
        XCTAssertNil(ghost)
    }

    // MARK: - combined

    func testCombinedSendsWritesToArcAndReadsToWoc() async throws {
        let transport = MockTransport()
        transport.postResponses["https://arc.gorillapool.io/v1/tx"] = MockTransport.json(#"{"txid":"1a","txStatus":"ACCEPTED"}"#)
        transport.getResponses["https://arc.gorillapool.io/v1/tx/1a"] = MockTransport.json(#"{"txStatus":"MINED","blockHeight":9}"#)
        transport.getResponses["https://api.whatsonchain.com/v1/bsv/main/address/1A/unspent"] = MockTransport.json("[]")
        transport.getResponses["https://api.whatsonchain.com/v1/bsv/main/address/1A/balance"] = MockTransport.json(#"{"confirmed":0,"unconfirmed":0}"#)
        let combined = CombinedProvider(
            write: ArcProvider(transport: transport),
            read: WocProvider(transport: transport)
        )

        let broadcast = try await combined.broadcast(txHex: "00")
        XCTAssertEqual(broadcast.txid, "1a")
        let arcStatus = try await combined.status(txid: "1a")
        XCTAssertEqual(arcStatus.status, .mined)
        _ = try await combined.utxos(address: "1A")

        let hosts = transport.requested.map { ($0.method, URL(string: $0.url)?.host ?? "") }
        XCTAssertEqual(hosts.map(\.0), ["POST", "GET", "GET", "GET"])
        XCTAssertEqual(hosts[0].1, "arc.gorillapool.io")
        XCTAssertEqual(hosts[1].1, "arc.gorillapool.io")
        XCTAssertEqual(hosts[2].1, "api.whatsonchain.com")
        XCTAssertEqual(hosts[3].1, "api.whatsonchain.com")
    }

    // MARK: - resolveOutpoint

    func testResolveOutpointPrefersTheAddressIndex() async throws {
        var chain = StubChain()
        chain.utxosResult = .success(AddressUtxos(
            confirmed: 0, unconfirmed: 12345,
            utxos: [ChainUtxo(txid: "aa", vout: 1, value: 12345, height: 0)]
        ))

        let resolved = try await resolveOutpoint(chain: chain, address: "1A", txid: "aa", vout: 1)
        XCTAssertEqual(resolved, ResolvedOutpoint(txid: "aa", vout: 1, value: 12345, unconfirmed: true, indexed: true))
    }

    func testResolveOutpointFallsBackToTheParentTransaction() async throws {
        var chain = StubChain()
        chain.txResult = .success(ChainTx(confirmations: 0, vin: [], vout: []))

        let resolved = try await resolveOutpoint(chain: chain, address: "1A", txid: "aa", vout: 0)
        XCTAssertEqual(resolved, ResolvedOutpoint(txid: "aa", vout: 0, value: 1, unconfirmed: true, indexed: false))
    }

    func testResolveOutpointMarksConfirmedParentAsSuch() async throws {
        var chain = StubChain()
        chain.txResult = .success(ChainTx(confirmations: 6, vin: [], vout: []))

        let resolved = try await resolveOutpoint(chain: chain, address: "1A", txid: "aa", vout: 0)
        XCTAssertEqual(resolved, ResolvedOutpoint(txid: "aa", vout: 0, value: 1, unconfirmed: false, indexed: false))
    }

    func testResolveOutpointThrowsWhenTheParentIsNotVisible() async throws {
        let chain = StubChain()   // txResult is nil and no index entry
        do {
            _ = try await resolveOutpoint(chain: chain, address: "1A", txid: "aa", vout: 0)
            XCTFail("expected not found")
        } catch let ChainError.notFound(detail) {
            XCTAssertTrue(detail.contains("wait and retry"))
        }
    }

    /// Index failure must not fail resolution: absence proves nothing, and the
    /// parent is still the source of truth.
    func testResolveOutpointSurvivesAnIndexFailure() async throws {
        var chain = StubChain()
        chain.utxosResult = .failure(URLError(.notConnectedToInternet))
        chain.txResult = .success(ChainTx(confirmations: 1, vin: [], vout: []))

        let resolved = try await resolveOutpoint(chain: chain, address: "1A", txid: "aa", vout: 0)
        XCTAssertEqual(resolved, ResolvedOutpoint(txid: "aa", vout: 0, value: 1, unconfirmed: false, indexed: false))
    }
}
