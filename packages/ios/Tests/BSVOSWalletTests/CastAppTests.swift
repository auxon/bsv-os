import XCTest
@testable import BSVOSWallet

/// The Cast engine on the phone: splits become streams, a fresh beat earns a
/// minute of sats under the daemon's gate, stale beats auto-pause, budgets
/// close, and live broadcasts have a lifecycle.
final class CastAppTests: XCTestCase {
    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Int
        init(_ value: Int) { self.value = value }
        var now: Int {
            lock.lock(); defer { lock.unlock() }
            return value
        }
        func advance(_ ms: Int) {
            lock.lock(); value += ms; lock.unlock()
        }
    }

    actor StubChain: ChainProvider {
        nonisolated let name = "stub"
        private let selfScriptHex: String
        private let fundingTxid = String(repeating: "bb", count: 32)
        private(set) var broadcasts: [String] = []
        private var utxoList: [ChainUtxo] = [
            ChainUtxo(txid: String(repeating: "bb", count: 32), vout: 1, value: 100_000, height: 1),
        ]
        /// Parent outputs by txid, so change from earlier broadcasts is
        /// readable exactly as a real index would serve it.
        private var parents: [String: [ChainTx.Vout]] = [:]

        init(selfScriptHex: String) {
            self.selfScriptHex = selfScriptHex
            parents[fundingTxid] = [
                ChainTx.Vout(value: 0, addresses: nil, scriptHex: nil),
                ChainTx.Vout(value: 100_000, addresses: nil, scriptHex: selfScriptHex),
            ]
        }

        func utxos(address: String) async throws -> AddressUtxos {
            AddressUtxos(confirmed: utxoList.reduce(0) { $0 + $1.value }, unconfirmed: 0, utxos: utxoList)
        }

        func tx(txid: String) async throws -> ChainTx? {
            guard let vouts = parents[txid] else { return nil }
            return ChainTx(confirmations: 1, vin: [], vout: vouts)
        }

        func broadcast(txHex: String) async throws -> BroadcastResult {
            broadcasts.append(txHex)
            let txid = Tx.txid(ofSignedBytes: try Hex.decode(txHex))
            // The chain now carries the change this transaction wrote, so the
            // next stream tick has funding — as a real index would show.
            if let parsed = try? Tx.parse(try Hex.decode(txHex)) {
                parents[txid] = parsed.outputs.map {
                    ChainTx.Vout(value: $0.sats, addresses: nil, scriptHex: Hex.encode($0.script))
                }
                for (index, output) in parsed.outputs.enumerated() where Hex.encode(output.script) == selfScriptHex {
                    utxoList.append(ChainUtxo(txid: txid, vout: index, value: output.sats, height: 1))
                }
            }
            return BroadcastResult(txid: txid, status: .seen)
        }

        func status(txid: String) async throws -> TxStatusResult {
            TxStatusResult(status: .unknown, blockHeight: 0)
        }
    }

    private let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let destination = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"

    private func selfScriptHex() throws -> String {
        let master = try BIP32.master(fromSeed: BIP39.seed(from: phrase))
        let key = try BIP32.derive("m/0/0", from: master)
        let publicKey = try Secp256k1.publicKey(fromPrivateKey: key.privateKey)
        return Hex.encode(try Address.lockingScript(for: Address.from(publicKey: publicKey)))
    }

    private func harness() throws -> (LocalWalletBackend, PolicyEngine, StubChain, Clock, InMemoryCastStore) {
        let chain = StubChain(selfScriptHex: try selfScriptHex())
        let engine = PolicyEngine(store: InMemoryPolicyStore())
        let store = InMemoryCastStore()
        let clock = Clock(1_700_000_000_000)
        let wallet = LocalWalletBackend(
            vault: InMemorySeedVault(phrase: phrase),
            chain: chain,
            policy: engine,
            ledger: InMemoryLedgerStore(),
            cast: store,
            now: { clock.now }
        )
        return (wallet, engine, chain, clock, store)
    }

    private func addEpisode(_ wallet: LocalWalletBackend, splits: String? = nil) async throws -> CastEpisode {
        try await wallet.castAdd(
            title: "Demo Cast",
            splits: splits ?? "\(destination):100"
        )
    }

    // MARK: - episodes

    func testEpisodesRoundTripAndValidate() async throws {
        let (wallet, _, _, _, _) = try harness()
        let episode = try await wallet.castAdd(
            title: "  Talk  ", media: "https://example.com/a.mp4",
            splits: "\(destination):70,13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:30"
        )
        XCTAssertEqual(episode.title, "Talk", "trimmed")
        XCTAssertEqual(episode.splits.count, 2)
        XCTAssertEqual(episode.splits[0].pct, 70)
        let listed = try await wallet.castEpisodes().map(\.id)
        XCTAssertEqual(listed, [episode.id])

        let updated = try await wallet.castSetMedia(episode: episode.id, mediaUrl: "/cast/media/x.webm")
        XCTAssertEqual(updated.mediaUrl, "/cast/media/x.webm")

        do {
            _ = try await wallet.castAdd(title: "", splits: "\(destination):100")
            XCTFail("title is required")
        } catch let error as WalletError {
            XCTAssertEqual(error.message, "title required")
        }
        do {
            _ = try await wallet.castAdd(title: "x", splits: "\(destination):90,13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:20")
            XCTFail("splits must sum to 100")
        } catch let error as WalletError {
            XCTAssertEqual(error.message, "splits must sum to 100 (got 110)")
        }
    }

    // MARK: - sessions and the tick engine

    func testPlayCreatesOneStreamPerSplitWithTheDaemonsMath() async throws {
        let (wallet, _, _, _, store) = try harness()
        let episode = try await addEpisode(
            wallet, splits: "\(destination):70,13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz:30"
        )
        let session = try await wallet.castPlay(episode: episode.id, rate: 1500, every: "1m", maxTotal: 20_000)
        XCTAssertEqual(session.everySecs, 60)
        XCTAssertEqual(session.streamIds.count, 2)

        let streams = try await store.streams().sorted { $0.payee < $1.payee }
        XCTAssertEqual(streams.count, 2)
        let byPayee = Dictionary(uniqueKeysWithValues: streams.map { ($0.payee, $0) })
        XCTAssertEqual(byPayee[destination]?.ratePerMin, 1050, "70% of the rate")
        XCTAssertEqual(byPayee[destination]?.maxTotal, 14_000, "70% of the cap")
        XCTAssertEqual(byPayee["13iX7DteNj1gV7zhe4t6o9FX9CArR5wZxz"]?.ratePerMin, 450)
        XCTAssertEqual(byPayee[destination]?.tickSecs, 60)
        XCTAssertEqual(byPayee[destination]?.status, "active")

        do {
            _ = try await wallet.castPlay(episode: episode.id, rate: 0, maxTotal: 5000)
            XCTFail("rate must be positive")
        } catch let error as WalletError {
            XCTAssertEqual(error.message, "rate must be positive sats/min")
        }
        do {
            _ = try await wallet.castPlay(episode: episode.id, rate: 100, every: "30s", maxTotal: 5000)
            XCTFail("interval minimum")
        } catch let error as WalletError {
            XCTAssertEqual(error.message, "minimum tick is 60s")
        }
        do {
            _ = try await wallet.castPlay(episode: episode.id, rate: 100, maxTotal: 500)
            XCTFail("cap floor")
        } catch let error as WalletError {
            XCTAssertEqual(error.message, "max total must be at least 1000 sats")
        }
    }

    func testAFreshMinutePaysTheStreamsThroughTheGate() async throws {
        let (wallet, engine, chain, clock, store) = try harness()
        try await wallet.unlock()
        try await engine.setPolicy(origin: "stream", mode: .allow, capSats: 10_000_000)
        let episode = try await addEpisode(wallet)
        let session = try await wallet.castPlay(episode: episode.id, rate: 3000, every: "1m", maxTotal: 20_000)
        let streamId = try XCTUnwrap(session.streamIds.first)

        // The immediate pass posts the first beat; nothing is due yet.
        let earlyTicks = try await store.ticks(streamId: streamId, limit: 50)
        XCTAssertTrue(earlyTicks.isEmpty)
        var broadcastCount = await chain.broadcasts.count
        XCTAssertEqual(broadcastCount, 0)

        clock.advance(60_000)
        _ = await wallet.castTickPass()

        let ticks = try await store.ticks(streamId: streamId, limit: 50)
        XCTAssertEqual(ticks.count, 1)
        XCTAssertEqual(ticks[0].status, "paid")
        XCTAssertEqual(ticks[0].amount, 3000, "one minute at the stream rate")
        XCTAssertNotNil(ticks[0].txid)
        broadcastCount = await chain.broadcasts.count
        XCTAssertEqual(broadcastCount, 1)

        let streamRow = try await store.stream(id: streamId)
        let stream = try XCTUnwrap(streamRow)
        XCTAssertEqual(stream.paidTotal, 3000)
        XCTAssertEqual(stream.status, "active")

        let history = try await wallet.history()
        let tickLabel = try XCTUnwrap(history.transactions.first?.label)
        XCTAssertTrue(tickLabel.hasPrefix("stream cast Demo Cast 100%"), tickLabel)

        // A second minute pays again — the change output from the first
        // payment is the funding, not the spent outpoint.
        clock.advance(60_000)
        _ = await wallet.castTickPass()
        broadcastCount = await chain.broadcasts.count
        XCTAssertEqual(broadcastCount, 2)
        let afterSecond = try await store.ticks(streamId: streamId, limit: 50)
        XCTAssertEqual(afterSecond.count, 2)
    }

    func testPolicyDenialLeavesTheTickSkippedButTheSessionAlive() async throws {
        let (wallet, _, chain, clock, store) = try harness()
        try await wallet.unlock() // locked would also fail, as a locked daemon does
        let episode = try await addEpisode(wallet)
        let session = try await wallet.castPlay(episode: episode.id, rate: 3000, every: "1m", maxTotal: 20_000)
        let streamId = try XCTUnwrap(session.streamIds.first)

        clock.advance(60_000)
        _ = await wallet.castTickPass()

        let ticks = try await store.ticks(streamId: streamId, limit: 50)
        XCTAssertEqual(ticks.count, 1)
        XCTAssertEqual(ticks[0].status, "skipped")
        XCTAssertTrue(ticks[0].detail.contains("payment failed: denied:"), ticks[0].detail)
        let deniedBroadcasts = await chain.broadcasts.count
        XCTAssertEqual(deniedBroadcasts, 0, "nothing broadcasts without approval")
        let aliveStream = try await store.stream(id: streamId)
        XCTAssertEqual(aliveStream?.status, "active", "the session keeps playing")
    }

    func testStaleBeatsAutoPause() async throws {
        let (wallet, _, _, _, store) = try harness()
        // Seed an active stream with no heartbeat, due now — the shape a
        // broadcast leaves behind when its recorder goes quiet.
        let stream = PayStream(
            id: "stm_stale0001", name: "cast stale", payee: destination, ratePerMin: 1200,
            tickSecs: 60, maxTotal: 6000, board: CastRules.board, status: "active",
            paidTotal: 0, lastPaidAt: 1_699_999_000_000, nextDue: 1_699_999_999_000, createdAt: 1_699_999_000_000
        )
        try await store.saveStream(stream)

        _ = await wallet.castTickPass()

        let updatedRow = try await store.stream(id: stream.id)
        let updated = try XCTUnwrap(updatedRow)
        XCTAssertEqual(updated.status, "paused")
        let ticks = try await store.ticks(streamId: stream.id, limit: 10)
        XCTAssertEqual(ticks.first?.status, "stale")
        XCTAssertTrue(ticks.first?.detail.contains("no heartbeat on the board yet") == true)
    }

    func testBudgetsCloseStreams() async throws {
        let (wallet, engine, chain, clock, store) = try harness()
        try await wallet.unlock()
        try await engine.setPolicy(origin: "stream", mode: .allow, capSats: 10_000_000)
        // A stream whose remainder is below the pay floor closes without
        // touching the chain.
        let exhausted = PayStream(
            id: "stm_short00001", name: "cast short", payee: destination, ratePerMin: 1200,
            tickSecs: 60, maxTotal: 1000, board: CastRules.board, status: "active",
            paidTotal: 600, lastPaidAt: 1_699_999_000_000, nextDue: 1_699_999_999_000, createdAt: 1_699_999_000_000
        )
        try await store.saveStream(exhausted)
        _ = await wallet.castTickPass()
        let closedStream = try await store.stream(id: exhausted.id)
        XCTAssertEqual(closedStream?.status, "done")
        let closedTicks = try await store.ticks(streamId: exhausted.id, limit: 10)
        XCTAssertEqual(closedTicks.first?.status, "closed")
        let shortBroadcasts = await chain.broadcasts.count
        XCTAssertEqual(shortBroadcasts, 0)

        // A paid-out stream whose cap is reached also closes.
        let paying = PayStream(
            id: "stm_final0001", name: "cast final", payee: destination, ratePerMin: 1200,
            tickSecs: 60, maxTotal: 1200, board: CastRules.board, status: "active",
            paidTotal: 0, lastPaidAt: clock.now - 60_000, nextDue: clock.now - 1, createdAt: clock.now - 60_000
        )
        try await store.saveStream(paying)
        try await store.appendBeat(StreamBeat(id: "bt_fresh01", streamId: paying.id, ts: clock.now))
        _ = await wallet.castTickPass()
        let settledRow = try await store.stream(id: paying.id)
        let settled = try XCTUnwrap(settledRow)
        XCTAssertEqual(settled.paidTotal, 1200)
        XCTAssertEqual(settled.status, "done")
    }

    func testPauseResumeAndStop() async throws {
        let (wallet, _, _, _, store) = try harness()
        let episode = try await addEpisode(wallet)
        let session = try await wallet.castPlay(episode: episode.id, rate: 1200, every: "1m", maxTotal: 6000)
        let streamId = try XCTUnwrap(session.streamIds.first)

        _ = try await wallet.streamPause(id: streamId)
        let paused = try await store.stream(id: streamId)
        XCTAssertEqual(paused?.status, "paused")

        let resumed = try await wallet.streamResume(id: streamId)
        XCTAssertEqual(resumed.status, "active")
        XCTAssertGreaterThan(resumed.nextDue, resumed.lastPaidAt, "resume restarts the cadence")

        _ = try await wallet.castStop(id: session.id)
        let doneStream = try await store.stream(id: streamId)
        XCTAssertEqual(doneStream?.status, "done")
        let doneSession = try await store.session(id: session.id)
        XCTAssertEqual(doneSession?.status, "stopped")

        do {
            _ = try await wallet.streamPause(id: streamId)
            XCTFail("closed streams stay closed")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_STATE")
            XCTAssertEqual(error.message, "closed streams stay closed")
        }
    }

    // MARK: - live

    func testLiveLifecycleAndTheSilenceReaper() async throws {
        let (wallet, _, _, clock, store) = try harness()
        let episode = try await addEpisode(wallet)

        let started = try await wallet.castLiveStart(episode: episode.id)
        XCTAssertEqual(started.playlist, "/cast/live/\(started.live.id)/index.m3u8")
        let liveEpisode = try await store.episode(id: episode.id)
        XCTAssertEqual(liveEpisode?.live, true)
        let liveRow = try await wallet.castLiveGet(id: started.live.id)
        XCTAssertEqual(liveRow.status, "live")

        do {
            _ = try await wallet.castLiveGet(id: "bad id")
            XCTFail("bad live id")
        } catch let error as WalletError {
            XCTAssertEqual(error.message, "bad live id")
        }

        let ended = try await wallet.castLiveStop(id: started.live.id)
        XCTAssertEqual(ended.status, "ended")
        let cooledEpisode = try await store.episode(id: episode.id)
        XCTAssertEqual(cooledEpisode?.live, false)

        // A recorder that went quiet ends itself, so its playlist gets ENDLIST.
        // The silence window is measured from the last segment or from the
        // start, whichever is later — so time itself must move.
        let quiet = try await wallet.castLiveStart(episode: episode.id)
        clock.advance(CastRules.liveIdleMs + 1_000)
        let reaped = await wallet.castReapStaleLive()
        XCTAssertEqual(reaped, [quiet.live.id])
        let reapedRow = try await store.live(id: quiet.live.id)
        XCTAssertEqual(reapedRow?.status, "ended")
    }
}
