import XCTest
@testable import BSVOSWallet

/// The loopback origin the bundled apps are served from: files come back with
/// the right bytes and MIME types, traversal and misses are 404s, and one
/// server is reused for every app.
final class BundleAssetServerTests: XCTestCase {
    private var root: URL!
    private var server: BundleAssetServer!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("bsvos-assets-\(UUID().uuidString)")
        let demo = root.appendingPathComponent("demo")
        try FileManager.default.createDirectory(at: demo, withIntermediateDirectories: true)
        try Data("<html>hi</html>".utf8).write(to: demo.appendingPathComponent("index.html"))
        try Data("console.log(1)".utf8).write(to: demo.appendingPathComponent("app.js"))
        try Data("secret".utf8).write(to: root.appendingPathComponent("secret.txt"))
        server = BundleAssetServer()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func start() async throws -> URL {
        let base = await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            server.baseURL(for: DirectoryAppAssetSource(root: root)) { continuation.resume(returning: $0) }
        }
        return try XCTUnwrap(base)
    }

    private func get(_ url: URL) async throws -> (body: String, code: Int, mime: String?) {
        let (data, response) = try await URLSession.shared.data(from: url)
        let http = response as? HTTPURLResponse
        return (String(decoding: data, as: UTF8.self), http?.statusCode ?? 0, http?.value(forHTTPHeaderField: "content-type"))
    }

    func testItServesAppFilesWithMimeTypes() async throws {
        let base = try await start()
        XCTAssertEqual(base.host, "127.0.0.1", "loopback only")
        XCTAssertEqual(base.scheme, "http", "a real origin, so modules and secure APIs work")

        let html = try await get(base.appendingPathComponent("demo").appendingPathComponent("index.html"))
        XCTAssertEqual(html.code, 200)
        XCTAssertEqual(html.body, "<html>hi</html>")
        XCTAssertEqual(html.mime, "text/html; charset=utf-8")

        let js = try await get(base.appendingPathComponent("demo").appendingPathComponent("app.js"))
        XCTAssertEqual(js.code, 200)
        XCTAssertEqual(js.body, "console.log(1)")
        XCTAssertEqual(js.mime, "text/javascript; charset=utf-8")
    }

    /// A module import is the case that broke under `file://`; same-origin
    /// HTTP must serve it without any special headers.
    func testItServesModulesAndRelativeFetches() async throws {
        let base = try await start()
        let module = try await get(
            base.appendingPathComponent("demo").appendingPathComponent("app.js")
        )
        XCTAssertEqual(module.code, 200)
        // The MIME is what WebKit requires for module scripts.
        XCTAssertTrue(module.mime?.contains("javascript") == true)
    }

    func testTraversalAndMissingFilesAre404s() async throws {
        let base = try await start()
        let port = try XCTUnwrap(server.port)
        // The browser normalizes `../` away before sending, so ask with the
        // encoded form the server itself must refuse.
        let traversal = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/demo/%2e%2e/secret.txt"))
        let escaped = try await get(traversal)
        XCTAssertEqual(escaped.code, 404, "no path escapes the app directory")

        let missing = try await get(base.appendingPathComponent("demo").appendingPathComponent("nope.js"))
        XCTAssertEqual(missing.code, 404)

        let unknownApp = try await get(base.appendingPathComponent("ghost").appendingPathComponent("index.html"))
        XCTAssertEqual(unknownApp.code, 404)
    }

    func testTheSameServerIsReused() async throws {
        let first = try await start()
        let second = try await start()
        XCTAssertEqual(first, second)
    }
}
