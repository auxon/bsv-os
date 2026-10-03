import XCTest
@testable import BSVOSWallet

/// S3's acceptance test: the Swift policy engine replays the daemon's own
/// decisions, case for case.
///
/// The vectors come from `packages/walletd/test/vectors/generate-policy.mjs`,
/// which runs the real `policy.ts` through 17 scenarios — modes, caps, first
/// asks, cached scores, auto thresholds, probes, approval, seeded requests —
/// and records the verdict, reason, pending flag, advisor fields and the
/// contents of the queue after each step.
///
/// The engine is configured with the daemon's CLI wording (`PolicyHints.daemonCLI`)
/// so reasons compare character for character; the app uses the phone wording.
final class PolicyVectorTests: XCTestCase {
    struct VectorFile: Decodable {
        let scenarios: [Scenario]
    }

    struct Scenario: Decodable {
        let name: String
        /// advisor output keyed "origin|action|amountSats"
        let scores: [String: SpendScore]
        let steps: [Step]
    }

    struct Step: Decodable {
        let call: String
        let origin: String?
        let amountSats: Int?
        let action: String?
        let mode: String?
        let capSats: Int?
        let scorerCalled: Bool?
        let expectCheck: PolicyCheck?
        let expectRequests: [ExpectedRequest]?
        let expectPolicies: [ExpectedPolicy]?

        enum CodingKeys: String, CodingKey {
            case call, origin, amountSats, action, mode, capSats, scorerCalled, expect
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            call = try c.decode(String.self, forKey: .call)
            origin = try c.decodeIfPresent(String.self, forKey: .origin)
            amountSats = try c.decodeIfPresent(Int.self, forKey: .amountSats)
            action = try c.decodeIfPresent(String.self, forKey: .action)
            mode = try c.decodeIfPresent(String.self, forKey: .mode)
            capSats = try c.decodeIfPresent(Int.self, forKey: .capSats)
            scorerCalled = try c.decodeIfPresent(Bool.self, forKey: .scorerCalled)
            switch call {
            case "check", "probe":
                expectCheck = try c.decode(PolicyCheck.self, forKey: .expect)
                expectRequests = nil
                expectPolicies = nil
            case "pending":
                expectCheck = nil
                expectRequests = try c.decode([ExpectedRequest].self, forKey: .expect)
                expectPolicies = nil
            case "policies":
                expectCheck = nil
                expectRequests = nil
                expectPolicies = try c.decode([ExpectedPolicy].self, forKey: .expect)
            default:
                expectCheck = nil
                expectRequests = nil
                expectPolicies = nil
            }
        }
    }

    /// A row of the daemon's policy_requests table. The daemon stores the
    /// advisor's answer in seven columns; the score here rebuilds it the same
    /// way `scoreFromRow` does, so the two sides compare equal.
    struct ExpectedRequest: Decodable {
        let id: Int
        let origin: String
        let amountSats: Int
        let action: String
        let jevVerdict: String?
        let jevProb: Double?
        let jevRisk: Double?
        let jevRiskLevel: String?
        let jevConfidence: Double?
        let jevModel: String?
        let jevCheckedAt: Int?

        enum CodingKeys: String, CodingKey {
            case id, origin, action
            case amountSats = "amount_sats"
            case jevVerdict = "jev_verdict"
            case jevProb = "jev_prob"
            case jevRisk = "jev_risk"
            case jevRiskLevel = "jev_risk_level"
            case jevConfidence = "jev_confidence"
            case jevModel = "jev_model"
            case jevCheckedAt = "jev_checked_at"
        }

        var projection: RequestProjection {
            let score: SpendScore? = {
                guard let jevVerdict, jevCheckedAt != nil else { return nil }
                return SpendScore(
                    verdict: SpendScore.Verdict(rawValue: jevVerdict) ?? .ask,
                    verdictProb: jevProb ?? 0,
                    risk: jevRisk ?? 0,
                    riskLevel: SpendScore.RiskLevel(stored: jevRiskLevel),
                    confidence: jevConfidence ?? 0,
                    model: jevModel ?? "cached"
                )
            }()
            return RequestProjection(id: id, origin: origin, amountSats: amountSats, action: action, score: score)
        }
    }

    struct ExpectedPolicy: Decodable {
        let origin: String
        let mode: String
        let spendCapSats: Int

        enum CodingKeys: String, CodingKey {
            case origin, mode
            case spendCapSats = "spend_cap_sats"
        }
    }

    /// The stable part of a queued request — everything except the wall-clock
    /// timestamp, which a replay cannot reproduce. The score is normalised the
    /// way `scoreFromRow` does, zeroing the cost and elapsed time of the call
    /// that produced it.
    struct RequestProjection: Equatable {
        let id: Int
        let origin: String
        let amountSats: Int
        let action: String
        let score: SpendScore?
    }

