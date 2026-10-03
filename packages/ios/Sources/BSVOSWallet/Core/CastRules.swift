import Foundation

/// One value split: an address and its share of the stream.
public struct CastSplit: Codable, Sendable, Equatable {
    public var address: String
    public var pct: Double

    public init(address: String, pct: Double) {
        self.address = address
        self.pct = pct
    }
}

/// A rule refusal carrying the daemon's code and message.
public struct CastRuleError: Error, Equatable, Sendable {
    public var code: String
    public var message: String
    public init(code: String = "BAD_PARAM", message: String) {
        self.code = code
        self.message = message
    }
}

/// The pure rules of Cast, ported from the daemon's `cast.ts` and `streams.ts`:
/// split and interval parsing, the HLS playlist, id/file validators and the
/// media allowlists. Vectors pin them against the daemon's own functions.
public enum CastRules {
    public static let board = "cast"
    public static let agent = "cast-player"
    public static let minTickSats = 1000
    public static let assumedFeeSats = 250
    public static let liveWindow = 20
    public static let maxLiveSegments = 500
    public static let maxSegmentBytes = 8 * 1024 * 1024
    public static let maxUploadBytes = 256 * 1024 * 1024
    public static let liveIdleMs = 5 * 60_000

    private static let idChars = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    // MARK: - parsing

    /// `"addr:70,addr:30"` → validated splits summing to 100, exactly the
    /// daemon's `parseSplits` (including its messages).
    public static func parseSplits(_ raw: String?, validAddress: (String) -> Bool) throws -> [CastSplit] {
        let text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw CastRuleError(message: "splits required: <address>:<pct>[,<address>:<pct>…]")
        }
        let parts = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !parts.isEmpty, parts.count <= 8 else {
            throw CastRuleError(message: "1..8 splits")
        }
        var seen = Set<String>()
        var splits: [CastSplit] = []
        for part in parts {
            guard let colon = part.lastIndex(of: ":"), colon > part.startIndex else {
                throw CastRuleError(message: "bad split (want address:pct): \(String(part.prefix(20)))")
            }
            let address = String(part[part.startIndex..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
            let pctText = String(part[part.index(after: colon)...])
            guard validAddress(address) else {
                throw CastRuleError(message: "bad address in splits: \(String(address.prefix(16)))…")
            }
            guard let pct = Double(pctText), pct.isFinite, pct > 0, pct <= 100 else {
                throw CastRuleError(message: "bad pct in splits: \(String(part.prefix(30)))")
            }
            let key = address.lowercased()
            guard !seen.contains(key) else {
                throw CastRuleError(message: "duplicate address in splits")
            }
            seen.insert(key)
            splits.append(CastSplit(address: address, pct: pct))
        }
        let total = splits.reduce(0) { $0 + $1.pct }
        guard abs(total - 100) <= 0.001 else {
            throw CastRuleError(message: "splits must sum to 100 (got \(formatNumber(total)))")
        }
        return splits
    }

    /// `"90s" | "5m" | "1h"` (or bare seconds) to milliseconds, 60s..24h.
    public static func parseTick(_ raw: String?) throws -> Int {
        let text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let pattern = /^(\d+)\s*([smhSMH])$/
        guard let match = try? pattern.wholeMatch(in: text),
              let units = Int(match.1) else {
            throw CastRuleError(message: "interval like 90s, 5m, 1h")
        }
        let perUnit: Int
        switch match.2.lowercased() {
        case "s": perUnit = 1000
        case "m": perUnit = 60_000
        default: perUnit = 3_600_000
        }
        let ms = units * perUnit
        guard ms >= 60_000 else { throw CastRuleError(message: "minimum tick is 60s") }
        guard ms <= 86_400_000 else { throw CastRuleError(message: "maximum tick is 24h") }
        return ms
    }

    /// The bare-number spelling (seconds), as `parseTick` accepts numbers.
    public static func parseTick(seconds: Int) throws -> Int {
        guard seconds > 0 else { throw CastRuleError(message: "interval must be positive") }
        return seconds * 1000
    }

    // MARK: - HLS

    /// Rolling playlist over [0, segments): windowed while live, full and
    /// ENDLIST when ended — the daemon's `livePlaylist`, character for
    /// character.
    public static func livePlaylist(segments: Int, ended: Bool, targetDuration: Int = 6) -> String {
        let start = ended ? 0 : max(0, segments - liveWindow)
        var out = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-TARGETDURATION:\(targetDuration)",
            "#EXT-X-MEDIA-SEQUENCE:\(start)",
            "#EXT-X-MAP:URI=\"init.mp4\"",
        ]
        if segments > start {
            for index in start..<segments {
                out.append("#EXTINF:\(targetDuration).0,")
                out.append("seg-\(index).m4s")
            }
        }
        if ended { out.append("#EXT-X-ENDLIST") }
        return out.joined(separator: "\n") + "\n"
    }

