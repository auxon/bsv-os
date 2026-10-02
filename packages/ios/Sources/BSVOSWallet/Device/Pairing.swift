import Foundation

/// Pairing: the one call the device surface accepts without a token, guarded by
/// the code `bsv device pair` prints.
///
/// Separate from `DeviceWalletClient` because it is pre-authentication — it is
/// how a credential comes to exist at all.
public struct DevicePairingClient: Sendable {
    private let baseURL: URL
    private let http: DeviceHTTPClient
    private let decoder = JSONDecoder()

    public init(baseURL: URL, http: DeviceHTTPClient = URLSessionDeviceClient()) {
        self.baseURL = baseURL
        self.http = http
    }

    /// Exchange a pairing code for a credential. The credential is returned
    /// exactly once — the daemon keeps only a hash — so the caller must store it.
    public func pair(code: String, name: String, platform: String = "ios") async throws -> DeviceCredential {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard trimmed.count >= 6 else {
            throw WalletError(code: "BAD_CODE", message: "That does not look like a pairing code.")
        }

        let payload = try JSONEncoder().encode(PairingRequest(code: trimmed, name: name, platform: platform))
        let request = try DeviceWire.pairRequest(baseURL: baseURL, payload: payload)
        let (data, httpResponse) = try await http.send(request)
        let envelope: DeviceEnvelope<PairingResponse>
        do {
            envelope = try decoder.decode(DeviceEnvelope<PairingResponse>.self, from: data)
        } catch {
            throw WalletError(code: "BAD_REPLY", message: "could not read the daemon's reply")
        }
        if let error = envelope.error { throw error }
        guard let paired = envelope.result else {
            throw WalletError(code: "BAD_REPLY", message: "the daemon sent neither a credential nor an error")
        }
        if httpResponse.statusCode != 200 {
            throw WalletError(code: "PAIR_FAILED", message: "pairing failed (\(httpResponse.statusCode))")
        }
        return DeviceCredential(deviceID: paired.deviceId, token: paired.token)
    }
}

/// Where the credential lives between launches.
///
/// A protocol so the app can use the Keychain while tests use memory: a test
/// that touched the real Keychain would prompt for access on a developer's Mac.
public protocol CredentialStore: Sendable {
    func load() throws -> DeviceCredential?
    func save(_ credential: DeviceCredential) throws
    func clear() throws
}

public enum CredentialStoreError: Error, Equatable {
    case unreadable
}

/// Keychain, with two deliberate attributes:
///
/// - `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — the credential is
///   device-bound (it should not ride an iCloud backup to another phone) and is
///   unreadable while the device is locked.
/// - no synchronisation, for the same reason.
///
/// Note what this does *not* yet do: the design in docs/ios.md calls for the
/// token to be wrapped by a Secure Enclave key. Phase 1 stores it in the
/// Keychain and enforces biometrics at the moment of spending, which is where
/// the risk is. The Enclave wrap is a hardening step, not a Phase 1 gate.
public struct KeychainCredentialStore: CredentialStore {
    private let service: String
    private let account = "device-credential"

    public init(service: String = "bsv-os-ios") {
        self.service = service
    }

    #if canImport(Security)
    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() throws -> DeviceCredential? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw CredentialStoreError.unreadable
        }
        return try JSONDecoder().decode(DeviceCredential.self, from: data)
    }

    public func save(_ credential: DeviceCredential) throws {
        let data = try JSONEncoder().encode(credential)
        // Replace rather than add, so re-pairing does not fail on a duplicate.
        SecItemDelete(baseQuery() as CFDictionary)
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw CredentialStoreError.unreadable }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.unreadable
        }
    }
    #else
    public func load() throws -> DeviceCredential? { nil }
    public func save(_ credential: DeviceCredential) throws { throw CredentialStoreError.unreadable }
    public func clear() throws {}
    #endif
}

/// For tests and previews.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: DeviceCredential?

    public init(initial: DeviceCredential? = nil) {
        stored = initial
    }

    public func load() throws -> DeviceCredential? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }

    public func save(_ credential: DeviceCredential) throws {
        lock.lock(); defer { lock.unlock() }
        stored = credential
    }

    public func clear() throws {
        lock.lock(); defer { lock.unlock() }
        stored = nil
    }
}
