import Foundation

/// Where a bundled app's files come from.
///
/// The stock apps (Twetch, Explorer, MemeStudio, …) are normally served by the
/// daemon. A standalone phone has no server, so the same files ride in the app
/// bundle and this hands them to the host. The security rule is the boring one:
/// a page must not be able to ask for a path that escapes its own directory,
/// and a missing file is a miss, not a crash.
public protocol AppAssetSource: Sendable {
    /// The bytes and MIME type for `path` inside `app`, or nil.
    func asset(app: String, path: String) -> (data: Data, mime: String)?
    /// Every app name this source carries, sorted.
    func appNames() -> [String]
}

/// A directory of `<name>/…` app folders — the synced runner apps, or a test's
/// temporary tree.
public struct DirectoryAppAssetSource: AppAssetSource {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// The app bundle's copy, when `scripts/sync-apps.mjs` has run.
    public init?() {
        guard let url = Bundle.module.resourceURL?.appendingPathComponent("apps", isDirectory: true),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        self.root = url
    }

    public func appNames() -> [String] {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey]
        ) else { return [] }
        return entries
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }
            .map(\.lastPathComponent)
            .sorted()
    }

    public func asset(app: String, path: String) -> (data: Data, mime: String)? {
        guard Self.isSafeComponent(app) else { return nil }
        let relative = path.isEmpty || path == "/" ? "index.html" : path
        guard Self.isSafeRelativePath(relative) else { return nil }
        let file = root
            .appendingPathComponent(app, isDirectory: true)
            .appendingPathComponent(relative)
        guard let data = try? Data(contentsOf: file) else { return nil }
        return (data, MIMEType.forExtension(file.pathExtension))
    }

    /// One directory name: no separators, no dot-dot, not empty.
    static func isSafeComponent(_ name: String) -> Bool {
        !name.isEmpty && !name.contains("/") && !name.contains("\\") && name != "." && name != ".."
    }

    /// A path inside the app: relative, and every segment a plain name. This is
    /// what keeps `../` and absolute paths from walking out of the app's folder.
    static func isSafeRelativePath(_ path: String) -> Bool {
        guard !path.hasPrefix("/") && !path.hasPrefix("~") else { return false }
        let segments = path.split(separator: "/")
        guard !segments.isEmpty else { return false }
        return segments.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
}

/// The subset of MIME types the runner apps actually use.
public enum MIMEType {
    public static func forExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        case "mp3": return "audio/mpeg"
        case "mp4": return "video/mp4"
        case "webm": return "video/webm"
        default: return "application/octet-stream"
        }
    }
}
