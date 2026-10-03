import Foundation

/// The Twetch Meme Library (Dank Rares) read: public, keyless, and the one
/// data source MemeStudio needs beyond the files in its bundle. Posting and
/// vision remain desktop/account features; browsing does not need either.
public struct MemeItem: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var description: String
    public var folder: String
    public var folderSlug: String
    public var format: String
    public var mediaUrl: String
    public var previewUrl: String
    public var onchainRef: String
    public var sha256: String
    public var tags: [String]
    public var tokenNumber: Int?
    public var ownerUserId: Int?
    public var uploadedAtMs: Int
    public var bytes: Int
    public var url: String

    public init(
        id: String, title: String, description: String, folder: String, folderSlug: String,
        format: String, mediaUrl: String, previewUrl: String, onchainRef: String, sha256: String,
        tags: [String], tokenNumber: Int?, ownerUserId: Int?, uploadedAtMs: Int, bytes: Int, url: String
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.folder = folder
        self.folderSlug = folderSlug
        self.format = format
        self.mediaUrl = mediaUrl
        self.previewUrl = previewUrl
        self.onchainRef = onchainRef
        self.sha256 = sha256
        self.tags = tags
        self.tokenNumber = tokenNumber
        self.ownerUserId = ownerUserId
        self.uploadedAtMs = uploadedAtMs
        self.bytes = bytes
        self.url = url
    }
}

public struct MemePage: Codable, Sendable, Equatable {
    public var items: [MemeItem]
    public var nextCursor: String?
    public var total: Int

    public init(items: [MemeItem], nextCursor: String?, total: Int) {
        self.items = items
        self.nextCursor = nextCursor
        self.total = total
    }
}

/// The subset of the daemon's `MemeQuery` the apps use.
public struct MemeQuery: Sendable, Equatable {
    public var q: String?
    public var folder: String?
    public var tag: String?
    public var format: String?
    public var sort: String?
    public var cursor: String?
    public var limit: Int
    public var uploaderUserId: Int?

    public init(
        q: String? = nil, folder: String? = nil, tag: String? = nil, format: String? = nil,
        sort: String? = nil, cursor: String? = nil, limit: Int = 30, uploaderUserId: Int? = nil
    ) {
        self.q = q
        self.folder = folder
        self.tag = tag
        self.format = format
        self.sort = sort
        self.cursor = cursor
        self.limit = limit
        self.uploaderUserId = uploaderUserId
    }
}

public protocol MemeLibrary: Sendable {
    func search(_ query: MemeQuery) async throws -> MemePage
}

/// The daemon's `memeLibrary` + `asMeme` (twetch.ts), pointed at the public
/// API. Errors keep the daemon's `RAILS` code and message so the page sees the
/// same wording on both hosts.
public struct TwetchMemeLibrary: MemeLibrary {
    public static let apiBase = "https://api.twetch.com"
    private let baseURL: String
    private let transport: any ChainTransport

    public init(
        baseURL: String = TwetchMemeLibrary.apiBase,
        transport: any ChainTransport = URLSessionTransport()
    ) {
        self.baseURL = baseURL
        self.transport = transport
    }

    public func search(_ query: MemeQuery) async throws -> MemePage {
        guard let url = URL(string: baseURL + "/v1/dank-rares?" + Self.queryString(query)) else {
            throw WalletError(code: "RAILS", message: "twetch api: bad url")
        }
        let (data, code) = try await transport.get(url)
        guard (200..<300).contains(code) else {
            let detail = String(decoding: data.prefix(200), as: UTF8.self)
            throw WalletError(code: "RAILS", message: "twetch api \(code): \(detail)")
        }
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let rawItems = payload["items"] as? [[String: Any]] ?? []
        return MemePage(
            items: rawItems.map(Self.meme),
            nextCursor: payload["nextCursor"] as? String,
            total: Int(Self.number(payload["total"]) ?? 0)
        )
    }

    // MARK: - the daemon's pieces, ported

    static func queryString(_ query: MemeQuery) -> String {
        var parts: [String] = []
        func add(_ name: String, _ value: String) {
            parts.append("\(name)=\(formEncode(value))")
        }
        if let cursor = query.cursor, !cursor.isEmpty { add("cursor", cursor) }
        if let q = query.q?.trimmingCharacters(in: .whitespaces), !q.isEmpty { add("q", q) }
        if let folder = query.folder, !folder.isEmpty { add("folder", folder) }
        if let tag = query.tag, !tag.isEmpty { add("tag", tag) }
        if let format = query.format, !format.isEmpty, format != "all" { add("format", format) }
        if let sort = query.sort, !sort.isEmpty { add("sort", sort) }
        if let uploader = query.uploaderUserId, uploader > 0 { add("uploaderUserId", String(uploader)) }
        add("limit", String(min(max(query.limit, 1), 60)))
        return parts.joined(separator: "&")
    }

