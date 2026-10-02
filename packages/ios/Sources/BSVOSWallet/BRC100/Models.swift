import Foundation

// Wire models for the core BRC-100 calls, derived by reading the daemon's
// implementation (`packages/walletd/src/brc100.ts`) rather than from the spec
// prose, because this client talks to *this* wallet.
//
// Two encodings appear on the wire and they are easy to confuse:
//
//   * Byte payloads — plaintext, ciphertext, data, signature, hashToDirectlySign
//     — are JSON ARRAYS of integers 0-255. `checkBytes` rejects anything else
//     with `BAD_PARAM: <field> must be a byte array`. They are NOT base64.
//     Swift's `[UInt8]` already encodes as exactly that, so the types below use
//     it directly and a test pins the behaviour.
//   * Scripts and headers — `lockingScript`, `header` — are lowercase HEX
//     STRINGS. Same wire, different encoding, so they are `String` here.
//
// Getting these two backwards is a runtime `BAD_PARAM`, not a compile error,
// which is why they are called out at every use site.

// MARK: - Trivial reads

public struct IsAuthenticatedResponse: Codable, Sendable, Equatable {
    public let authenticated: Bool
    public init(authenticated: Bool) { self.authenticated = authenticated }
}

public struct GetVersionResponse: Codable, Sendable, Equatable {
    public let version: String
    public init(version: String) { self.version = version }
}

public struct GetNetworkResponse: Codable, Sendable, Equatable {
    public let network: String
    public init(network: String) { self.network = network }
}

public struct GetHeightResponse: Codable, Sendable, Equatable {
    public let height: Int
    public init(height: Int) { self.height = height }
}

public struct GetHeaderRequest: Codable, Sendable, Equatable {
    public let height: Int
    public init(height: Int) { self.height = height }
}

/// `header` is hex, not bytes.
public struct GetHeaderResponse: Codable, Sendable, Equatable {
    public let header: String
    public init(header: String) { self.header = header }
}

public struct WaitForAuthenticationRequest: Codable, Sendable, Equatable {
    /// The daemon clamps this to 300_000 ms.
    public let timeoutMs: Int?
    public init(timeoutMs: Int? = nil) { self.timeoutMs = timeoutMs }
}

// MARK: - Keys

public struct GetPublicKeyRequest: Codable, Sendable, Equatable {
    /// When true the daemon returns the wallet's identity key and ignores the
    /// rest — the "who am I" path.
    public let identityKey: Bool?
    public let protocolID: ProtocolID?
    public let keyID: String?
    public let counterparty: Counterparty?
    public let forSelf: Bool?

    public init(
        identityKey: Bool? = nil,
        protocolID: ProtocolID? = nil,
        keyID: String? = nil,
        counterparty: Counterparty? = nil,
        forSelf: Bool? = nil
    ) {
        self.identityKey = identityKey
        self.protocolID = protocolID
        self.keyID = keyID
        self.counterparty = counterparty
        self.forSelf = forSelf
    }
}

public struct GetPublicKeyResponse: Codable, Sendable, Equatable {
    public let publicKey: String
    public init(publicKey: String) { self.publicKey = publicKey }
}

// MARK: - Symmetric crypto

public struct EncryptRequest: Codable, Sendable, Equatable {
    public let protocolID: ProtocolID
    public let keyID: String
    public let counterparty: Counterparty?
    /// Byte array on the wire — see the note at the top of this file.
    public let plaintext: [UInt8]

    public init(protocolID: ProtocolID, keyID: String, counterparty: Counterparty? = nil, plaintext: [UInt8]) {
        self.protocolID = protocolID
        self.keyID = keyID
        self.counterparty = counterparty
        self.plaintext = plaintext
    }
}

public struct EncryptResponse: Codable, Sendable, Equatable {
    public let ciphertext: [UInt8]
    public init(ciphertext: [UInt8]) { self.ciphertext = ciphertext }
}

public struct DecryptRequest: Codable, Sendable, Equatable {
    public let protocolID: ProtocolID
    public let keyID: String
    public let counterparty: Counterparty?
    public let ciphertext: [UInt8]

    public init(protocolID: ProtocolID, keyID: String, counterparty: Counterparty? = nil, ciphertext: [UInt8]) {
        self.protocolID = protocolID
        self.keyID = keyID
        self.counterparty = counterparty
        self.ciphertext = ciphertext
    }
}

