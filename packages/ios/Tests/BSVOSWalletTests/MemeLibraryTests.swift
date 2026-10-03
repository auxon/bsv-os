import XCTest
@testable import BSVOSWallet

/// MemeStudio's search path: the public Dank Rares API read must match the
/// daemon's request URL and its item mapping (media rewriting, slug building,
/// tolerant fields), and errors must keep the daemon's code and wording.
final class MemeLibraryTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Failure: Decodable {
            let code: String
            let message: String
        }
        let requestUrl: String
        let responseBody: String
        let page: MemePage
        let error: Failure?
    }

    actor CaptureTransport: ChainTransport {
        private var response: (Data, Int) = (Data("null".utf8), 500)
        private(set) var requested: [String] = []

        func get(_ url: URL) async throws -> (Data, Int) {
            requested.append(url.absoluteString)
            return response
        }

        func post(_ url: URL, jsonBody: Data) async throws -> (Data, Int) {
            (Data("null".utf8), 405)
        }

        func set(_ body: String, code: Int) {
            response = (Data(body.utf8), code)
        }
    }

    private func load() throws -> Vectors {
        let here = URL(fileURLWithPath: #filePath)
        let repoRoot = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("walletd/test/vectors/twetch-meme-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testSearchAsksTheDaemonsQuestionAndMapsTheDaemonsPage() async throws {
        let vectors = try load()
        let transport = CaptureTransport()
        await transport.set(vectors.responseBody, code: 200)
        let library = TwetchMemeLibrary(baseURL: "https://api.twetch.com", transport: transport)

        let page = try await library.search(MemeQuery(
            q: "meme template", format: "gif", sort: "recent", cursor: "abc", limit: 24
        ))

        let requested = await transport.requested
        XCTAssertEqual(requested, [vectors.requestUrl], "the request URL is byte-identical")
        XCTAssertEqual(page, vectors.page, "every item field maps as the daemon maps it")
    }

    func testAFailedLookupKeepsTheDaemonsCodeAndWording() async throws {
        let vectors = try load()
        let transport = CaptureTransport()
        await transport.set("boom", code: 503)
        let library = TwetchMemeLibrary(transport: transport)
        do {
            _ = try await library.search(MemeQuery(q: "x"))
            XCTFail("a 503 is not a page")
        } catch let error as WalletError {
            XCTAssertEqual(error.code, vectors.error?.code)
            XCTAssertEqual(error.message, vectors.error?.message)
        }
    }
}
