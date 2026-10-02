import XCTest
@testable import BSVOSWallet

/// Serves canned HTTP so pairing can be tested without a daemon.
private struct StubHTTP: DeviceHTTPClient {
    let status: Int
    let body: String
    var captured: (@Sendable (URLRequest) -> Void)? = nil

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        captured?(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), response)
    }
}

final class PairingTests: XCTestCase {
    private let base = URL(string: "https://10.0.0.5:2121")!

    func testPairingReturnsACredentialAndSendsTheCodeUppercased() async throws {
        let box = RequestBox()
        let http = StubHTTP(
            status: 200,
            body: #"{"result":{"deviceId":"dev_abc123","token":"deadbeef"}}"#,
            captured: { box.record($0) }
        )
        let client = DevicePairingClient(baseURL: base, http: http)

        let credential = try await client.pair(code: " bu5kxb7w ", name: "iPhone")

        XCTAssertEqual(credential.deviceID, "dev_abc123")
        XCTAssertEqual(credential.token, "deadbeef")
        let request = try XCTUnwrap(box.last)
        XCTAssertEqual(request.url?.path, "/v1/device/pair")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Bsv-Device"), "1")
        // Pairing is unauthenticated: no bearer, and never an Origin.
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: DeviceWire.forbiddenHeader))
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["code"] as? String, "BU5KXB7W", "the code is normalised")
        XCTAssertEqual(json["platform"] as? String, "ios")
    }

    func testAShortCodeIsRejectedWithoutCallingTheDaemon() async {
        let box = RequestBox()
        let http = StubHTTP(status: 200, body: "{}", captured: { box.record($0) })
        let client = DevicePairingClient(baseURL: base, http: http)

        do {
            _ = try await client.pair(code: "abc", name: "iPhone")
            XCTFail("expected a refusal")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_CODE")
        } catch {
            XCTFail("unexpected error \(error)")
        }
        XCTAssertNil(box.last, "nothing was sent")
    }

    func testTheDaemonsRefusalKeepsItsCode() async {
        let http = StubHTTP(
            status: 403,
            body: #"{"error":{"code":"NO_PAIRING","message":"no pairing is open — run `bsv device pair` on the desktop"}}"#
        )
        let client = DevicePairingClient(baseURL: base, http: http)

        do {
            _ = try await client.pair(code: "BU5KXB7W", name: "iPhone")
            XCTFail("expected a refusal")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "NO_PAIRING")
            XCTAssertTrue(error.message.contains("bsv device pair"), "the message tells you what to do")
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testGarbageFromTheDaemonIsNotACrash() async {
        let client = DevicePairingClient(baseURL: base, http: StubHTTP(status: 200, body: "not json"))
        do {
            _ = try await client.pair(code: "BU5KXB7W", name: "iPhone")
            XCTFail("expected a refusal")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, "BAD_REPLY")
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testCredentialRoundTripsThroughCodable() throws {
        // The daemon writes deviceId; the package calls it deviceID. A silent
        // mismatch here would store a credential that never authenticates.
        let encoded = try JSONEncoder().encode(DeviceCredential(deviceID: "dev_1", token: "t"))
        let json = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        XCTAssertTrue(json.contains("\"deviceId\""), "the wire key, not deviceID: \(json)")

        let decoded = try JSONDecoder().decode(DeviceCredential.self, from: encoded)
        XCTAssertEqual(decoded.deviceID, "dev_1")
        XCTAssertEqual(decoded.token, "t")
    }
}

final class CredentialStoreTests: XCTestCase {
    func testInMemoryStoreRoundTrips() throws {
        let store = InMemoryCredentialStore()
        XCTAssertNil(try store.load())

        let credential = DeviceCredential(deviceID: "dev_1", token: "secret")
        try store.save(credential)
        XCTAssertEqual(try store.load(), credential)

        try store.clear()
        XCTAssertNil(try store.load())
    }

    func testSavingTwiceReplacesRatherThanDuplicating() throws {
        let store = InMemoryCredentialStore()
        try store.save(DeviceCredential(deviceID: "dev_1", token: "first"))
        try store.save(DeviceCredential(deviceID: "dev_2", token: "second"))
        XCTAssertEqual(try store.load()?.deviceID, "dev_2", "re-pairing must not leave the old credential")
    }
}

/// Collects requests from concurrent test code without data races.
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
    }

    var last: URLRequest? {
        lock.lock(); defer { lock.unlock() }
        return requests.last
    }
}
