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
}
