import Foundation

/// BSV21 fungible tokens, ported from the daemon's `tokens.ts`.
///
/// A BSV21 carrier is a 1-sat output whose P2PKH script carries the ord
/// envelope with content type `application/bsv-20` and a small JSON body:
///
///     OP_0 OP_IF push("ord") OP_1 push("application/bsv-20") OP_0 push(json) OP_ENDIF
///     {"p":"bsv-20","op":"transfer","id":"<txid>_<vout>","amt":"<uint64>"}
///
/// Amounts are base-unit strings everywhere — never floats — and the transfer
/// JSON's key order is fixed (`p`, `op`, `id`, `amt`) because it is hashed by
/// byte elsewhere. The vectors pin both.
public enum Bsv21 {
    public static let protocolId = "bsv-20"
    public static let contentType = "application/bsv-20"
    /// UInt64.max, the daemon's BigInt bound for an amount.
    static let maxAmount = "18446744073709551615"

    /// The parsed JSON body plus the envelope's content type.
    public struct Envelope: Equatable, Sendable {
        public var protocolId: String
        public var op: String
        public var id: String
        public var amt: String
        public var contentType: String

        public init(protocolId: String, op: String, id: String, amt: String, contentType: String) {
            self.protocolId = protocolId
            self.op = op
            self.id = id
            self.amt = amt
            self.contentType = contentType
        }
    }

    /// Canonical `<txid>_<vout>` (lowercase, no leading zeros); accepts a dot
    /// separator. Nil when the shape is wrong — the daemon's
    /// `normalizeTokenId`.
    public static func normalizeTokenId(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let separator = trimmed.firstIndex(where: { $0 == "_" || $0 == "." }) else { return nil }
        let txid = String(trimmed[trimmed.startIndex..<separator])
        let voutText = String(trimmed[trimmed.index(after: separator)...])
        guard txid.count == 64, txid.allSatisfy({ $0.isHexDigit }),
              !voutText.isEmpty, voutText.allSatisfy({ $0.isNumber }),
              let vout = Int(voutText), vout >= 0 else { return nil }
        return "\(txid.lowercased())_\(vout)"
    }

    /// Canonical base-unit amount string. Rejects zero, signs, floats, and
    /// anything above uint64 — the daemon's `parseTokenAmount`.
    public static func parseTokenAmount(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.allSatisfy({ $0.isNumber }) else { return nil }
        let digits = String(trimmed.drop(while: { $0 == "0" }))
        guard !digits.isEmpty else { return nil } // zero (or all zeros)
        if digits.count > maxAmount.count { return nil }
        if digits.count == maxAmount.count, digits > maxAmount { return nil }
        return digits
    }

    /// The carrier script: P2PKH plus the transfer envelope. The JSON key
    /// order is the daemon's `JSON.stringify` order and is byte-pinned.
    public static func transferScript(ownerAddress: String, tokenId: String, amount: String) throws -> String {
        let json = #"{"p":"\#(protocolId)","op":"transfer","id":"\#(tokenId)","amt":"\#(amount)"}"#
        return try Inscription.script(
            ownerAddress: ownerAddress,
            contentType: contentType,
            dataHex: Hex.encode(Array(json.utf8))
        )
    }

    /// Parse the first `ord` envelope as BSV21; nil on any deviation. It does
    /// not check that this *is* a BSV21 — callers compare protocol and content
    /// type, exactly as the daemon's callers do.
    public static func parseEnvelope(_ scriptHex: String) -> Envelope? {
        guard let bytes = try? Hex.decode(scriptHex) else { return nil }
        guard let start = Inscription.envelopeStart(bytes) else { return nil }
        guard let tag = Inscription.readPush(bytes, at: start), tag.data == Array("ord".utf8) else { return nil }
        guard tag.next < bytes.count, bytes[tag.next] == 0x51 else { return nil } // OP_1
        guard let content = Inscription.readPush(bytes, at: tag.next + 1) else { return nil }
        guard content.next < bytes.count, bytes[content.next] == 0x00 else { return nil } // OP_0
        guard let body = Inscription.readPush(bytes, at: content.next + 1) else { return nil }
        guard body.next < bytes.count, bytes[body.next] == 0x68 else { return nil } // OP_ENDIF
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(body.data)) as? [String: Any],
              let protocolId = parsed["p"] as? String,
              let op = parsed["op"] as? String else { return nil }
        return Envelope(
            protocolId: protocolId,
            op: op,
            id: parsed["id"] as? String ?? "",
            amt: parsed["amt"] as? String ?? "",
            contentType: String(bytes: content.data, encoding: .utf8) ?? ""
        )
    }

    /// `<txid>[_.]<vout>`, lowercased. Nil when the shape is wrong.
    public static func splitOutpoint(_ raw: String) -> (txid: String, vout: Int)? {
        guard let separator = raw.firstIndex(where: { $0 == "_" || $0 == "." }) else { return nil }
        let txid = String(raw[raw.startIndex..<separator])
        let voutText = String(raw[raw.index(after: separator)...])
        guard txid.count == 64, txid.allSatisfy({ $0.isHexDigit }),
              !voutText.isEmpty, voutText.allSatisfy({ $0.isNumber }),
              let vout = Int(voutText), vout >= 0 else { return nil }
        return (txid.lowercased(), vout)
    }
}
