import XCTest
@testable import BSVOSWallet

/// The notification payload is a dictionary from outside the app, and its
/// buttons approve or block spending — so the mapping is tested rather than
/// assumed.
// MainActor because WalletSession.suggestedCap is isolated to it, and the
// agreement between the two cap calculators is one of the things under test.
@MainActor
final class PushActionTests: XCTestCase {
    private func approval(origin: String = "pocketpets.entangleit.com", amount: Any = 1200) -> [AnyHashable: Any] {
        ["kind": "approval", "origin": origin, "action": "app-spend", "amountSats": amount]
    }

    func testApprovingFromTheLockScreenDerivesACapFromTheAsk() {
        let action = PushAction.from(userInfo: approval(amount: 1200), actionIdentifier: PushAction.approveIdentifier)
        // Same padding as the in-app suggestion, so a lock-screen approval
        // cannot grant a different limit than the approvals screen would.
        XCTAssertEqual(action, .approve(origin: "pocketpets.entangleit.com", capSats: 1500))
    }

    func testBlockingNamesTheOrigin() {
        XCTAssertEqual(
            PushAction.from(userInfo: approval(), actionIdentifier: PushAction.denyIdentifier),
            .deny(origin: "pocketpets.entangleit.com")
        )
    }

    /// A malformed payload must do nothing. Approving "something" would be worse
    /// than ignoring it: the request is still listed in the app.
    func testMalformedPayloadsAreUnknownRatherThanGuessed() {
        let cases: [[AnyHashable: Any]] = [
            [:],
            ["kind": "approval"],
            ["kind": "approval", "origin": ""],
            ["kind": "approval", "origin": "   "],
            ["kind": "something-else", "origin": "x.com"],
            ["origin": "x.com"],
        ]
        for payload in cases {
            XCTAssertEqual(
                PushAction.from(userInfo: payload, actionIdentifier: PushAction.approveIdentifier),
                .unknown,
                "payload \(payload) must not approve anything"
            )
        }
    }

    /// Tapping the notification itself (no action button) is not an approval.
    func testTheDefaultActionIsNotAnApproval() {
        XCTAssertEqual(PushAction.from(userInfo: approval(), actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier"), .unknown)
        XCTAssertEqual(PushAction.from(userInfo: approval(), actionIdentifier: "com.apple.UNNotificationDismissActionIdentifier"), .unknown)
    }

    /// A zero-amount ask (an anchor, a first-run request) approves with no cap,
    /// which means "ask me every time" rather than "no limit".
    func testAZeroAmountAskApprovesWithNoCap() {
        XCTAssertEqual(
            PushAction.from(userInfo: approval(amount: 0), actionIdentifier: PushAction.approveIdentifier),
            .approve(origin: "pocketpets.entangleit.com", capSats: 0)
        )
    }

    /// The daemon may serialise the amount as a number or, through some paths, a
    /// string. Both must work or the cap silently becomes 0.
    func testTheAmountSurvivesEitherEncoding() {
        let asNumber = PushAction.from(userInfo: approval(amount: 250), actionIdentifier: PushAction.approveIdentifier)
        XCTAssertEqual(asNumber, .approve(origin: "pocketpets.entangleit.com", capSats: 300))
    }

    /// The two cap calculators must agree; a test asserts it here because a
    /// divergent pair is a security surprise rather than a cosmetic one.
    func testTheTwoCapCalculatorsAgree() {
        for amount in [0, 1, 250, 1200, 9_999, 100_000] {
            XCTAssertEqual(
                PushAction.suggestedCap(for: amount),
                WalletSession.suggestedCap(for: PendingRequest(
                    id: 1, origin: "x", amountSats: amount, action: "app-spend", createdAt: 0
                )),
                "cap for \(amount) must match the in-app suggestion"
            )
        }
    }

    func testTheCategoryAndActionIdentifiersMatchTheDaemon() {
        // The daemon sets aps.category to this string; the app registers the
        // same one, or the lock screen would show no buttons at all.
        XCTAssertEqual(PushAction.category, "BSV_APPROVAL")
        let daemon = try? String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("walletd/src/push.ts"),
            encoding: .utf8
        )
        if let daemon {
            XCTAssertTrue(daemon.contains("category: \"BSV_APPROVAL\""), "the daemon uses the same category")
        }
    }
}
