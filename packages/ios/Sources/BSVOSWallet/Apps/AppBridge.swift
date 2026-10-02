import Foundation

/// The native half of the `window.bsv` bridge.
///
/// Kept free of WebKit so it can be tested directly: the rules below are what
/// stands between a web page and the wallet, and rules that cannot be tested
/// are rules that quietly stop holding.
///
/// Three things it enforces, none of which the page can influence:
///
///   1. **The app is pinned, not self-declared.** The domain is set when the
///      host creates the bridge for one installed app. The page never sends a
///      domain, so it cannot claim to be another app — on the desktop the same
///      property comes from the browser's `Origin` header, which a page also
///      cannot set. Here it is stronger: native knows exactly which web view it
///      is serving.
///   2. **The intent allowlist.** Anything outside `AppIntent` is refused
///      locally; the daemon would also refuse it with BAD_METHOD.
///   3. **One app's bridge answers for one app.** A reply is only ever sent to
///      the web view that owns this bridge.
public struct AppBridge: Sendable {
    public let app: InstalledApp
    private let backend: AppBridgeBackend

    public init(app: InstalledApp, backend: AppBridgeBackend) {
        self.app = app
        self.backend = backend
    }

    public struct Reply: Sendable, Equatable {
        public let id: Int
        public let ok: Bool
        public let result: String?     // JSON, already encoded
        public let errorCode: String?
        public let errorMessage: String?
    }

    /// One message from the page: `{ id, method, params }`.
    public func handle(id: Int, method: String, params: [String: JSONValue]) async -> Reply {
        guard let intent = AppIntent(rawValue: method) else {
            // Named locally so the page gets a clear message without a round
            // trip; the daemon refuses it too.
            return Reply(id: id, ok: false, result: nil, errorCode: "BAD_METHOD",
                         errorMessage: "\(app.domain) may not call \(method)")
        }
        do {
            let json = try await backend.invoke(app: app.domain, intent: intent, params: params)
            return Reply(id: id, ok: true, result: json, errorCode: nil, errorMessage: nil)
        } catch let error as WalletError {
            return Reply(id: id, ok: false, result: nil, errorCode: error.code, errorMessage: error.message)
        } catch {
            return Reply(id: id, ok: false, result: nil, errorCode: "BRIDGE",
                         errorMessage: String(describing: error))
        }
    }
}

/// How the bridge reaches the wallet. A protocol so the bridge's rules can be
/// tested without a daemon, and so Phase 4 can point it at an on-device wallet.
public protocol AppBridgeBackend: Sendable {
    /// Returns the result as encoded JSON.
    func invoke(app domain: String, intent: AppIntent, params: [String: JSONValue]) async throws -> String
}

/// Forwards to the daemon's `appInvoke`, which is on the device allowlist and
/// enforces the app's own origin policy — so an app on the phone carries the
/// same policy identity it has on the desktop rather than inheriting the
/// phone's access.
public struct DeviceAppBridgeBackend: AppBridgeBackend {
    private let client: DeviceWalletClient

    public init(baseURL: URL, credential: DeviceCredential, http: DeviceHTTPClient = URLSessionDeviceClient()) {
        self.client = DeviceWalletClient(baseURL: baseURL, credential: credential, client: http)
    }

    private struct InvokeParams: Encodable, Sendable {
        let domain: String
        let method: String
        let callParams: [String: JSONValue]
    }

    public func invoke(app domain: String, intent: AppIntent, params: [String: JSONValue]) async throws -> String {
        let response: RawJSON = try await client.call(
            "appInvoke",
            params: InvokeParams(domain: domain, method: intent.rawValue, callParams: params)
        )
        return response.json
    }
}

/// Decodes a reply whose shape is only known to the page, keeping the raw JSON
/// to hand back across the bridge rather than re-encoding a parsed structure.
public struct RawJSON: Decodable, Sendable {
    public let json: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            json = "\"" + value.replacingOccurrences(of: "\"", with: "\\\"") + "\""
            return
        }
        if let value = try? container.decode(Bool.self) {
            json = value ? "true" : "false"; return
        }
        if let value = try? container.decode(Int.self) {
            json = String(value); return
        }
        if let value = try? container.decode(Double.self) {
            json = String(value); return
        }
        if container.decodeNil() {
            json = "null"; return
        }
        // Object or array: re-encode from a generic value.
        let any = try container.decode(JSONValue.self)
        let data = try JSONEncoder().encode(any)
        json = String(data: data, encoding: .utf8) ?? "null"
    }
}

/// A minimal JSON tree, so unknown result shapes can be re-encoded faithfully.
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Int.self) { self = .int(v); return }
        if let v = try? c.decode(Double.self) { self = .double(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }

    /// Convert what JavaScript hands over — NSNumber, NSString, NSArray,
    /// NSDictionary, NSNull — into the typed tree, once, at the boundary. After
    /// this point nothing in the bridge is `Any`, so the compiler can help.
    public static func from(_ any: Any) -> JSONValue {
        switch any {
        case is NSNull:
            return .null
        case let value as Bool:
            return .bool(value)
        case let value as Int:
            return .int(value)
        case let value as Double:
            return .double(value)
        case let value as String:
            return .string(value)
        case let value as [Any]:
            return .array(value.map(JSONValue.from))
        case let value as [String: Any]:
            return .object(value.mapValues(JSONValue.from))
        case let value as NSNumber:
            // NSNumber covers Bool too on some paths; the CFBoolean check keeps
            // `true` from arriving as the number 1.
            if CFGetTypeID(value) == CFBooleanGetTypeID() { return .bool(value.boolValue) }
            return .double(value.doubleValue)
        default:
            return .string(String(describing: any))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}