    // MARK: - validators and allowlists

    /// URLs that point at our own loopback origin are reduced to their path:
    /// the asset server's port is ephemeral, so an absolute self-URL recorded
    /// in one launch would be dead in the next. External URLs pass through.
    public static func normalizeMediaUrl(_ url: String) -> String {
        let lower = url.lowercased()
        if lower.hasPrefix("http://127.0.0.1:") || lower.hasPrefix("http://localhost:") {
            if let parsed = URL(string: url) {
                return parsed.path.isEmpty ? "/" : parsed.path
            }
        }
        return url
    }

    /// The daemon's media-URL rule: an http(s) URL or a site path.
    public static func isSiteMediaUrl(_ url: String) -> Bool {
        let lower = url.lowercased()
        return lower.hasPrefix("http://") || lower.hasPrefix("https://") || url.hasPrefix("/")
    }

    public static func liveIdValid(_ id: String?) -> Bool {
        guard let id else { return false }
        return id.count >= 6 && id.count <= 16 && id.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber) }
    }

    public static func liveFileValid(_ name: String?) -> Bool {
        guard let name else { return false }
        if name == "index.m3u8" || name == "init.mp4" { return true }
        let pattern = /^seg-(\d{1,6})\.m4s$/
        guard let match = try? pattern.wholeMatch(in: name), let n = Int(match.1) else { return false }
        return n >= 0 && n < maxLiveSegments
    }

    private static let mediaExtensions: [String: String] = [
        "video/webm": ".webm",
        "video/mp4": ".mp4",
        "audio/webm": ".webm",
        "audio/mp4": ".m4a",
        "audio/mpeg": ".mp3",
        "audio/ogg": ".ogg",
    ]

    public static func mediaExt(_ mime: String) -> String? {
        let clean = mime.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? mime
        return mediaExtensions[clean.lowercased()]
    }

    /// The 12-character id of a stored recording.
    public static func recordingBaseValid(_ base: String?) -> Bool {
        guard let base else { return false }
        return base.count == 12 && base.allSatisfy { ($0.isASCII && $0.isLowercase) || $0.isNumber }
    }

    /// A packaged part name: the init segment or one numbered segment.
    public static func recordingPartValid(_ file: String?) -> Bool {
        guard let file else { return false }
        if file == "init.mp4" { return true }
        let pattern = /^seg-(\d{1,6})\.m4s$/
        return (try? pattern.wholeMatch(in: file)) != nil
    }

    public static func mediaFileValid(_ name: String?) -> Bool {
        guard let name else { return false }
        let pattern = /^[a-z0-9]{12}\.(webm|mp4|m4a|mp3|ogg)$/
        return (try? pattern.wholeMatch(in: name)) != nil
    }

    public static func mediaMime(for name: String) -> String {
        if name.hasSuffix(".mp4") { return "video/mp4" }
        if name.hasSuffix(".webm") { return "video/webm" }
        if name.hasSuffix(".m4a") { return "audio/mp4" }
        if name.hasSuffix(".mp3") { return "audio/mpeg" }
        return "audio/ogg"
    }

    // MARK: - ids

    public static func newId(prefix: String) -> String {
        prefix + "_" + randomId(length: 6)
    }

    public static func newLiveId() -> String {
        randomId(length: 12)
    }

    /// Stream ids are `stm_` plus nine characters, the daemon's `newStreamId`.
    public static func newStreamId() -> String {
        "stm_" + randomId(length: 9)
    }

    public static func newMediaId() -> String {
        randomId(length: 12)
    }

    private static func randomId(length: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        var out = ""
        for _ in 0..<length {
            out.append(idChars[Int.random(in: 0..<idChars.count, using: &generator)])
        }
        return out
    }

    /// JS `${total}` for a number: integral values print without `.0`.
    static func formatNumber(_ value: Double) -> String {
        if value.rounded() == value, abs(value) < 9_007_199_254_740_992 {
            return String(Int64(value))
        }
        return String(value)
    }
}
