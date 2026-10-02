import Foundation
import Observation

/// Phase 1's state and behaviour. The views are thin over this; the tests are
/// thorough about it.
///
/// Deliberate choices:
///
/// - Spending is gated by `BiometricGate` *before* the call, and the gate's
///   refusal is surfaced rather than swallowed. The daemon's policy engine
///   remains the real authority; this is the local "is this you?" question,
///   which the daemon cannot ask.
/// - Every failure keeps its `WalletError`, so the UI can say "wallet is
///   locked" or "blocked by spending policy" instead of "something went wrong".
/// - The session never computes an amount for a spend beyond validating that
///   it is positive. Fee arithmetic and policy live in the daemon, and a second
///   implementation here would be a second source of truth.
@MainActor
@Observable
public final class WalletSession {
    public private(set) var authenticated = false
    public private(set) var hasWallet = false
    public private(set) var locked = true
    public private(set) var balance: BalanceResponse?
    public private(set) var qr: AddressQrResponse?
    public private(set) var pending: [PendingRequest] = []
    public private(set) var policies: [PolicyRow] = []
    public private(set) var transactions: [LedgerTransaction] = []
    public private(set) var summary = HistorySummary()

    public private(set) var loading = false
    public private(set) var lastError: WalletError?
    /// A short confirmation for the UI to show and clear.
    public private(set) var notice: String?

    private let backend: WalletBackend
    private let biometrics: BiometricGate

    public init(backend: WalletBackend, biometrics: BiometricGate = AlwaysAuthorisedGate()) {
        self.backend = backend
        self.biometrics = biometrics
    }

    // MARK: - reads

    /// Refresh everything the Phase 1 screens show.
    ///
    /// Reads are attempted individually so one refusal (a locked wallet
    /// answering WALLET_LOCKED to `balance`) does not blank the whole screen.
    public func refresh() async {
        loading = true
        defer { loading = false }
        lastError = nil

        do {
            let status = try await backend.isAuthenticated()
            authenticated = status.authenticated
            hasWallet = status.hasWallet
            locked = status.locked
        } catch let error as WalletError {
            lastError = error
            return
        } catch {
            lastError = WalletError(code: "UNKNOWN", message: String(describing: error))
            return
        }

        // A locked wallet answers WALLET_LOCKED to the wallet reads. Don't treat
        // that as an error: it is a state, and the UI has a button for it.
        if locked {
            balance = nil
            qr = nil
        } else {
            balance = try? await backend.balance()
            qr = try? await backend.addressQr()
        }

        if let history = try? await backend.history() {
            transactions = history.transactions
            policies = history.policies.isEmpty ? policies : history.policies
            summary = history.summary
        }
        if let pendingResponse = try? await backend.policyPending() {
            pending = pendingResponse.requests
        }
        if let list = try? await backend.policyList(), !list.policies.isEmpty {
            policies = list.policies
        }
    }

    // MARK: - lock state

    public func unlock() async {
        await perform("unlock") {
            try await self.backend.unlock()
            await self.refresh()
        }
    }

    public func lock() async {
        await perform("lock") {
            try await self.backend.lock()
            await self.refresh()
        }
    }

    // MARK: - approvals

    /// What we suggest capping a newly approved origin at: the request's own
    /// amount, rounded up a little. Approving should never silently grant far
    /// more than the origin is asking for — the operator can raise it.
    public static func suggestedCap(for request: PendingRequest) -> Int {
        guard request.amountSats > 0 else { return 0 }
        let padded = Int((Double(request.amountSats) * 1.2).rounded(.up))
        // Round to a tidy number so the UI does not show 297.
        let step = 100
        return ((padded + step - 1) / step) * step
    }

    /// Approve an origin. Requires biometric authorisation, because approving
    /// hands an origin the ability to spend without asking again.
    public func approve(_ request: PendingRequest, capSats: Int? = nil) async {
        let cap = capSats ?? Self.suggestedCap(for: request)
        do {
            try await biometrics.require("Approve \(request.origin) to spend up to \(cap) sats")
        } catch {
            lastError = WalletError(code: "BIOMETRIC_DENIED", message: "Not authorised — nothing was approved.")
            return
        }
        await perform("approve \(request.origin)") {
            _ = try await self.backend.policyApprove(origin: request.origin, capSats: cap)
            self.notice = cap > 0 ? "\(request.origin) may now spend up to \(cap) sats" : "\(request.origin) may now ask"
            await self.refresh()
        }
    }

    public func deny(_ request: PendingRequest) async {
        do {
            try await biometrics.require("Block \(request.origin) from spending")
        } catch {
            lastError = WalletError(code: "BIOMETRIC_DENIED", message: "Not authorised — nothing was changed.")
            return
        }
        await perform("deny \(request.origin)") {
            _ = try await self.backend.policyDeny(origin: request.origin)
            self.notice = "\(request.origin) is blocked"
            await self.refresh()
        }
    }

    // MARK: - spend

    /// Send sats. Validates locally only what the daemon would reject anyway
    /// (an empty address, a non-positive amount), then asks for authorisation
    /// and hands the amount to the daemon unchanged.
    public func send(to: String, sats: Int) async -> SendResponse? {
        let address = to.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else {
            lastError = WalletError(code: "BAD_PARAM", message: "Enter a destination address.")
            return nil
        }
        guard sats > 0 else {
            lastError = WalletError(code: "BAD_PARAM", message: "Enter an amount in sats.")
            return nil
        }
        if let balance, sats > balance.total {
            lastError = WalletError(
                code: "INSUFFICIENT",
                message: "That is more than the wallet holds (\(balance.total) sats)."
            )
            return nil
        }
        do {
            try await biometrics.require("Send \(sats) sats to \(address.prefix(12))…")
        } catch {
            lastError = WalletError(code: "BIOMETRIC_DENIED", message: "Not authorised — nothing was sent.")
            return nil
        }

        lastError = nil
        do {
            let result = try await backend.send(to: address, sats: sats)
            notice = "Sent \(sats) sats · fee \(result.fee)"
            await refresh()
            return result
        } catch let error as WalletError {
            lastError = error
            return nil
        } catch {
            lastError = WalletError(code: "UNKNOWN", message: String(describing: error))
            return nil
        }
    }

    // MARK: - plumbing

    public func clearError() { lastError = nil }
    public func clearNotice() { notice = nil }

    /// Run an operation, mapping a `WalletError` into `lastError` and anything
    /// else into a generic one, so no failure is ever silently dropped.
    private func perform(_ what: String, _ body: @escaping () async throws -> Void) async {
        lastError = nil
        do {
            try await body()
        } catch let error as WalletError {
            lastError = error
        } catch {
            lastError = WalletError(code: "UNKNOWN", message: "\(what) failed: \(error)")
        }
    }
}

/// The daemon's *RPC* `isAuthenticated` returns more than the BRC-100 call of
/// the same name: the wire call answers with a bare boolean, while this one
/// carries the lock state the UI needs. They are different shapes from
/// different surfaces, so they are different types.
public struct WalletStatus: Codable, Sendable, Equatable {
    public let authenticated: Bool
    public let locked: Bool
    public let hasWallet: Bool

    public init(authenticated: Bool, locked: Bool, hasWallet: Bool) {
        self.authenticated = authenticated
        self.locked = locked
        self.hasWallet = hasWallet
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        locked = (try? c.decode(Bool.self, forKey: .locked)) ?? true
        hasWallet = (try? c.decode(Bool.self, forKey: .hasWallet)) ?? false
        authenticated = (try? c.decode(Bool.self, forKey: .authenticated)) ?? false
    }
}