    /// `URLSearchParams` encoding: space is `+`, and only `*`, `-`, `.`, `_`
    /// and ASCII alphanumerics stay raw. Matching it keeps the request URL
    /// byte-identical to the daemon's.
    static func formEncode(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._")
        return value.addingPercentEncoding(withAllowedCharacters: allowed)?
            .replacingOccurrences(of: "%20", with: "+") ?? value
    }

    static func meme(_ m: [String: Any]) -> MemeItem {
        let sha256 = m["sha256"] as? String ?? ""
        let title = m["title"] as? String ?? ""
        let media = mediaUrl(m["mediaUrl"])
        let preview = mediaUrl(m["previewUrl"])
        return MemeItem(
            id: m["id"] as? String ?? "",
            title: title,
            description: m["description"] as? String ?? "",
            folder: m["folder"] as? String ?? "",
            folderSlug: m["folderSlug"] as? String ?? "",
            format: m["format"] as? String ?? "",
            mediaUrl: media,
            previewUrl: preview.isEmpty ? media : preview,
            onchainRef: (m["onchainRef"] as? String) ?? (m["path"] as? String) ?? "",
            sha256: sha256,
            tags: (m["tags"] as? [Any])?.compactMap { $0 as? String } ?? [],
            tokenNumber: optionalInt(m["tokenNumber"]),
            ownerUserId: optionalInt(m["ownerUserId"]),
            uploadedAtMs: Int(number(m["uploadedAtMs"]) ?? 0),
            bytes: Int(number(m["bytes"]) ?? 0),
            url: sha256.isEmpty
                ? "https://twetch.com/meme-library"
                : "https://twetch.com/meme-library/meme/\(sha256)/\(slug(title))"
        )
    }

    /// `mediaUrlOf`: absolute URLs (http upgraded to https), API-relative
    /// paths, `b://` and bare hashes become Twetch media URLs; anything else
    /// falls through to the ordinals wallet media host.
    static func mediaUrl(_ raw: Any?) -> String {
        let value = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if value.isEmpty { return "" }
        if value.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil {
            if value.count >= 5, value.lowercased().hasPrefix("http:") {
                return "https:" + value.dropFirst(5)
            }
            return value
        }
        if value.hasPrefix("/") { return TwetchMemeLibrary.apiBase + value }
        if value.hasPrefix("b://") {
            guard let match = firstHash(in: String(value.dropFirst(4))) else { return "" }
            return TwetchMemeLibrary.apiBase + "/v1/media/\(match).jpg?v=4"
        }
        if isLowercaseHex(value, count: 64) {
            return TwetchMemeLibrary.apiBase + "/v1/media/\(value.lowercased()).jpg?v=4"
        }
        return "https://media.ordinalswallet.com/\(value)"
    }

    /// The daemon's `memeSlug`: NFKD-folded, lowercased, non-alphanumerics
    /// collapsed to `-`, capped at 90, trimmed — or `meme`.
    static func slug(_ title: String) -> String {
        let stripped = title.decomposedStringWithCanonicalMapping.unicodeScalars.filter {
            !(0x0300...0x036f).contains($0.value)
        }
        var text = String(String.UnicodeScalarView(stripped)).lowercased()
        text = text.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        text = String(text.prefix(90)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return text.isEmpty ? "meme" : text
    }

    private static func number(_ raw: Any?) -> Double? {
        if let value = raw as? NSNumber { return value.doubleValue }
        if let text = raw as? String { return Double(text) }
        return nil
    }

    /// `m.tokenNumber == null ? null : Math.floor(Number(t) || 0)`.
    private static func optionalInt(_ raw: Any?) -> Int? {
        if raw == nil || raw is NSNull { return nil }
        return Int(number(raw) ?? 0)
    }

    private static func isLowercaseHex(_ value: String, count: Int) -> Bool {
        value.count == count && value.allSatisfy { $0.isHexDigit }
    }

    private static func firstHash(in value: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: "[a-f0-9]{64}", options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: range),
              let matchRange = Range(match.range, in: value) else { return nil }
        return String(value[matchRange]).lowercased()
    }
}
