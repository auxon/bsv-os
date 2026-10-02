import XCTest
@testable import BSVOSWallet

/// A backend that records what it was asked and returns canned answers, so the
/// session's behaviour can be asserted without a daemon, a network or TLS.
actor StubBackend: WalletBackend {
    struct Calls {
        var isAuthenticated = 0
        var unlock = 0
        var lock = 0
        var balance = 0
        var policyApprove: [(origin: String, cap: Int)] = []
        var policyDeny: [String] = []
        var send: [(to: String, sats: Int)] = []
        var addressQr = 0
        var history = 0
    }

    private(set) var calls = Calls()

    var status = WalletStatus(authenticated: true, locked: false, hasWallet: true)
    var balanceValue = BalanceResponse(address: "1TestAddr", confirmed: 25_000, unconfirmed: 0, utxos: 1)
    var pendingValue = PolicyPendingResponse(requests: [])
    var policyValue = PolicyListResponse(policies: [])
    var historyValue = HistoryResponse()
    var sendResult = SendResponse(txid: "ab", fee: 275)

    /// When set, the next call of that name throws this instead of answering.
    var failWith: [String: WalletError] = [:]

    init() {}

    private func check(_ name: String) throws {
        if let error = failWith[name] { throw error }
    }

    func isAuthenticated() async throws -> WalletStatus {
        calls.isAuthenticated += 1
        try check("isAuthenticated")
        return status
    }

    func unlock() async throws {
        calls.unlock += 1
        try check("unlock")
        status = WalletStatus(authenticated: true, locked: false, hasWallet: true)
    }

    func lock() async throws {
        calls.lock += 1
        status = WalletStatus(authenticated: false, locked: true, hasWallet: true)
    }

    func balance() async throws -> BalanceResponse {
        calls.balance += 1
        try check("balance")
        return balanceValue
    }

    func addressQr() async throws -> AddressQrResponse {
        calls.addressQr += 1
        return AddressQrResponse(address: balanceValue.address, dataUrl: "data:image/png;base64,iVBORw0KGgo=")
    }

    func policyPending() async throws -> PolicyPendingResponse {
        try check("policyPending")
        return pendingValue
    }

    func policyList() async throws -> PolicyListResponse {
        try check("policyList")
        return policyValue
    }

    func history() async throws -> HistoryResponse {
        calls.history += 1
        try check("history")
        return historyValue
    }

    func policyApprove(origin: String, capSats: Int) async throws -> PolicyApproveResponse {
        calls.policyApprove.append((origin, capSats))
        try check("policyApprove")
        return PolicyApproveResponse(origin: origin, mode: "allow")
    }

    func policyDeny(origin: String) async throws -> PolicyApproveResponse {
        calls.policyDeny.append(origin)
        try check("policyDeny")
        return PolicyApproveResponse(origin: origin, mode: "deny")
    }

    func send(to: String, sats: Int) async throws -> SendResponse {
        calls.send.append((to, sats))
        try check("send")
        return sendResult
    }

    // Test helpers, so assertions read plainly.
    func setFail(_ name: String, _ error: WalletError) { failWith[name] = error }
    func setStatus(_ s: WalletStatus) { status = s }
    func snapshotCalls() -> Calls { calls }
}

private func request(origin: String = "pocketpets.entangleit.com", amount: Int = 1200, id: Int = 1) -> PendingRequest {
    PendingRequest(id: id, origin: origin, amountSats: amount, action: "app-spend", createdAt: 1_790_000_000_000)
}

@MainActor
final class WalletSessionTests: XCTestCase {
    func testRefreshPopulatesEverythingWhenUnlocked() async {
        let backend = StubBackend()
        await backend.setStatus(WalletStatus(authenticated: true, locked: false, hasWallet: true))
        let session = WalletSession(backend: backend)

        await session.refresh()

        XCTAssertFalse(session.locked)
        XCTAssertTrue(session.hasWallet)
        XCTAssertEqual(session.balance?.confirmed, 25_000)
        XCTAssertNotNil(session.qr, "the receive QR is loaded while unlocked")
        XCTAssertNil(session.lastError)
    }

