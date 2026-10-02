import Foundation
#if canImport(LocalAuthentication)
import LocalAuthentication
#endif

#if canImport(LocalAuthentication)
/// Face ID / Touch ID, or the device passcode as a fallback.
///
/// `deviceOwnerAuthentication` rather than `deviceOwnerAuthenticationWithBiometrics`
/// on purpose: a phone whose sensor fails should fall back to the passcode, not
/// lock the owner out of their own wallet. The threat being resisted is someone
/// holding an unlocked phone, and the passcode already answers that.
public struct LocalAuthenticationGate: BiometricGate {
    public init() {}

    public func isAvailable() -> Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    public func require(_ reason: String) async throws {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw BiometricError.unavailable
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            guard ok else { throw BiometricError.denied }
        } catch let failure as LAError {
            switch failure.code {
            case .userCancel, .systemCancel, .appCancel:
                throw BiometricError.cancelled
            default:
                throw BiometricError.denied
            }
        }
    }
}
#else
/// Platforms without LocalAuthentication (Linux CI, for one) get an explicit
/// refusal rather than a silent pass — a gate that fails open is worse than one
/// that is missing, because it looks like protection.
public struct LocalAuthenticationGate: BiometricGate {
    public init() {}
    public func isAvailable() -> Bool { false }
    public func require(_ reason: String) async throws { throw BiometricError.unavailable }
}
#endif

/// Always authorises. For tests, previews, and the simulator.
public struct AlwaysAuthorisedGate: BiometricGate {
    public init() {}
    public func isAvailable() -> Bool { true }
    public func require(_ reason: String) async throws {}
}

/// Always refuses. Cf. the note above: this is what a missing sensor should do.
public struct DenyingGate: BiometricGate {
    public init() {}
    public func isAvailable() -> Bool { false }
    public func require(_ reason: String) async throws { throw BiometricError.denied }
}