    actor ScriptedScorer: SpendScoring {
        private let scores: [String: SpendScore]
        private(set) var callCount = 0
        private(set) var misses: [String] = []

        init(scores: [String: SpendScore]) {
            self.scores = scores
        }

        func score(_ context: SpendContext) async throws -> SpendScore {
            callCount += 1
            let key = "\(context.origin)|\(context.action)|\(context.amountSats)"
            guard let score = scores[key] else {
                misses.append(key)
                return SpendScore(verdict: .ask, verdictProb: 0.5, risk: 0.5, riskLevel: .unverified, confidence: 0.5, model: "missing-score")
            }
            return score
        }
    }

    final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var current = 1_700_000_000_000

        func now() -> Int {
            lock.lock()
            defer { lock.unlock() }
            current += 1000
            return current
        }
    }

    private func loadVectors() throws -> VectorFile {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/policy-vectors.json")
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
    }

    func testTheVectorsCoverTheInterestingBranches() throws {
        let file = try loadVectors()
        XCTAssertEqual(file.scenarios.count, 17)
        let calls = file.scenarios.flatMap { $0.steps }.map(\.call)
        XCTAssertTrue(calls.contains("check"))
        XCTAssertTrue(calls.contains("probe"))
        XCTAssertTrue(calls.contains("pending"))
        XCTAssertTrue(calls.contains("policies"))
        XCTAssertTrue(calls.contains("setPolicy"))
        XCTAssertTrue(calls.contains("seedRequest"))
        // The advisor call-count rule is the subtle one: ask caches, auto re-scores.
        let allSteps = file.scenarios.flatMap { $0.steps }
        XCTAssertTrue(allSteps.contains { $0.scorerCalled == false })
        XCTAssertTrue(allSteps.contains { $0.scorerCalled == true })
    }

    func testTheEngineReplaysTheDaemonsDecisions() async throws {
        let file = try loadVectors()
        for scenario in file.scenarios {
            let store = InMemoryPolicyStore()
            let scorer = ScriptedScorer(scores: scenario.scores)
            let clock = TestClock()
            let engine = PolicyEngine(
                store: store,
                scorer: scorer,
                budget: nil,
                thresholds: .default,
                hints: .daemonCLI,
                now: { clock.now() }
            )

            for step in scenario.steps {
                let callsBefore = await scorer.callCount
                let label = "\(scenario.name): \(step.call)"
                switch step.call {
                case "setPolicy":
                    let rawMode = try XCTUnwrap(step.mode)
                    let mode = try XCTUnwrap(PolicyMode(rawValue: rawMode))
                    let policyOrigin = try XCTUnwrap(step.origin)
                    try await engine.setPolicy(origin: policyOrigin, mode: mode, capSats: step.capSats ?? 0)

                case "seedRequest":
                    let seedOrigin = try XCTUnwrap(step.origin)
                    let seedAmount = try XCTUnwrap(step.amountSats)
                    let seedAction = try XCTUnwrap(step.action)
                    try await engine.seedRequest(origin: seedOrigin, amountSats: seedAmount, action: seedAction)

                case "check", "probe":
                    let origin = try XCTUnwrap(step.origin)
                    let amountSats = try XCTUnwrap(step.amountSats)
                    let action = try XCTUnwrap(step.action)
                    let expected = try XCTUnwrap(step.expectCheck)
                    let result = step.call == "probe"
                        ? try await engine.probe(origin: origin, amountSats: amountSats, action: action)
                        : try await engine.check(origin: origin, amountSats: amountSats, action: action)
                    XCTAssertEqual(result, expected, label)

                case "pending":
                    let expected = try XCTUnwrap(step.expectRequests).map(\.projection).sorted { $0.id < $1.id }
                    let actual = try await engine.pendingRequests()
                        .map { RequestProjection(id: $0.id, origin: $0.origin, amountSats: $0.amountSats, action: $0.action, score: normalised($0.score)) }
                        .sorted { $0.id < $1.id }
                    XCTAssertEqual(actual, expected, label)

                case "policies":
                    let expected = try XCTUnwrap(step.expectPolicies)
                        .map { "\($0.origin)|\($0.mode)|\($0.spendCapSats)" }
                    let actual = try await engine.listPolicies()
                        .map { "\($0.origin)|\($0.mode.rawValue)|\($0.spendCapSats)" }
                    XCTAssertEqual(actual, expected, label)

                default:
                    XCTFail("unknown step \(step.call)")
                }

                if let expectedCall = step.scorerCalled {
                    let callsAfter = await scorer.callCount
                    XCTAssertEqual(
                        callsAfter - callsBefore, expectedCall ? 1 : 0,
                        "\(label): advisor consulted"
                    )
                }
            }

            let misses = await scorer.misses
            XCTAssertEqual(misses, [], "\(scenario.name): advisor was asked for a score the vectors do not contain")
        }
    }

    private func normalised(_ score: SpendScore?) -> SpendScore? {
        guard var score else { return nil }
        score.cost = 0
        score.elapsedMs = 0
        return score
    }
}
