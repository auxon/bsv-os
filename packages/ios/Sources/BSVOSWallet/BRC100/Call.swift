import Foundation

/// The 28 BRC-100 calls this wallet implements.
///
/// The raw values and codes are the daemon's `WIRE_CALL_CODES`
/// (`packages/walletd/src/index.ts`). An npm-side test
/// (`packages/walletd/test/ios-parity.test.mjs`) parses both that table and this
/// enum and fails if they ever diverge, so the Swift client cannot silently
/// drift from the wallet it talks to.
public enum BRC100Call: String, CaseIterable, Sendable {
    case createAction
    case signAction
    case abortAction
    case listActions
    case internalizeAction
    case listOutputs
    case relinquishOutput
    case getPublicKey
    case revealCounterpartyKeyLinkage
    case revealSpecificKeyLinkage
    case encrypt
    case decrypt
    case createHmac
    case verifyHmac
    case createSignature
    case verifySignature
    case acquireCertificate
    case listCertificates
    case proveCertificate
    case relinquishCertificate
    case discoverByIdentityKey
    case discoverByAttributes
    case isAuthenticated
    case waitForAuthentication
    case getHeight
    case getHeader
    case getNetwork
    case getVersion

    /// The numeric code used by the binary wire transport (`/w/:call`).
    ///
    /// Written as an explicit switch rather than derived from the case order:
    /// reordering the enum must not silently renumber the wire, because the
    /// daemon's dispatch depends on these values.
    public var wireCode: Int {
        switch self {
        case .createAction: return 1
        case .signAction: return 2
        case .abortAction: return 3
        case .listActions: return 4
        case .internalizeAction: return 5
        case .listOutputs: return 6
        case .relinquishOutput: return 7
        case .getPublicKey: return 8
        case .revealCounterpartyKeyLinkage: return 9
        case .revealSpecificKeyLinkage: return 10
        case .encrypt: return 11
        case .decrypt: return 12
        case .createHmac: return 13
        case .verifyHmac: return 14
        case .createSignature: return 15
        case .verifySignature: return 16
        case .acquireCertificate: return 17
        case .listCertificates: return 18
        case .proveCertificate: return 19
        case .relinquishCertificate: return 20
        case .discoverByIdentityKey: return 21
        case .discoverByAttributes: return 22
        case .isAuthenticated: return 23
        case .waitForAuthentication: return 24
        case .getHeight: return 25
        case .getHeader: return 26
        case .getNetwork: return 27
        case .getVersion: return 28
        }
    }

    /// Calls that only read public chain state, so they are safe to expose to a
    /// remote client without touching custody.
    public var isPublicRead: Bool {
        switch self {
        case .getVersion, .getNetwork, .getHeight, .getHeader: return true
        default: return false
        }
    }

    /// Calls that move value or sign. Remote exposure of these must go through
    /// policy, never straight to custody.
    public var movesValueOrSigns: Bool {
        switch self {
        case .createAction, .signAction, .internalizeAction, .relinquishOutput,
             .createSignature, .createHmac, .encrypt, .decrypt,
             .acquireCertificate, .proveCertificate, .relinquishCertificate,
             .revealCounterpartyKeyLinkage, .revealSpecificKeyLinkage:
            return true
        default:
            return false
        }
    }
}

/// The daemon's error envelope, as returned by its JSON surface.
///
/// The codes are the ones `brc100.ts` actually raises. They are strings rather
/// than an enum because the daemon may add codes and a client that refuses to
/// decode an unknown one would break on a server upgrade.
public struct WalletError: Error, Codable, Sendable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    /// Written plainly, because the UI shouldn't have to know the taxonomy.
    public var isLocked: Bool { code == "WALLET_LOCKED" || code == "NO_WALLET" }
    public var isPolicyDenial: Bool { code == "POLICY_DENY" }
}
