import Foundation

/// The methods a paired iOS device may call on the daemon.
///
/// This is the Swift half of the design in `docs/ios.md`: the device surface is
/// an explicit allowlist rather than the daemon's full dispatch, because the
/// loopback surface has ~192 methods and only had that luxury because loopback
/// needed no authentication.
///
/// An npm-side test (`packages/walletd/test/ios-parity.test.mjs`) parses this
/// file and the design doc and fails if they disagree, so widening the list
/// means editing the doc and the expectation on purpose — never by accident.
public enum DeviceAllowlist {
    /// Reads. No custody effect.
    public static let reads: Set<String> = [
        "isAuthenticated",
        "getVersion",
        "getNetwork",
        "getHeight",
        "getHeader",
        "balance",
        "addressQr",
        "history",
        "policyList",
        "policyPending",
        "listPending",
        "utxos",
        "ordList",
        "bsv21List",
        "appList",
    ]

    /// Writes the phone is allowed to attempt. Every one still runs through the
    /// daemon's policy engine under a `device:<name>` origin, so caps and the
    /// ask-then-approve loop apply exactly as they do for the CLI.
    ///
    /// `pay`, `requestCreate` and `requestPay` are deliberately absent: each
    /// resolves a person before spending, and that path hardcodes the `cli`
    /// origin today. Supporting them from a device means threading an origin
    /// through the person-resolution code, which is Phase 1 work. See
    /// docs/ios.md.
    public static let writes: Set<String> = [
        "lock",
        "unlock",
        "policyApprove",
        "policyDeny",
        "send",
        "anchorFile",
        "sweepOut",
        "inscribe",
        "appInvoke",
    ]

    /// Methods that must never be reachable from a device, however convenient
    /// it would be.
    ///
    /// These are the key-material paths. On the desktop they are terminal-only;
    /// on iOS there is no terminal, which makes it tempting to expose them —
    /// and that is exactly why this list exists as data rather than as a
    /// comment. The phone must not become the weakest key path in the system
    /// merely because it is the most convenient one.
    public static let neverDeviceCallable: Set<String> = [
        "createWallet",
        "importWallet",
        "recoverySetup",
        "recoveryRotate",
        "recoveryRestore",
        "exportEntropy",
        "twetchAccountImport",
        "twetchAccountImportFromPhrase",
        "twetchAccountImportFromSeed",
    ]

    public static var all: Set<String> { reads.union(writes) }

    public static func isCallable(_ method: String) -> Bool {
        all.contains(method) && !neverDeviceCallable.contains(method)
    }
}

/// A device credential minted by the pairing step described in `docs/ios.md`.
///
/// Stored in the iOS Keychain, Secure-Enclave-wrapped, released only after
/// Face ID. The daemon keeps only a hash of `token`, so a database read does not
/// yield a usable credential.
public struct DeviceCredential: Sendable, Equatable, Codable {
    public let deviceID: String
    public let token: String

    public init(deviceID: String, token: String) {
        self.deviceID = deviceID
        self.token = token
    }

    // The daemon writes `deviceId`; everything in this package calls it
    // deviceID. The mapping lives here rather than at each call site.
    enum CodingKeys: String, CodingKey {
        case deviceID = "deviceId"
        case token
    }
}

public struct PairingRequest: Codable, Sendable, Equatable {
    /// The one-time code shown by `bsv device pair` on the desktop.
    public let code: String
    public let name: String
    public let platform: String

    public init(code: String, name: String, platform: String = "ios") {
        self.code = code
        self.name = name
        self.platform = platform
    }
}

public struct PairingResponse: Codable, Sendable, Equatable {
    public let deviceId: String
    public let token: String

    public init(deviceId: String, token: String) {
        self.deviceId = deviceId
        self.token = token
    }
}
