import Foundation
import CryptoKit

/// The app registry, behind a seam.
///
/// On the daemon the registry is two SQLite tables plus manifest pinning; on
/// the phone it is a JSON document plus the same `/manifest.json` fetch and the
/// same validation rules (`apps.ts`). Same contract, so an app installed on one
/// front end is the same app on the other.
///
/// Installing seeds a pending policy request per declared intent, exactly as
/// the daemon does: the store listing says what an app will ask to spend, and
/// the queue is where the human answers.
public protocol AppRegistry: Sendable {
    func list() async throws -> [InstalledApp]
    func install(domain: String, manifestJson: String?) async throws -> InstalledApp
    func remove(domain: String) async throws
}

public enum AppRegistryError: Error, Equatable, LocalizedError {
    case badDomain
    case badManifest(String)
    case fetchFailed(Int)
    case unsupportedVersion(Int)

    public var errorDescription: String? {
        switch self {
        case .badDomain: return "that does not look like an app domain"
        case .badManifest(let why): return why
        case .fetchFailed(let code): return "the manifest request failed (\(code))"
        case .unsupportedVersion(let version): return "the registry file is from a newer app version (\(version))"
        }
    }
}

public protocol AppRegistryStore: Sendable {
    func all() async throws -> [InstalledApp]
    func save(_ app: InstalledApp) async throws
    func remove(domain: String) async throws
}

public actor InMemoryAppRegistryStore: AppRegistryStore {
    private var apps: [String: InstalledApp]

    public init(initial: [InstalledApp] = []) {
        apps = Dictionary(uniqueKeysWithValues: initial.map { ($0.domain, $0) })
    }

    public func all() async throws -> [InstalledApp] {
        apps.values.sorted { $0.domain < $1.domain }
    }

    public func save(_ app: InstalledApp) async throws {
        apps[app.domain] = app
    }

    public func remove(domain: String) async throws {
        apps.removeValue(forKey: domain)
    }
}

public actor FileAppRegistryStore: AppRegistryStore {
    private struct Snapshot: Codable {
        static let currentVersion = 1
        var version: Int
        var apps: [InstalledApp]

        static let empty = Snapshot(version: currentVersion, apps: [])
    }

    private let url: URL
    private var snapshot: Snapshot

    public init(url: URL) throws {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            let loaded = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
            guard loaded.version == Snapshot.currentVersion else {
                throw AppRegistryError.unsupportedVersion(loaded.version)
            }
            snapshot = loaded
        } else {
            snapshot = .empty
        }
    }

    public static func defaultURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        let directory = base.appendingPathComponent("BSVOS", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("apps.json")
    }

    private func persist() throws {
        try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
    }

    public func all() async throws -> [InstalledApp] {
        snapshot.apps.sorted { $0.domain < $1.domain }
    }

    public func save(_ app: InstalledApp) async throws {
        if let index = snapshot.apps.firstIndex(where: { $0.domain == app.domain }) {
            snapshot.apps[index] = app
        } else {
            snapshot.apps.append(app)
        }
        try persist()
    }

    public func remove(domain: String) async throws {
        snapshot.apps.removeAll { $0.domain == domain }
        try persist()
    }
}

/// The daemon-backed registry: the device allowlist's appList/appInstall/appRemove.
public struct DeviceAppRegistry: AppRegistry {
    private let client: DeviceWalletClient

    public init(baseURL: URL, credential: DeviceCredential, http: DeviceHTTPClient = URLSessionDeviceClient()) {
        self.client = DeviceWalletClient(baseURL: baseURL, credential: credential, client: http)
    }

    private struct NoParams: Encodable, Sendable {}
    private struct InstallParams: Encodable, Sendable { let domain: String; let manifestJson: String? }
    private struct RemoveParams: Encodable, Sendable { let domain: String }
    private struct InstallReply: Decodable, Sendable { let app: InstalledApp? }

    public func list() async throws -> [InstalledApp] {
        let response: AppListResponse = try await client.call("appList", params: NoParams())
        return response.apps
    }

    public func install(domain: String, manifestJson: String?) async throws -> InstalledApp {
        let reply: InstallReply = try await client.call("appInstall", params: InstallParams(domain: domain, manifestJson: manifestJson))
        guard let app = reply.app else {
            throw WalletError(code: "BAD_REPLY", message: "the daemon did not return the installed app")
        }
        return app
    }

    public func remove(domain: String) async throws {
        let _: AppMutationResponse = try await client.call("appRemove", params: RemoveParams(domain: domain))
    }
}

