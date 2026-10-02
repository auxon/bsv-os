import Foundation

/// A BRC-100 protocol ID: `[securityLevel, name]` on the wire.
///
/// The validation is a direct port of `checkProtocolID` in
/// `packages/walletd/src/brc100.ts`, because the daemon rejects anything that
/// breaks these rules with `BAD_PARAM` and the messages are unhelpful at the
/// call site. Validating here turns a round trip into a compile-time-adjacent
/// error.
public struct ProtocolID: Sendable, Equatable, Hashable {
    public enum SecurityLevel: Int, Sendable, CaseIterable {
        case open = 0
        case named = 1
        case privileged = 2
    }

    public enum ValidationError: Error, Equatable, CustomStringConvertible {
        case nameTooShort
        case nameTooLong
        case nameNotLowercase
        case consecutiveSpaces
        case reservedSuffix

        public var description: String {
            switch self {
            case .nameTooShort: return "protocol name must be at least 5 characters"
            case .nameTooLong: return "protocol name must be at most 400 characters"
            case .nameNotLowercase: return "protocol name must be lowercase letters, numbers and single spaces"
            case .consecutiveSpaces: return "protocol name must not contain consecutive spaces"
            case .reservedSuffix: return "protocol name must not end with ' protocol'"
            }
        }
    }

    public let securityLevel: SecurityLevel
    public let name: String

    public init(securityLevel: SecurityLevel, name: String) throws {
        guard name.count >= 5 else { throw ValidationError.nameTooShort }
        guard name.count <= 400 else { throw ValidationError.nameTooLong }
        guard name == name.lowercased(),
              name.allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == " ") })
        else { throw ValidationError.nameNotLowercase }
        guard !name.contains("  ") else { throw ValidationError.consecutiveSpaces }
        guard !name.hasSuffix(" protocol") else { throw ValidationError.reservedSuffix }
        self.securityLevel = securityLevel
        self.name = name
    }
}

extension ProtocolID: Codable {
    public init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        let level = try container.decode(Int.self)
        guard let securityLevel = SecurityLevel(rawValue: level) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "protocolID security level must be 0, 1, or 2"
            )
        }
        let name = try container.decode(String.self)
        try self.init(securityLevel: securityLevel, name: name)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(securityLevel.rawValue)
        try container.encode(name)
    }
}

/// Who a key, signature or ciphertext is bound to: `"self"`, `"anyone"`, or a
/// 33-byte compressed public key. Ported from `checkCounterparty`.
public enum Counterparty: Sendable, Equatable, Hashable {
    case `self`
    case anyone
    case publicKey(String)

    public enum ValidationError: Error, Equatable {
        case notACompressedPublicKey
    }

    /// Acceps the two keywords, or a 66-character hex compressed pubkey.
    public init(wireValue: String) throws {
        switch wireValue {
        case "self": self = .self
        case "anyone": self = .anyone
        default:
            let lowered = wireValue.lowercased()
            let isCompressed = lowered.count == 66
                && (lowered.hasPrefix("02") || lowered.hasPrefix("03"))
                && lowered.allSatisfy(\.isHexDigit)
            guard isCompressed else { throw ValidationError.notACompressedPublicKey }
            self = .publicKey(lowered)
        }
    }

    public var wireValue: String {
        switch self {
        case .self: return "self"
        case .anyone: return "anyone"
        case .publicKey(let hex): return hex
        }
    }
}

extension Counterparty: Codable {
    public init(from decoder: Decoder) throws {
        try self.init(wireValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wireValue)
    }
}
