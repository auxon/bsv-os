import Foundation

/// Where the recovery phrase lives.
///
/// A protocol for the same reason `CredentialStore` is one: tests use memory so
/// they never touch the real Keychain, and the app gets one implementation that
/// is device-bound and unreadable while the phone is locked.
///
/// The phrase is stored, not a derived seed, because the phrase is what the
/// human has to be able to see and back up. It never leaves this type in a form
/// the UI does not explicitly ask for, and it never goes near a web view.
public protocol SeedVault: Sendable {
    func loadPhrase() throws -> String?
    func savePhrase(_ phrase: String) throws
    func deletePhrase() throws
}

public extension SeedVault {
    var hasPhrase: Bool {
        (try? loadPhrase()) != nil
    }

    /// Validate, normalise, store. Invalid input never reaches the Keychain.
    func importPhrase(_ phrase: String) throws {
        try BIP39.validate(phrase)
        try savePhrase(BIP39.normalize(phrase))
    }

    /// A fresh phrase, generated here so setup screens do not reach for the
    /// wordlist themselves — and so the custody guard can keep saying that key
    /// material exists only in the vault and the crypto core.
    func generatePhrase(wordCount: Int = 12) throws -> String {
        try BIP39.generate(wordCount: wordCount)
    }
}

public enum SeedVaultError: Error, Equatable {
    case unreadable
    case missing
}

/// Keychain, with the same two attributes as the device credential:
/// `WhenUnlockedThisDeviceOnly` and no iCloud synchronisation. A recovery phrase
/// that rode a backup to another phone, or could be read while the phone is
/// locked, would defeat the point of storing it there.
public struct KeychainSeedVault: SeedVault {
    private let service: String
    private let account = "wallet-seed"

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

    public func loadPhrase() throws -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data,
              let phrase = String(data: data, encoding: .utf8) else {
            throw SeedVaultError.unreadable
        }
        return phrase
    }

    public func savePhrase(_ phrase: String) throws {
        let data = Data(phrase.utf8)
        SecItemDelete(baseQuery() as CFDictionary)
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw SeedVaultError.unreadable }
    }

    public func deletePhrase() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SeedVaultError.unreadable
        }
    }
    #else
    public func loadPhrase() throws -> String? { nil }
    public func savePhrase(_ phrase: String) throws { throw SeedVaultError.unreadable }
    public func deletePhrase() throws {}
    #endif
}

/// For tests, previews, and the simulator.
public final class InMemorySeedVault: SeedVault, @unchecked Sendable {
    private let lock = NSLock()
    private var phrase: String?

    public init(phrase: String? = nil) {
        self.phrase = phrase
    }

    public func loadPhrase() throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return phrase
    }

    public func savePhrase(_ phrase: String) throws {
        lock.lock()
        defer { lock.unlock() }
        self.phrase = phrase
    }

    public func deletePhrase() throws {
        lock.lock()
        defer { lock.unlock() }
        phrase = nil
    }
}
