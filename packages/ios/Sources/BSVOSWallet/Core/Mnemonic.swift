import Foundation
import CryptoKit

/// Phrase generation. S1 had validation and derivation; a standalone wallet
/// also has to be *created*, so the entropy → words half lives here.
///
/// The daemon's `custody.ts` makes a 12-word phrase with `Mnemonic.fromRandom()`
/// (128 bits) and `@scure/bip39`'s `entropyToMnemonic`. This is the same
/// algorithm, pinned by vectors in `walletd/test/vectors/mnemonic-vectors.json`.
public extension BIP39 {
    enum GenerationError: Swift.Error, Equatable {
        case unsupportedWordCount(Int)
        case entropyUnavailable
        case wordlistIncomplete
    }

    /// A fresh phrase from the system CSPRNG.
    static func generate(wordCount: Int = 12) throws -> String {
        let entropyBytes: Int
        switch wordCount {
        case 12: entropyBytes = 16
        case 15: entropyBytes = 20
        case 18: entropyBytes = 24
        case 21: entropyBytes = 28
        case 24: entropyBytes = 32
        default: throw GenerationError.unsupportedWordCount(wordCount)
        }

        var entropy = [UInt8](repeating: 0, count: entropyBytes)
        #if canImport(Security)
        let status = SecRandomCopyBytes(kSecRandomDefault, entropyBytes, &entropy)
        guard status == errSecSuccess else { throw GenerationError.entropyUnavailable }
        #else
        var generator = SystemRandomNumberGenerator()
        for index in 0..<entropyBytes { entropy[index] = UInt8.random(in: 0...255, using: &generator) }
        #endif
        return try mnemonic(fromEntropy: entropy)
    }

    /// The deterministic half — the half a test can pin.
    ///
    /// BIP39 appends the first `ENT/32` bits of `SHA256(entropy)` to the
    /// entropy and reads 11-bit indices into the 2048-word list.
    static func mnemonic(fromEntropy entropy: [UInt8]) throws -> String {
        guard [16, 20, 24, 28, 32].contains(entropy.count) else {
            throw GenerationError.unsupportedWordCount(entropy.count)
        }
        let checksumBits = entropy.count / 4
        let checksum = Array(SHA256.hash(data: Data(entropy)))

        var bits: [Int] = []
        bits.reserveCapacity(entropy.count * 8 + checksumBits)
        for byte in entropy {
            for shift in stride(from: 7, through: 0, by: -1) {
                bits.append(Int((byte >> shift) & 1))
            }
        }
        for index in 0..<checksumBits {
            bits.append(Int((checksum[index / 8] >> (7 - index % 8)) & 1))
        }

        // The wordlist is exposed as word → index; generation needs the inverse.
        let byIndex = try wordlist().sorted { $0.value < $1.value }.map(\.key)
        guard byIndex.count == 2048 else { throw GenerationError.wordlistIncomplete }

        var words: [String] = []
        words.reserveCapacity(bits.count / 11)
        for start in stride(from: 0, to: bits.count, by: 11) {
            var index = 0
            for offset in 0..<11 {
                index = (index << 1) | bits[start + offset]
            }
            words.append(byIndex[index])
        }
        return words.joined(separator: " ")
    }
}
