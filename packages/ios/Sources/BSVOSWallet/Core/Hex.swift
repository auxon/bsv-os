import Foundation

/// Hex, and the byte helpers the rest of the core expects.
///
/// Every conversion here replaces a `fatalError`-shaped assumption with a
/// throwing one: this code handles key material, and "it cannot happen" is how
/// key material gets mangled silently.
public enum Hex {
    public enum Error: Swift.Error, Equatable {
        case oddLength
        case notHex(String)
    }

    public static func encode(_ bytes: [UInt8]) -> String {
        var out = String()
        out.reserveCapacity(bytes.count * 2)
        for byte in bytes {
            out.append(Character(UnicodeScalar(hexDigits[Int(byte >> 4)])))
            out.append(Character(UnicodeScalar(hexDigits[Int(byte & 0x0f)])))
        }
        return out
    }

    public static func decode(_ string: String) throws -> [UInt8] {
        let text = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard text.count % 2 == 0 else { throw Error.oddLength }
        var out = [UInt8]()
        out.reserveCapacity(text.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            let pair = text[index..<next]
            guard let high = nibble(pair.first), let low = nibble(pair.last) else {
                throw Error.notHex(String(pair))
            }
            out.append(high << 4 | low)
            index = next
        }
        return out
    }

    private static func nibble(_ character: Character?) -> UInt8? {
        guard let character, let ascii = character.asciiValue else { return nil }
        switch ascii {
        case 0x30...0x39: return ascii - 0x30          // 0-9
        case 0x61...0x66: return ascii - 0x61 + 10     // a-f
        default: return nil
        }
    }

    private static let hexDigits: [UInt8] = Array("0123456789abcdef".utf8)
}

/// A byte buffer that is deliberately awkward to print.
///
/// Key material ends up in logs and crash reports by accident; `CustomStringConvertible`
/// returning a refusal rather than the bytes is a cheap way to make that harder
/// without pretending to be a security boundary.
public struct SecretBytes {
    public let bytes: [UInt8]
    public init(_ bytes: [UInt8]) { self.bytes = bytes }
    public init(hex: String) throws { self.bytes = try Hex.decode(hex) }
    public var hex: String { Hex.encode(bytes) }
}

extension SecretBytes: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String { "<secret \(bytes.count) bytes>" }
    public var debugDescription: String { description }
}
