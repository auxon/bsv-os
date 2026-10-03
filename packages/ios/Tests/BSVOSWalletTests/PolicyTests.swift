import XCTest
@testable import BSVOSWallet

/// Unit tests for the parts the daemon vectors cannot cover: the budget seam
/// (the daemon's `agents.ts` is not ported), persistence, ordering, and the
/// phone-appropriate approval hint.
final class PolicyTests: XCTestCase {
    struct StubBudget: SpendBudgeting {
        let decision: BudgetDecision
        func check(origin: String, amountSats: Int) async throws -> BudgetDecision {
            decision
        }
    }

    actor BudgetSpy: SpendBudgeting {
        private(set) var calls = 0
        func check(origin: String, amountSats: Int) async throws -> BudgetDecision {
            calls += 1
            return BudgetDecision()
        }
    }

    actor CountingScorer: SpendScoring {
        private(set) var calls = 0
        private let score: SpendScore?

        init(score: SpendScore? = nil) {
            self.score = score
        }

        func score(_ context: SpendContext) async throws -> SpendScore {
            calls += 1
            return score ?? SpendScore(
                verdict: .ask, verdictProb: 0.5, risk: 0.5,
                riskLevel: .unverified, confidence: 0.5, model: "test"
            )
        }
    }

    final class Ticker: @unchecked Sendable {
        private let lock = NSLock()
        private var current = 1_700_000_000_000
        func now() -> Int {
            lock.lock()
            defer { lock.unlock() }
            current += 1000
            return current
        }
    }

    private func makeEngine(
        store: any PolicyStore,
        scorer: (any SpendScoring)? = nil,
        budget: (any SpendBudgeting)? = nil,
        hints: PolicyHints = .iOS
    ) -> PolicyEngine {
        let clock = Ticker()
        return PolicyEngine(store: store, scorer: scorer, budget: budget, hints: hints, now: { clock.now() })
    }

    // MARK: - budgets

    func testABudgetCoveredSpendIsAllowedEvenInAskMode() async throws {
        let store = InMemoryPolicyStore()
        let scorer = CountingScorer()
        let engine = makeEngine(
            store: store,
            scorer: scorer,
            budget: StubBudget(decision: BudgetDecision(ok: true, reason: "", covered: true))
        )
        try await engine.setPolicy(origin: "agent.example", mode: .ask)

        let result = try await engine.check(origin: "agent.example", amountSats: 250, action: "send")
        XCTAssertEqual(result.verdict, .allow)
        XCTAssertEqual(result.reason, "allowed by agent budget")
        XCTAssertTrue(result.budgetCovered)
        XCTAssertFalse(result.pending)

        // Minting was the approval ceremony; the advisor is not consulted.
        let calls = await scorer.calls
        XCTAssertEqual(calls, 0)
        let pending = try await engine.pendingRequests()
        XCTAssertEqual(pending.count, 0)
    }

    func testARejectedBudgetDeniesWithoutQueueing() async throws {
        let store = InMemoryPolicyStore()
        let engine = makeEngine(
            store: store,
            budget: StubBudget(decision: BudgetDecision(
                ok: false,
                reason: "over lifetime budget (10 of 100 sats left) — ask your human to re-mint with a bigger --budget",
                covered: false
            ))
        )

        let result = try await engine.check(origin: "agent.example", amountSats: 250, action: "send")
        XCTAssertEqual(result.verdict, .deny)
        XCTAssertEqual(result.reason, "over lifetime budget (10 of 100 sats left) — ask your human to re-mint with a bigger --budget")
        XCTAssertFalse(result.pending, "a budget refusal is not an approval request")
        let pending = try await engine.pendingRequests()
        XCTAssertEqual(pending.count, 0)
    }

    /// Deny mode returns before the budget is consulted. Pinned because it
    /// decides which error a caller sees.
    func testDenyModeNeverReachesTheBudget() async throws {
        let spy = BudgetSpy()
        let store = InMemoryPolicyStore()
        let engine = makeEngine(store: store, budget: spy)
        try await engine.setPolicy(origin: "deny.example", mode: .deny)

        _ = try await engine.check(origin: "deny.example", amountSats: 1, action: "send")
        let calls = await spy.calls
        XCTAssertEqual(calls, 0)
    }

    // MARK: - hints

    func testThePhoneWordingSaysWhereApprovalHappens() async throws {
        let store = InMemoryPolicyStore()
        let engine = makeEngine(store: store)

        let result = try await engine.check(origin: "app.example", amountSats: 0, action: "send")
        XCTAssertEqual(result.reason, "first-run approval required — approve in Policy")
        XCTAssertFalse(result.reason.contains("bsv allow"), "there is no CLI on a phone")
    }

