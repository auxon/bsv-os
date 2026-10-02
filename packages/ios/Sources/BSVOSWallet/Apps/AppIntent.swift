import Foundation

/// The intents a hosted app may call, mirroring the daemon's `appInvoke`.
///
/// This list is not a policy decision made here — the daemon enforces it and
/// answers `BAD_METHOD` for anything else. This is the client's copy so a typo
/// fails on the phone with a clear message rather than a round trip, and an
/// npm-side test parses both this file and `appInvoke`'s cases so the two
/// cannot drift. Thirteen intents as of writing; the count in docs/ios.md was
/// stale at ten, which is exactly the kind of thing that test prevents.
public enum AppIntent: String, CaseIterable, Sendable {
    // reads
    case getStatus
    case getIdentity
    case getBalance
    case getUtxos
    // writes, all policy-gated by the daemon
    case timestamp
    case spend
    case inscribe
    case transferNft
    case signSwapOffer
    case completeSwap
    case ordlockLock
    case ordlockBuy
    case ordlockCancel

    /// Reads answer even when the wallet is locked; writes do not.
    public var isRead: Bool {
        switch self {
        case .getStatus, .getIdentity, .getBalance, .getUtxos: return true
        default: return false
        }
    }
}

/// An app as the daemon's registry knows it.
///
/// The phone does NOT keep its own registry: `appList` is on the device
/// allowlist, so installing, removing and listing all happen once, in the
/// daemon, where the manifest hash and the spend cap already live. A second
/// registry on the phone would be a second thing to keep in step.
public struct InstalledApp: Codable, Sendable, Equatable, Identifiable {
    public let domain: String
    public let name: String
    public let startUrl: String
    public let icon: String?
    public let spendCapSats: Int
    public let manifestSha256: String?
    public let intents: [DeclaredIntent]

    public var id: String { domain }

    public init(
        domain: String, name: String, startUrl: String, icon: String? = nil,
        spendCapSats: Int, manifestSha256: String? = nil, intents: [DeclaredIntent] = []
    ) {
        self.domain = domain
        self.name = name
        self.startUrl = startUrl
        self.icon = icon
        self.spendCapSats = spendCapSats
        self.manifestSha256 = manifestSha256
        self.intents = intents
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        domain = try c.decode(String.self, forKey: .domain)
        name = try c.decode(String.self, forKey: .name)
        startUrl = try c.decode(String.self, forKey: .startUrl)
        icon = try? c.decodeIfPresent(String.self, forKey: .icon) ?? nil
        spendCapSats = (try? c.decode(Int.self, forKey: .spendCapSats)) ?? 0
        manifestSha256 = try? c.decodeIfPresent(String.self, forKey: .manifestSha256) ?? nil
        intents = (try? c.decode([DeclaredIntent].self, forKey: .intents)) ?? []
    }

    /// A hosted app needs an https start URL on its own domain — the daemon
    /// validated that at install time, and this refuses to open anything else.
    public var isHostable: Bool {
        guard let url = URL(string: startUrl), url.scheme == "https" else { return false }
        return url.host?.lowercased() == domain.lowercased()
    }
}

/// What an app declares it does, for the app list's "what is this" line.
public struct DeclaredIntent: Codable, Sendable, Equatable {
    public let action: String
    public let label: String?
    public let description: String?

    public init(action: String, label: String? = nil, description: String? = nil) {
        self.action = action
        self.label = label
        self.description = description
    }
}

public struct AppListResponse: Codable, Sendable, Equatable {
    public let apps: [InstalledApp]
    public init(apps: [InstalledApp]) { self.apps = apps }
}

public struct AppMutationResponse: Codable, Sendable, Equatable {
    public let removed: Bool?
    public let app: InstalledApp?
}