public struct DecryptResponse: Codable, Sendable, Equatable {
    public let plaintext: [UInt8]
    public init(plaintext: [UInt8]) { self.plaintext = plaintext }
}

// MARK: - Signatures

public struct CreateSignatureRequest: Codable, Sendable, Equatable {
    /// Exactly one of `data` or `hashToDirectlySign` must be present; the
    /// daemon rejects a request carrying neither.
    public let data: [UInt8]?
    public let hashToDirectlySign: [UInt8]?
    public let protocolID: ProtocolID
    public let keyID: String
    public let counterparty: Counterparty?

    public init(
        data: [UInt8]? = nil,
        hashToDirectlySign: [UInt8]? = nil,
        protocolID: ProtocolID,
        keyID: String,
        counterparty: Counterparty? = nil
    ) {
        self.data = data
        self.hashToDirectlySign = hashToDirectlySign
        self.protocolID = protocolID
        self.keyID = keyID
        self.counterparty = counterparty
    }

    public enum ValidationError: Error, Equatable {
        case needsDataOrHash
        case bothDataAndHash
    }

    public func validate() throws {
        switch (data, hashToDirectlySign) {
        case (nil, nil): throw ValidationError.needsDataOrHash
        case (.some, .some): throw ValidationError.bothDataAndHash
        default: return
        }
    }
}

public struct CreateSignatureResponse: Codable, Sendable, Equatable {
    public let signature: [UInt8]
    public init(signature: [UInt8]) { self.signature = signature }
}

public struct VerifySignatureRequest: Codable, Sendable, Equatable {
    public let data: [UInt8]?
    public let hashToDirectlyVerify: [UInt8]?
    public let signature: [UInt8]
    public let protocolID: ProtocolID
    public let keyID: String
    public let counterparty: Counterparty?
    public let forSelf: Bool?

    public init(
        data: [UInt8]? = nil,
        hashToDirectlyVerify: [UInt8]? = nil,
        signature: [UInt8],
        protocolID: ProtocolID,
        keyID: String,
        counterparty: Counterparty? = nil,
        forSelf: Bool? = nil
    ) {
        self.data = data
        self.hashToDirectlyVerify = hashToDirectlyVerify
        self.signature = signature
        self.protocolID = protocolID
        self.keyID = keyID
        self.counterparty = counterparty
        self.forSelf = forSelf
    }
}

public struct VerifySignatureResponse: Codable, Sendable, Equatable {
    public let valid: Bool
    public init(valid: Bool) { self.valid = valid }
}

// MARK: - Outputs

public struct ListOutputsRequest: Codable, Sendable, Equatable {
    public enum TagQueryMode: String, Codable, Sendable {
        case any, all
    }

    /// What to include on each output. The daemon adds `lockingScript` for the
    /// first, and switches to whole-transaction lookups for the second.
    public enum Include: String, Codable, Sendable {
        case none
        case lockingScripts = "locking scripts"
        case entireTransactions = "entire transactions"
    }

    public let basket: String
    public let tags: [String]?
    public let tagQueryMode: TagQueryMode?
    /// 1-10000; the daemon defaults to 10.
    public let limit: Int?
    /// An integer. A NEGATIVE offset reverses the sort — a quirk of the daemon
    /// worth preserving rather than "fixing" in the client.
    public let offset: Int?
    public let include: Include?
    public let includeCustomInstructions: Bool?
    public let includeTags: Bool?

    public init(
        basket: String,
        tags: [String]? = nil,
        tagQueryMode: TagQueryMode? = nil,
        limit: Int? = nil,
        offset: Int? = nil,
        include: Include? = nil,
        includeCustomInstructions: Bool? = nil,
        includeTags: Bool? = nil
    ) {
        self.basket = basket
        self.tags = tags
        self.tagQueryMode = tagQueryMode
        self.limit = limit
        self.offset = offset
        self.include = include
        self.includeCustomInstructions = includeCustomInstructions
        self.includeTags = includeTags
    }
}

public struct WalletOutput: Codable, Sendable, Equatable {
    public let satoshis: Int
    public let spendable: Bool
    /// `"<txid>.<vout>"`.
    public let outpoint: String
    /// HEX, not bytes — see the note at the top of this file.
    public let lockingScript: String?
    public let customInstructions: String?
    public let tags: [String]?
}

public struct ListOutputsResponse: Codable, Sendable, Equatable {
    public let outputs: [WalletOutput]
    public let totalOutputs: Int
}
