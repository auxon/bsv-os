import Foundation

/// Phase 0 transport: a paired device talking to the daemon's device surface
/// over WireGuard. See `docs/ios.md`.
///
/// The request construction lives in a pure function so it can be tested
/// without a network, and so the two security-relevant headers cannot be
/// dropped by an accident elsewhere.
public enum DeviceWire {
    /// Path prefix for the device surface. Deliberately not `/`, which is the
    /// loopback-only wallet RPC.
    public static let pathPrefix = "/v1/device/"

    public static let authorizationHeader = "Authorization"
    public static let deviceHeader = "X-Bsv-Device"

    /// The daemon refuses any device request carrying an `Origin` header —
    /// browsers always send one, native clients never do, so its presence means
    /// a web page (or a stray browser on the LAN) is reaching for the wallet.
    public static let forbiddenHeader = "Origin"

    public enum BuildError: Error, Equatable {
        case methodNotAllowed(String)
        case invalidBaseURL
    }

    /// Build a device request.
    ///
    /// Throws `methodNotAllowed` rather than sending a call the daemon would
    /// refuse: failing locally keeps the allowlist authoritative on both sides.
    public static func request(
        baseURL: URL,
        method: String,
        params: Data = Data("{}".utf8),
        credential: DeviceCredential
    ) throws -> URLRequest {
        guard DeviceAllowlist.isCallable(method) else {
            throw BuildError.methodNotAllowed(method)
        }
        guard let url = URL(string: pathPrefix + method, relativeTo: baseURL) else {
            throw BuildError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = params
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: authorizationHeader)
        request.setValue("1", forHTTPHeaderField: deviceHeader)
        // Note the absence of an Origin header, asserted by a test.
        return request
    }
}

/// Minimal HTTP seam so the transport is testable without a daemon.
public protocol DeviceHTTPClient: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionDeviceClient: DeviceHTTPClient {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw WalletError(code: "BAD_REPLY", message: "response was not HTTP")
        }
        return (data, http)
    }
}

/// Calls the device surface and decodes either a result or the daemon's error.
public struct DeviceWalletClient: Sendable {
    private let baseURL: URL
    private let credential: DeviceCredential
    private let client: DeviceHTTPClient
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(baseURL: URL, credential: DeviceCredential, client: DeviceHTTPClient = URLSessionDeviceClient()) {
        self.baseURL = baseURL
        self.credential = credential
        self.client = client
    }

    /// The daemon's device surface mirrors the wallet's JSON shape:
    /// `{"result": …}` on success, `{"error": {"code", "message"}}` otherwise.
    private struct Envelope<T: Decodable>: Decodable {
        let result: T?
        let error: WalletError?
    }

    public func call<Result: Decodable & Sendable>(
        _ method: String,
        params: some Encodable & Sendable,
        as: Result.Type = Result.self
    ) async throws -> Result {
        let body = try encoder.encode(params)
        let request = try DeviceWire.request(baseURL: baseURL, method: method, params: body, credential: credential)
        let (data, http) = try await client.send(request)

        if http.statusCode == 403 || http.statusCode == 401 {
            // Distinguish an authorisation failure from a policy denial: the
            // first means this device is not paired (or was revoked), the
            // second means the wallet said no. Both are 403 on the wire.
            if let envelope = try? decoder.decode(Envelope<Result>.self, from: data),
               let error = envelope.error {
                throw error
            }
            throw WalletError(code: "UNAUTHORIZED", message: "device is not paired, or was revoked")
        }

        let envelope: Envelope<Result>
        do {
            envelope = try decoder.decode(Envelope<Result>.self, from: data)
        } catch {
            throw WalletError(code: "BAD_REPLY", message: "could not decode the daemon's reply: \(error)")
        }
        if let error = envelope.error { throw error }
        guard let result = envelope.result else {
            throw WalletError(code: "BAD_REPLY", message: "reply carried neither result nor error")
        }
        return result
    }
}
