import XCTest
@testable import BSVOSWallet

/// Item 2, the testable half: serving a bundled app's files, and refusing to
/// serve anything outside its own folder.
final class AppAssetSourceTests: XCTestCase {
    private func makeTree() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("bsvos-assets-\(UUID().uuidString)", isDirectory: true)
        let app = root.appendingPathComponent("demo", isDirectory: true)
        try FileManager.default.createDirectory(at: app.appendingPathComponent("js"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: app.appendingPathComponent("img"), withIntermediateDirectories: true)
        try Data("<html>hi</html>".utf8).write(to: app.appendingPathComponent("index.html"))
        try Data("console.log(1)".utf8).write(to: app.appendingPathComponent("js/app.js"))
        try Data([0x89, 0x50, 0x4e, 0x47]).write(to: app.appendingPathComponent("img/pic.png"))
        try Data("not yours".utf8).write(to: root.appendingPathComponent("secret.txt"))
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testServesFilesWithMIMETypes() throws {
        let source = DirectoryAppAssetSource(root: try makeTree())
        XCTAssertEqual(source.appNames(), ["demo"])

        let index = try XCTUnwrap(source.asset(app: "demo", path: ""))
        XCTAssertEqual(String(data: index.data, encoding: .utf8), "<html>hi</html>")
        XCTAssertEqual(index.mime, "text/html; charset=utf-8")

        let script = try XCTUnwrap(source.asset(app: "demo", path: "js/app.js"))
        XCTAssertEqual(script.mime, "text/javascript; charset=utf-8")

        let image = try XCTUnwrap(source.asset(app: "demo", path: "img/pic.png"))
        XCTAssertEqual(image.mime, "image/png")
    }

    func testRefusesToLeaveTheAppsFolder() throws {
        let source = DirectoryAppAssetSource(root: try makeTree())
        for path in ["../secret.txt", "js/../../secret.txt", "/etc/passwd", "..", ".", "js/./app.js"] {
            XCTAssertNil(source.asset(app: "demo", path: path), "path \(path) must not resolve")
        }
        for app in ["..", ".", "demo/../demo", "", "demo/sub"] {
            XCTAssertNil(source.asset(app: app, path: "index.html"), "app \(app) must not resolve")
        }
    }

    func testAMissIsNilNotACrash() throws {
        let source = DirectoryAppAssetSource(root: try makeTree())
        XCTAssertNil(source.asset(app: "demo", path: "missing.html"))
        XCTAssertNil(source.asset(app: "absent", path: "index.html"))
    }
}
