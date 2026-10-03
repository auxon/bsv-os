import Foundation

/// The ord inscription envelope, ported from the daemon's `tokens.ts`.
///
/// A 1-sat output whose script is the owner's P2PKH with the envelope appended:
///
///     OP_0 OP_IF push("ord") OP_1 push(contentType) OP_0 push(data) OP_ENDIF
///
/// The pushes are the part worth pinning against vectors: 75 bytes and below
/// push directly, up to 255 use OP_PUSHDATA1, and larger data uses
/// OP_PUSHDATA2. A port that hand-writes any boundary produces an envelope an
/// indexer reads differently, which is a silent failure — so the vectors cover
/// all three.
public enum Inscription {
    public enum Error: Swift.Error, Equatable {
        case badData
        case badContentType
    }

    public static func script(ownerAddress: String, contentType: String, dataHex: String) throws -> String {
        // The daemon's rule: 1-128 printable ASCII, no spaces.
        let contentBytes = Array(contentType.utf8)
        guard !contentBytes.isEmpty, contentBytes.count <= 128,
              contentBytes.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e }) else {
            throw Error.badContentType
        }
        let data: [UInt8]
        do {
            data = try Hex.decode(dataHex)
        } catch {
            throw Error.badData
        }
        guard !data.isEmpty else { throw Error.badData }

        var out = try Address.lockingScript(for: ownerAddress)
        out += [0x00, 0x63]                       // OP_0 OP_IF
        out += Tx.push(Array("ord".utf8))
        out += [0x51]                             // OP_1
        out += Tx.push(contentBytes)
        out += [0x00]                             // OP_0
        out += Tx.push(data)
        out += [0x68]                             // OP_ENDIF
        return Hex.encode(out)
    }

    /// True when the script carries any `ord` envelope — the check the funding
    /// selector uses to keep its hands off ordinal carriers.
    ///
    /// It scans for the first `OP_0 OP_IF`, then requires a push of `"ord"`
    /// followed by `OP_1`. Deliberately shallow: it detects carriers, it does
    /// not validate inscriptions, which is why a mutated tag reads as "not a
    /// carrier" rather than as a broken inscription.
    public static func hasOrdEnvelope(_ scriptHex: String) -> Bool {
        guard let bytes = try? Hex.decode(scriptHex) else { return false }
        guard let start = envelopeStart(bytes) else { return false }
        guard let tag = readPush(bytes, at: start) else { return false }
        guard tag.data == Array("ord".utf8) else { return false }
        guard tag.next < bytes.count, bytes[tag.next] == 0x51 else { return false }
        return true
    }

    /// The offset just past `OP_0 OP_IF`, or nil.
    static func envelopeStart(_ bytes: [UInt8]) -> Int? {
        guard bytes.count >= 2 else { return nil }
        for index in 0..<(bytes.count - 1) where bytes[index] == 0x00 && bytes[index + 1] == 0x63 {
            return index + 2
        }
        return nil
    }

    /// The daemon's `readPush`: direct, OP_PUSHDATA1, OP_PUSHDATA2, or nil.
    static func readPush(_ bytes: [UInt8], at offset: Int) -> (data: [UInt8], next: Int)? {
        guard offset < bytes.count else { return nil }
        let op = Int(bytes[offset])
        if op <= 75 {
            guard offset + 1 + op <= bytes.count else { return nil }
            return (Array(bytes[(offset + 1)..<(offset + 1 + op)]), offset + 1 + op)
        }
        if op == 0x4c {
            guard offset + 2 <= bytes.count else { return nil }
            let length = Int(bytes[offset + 1])
            guard offset + 2 + length <= bytes.count else { return nil }
            return (Array(bytes[(offset + 2)..<(offset + 2 + length)]), offset + 2 + length)
        }
        if op == 0x4d {
            guard offset + 3 <= bytes.count else { return nil }
            let length = Int(bytes[offset + 1]) | Int(bytes[offset + 2]) << 8
            guard offset + 3 + length <= bytes.count else { return nil }
            return (Array(bytes[(offset + 3)..<(offset + 3 + length)]), offset + 3 + length)
        }
        return nil
    }
}
