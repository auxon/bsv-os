import Foundation

/// The methods a paired iOS device may call: **the operator tier** (option A in
/// docs/ios.md).
///
/// This is the Swift mirror of `DEVICE_READS` / `DEVICE_WRITES` in
/// `packages/walletd/src/device.ts`, and an npm-side test
/// (`packages/walletd/test/ios-parity.test.mjs`) parses both and fails if they
/// disagree. Widening access therefore means editing the daemon and this file
/// together, on purpose.
///
/// The tier is 109 methods, and the trade is deliberate: the phone can do everything
/// the desktop panel can, spends remain gated by the daemon's policy engine, and
/// key material stays out. The daemon is the enforcement point; this copy exists
/// so a mistyped call fails on the phone with a clear message instead of a round
/// trip.
public enum DeviceAllowlist {
    /// Reads. Not policy-gated, and no origin is involved. Most still need an
    /// unlocked wallet: only isAuthenticated and getVersion answer while locked.
    public static let reads: Set<String> = [
        "isAuthenticated", "getVersion", "balance", "addressQr", "history", "policyList",
        "policyPending", "pending", "utxos", "doctor", "ordList", "bsv21List", "appList",
        "appOpen", "storeList", "identitySession", "identityConfigStatus",
        "identityLoginStatus", "certList", "certShow", "profileGet", "contactList", "p2pPeers",
        "msgList", "msgShow", "requestList", "requestCode", "receiptList", "receiptShow",
        "faucetStatus", "recoveryStatus", "gigBoard", "gigList", "shiftList", "shiftRuns",
        "streamTicks", "overlayHealth", "overlayLookup", "torrentList", "twetchStatus",
        "twetchFeed", "twetchNotifications", "twetchUser", "twetchList", "twetchMarket",
        "twetchMemes", "twetchMemeFolders", "castEpisodes", "castLiveGet", "agentList",
        "askList", "classifyMeme",
    ]

    /// Writes. Every spend among them still runs through the daemon's policy
    /// engine under an origin: the device's own (`device:<name>`) for operator
    /// spends, and the app's existing origin for app activity, so an app on the
    /// phone carries the policy identity it has on the desktop.
    public static let writes: Set<String> = [
        "lock", "unlock", "policyApprove", "policyDeny", "send", "pay", "sweepOut",
        "anchorFile", "inscribe", "requestCreate", "requestDecline", "requestImport",
        "requestPay", "receiptIssue", "faucetClaim", "appInstall", "appRemove", "appUpdate",
        "appLaunch", "appInvoke", "registerPush", "identityConfigure", "identityLoginStart",
        "identityLogout", "profileSet", "contactAdd", "certRevoke", "msgSend", "msgAck",
        "msgSync", "agentMint", "agentRevoke", "gigTrack", "gigUntrack", "gigClaim",
        "streamPause", "streamResume", "boardCreate", "boardThread", "askPost", "askAccept",
        "askAnswer", "askGrade", "askTriage", "torrentFetch", "torrentRemove", "twetchPost",
        "twetchIndex", "twetchBuy", "castAdd", "castPlay", "castStop", "castSetMedia",
        "castLiveStart", "castLiveStop", "marketCancel", "ordInscribe",
    ]

    /// Key-material methods. Never device-callable.
    ///
    /// Unchanged by the operator tier, and worth stating why: option A exists so
    /// the phone can do what the desktop panel can, and the panel refuses these
    /// too — terminal-only there, and there is no terminal here.
    public static let neverDeviceCallable: Set<String> = [
        "createWallet", "importWallet", "recoverySetup", "recoveryRotate", "recoveryRestore",
        "exportEntropy", "twetchAccountImport", "twetchAccountImportFromPhrase",
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