    func testLockedWalletIsAStateNotAnError() async {
        let backend = StubBackend()
        await backend.setStatus(WalletStatus(authenticated: false, locked: true, hasWallet: true))
        let session = WalletSession(backend: backend)

        await session.refresh()

        XCTAssertTrue(session.locked)
        XCTAssertNil(session.balance, "no balance is fetched while locked")
        XCTAssertNil(session.lastError, "being locked is not an error to show")
    }

    func testUnlockLoadsTheBalance() async {
        let backend = StubBackend()
        await backend.setStatus(WalletStatus(authenticated: false, locked: true, hasWallet: true))
        let session = WalletSession(backend: backend)
        await session.refresh()
        XCTAssertTrue(session.locked)

        await session.unlock()

        XCTAssertFalse(session.locked)
        XCTAssertEqual(session.balance?.confirmed, 25_000)
        let calls = await backend.snapshotCalls()
        XCTAssertEqual(calls.unlock, 1)
    }

    func testAnUnreachableDaemonSurfacesAsAnError() async {
        let backend = StubBackend()
        await backend.setFail("isAuthenticated", WalletError(code: "FORBIDDEN", message: "device is not paired, or was revoked"))
        let session = WalletSession(backend: backend)

        await session.refresh()

        XCTAssertEqual(session.lastError?.code, "FORBIDDEN")
        XCTAssertEqual(session.lastError?.message, "device is not paired, or was revoked")
    }

    // MARK: approvals