    // MARK: - store behaviour

    func testPendingRequestsComeBackNewestFirst() async throws {
        let store = InMemoryPolicyStore()
        let engine = makeEngine(store: store)
        for action in ["send", "anchor", "publish"] {
            try await engine.seedRequest(origin: "app.example", amountSats: 100, action: action)
        }
        let pending = try await engine.pendingRequests()
        XCTAssertEqual(pending.map(\.id), [3, 2, 1])
        XCTAssertEqual(pending.map(\.action), ["publish", "anchor", "send"])
    }

    func testSettingAskKeepsTheQueueButAnyOtherModeClearsIt() async throws {
        let store = InMemoryPolicyStore()
        let engine = makeEngine(store: store)
        _ = try await engine.check(origin: "app.example", amountSats: 0, action: "send")
        var pending = try await engine.pendingRequests()
        XCTAssertEqual(pending.count, 1)

        try await engine.setPolicy(origin: "app.example", mode: .ask, capSats: 0)
        pending = try await engine.pendingRequests()
        XCTAssertEqual(pending.count, 1, "ask does not answer the queue")

        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: 500)
        pending = try await engine.pendingRequests()
        XCTAssertEqual(pending.count, 0)
        let policies = try await engine.listPolicies()
        XCTAssertEqual(policies.map { "\($0.origin)|\($0.mode.rawValue)|\($0.spendCapSats)" }, ["app.example|allow|500"])
    }

    func testSetPolicyClampsNegativeCaps() async throws {
        let store = InMemoryPolicyStore()
        let engine = makeEngine(store: store)
        try await engine.setPolicy(origin: "app.example", mode: .allow, capSats: -10)
        let policies = try await engine.listPolicies()
        XCTAssertEqual(policies.first?.spendCapSats, 0)
    }

    func testUnknownStoredModesFallBackToAsk() {
        XCTAssertEqual(PolicyMode(stored: nil), .ask)
        XCTAssertEqual(PolicyMode(stored: "nonsense"), .ask)
        XCTAssertEqual(PolicyMode(stored: "auto"), .auto)
    }

    // MARK: - file store

    private func makeTemporaryURL() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("bsvos-policy-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("policy.json")
    }

    func testFileStoreRoundTripsAndContinuesIDs() async throws {
        let url = try makeTemporaryURL()

        do {
            let store = try FilePolicyStore(url: url)
            try await store.savePolicy(PolicyRowRecord(origin: "app.example", mode: .allow, spendCapSats: 777, updatedAt: 1))
            try await store.insertRequest(origin: "app.example", amountSats: 250, action: "send", createdAt: 10, score: nil)
            try await store.updateScore(id: 1, score: SpendScore(
                verdict: .allow, verdictProb: 0.9, risk: 0.1, riskLevel: .routine,
                confidence: 0.8, model: "round-trip"
            ))
        }

        // A second open of the same file sees everything, and ids continue.
        let reopened = try FilePolicyStore(url: url)
        let policy = try await reopened.policy(origin: "app.example")
        XCTAssertEqual(policy?.mode, .allow)
        XCTAssertEqual(policy?.spendCapSats, 777)

        let request = try await reopened.request(origin: "app.example", action: "send")
        XCTAssertEqual(request?.score?.model, "round-trip")
        XCTAssertEqual(request?.amountSats, 250)

        let next = try await reopened.insertRequest(origin: "b.example", amountSats: 1, action: "send", createdAt: 11, score: nil)
        XCTAssertEqual(next.id, 2, "ids survive a restart")
    }

    func testFileStoreRefusesADocumentFromTheFuture() throws {
        let url = try makeTemporaryURL()
        try Data(#"{"version":2,"policies":[],"requests":[],"nextRequestID":1}"#.utf8).write(to: url)

        XCTAssertThrowsError(try FilePolicyStore(url: url)) { error in
            XCTAssertEqual(error as? PolicyStoreError, .unsupportedVersion(2))
        }
    }

    func testAnAbsentFileIsAnEmptyWalletNotAnError() async throws {
        let url = try makeTemporaryURL()
        let store = try FilePolicyStore(url: url)
        let policies = try await store.allPolicies()
        XCTAssertEqual(policies.count, 0)
        let pending = try await store.pendingRequests(limit: 100)
        XCTAssertEqual(pending.count, 0)
    }
}
