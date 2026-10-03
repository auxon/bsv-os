import XCTest
@testable import BSVOSWallet

/// The shared commitment ladder (streams and cast ticks) must match the
/// daemon's `commitment.ts` exactly — grace, skip-ahead, accrual and every
/// decision branch.
final class CommitmentVectorTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Grace: Decodable {
            let cadenceSecs: Int
            let graceMs: Int
        }
        struct Advance: Decodable {
            let nextDueAt: Int
            let cadenceSecs: Int
            let now: Int
            let next: Int
        }
        struct Accrued: Decodable {
            let terms: Commitment.Terms
            let now: Int
            let amount: Int
        }
        struct Due: Decodable {
            struct Liveness: Decodable {
                let fresh: Bool
                let ageMs: Int
                let reason: String?
            }
            struct Decision: Decodable {
                let kind: String
                let nextDueAt: Int?
                let remaining: Int?
                let graceMs: Int?
                let reason: String?
                let amount: Int?

                var mapped: Commitment.Decision? {
                    switch kind {
                    case "wait": return nextDueAt.map { .wait(nextDueAt: $0) }
                    case "exhausted": return remaining.map { .exhausted(remaining: $0) }
                    case "stale":
                        guard let graceMs, let reason else { return nil }
                        return .stale(graceMs: graceMs, reason: reason)
                    case "accruing": return amount.map { .accruing(amount: $0) }
                    case "release":
                        guard let amount, let remaining else { return nil }
                        return .release(amount: amount, remaining: remaining)
                    default: return nil
                    }
                }
            }
            let name: String
            let terms: Commitment.Terms
            let liveness: Liveness
            let now: Int
            let decision: Decision
        }
        let grace: [Grace]
        let advance: [Advance]
        let accrued: [Accrued]
        let due: [Due]
    }

    private func load() throws -> Vectors {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/commitment-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testGraceSkipAheadAndAccrualMatchTheDaemon() throws {
        let vectors = try load()
        XCTAssertFalse(vectors.grace.isEmpty)
        for testCase in vectors.grace {
            XCTAssertEqual(
                Commitment.graceMsFor(testCase.cadenceSecs), testCase.graceMs,
                "grace(\(testCase.cadenceSecs))"
            )
        }
        for testCase in vectors.advance {
            XCTAssertEqual(
                Commitment.advanceDue(nextDueAt: testCase.nextDueAt, cadenceSecs: testCase.cadenceSecs, now: testCase.now),
                testCase.next,
                "advance(\(testCase.nextDueAt), \(testCase.cadenceSecs), \(testCase.now))"
            )
        }
        for testCase in vectors.accrued {
            XCTAssertEqual(
                Commitment.accruedSats(testCase.terms, now: testCase.now), testCase.amount,
                "accrued(rate \(testCase.terms.ratePerMin), now \(testCase.now))"
            )
        }
    }

    func testEveryDecisionBranchMatchesTheDaemon() throws {
        let vectors = try load()
        XCTAssertTrue(vectors.due.contains { $0.decision.kind == "wait" })
        XCTAssertTrue(vectors.due.contains { $0.decision.kind == "exhausted" })
        XCTAssertTrue(vectors.due.contains { $0.decision.kind == "stale" })
        XCTAssertTrue(vectors.due.contains { $0.decision.kind == "accruing" })
        XCTAssertTrue(vectors.due.contains { $0.decision.kind == "release" })
        for testCase in vectors.due {
            let expected = try XCTUnwrap(testCase.decision.mapped, testCase.name)
            let actual = Commitment.due(
                testCase.terms,
                fresh: testCase.liveness.fresh,
                ageMs: testCase.liveness.ageMs,
                reason: testCase.liveness.reason,
                now: testCase.now
            )
            XCTAssertEqual(actual, expected, testCase.name)
        }
    }
}