/// The phone's registry. Fetches the manifest itself, validates it by the
/// daemon's rules, pins its hash, and queues the declared intents.
public struct LocalAppRegistry: AppRegistry {
    private let store: any AppRegistryStore
    private let transport: any ChainTransport
    private let policy: PolicyEngine
    private let now: @Sendable () -> Int

    public init(
        store: any AppRegistryStore,
        transport: any ChainTransport = URLSessionTransport(),
        policy: PolicyEngine,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.store = store
        self.transport = transport
        self.policy = policy
        self.now = now
    }

    public func list() async throws -> [InstalledApp] {
        try await store.all()
    }

    public func install(domain rawDomain: String, manifestJson: String?) async throws -> InstalledApp {
        let domain = try Self.normalize(domain: rawDomain)
        let body: Data
        if let manifestJson {
            body = Data(manifestJson.utf8)
        } else {
            let (data, code) = try await transport.get(URL(string: "https://\(domain)/manifest.json")!)
            guard (200..<300).contains(code) else { throw AppRegistryError.fetchFailed(code) }
            body = data
        }
        let manifest = try JSONSerialization.jsonObject(with: body)
        let validated = try AppManifestValidator.validate(domain: domain, manifest: manifest)
        let existing = try await store.all().first { $0.domain == domain }
        let app = InstalledApp(
            domain: domain,
            name: validated.name,
            startUrl: validated.startUrl,
            icon: validated.icon,
            spendCapSats: existing?.spendCapSats ?? validated.spendCapSats,
            manifestSha256: AppManifestValidator.manifestSha256(manifest),
            intents: validated.intents
        )
        try await store.save(app)
        // The daemon's install ceremony: every declared intent is a pending
        // request, so the human approves the vocabulary before it is used.
        for intent in validated.intents {
            try await policy.seedRequest(origin: domain, amountSats: intent.typicalSats ?? 0, action: intent.action)
        }
        return app
    }

    public func remove(domain rawDomain: String) async throws {
        let domain = try Self.normalize(domain: rawDomain)
        try await store.remove(domain: domain)
    }

    static func normalize(domain: String) throws -> String {
        let clean = domain
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
            .split(separator: "/").first.map(String.init) ?? ""
        let valid = clean.range(of: "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", options: .regularExpression) != nil
        guard clean.count <= 253, valid else {
            throw AppRegistryError.badDomain
        }
        return clean
    }
}

/// The daemon's `validateManifest`, in Swift.
public enum AppManifestValidator {
    public struct Validated: Sendable {
        public var name: String
        public var startUrl: String
        public var icon: String?
        public var spendCapSats: Int
        public var intents: [DeclaredIntent]
    }

