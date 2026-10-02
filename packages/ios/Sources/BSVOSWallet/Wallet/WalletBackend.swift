import Foundation

/// What the UI needs from the wallet, as a protocol.
///
/// The session depends on this rather than on `DeviceWalletClient` directly so
/// the view models can be tested without a daemon, a network, or a TLS
/// certificate — and so a future on-device wallet (Phase 4) can be swapped in
/// behind the same seam without touching the views.
public protocol WalletBackend: Sendable {
    func isAuthenticated() async throws -> WalletStatus
    func unlock() async throws
    func lock() async throws
    func balance() async throws -> BalanceResponse
    func addressQr() async throws -> AddressQrResponse
    func policyPending() async throws -> PolicyPendingResponse
    func policyList() async throws -> PolicyListResponse
    func history() async throws -> HistoryResponse
    func policyApprove(origin: String, capSats: Int) async throws -> PolicyApproveResponse
    func policyDeny(origin: String) async throws -> PolicyApproveResponse
    func send(to: String, sats: Int) async throws -> SendResponse
}

/// The Phase 0 device surface, adapted to `WalletBackend`.
///
/// Every method is one of the allowlisted calls; the daemon refuses anything
/// else, so an accidental addition here fails at runtime rather than silently
/// widening the phone's authority.
public struct DeviceWalletBackend: WalletBackend {
    private let client: DeviceWalletClient

    public init(baseURL: URL, credential: DeviceCredential, http: DeviceHTTPClient = URLSessionDeviceClient()) {
        self.client = DeviceWalletClient(baseURL: baseURL, credential: credential, client: http)
    }

    private struct NoParams: Encodable, Sendable {}

    public func isAuthenticated() async throws -> WalletStatus {
        try await client.call("isAuthenticated", params: NoParams())
    }

    public func unlock() async throws {
        let _: UnlockAck = try await client.call("unlock", params: NoParams())
    }

    public func lock() async throws {
        let _: UnlockAck = try await client.call("lock", params: NoParams())
    }

    public func balance() async throws -> BalanceResponse {
        try await client.call("balance", params: NoParams())
    }

    public func addressQr() async throws -> AddressQrResponse {
        try await client.call("addressQr", params: NoParams())
    }

    public func policyPending() async throws -> PolicyPendingResponse {
        try await client.call("policyPending", params: NoParams())
    }

    public func policyList() async throws -> PolicyListResponse {
        try await client.call("policyList", params: NoParams())
    }

    public func history() async throws -> HistoryResponse {
        try await client.call("history", params: NoParams())
    }

    private struct ApproveParams: Encodable, Sendable {
        let origin: String
        let capSats: Int
        let auto: Bool
        // The daemon reads snake_case here.
        enum CodingKeys: String, CodingKey { case origin, capSats = "capSats", auto }
    }

    public func policyApprove(origin: String, capSats: Int) async throws -> PolicyApproveResponse {
        try await client.call("policyApprove", params: ApproveParams(origin: origin, capSats: capSats, auto: false))
    }

    private struct DenyParams: Encodable, Sendable { let origin: String }

    public func policyDeny(origin: String) async throws -> PolicyApproveResponse {
        try await client.call("policyDeny", params: DenyParams(origin: origin))
    }

    private struct SendParams: Encodable, Sendable { let to: String; let sats: Int }

    public func send(to: String, sats: Int) async throws -> SendResponse {
        try await client.call("send", params: SendParams(to: to, sats: sats))
    }
}

/// The daemon answers ack-style calls with a bare object; this decodes it
/// without caring about its contents.
struct UnlockAck: Decodable, Sendable {
    init(from decoder: Decoder) throws {}
}

/// Biometric authorisation for anything that spends.
///
/// A protocol, for two reasons: the simulator has no enrolled face, and a test
/// must be able to assert that a *failed* check stops the spend. That behaviour
/// is the whole point of the gate, so it has to be testable.
public protocol BiometricGate: Sendable {
    /// True when the platform can actually evaluate a policy.
    func isAvailable() -> Bool
    /// Throws when the user is not authorised. The throw is the denial.
    func require(_ reason: String) async throws
}

public enum BiometricError: Error, Equatable {
    case unavailable
    case denied
    case cancelled
}
