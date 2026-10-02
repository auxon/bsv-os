import XCTest
@testable import BSVOSWallet

/// A stub transport so the client can be exercised without a daemon.
private struct StubClient: DeviceHTTPClient {
    let status: Int
    let body: Data

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
        return (body, response)
    }
}

final class DeviceAllowlistTests: XCTestCase {
    /// The load-bearing rule from docs/ios.md: the phone must not become the
    /// weakest key path in the system merely because it is the most convenient.
    func testKeyMaterialMethodsAreNeverDeviceCallable() {
        for method in DeviceAllowlist.neverDeviceCallable {
            XCTAssertFalse(DeviceAllowlist.isCallable(method), "\(method) must never be device-callable")
        }
        // Named explicitly so a refactor of the set above cannot quietly drop one.
        for method in ["createWallet", "importWallet", "recoverySetup", "recoveryRestore", "exportEntropy"] {
            XCTAssertFalse(DeviceAllowlist.isCallable(method))
        }
    }

    func testReadsAndWritesAreCallableButUnknownMethodsAreNot() {
        XCTAssertTrue(DeviceAllowlist.isCallable("balance"))
        XCTAssertTrue(DeviceAllowlist.isCallable("policyApprove"))
        XCTAssertFalse(DeviceAllowlist.isCallable("createWallet"))
        XCTAssertFalse(DeviceAllowlist.isCallable("definitelyNotAMethod"))
        // The old full-dispatch temptation: unrelated RPCs stay out.
        XCTAssertFalse(DeviceAllowlist.isCallable("boardPost"))
        XCTAssertFalse(DeviceAllowlist.isCallable("torrentShare"))
    }

    func testAllowlistMembershipIsUnambiguous() {
        XCTAssertTrue(DeviceAllowlist.reads.isDisjoint(with: DeviceAllowlist.writes))
        XCTAssertTrue(DeviceAllowlist.all.isDisjoint(with: DeviceAllowlist.neverDeviceCallable))
    }
}

final class DeviceWireTests: XCTestCase {
    private let base = URL(string: "https://10.0.0.5:2121")!
    private let credential = DeviceCredential(deviceID: "dev_1", token: "secret-token")

    func testRequestCarriesTheCredentialAndTheDeviceMarker() throws {
        let request = try DeviceWire.request(baseURL: base, method: "balance", credential: credential)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Bsv-Device"), "1")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/device/balance")
    }

    /// Browsers always send Origin, native clients never do, so the daemon
    /// refuses any device request that carries one. The client must never
    /// produce such a request.
    func testRequestNeverCarriesAnOriginHeader() throws {
        let request = try DeviceWire.request(baseURL: base, method: "balance", credential: credential)
        XCTAssertNil(request.value(forHTTPHeaderField: DeviceWire.forbiddenHeader))
        for (key, _) in request.allHTTPHeaderFields ?? [:] {
            XCTAssertNotEqual(key.lowercased(), "origin")
        }
    }

    func testDisallowedMethodsFailLocallyRatherThanAtTheDaemon() {
        XCTAssertThrowsError(try DeviceWire.request(baseURL: base, method: "createWallet", credential: credential)) { error in
            XCTAssertEqual(error as? DeviceWire.BuildError, .methodNotAllowed("createWallet"))
        }
    }

    func testDeviceSurfaceIsNotTheLoopbackRoot() throws {
        let request = try DeviceWire.request(baseURL: base, method: "balance", credential: credential)
        XCTAssertTrue(request.url!.path.hasPrefix("/v1/device/"))
        XCTAssertNotEqual(request.url!.path, "/")
    }
}

final class DeviceClientTests: XCTestCase {
    private let base = URL(string: "https://10.0.0.5:2121")!
    private let credential = DeviceCredential(deviceID: "dev_1", token: "t")

    private func client(status: Int, body: String) -> DeviceWalletClient {
        DeviceWalletClient(baseURL: base, credential: credential, client: StubClient(status: status, body: Data(body.utf8)))
    }

    func testDecodesAResultEnvelope() async throws {
        let result: IsAuthenticatedResponse = try await client(status: 200, body: #"{"result":{"authenticated":true}}"#)
            .call("isAuthenticated", params: EmptyParams())
        XCTAssertTrue(result.authenticated)
    }

    func testSurfacesTheDaemonsErrorCode() async throws {
        let sut = client(status: 200, body: #"{"error":{"code":"POLICY_DENY","message":"denied: second approval required"}}"#)
        do {
            let _: IsAuthenticatedResponse = try await sut.call("isAuthenticated", params: EmptyParams())
            XCTFail("expected a policy denial")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "POLICY_DENY")
            XCTAssertTrue(error.isPolicyDenial)
        }
    }

    func testUnauthorisedIsDistinctFromPolicy() async throws {
        let sut = client(status: 403, body: #"{"error":{"code":"FORBIDDEN","message":"not paired"}}"#)
        do {
            let _: IsAuthenticatedResponse = try await sut.call("isAuthenticated", params: EmptyParams())
            XCTFail("expected a failure")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "FORBIDDEN")
            XCTAssertFalse(error.isPolicyDenial)
            XCTAssertFalse(error.isLocked)
        }
    }

    func testLockedIsReportedAsLocked() {
        XCTAssertTrue(WalletError(code: "WALLET_LOCKED", message: "wallet locked").isLocked)
        XCTAssertTrue(WalletError(code: "NO_WALLET", message: "no wallet").isLocked)
        XCTAssertFalse(WalletError(code: "POLICY_DENY", message: "no").isLocked)
    }

    func testGarbageReplyIsNotCrash() async throws {
        let sut = client(status: 200, body: "not json at all")
        do {
            let _: IsAuthenticatedResponse = try await sut.call("isAuthenticated", params: EmptyParams())
            XCTFail("expected a decode failure")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_REPLY")
        }
    }
}

/// Placeholder params for calls that take none.
struct EmptyParams: Codable, Sendable {}