    func testApprovingUsesASensibleSuggestedCapAndTellsTheUser() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend)

        // 1200 -> padded to 1440 -> rounded up to 1500. Approving should not
        // silently grant a far larger cap than the origin asked for.
        XCTAssertEqual(WalletSession.suggestedCap(for: request(amount: 1200)), 1500)
        XCTAssertEqual(WalletSession.suggestedCap(for: request(amount: 250)), 300)
        XCTAssertEqual(WalletSession.suggestedCap(for: request(amount: 0)), 0, "a zero-amount ask suggests no cap")

        await session.approve(request(amount: 1200))

        let calls = await backend.snapshotCalls()
        XCTAssertEqual(calls.policyApprove.count, 1)
        XCTAssertEqual(calls.policyApprove.first?.origin, "pocketpets.entangleit.com")
        XCTAssertEqual(calls.policyApprove.first?.cap, 1500)
        XCTAssertNotNil(session.notice)
    }

    func testAnExplicitCapOverridesTheSuggestion() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend)

        await session.approve(request(), capSats: 0)

        let calls = await backend.snapshotCalls()
        XCTAssertEqual(calls.policyApprove.first?.cap, 0, "0 means the origin must ask every time")
    }

    /// The behaviour that makes the gate worth having: if authorisation fails,
    /// nothing is approved. A gate that fails open is worse than none, because
    /// it looks like protection.
    func testAFailedBiometricCheckApprovesNothing() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend, biometrics: DenyingGate())

        await session.approve(request())

        let calls = await backend.snapshotCalls()
        XCTAssertTrue(calls.policyApprove.isEmpty, "the daemon must never be asked")
        XCTAssertEqual(session.lastError?.code, "BIOMETRIC_DENIED")
    }

    func testAFailedBiometricCheckBlocksAndSendsNothing() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend, biometrics: DenyingGate())

        await session.deny(request())
        let afterDeny = await backend.snapshotCalls()
        XCTAssertTrue(afterDeny.policyDeny.isEmpty)

        let sent = await session.send(to: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", sats: 100)
        XCTAssertNil(sent)
        let afterSend = await backend.snapshotCalls()
        XCTAssertTrue(afterSend.send.isEmpty, "nothing reached the daemon")
        XCTAssertEqual(session.lastError?.code, "BIOMETRIC_DENIED")
    }

    func testDenyingBlocksTheOrigin() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend)

        await session.deny(request(origin: "evil.example.com"))

        let calls = await backend.snapshotCalls()
        XCTAssertEqual(calls.policyDeny, ["evil.example.com"])
        XCTAssertEqual(session.notice, "evil.example.com is blocked")
    }

    // MARK: spending

    func testSendValidatesLocallyBeforeSpending() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend)
        await session.refresh()

        // Each result is bound before asserting: XCTAssertNil takes an
        // autoclosure, which cannot contain an await.
        let emptyAddress = await session.send(to: "   ", sats: 100)
        XCTAssertNil(emptyAddress, "empty address")
        XCTAssertEqual(session.lastError?.code, "BAD_PARAM")

        let zero = await session.send(to: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", sats: 0)
        XCTAssertNil(zero, "zero amount")
        let negative = await session.send(to: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", sats: -5)
        XCTAssertNil(negative, "negative amount")

        // More than the wallet holds: refused here so the user gets a sentence
        // rather than a chain error after authorising.
        session.clearError()
        let tooMuch = await session.send(to: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", sats: 999_999)
        XCTAssertNil(tooMuch)
        XCTAssertEqual(session.lastError?.code, "INSUFFICIENT")

        let calls = await backend.snapshotCalls()
        XCTAssertTrue(calls.send.isEmpty, "none of those reached the daemon")
    }

    func testSendPassesTheAmountThroughUnchanged() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend)
        await session.refresh()

        let result = await session.send(to: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", sats: 1234)

        XCTAssertEqual(result?.txid, "ab")
        XCTAssertEqual(result?.fee, 275)
        let calls = await backend.snapshotCalls()
        XCTAssertEqual(calls.send.first?.sats, 1234, "the exact amount, not a recomputed one")
        XCTAssertEqual(calls.send.first?.to, "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU")
        XCTAssertNotNil(session.notice)
    }

    /// A policy refusal is the answer, not a failure to be flattened. The code
    /// survives so the UI can say why.
    func testAPolicyDenialSurvivesWithItsCode() async {
        let backend = StubBackend()
        await backend.setFail("send", WalletError(code: "POLICY_DENY", message: "denied: second approval required"))
        let session = WalletSession(backend: backend)
        await session.refresh()

        let result = await session.send(to: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", sats: 500)

        XCTAssertNil(result)
        XCTAssertEqual(session.lastError?.code, "POLICY_DENY")
        XCTAssertTrue(session.lastError?.isPolicyDenial ?? false)
        XCTAssertEqual(session.lastError?.message, "denied: second approval required")
    }

    func testALockedWalletReportsLockedOnSend() async {
        let backend = StubBackend()
        await backend.setFail("send", WalletError(code: "WALLET_LOCKED", message: "wallet locked"))
        let session = WalletSession(backend: backend)

        _ = await session.send(to: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU", sats: 500)

        XCTAssertTrue(session.lastError?.isLocked ?? false, "the UI can offer an unlock button for this one")
    }

    func testBannersCanBeCleared() async {
        let backend = StubBackend()
        let session = WalletSession(backend: backend, biometrics: DenyingGate())
        await session.approve(request())
        XCTAssertNotNil(session.lastError)
        session.clearError()
        XCTAssertNil(session.lastError)

        let backend2 = StubBackend()
        let session2 = WalletSession(backend: backend2)
        await session2.approve(request())
        XCTAssertNotNil(session2.notice)
        session2.clearNotice()
        XCTAssertNil(session2.notice)
    }
}

final class QRCodeTests: XCTestCase {
    func testDataUrlDecodes() {
        // "iVBORw0KGgo=" is "\x89PNG\r\n\x1a\n".
        let data = QRCode.data(fromDataUrl: "data:image/png;base64,iVBORw0KGgo=")
        XCTAssertEqual(data?.count, 8)
        XCTAssertEqual(data?.first, 0x89)
    }

    func testNonBase64DataUrlsAreRejectedRatherThanMisread() {
        XCTAssertNil(QRCode.data(fromDataUrl: "data:image/png,not-base64"))
        XCTAssertNil(QRCode.data(fromDataUrl: "nonsense"))
    }

    func testLocalFallbackGeneratesAQrPng() throws {
        let png = try XCTUnwrap(QRCode.image(from: "1LVDqy9JjDd2ceXqPULKs39pxPBFo2GcrU"), "CoreImage produced a PNG")
        XCTAssertGreaterThan(png.count, 100, "a PNG, not an empty buffer")
        // PNG magic, so we know it is an image rather than a stub.
        XCTAssertEqual(Array(png.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
    }
}
