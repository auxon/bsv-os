import Foundation
import P256K

/// secp256k1, wrapped so the rest of the core never touches the library directly.
///
/// One dependency, one place. If it is ever swapped, this file is the whole of
/// the blast radius — and the vector tests are what would catch a behaviour
/// change.
public enum Secp256k1 {
    public enum Error: Swift.Error, Equatable {
        case invalidPrivateKey
        case invalidPublicKey
        case signingFailed
        case invalidSignature
    }

    /// The 33-byte compressed public key the daemon serializes.
    public static func publicKey(fromPrivateKey key: [UInt8]) throws -> [UInt8] {
        guard key.count == 32 else { throw Error.invalidPrivateKey }
        do {
            let privateKey = try P256K.Signing.PrivateKey(dataRepresentation: key, format: .compressed)
            return Array(privateKey.publicKey.dataRepresentation)
        } catch {
            throw Error.invalidPrivateKey
        }
    }

    public static func validatePrivateKey(_ key: [UInt8]) throws {
        guard key.count == 32 else { throw Error.invalidPrivateKey }
        do {
            _ = try P256K.Signing.PrivateKey(dataRepresentation: key, format: .compressed)
        } catch {
            throw Error.invalidPrivateKey
        }
    }

    /// DER-encoded ECDSA signature, which is what a Bitcoin unlock script
    /// carries. Not a compact or raw form: `OP_CHECKSIG` expects DER, and the
    /// daemon signs through the same library.
    public static func sign(derForDigest digest: [UInt8], withPrivateKey key: [UInt8]) throws -> [UInt8] {
        guard key.count == 32, digest.count == 32 else { throw Error.signingFailed }
        do {
            let privateKey = try P256K.Signing.PrivateKey(dataRepresentation: key, format: .compressed)
            let signature = try privateKey.signature(for: digest)
            return Array(signature.derRepresentation)
        } catch {
            throw Error.signingFailed
        }
    }

    /// Verify a DER signature over a 32-byte digest. Used by tests to prove the
    /// signing path, and by nothing else yet.
    public static func verify(derSignature signature: [UInt8], digest: [UInt8], publicKey: [UInt8]) throws -> Bool {
        guard digest.count == 32, publicKey.count == 33 else { throw Error.invalidSignature }
        do {
            let key = try P256K.Signing.PublicKey(dataRepresentation: publicKey, format: .compressed)
            let parsed = try P256K.Signing.ECDSASignature(derRepresentation: signature)
            return key.isValidSignature(parsed, for: digest)
        } catch {
            throw Error.invalidSignature
        }
    }
}

/// P2PKH addresses, mainnet.
public enum Address {
    public enum Error: Swift.Error, Equatable {
        case badLength(Int)
        case notMainnetP2PKH
        case badChecksum
    }

    /// Mainnet P2PKH version byte. The daemon is mainnet-only
    /// (`getNetwork` answers "mainnet"), so a testnet address here would be a
    /// silent way to send coins to the wrong chain.
    public static let version: UInt8 = 0x00

    /// Address for a public key, the way `toPublicKey().toAddress()` does it.
    public static func from(publicKey: [UInt8]) -> String {
        Base58.checkEncode([version] + Hash160.of(publicKey))
    }

    /// The 20-byte hash behind an address, after checking it is a mainnet P2PKH
    /// address at all. Sending to a string that merely looks like an address is
    /// a way to lose coins to a typo, so this is strict.
    public static func scriptHash(from address: String) throws -> [UInt8] {
        let payload = try Base58.checkDecode(address)
        guard payload.count == 21 else { throw Error.badLength(payload.count) }
        guard payload[0] == version else { throw Error.notMainnetP2PKH }
        return Array(payload.dropFirst())
    }

    /// The locking script for an address: `OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG`.
    public static func lockingScript(for address: String) throws -> [UInt8] {
        let hash = try scriptHash(from: address)
        return [0x76, 0xa9, 0x14] + hash + [0x88, 0xac]
    }
}
