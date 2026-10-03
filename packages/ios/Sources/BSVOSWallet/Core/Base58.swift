import Foundation
import CryptoKit

/// Base58Check, the encoding Bitcoin addresses use.
///
/// Written here rather than pulled in: it is a small, stable algorithm whose
/// only subtlety is the leading-zero rule, and the address vectors exercise it
/// exactly.
public enum Base58 {
    public enum Error: Swift.Error, Equatable {
        case invalidCharacter(Character)
        case badChecksum
        case tooShort
    }

    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)

    public static func encode(_ bytes: [UInt8]) -> String {
        // Count leading zeros: each becomes a literal '1'.
        var zeros = 0
        for byte in bytes {
            if byte == 0 { zeros += 1 } else { break }
        }

        // Base-256 to base-58 by repeated division on a little-endian buffer.
        var digits: [UInt8] = []
        var work = Array(bytes.dropFirst(zeros))
        while !work.isEmpty {
            var remainder = 0
            var quotient = [UInt8]()
            quotient.reserveCapacity(work.count)
            for byte in work {
                let acc = remainder * 256 + Int(byte)
                let digit = acc / 58
                remainder = acc % 58
                if !quotient.isEmpty || digit != 0 { quotient.append(UInt8(digit)) }
            }
            digits.append(alphabet[remainder])
            work = quotient
        }

        return String(decoding: Array(repeating: alphabet[0], count: zeros) + digits.reversed(), as: UTF8.self)
    }

    public static func decode(_ string: String) throws -> [UInt8] {
        var zeros = 0
        for character in string {
            if character == "1" { zeros += 1 } else { break }
        }
        var work: [UInt8] = []
        for character in string.dropFirst(zeros) {
            guard let index = alphabet.firstIndex(of: character.asciiValue ?? 0) else {
                throw Error.invalidCharacter(character)
            }
            var carry = index
            for position in (0..<work.count).reversed() {
                let acc = Int(work[position]) * 58 + carry
                work[position] = UInt8(acc & 0xff)
                carry = acc >> 8
            }
            while carry > 0 {
                work.insert(UInt8(carry & 0xff), at: 0)
                carry >>= 8
            }
        }
        return Array(repeating: 0, count: zeros) + work
    }

    /// Address-style encoding: the payload followed by the first four bytes of
    /// its double SHA-256.
    public static func checkEncode(_ payload: [UInt8]) -> String {
        let digest = Data(SHA256.hash(data: Data(SHA256.hash(data: Data(payload)))))
        return encode(payload + Array(digest.prefix(4)))
    }

    /// Decode and verify the checksum. Returns the payload without it.
    public static func checkDecode(_ string: String) throws -> [UInt8] {
        let decoded = try decode(string)
        guard decoded.count >= 5 else { throw Error.tooShort }
        let payload = Array(decoded.dropLast(4))
        let checksum = Array(decoded.suffix(4))
        let digest = Data(SHA256.hash(data: Data(SHA256.hash(data: Data(payload)))))
        guard Array(digest.prefix(4)) == checksum else { throw Error.badChecksum }
        return payload
    }
}

/// Hash160 — `RIPEMD160(SHA256(x))`, the hash inside every P2PKH address.
public enum Hash160 {
    public static func of(_ bytes: [UInt8]) -> [UInt8] {
        RIPEMD160.hash(Array(SHA256.hash(data: Data(bytes))))
    }
}