    public static func validate(domain: String, manifest: Any) throws -> Validated {
        guard let m = manifest as? [String: Any] else {
            throw AppRegistryError.badManifest("manifest is not an object")
        }
        let name = (m["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw AppRegistryError.badManifest("manifest.name is required") }
        guard name.count <= 80 else { throw AppRegistryError.badManifest("manifest.name too long") }

        let origin = "https://\(domain)"
        guard let base = URL(string: origin),
              let start = URL(string: m["start_url"] as? String ?? "/", relativeTo: base)?.absoluteURL else {
            throw AppRegistryError.badManifest("manifest.start_url is not a URL")
        }
        guard start.scheme == "https" else {
            throw AppRegistryError.badManifest("manifest.start_url must resolve to https")
        }
        guard start.host?.lowercased() == domain.lowercased() else {
            throw AppRegistryError.badManifest("start_url escapes the app origin")
        }

        var icon: String? = nil
        if let icons = m["icons"] as? [[String: Any]] {
            for candidate in icons {
                if let src = candidate["src"] as? String,
                   let resolved = URL(string: src, relativeTo: base)?.absoluteURL,
                   resolved.scheme != nil {
                    icon = resolved.absoluteString
                    break
                }
            }
        }

        let metanet = m["metanet"] as? [String: Any] ?? [:]
        let groupPermissions = metanet["groupPermissions"] as? [String: Any] ?? [:]
        let authorization = groupPermissions["spendingAuthorization"] as? [String: Any] ?? [:]
        let amount = (authorization["amount"] as? NSNumber)?.doubleValue ?? 0
        let spendCapSats = max(0, Int(amount.rounded(.down)))

        return Validated(
            name: String(name.prefix(80)),
            startUrl: start.absoluteString,
            icon: icon,
            spendCapSats: spendCapSats,
            intents: try validateIntents(metanet["intents"])
        )
    }

    static func validateIntents(_ raw: Any?) throws -> [DeclaredIntent] {
        guard let raw else { return [] }
        guard let entries = raw as? [Any], entries.count <= 32 else {
            throw AppRegistryError.badManifest("metanet.intents must be an array of at most 32 intents")
        }
        var intents: [DeclaredIntent] = []
        for (index, entry) in entries.enumerated() {
            guard let o = entry as? [String: Any] else {
                throw AppRegistryError.badManifest("metanet.intents[\(index)] must be an object")
            }
            let action = (o["action"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !action.isEmpty, action.count <= 64 else {
                throw AppRegistryError.badManifest("metanet.intents[\(index)].action is required (at most 64 chars)")
            }
            var label: String? = nil
            if let rawLabel = o["label"] {
                let clean = (rawLabel as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !clean.isEmpty, clean.count <= 80 else {
                    throw AppRegistryError.badManifest("metanet.intents[\(index)].label must be 1-80 chars")
                }
                label = clean
            }
            var description: String? = nil
            if let rawDescription = o["description"] {
                let clean = (rawDescription as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !clean.isEmpty, clean.count <= 200 else {
                    throw AppRegistryError.badManifest("metanet.intents[\(index)].description must be 1-200 chars")
                }
                description = clean
            }
            var typicalSats: Int? = nil
            if let rawTypical = o["typical_sats"] {
                let value = (rawTypical as? NSNumber)?.doubleValue
                guard let value, value.isFinite, value >= 0 else {
                    throw AppRegistryError.badManifest("metanet.intents[\(index)].typical_sats must be a non-negative sat number")
                }
                typicalSats = Int(value.rounded(.down))
            }
            intents.append(DeclaredIntent(action: action, label: label, description: description, typicalSats: typicalSats))
        }
        return intents
    }

    // MARK: - canonical manifest hashing

    /// The daemon's `manifestSha256` (apps.ts): SHA-256 over the canonical
    /// re-serialization of the parsed manifest, not over the raw body.
    ///
    /// The two hosts must compute the same value for the same manifest. The
    /// phone stores it beside an installed app; the daemon stores its own in
    /// `apps.manifest_sha256`, and a formatting difference between two servers
    /// must not look like a changed manifest.
    public static func manifestSha256(_ manifest: Any) -> String {
        Hex.encode(Array(SHA256.hash(data: Data(stableStringify(manifest).utf8))))
    }

    /// The daemon's `stableStringify`: keys sorted by UTF-16 code unit (JS
    /// string order), arrays in order, and the escaping `JSON.stringify` uses.
    public static func stableStringify(_ value: Any) -> String {
        if value is NSNull { return "null" }
        if let dictionary = value as? [String: Any] {
            let entries = dictionary.keys
                .sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
                .map { "\(jsonString($0)):\(stableStringify(dictionary[$0]!))" }
            return "{" + entries.joined(separator: ",") + "}"
        }
        if let array = value as? [Any] {
            return "[" + array.map(stableStringify).joined(separator: ",") + "]"
        }
        if let string = value as? String { return jsonString(string) }
        if let number = value as? NSNumber {
            // JSONSerialization hands booleans back as NSNumbers whose
            // objCType is 'c' — the same trick every JSON bridge needs.
            if String(cString: number.objCType) == "c" {
                return number.boolValue ? "true" : "false"
            }
            let double = number.doubleValue
            if double.rounded() == double, abs(double) < 9_007_199_254_740_992 {
                return String(Int64(double))
            }
            return String(double)
        }
        return "null"
    }

    /// `JSON.stringify` for one string: quotes, backslashes and control
    /// characters are escaped; `/` and non-ASCII stay raw.
    static func jsonString(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let other where other.value < 0x20:
                out += String(format: "\\u%04x", other.value)
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}

/// What the Apps screens need, whichever wallet this launch uses: a registry
/// and a way to build a `window.bsv` bridge for one installed app.
public struct AppsContext: Sendable {
    public let registry: any AppRegistry
    public let makeBridge: @Sendable (InstalledApp) -> AppBridge
    /// Names of the apps that ride in the bundle, served without a daemon.
    public let bundledApps: [String]
    /// Builds a host for one bundled app. Nil when this launch has none —
    /// the daemon serves the stock apps instead.
    public let makeBundledHost: (@MainActor (String) -> BundledAppHost)?

    public init(
        registry: any AppRegistry,
        bundledApps: [String] = [],
        makeBundledHost: (@MainActor (String) -> BundledAppHost)? = nil,
        makeBridge: @escaping @Sendable (InstalledApp) -> AppBridge
    ) {
        self.registry = registry
        self.bundledApps = bundledApps
        self.makeBundledHost = makeBundledHost
        self.makeBridge = makeBridge
    }
}
