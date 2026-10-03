import Foundation
#if canImport(Network)
import Network

/// Serves a bundled app's files over loopback HTTP, and the Cast app's media
/// routes alongside them.
///
/// `loadFileURL` gives the page a `file://` origin, and `file://` is not a web
/// origin: ES module imports refuse to load (so the app's script never runs and
/// the page sits on its initial "connecting…"), `fetch("library-index.json")`
/// fails, and secure-context-only APIs (`navigator.mediaDevices`, the
/// clipboard, service workers) are hidden. That is exactly how the bundled
/// apps broke on the phone.
///
/// Loopback is a real origin, and `127.0.0.1` (like `localhost`) is a secure
/// context, so the same assets behave the way they do on the desktop. The
/// asset half serves **static files only**, from one app root, with the same
/// path rules as `DirectoryAppAssetSource`; the wallet RPC still travels
/// through the injected `fetch("/")` shim and the native bridge, and no
/// credential is ever placed in a URL.
///
/// The cast half is the daemon's `/cast/media` and `/cast/live` surface — the
/// Cast app speaks plain HTTP for media because it uploads blobs and streams
/// ranges, which are not JSON-RPC. It is delegated to a `CastMediaServing`
/// handler backed by the phone's own cast store and media directory.
public final class BundleAssetServer: @unchecked Sendable {
    /// Production uses one server for the process; tests make their own.
    public static let shared = BundleAssetServer()

    private let queue = DispatchQueue(label: "com.bsvos.bundle-assets", qos: .userInitiated)
    private let lock = NSLock()
    private var source: (any AppAssetSource)?
    private var castMedia: (any CastMediaServing)?
    private var listener: NWListener?
    private var readyPort: NWEndpoint.Port?
    private var waiting: [@Sendable (URL?) -> Void] = []

    public init() {}

    /// The base URL for `source`, starting the server if needed. The completion
    /// runs once, with nil when the listener could not start — callers may fall
    /// back to `loadFileURL` (degrades to a static page) or show an error.
    public func baseURL(for source: any AppAssetSource, completion: @escaping @Sendable (URL?) -> Void) {
        lock.lock()
        if let readyPort {
            lock.unlock()
            completion(Self.url(port: readyPort))
            return
        }
        self.source = source
        waiting.append(completion)
        if listener != nil {
            lock.unlock()
            return
        }
        lock.unlock()
        start()
    }

    /// Installs the cast media routes. Called before any app host opens; a
    /// server without a handler answers 503 on cast paths.
    public func setCastMediaHandler(_ handler: any CastMediaServing) {
        lock.lock()
        castMedia = handler
        lock.unlock()
    }

    var port: UInt16? {
        lock.lock()
        defer { lock.unlock() }
        return readyPort.map { UInt16($0.rawValue) }
    }

    private static func url(port: NWEndpoint.Port) -> URL? {
        URL(string: "http://127.0.0.1:\(port.rawValue)/")
    }

    private func start() {
        do {
            let parameters = NWParameters.tcp
            // Bind the loopback interface only: nothing on the LAN can reach
            // this, and there is no local-network permission to ask for.
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
            parameters.allowLocalEndpointReuse = true
            let listener = try NWListener(using: parameters)
            lock.lock()
            self.listener = listener
            lock.unlock()
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.resolveReady(port: listener?.port)
                case .failed, .cancelled:
                    self.fail()
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.start(queue: queue)
        } catch {
            fail()
        }
    }

    private func resolveReady(port: NWEndpoint.Port?) {
        lock.lock()
        self.readyPort = port
        let waiters = waiting
        waiting = []
        lock.unlock()
        let url = port.flatMap(Self.url(port:))
        for waiter in waiters { waiter(url) }
    }

    private func fail() {
        lock.lock()
        listener = nil
        readyPort = nil
        let waiters = waiting
        waiting = []
        lock.unlock()
        for waiter in waiters { waiter(nil) }
    }

    // MARK: - connections

    private struct Request {
        var method: String
        var target: String
        var headers: [String: String]
        var body: Data

        var path: String {
            target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? target
        }

        var query: [String: String] {
            guard let queryStart = target.firstIndex(of: "?") else { return [:] }
            var out: [String: String] = [:]
            for pair in target[target.index(after: queryStart)...].split(separator: "&") {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                let key = String(parts[0]).removingPercentEncoding ?? String(parts[0])
                let value = parts.count > 1 ? (String(parts[1]).removingPercentEncoding ?? String(parts[1])) : ""
                out[key] = value
            }
            return out
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else {
                connection.cancel()
                return
            }
            var buffer = buffer
            if let data { buffer.append(data) }
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if isComplete || error != nil || buffer.count > 64 * 1024 {
                    connection.cancel()
                    return
                }
                self.receive(on: connection, buffer: buffer)
                return
            }
            let head = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
            let parsed = Self.parseHead(head)
            let contentLength = Int(parsed.headers["content-length"] ?? "") ?? 0
            if contentLength > CastRules.maxUploadBytes {
                self.write(.failure(413, code: "TOO_BIG", message: "body exceeds 256 MiB"), headOnly: true, on: connection)
                return
            }
            let bodyStart = headerEnd.upperBound
            let have = buffer.count - bodyStart
            if have < contentLength, !isComplete, error == nil {
                self.receive(on: connection, buffer: buffer)
                return
            }
            let body = buffer.subdata(in: bodyStart..<min(bodyStart + contentLength, buffer.count))
            self.respond(Self.request(parsed, body: body), on: connection)
        }
    }

    private static func parseHead(_ head: String) -> (method: String, target: String, headers: [String: String]) {
        let lines = head.split(separator: "\r\n", omittingEmptySubsequences: false)
        let requestLine = lines.first.map(String.init) ?? ""
        let parts = requestLine.split(separator: " ")
        let method = parts.first.map { String($0).uppercased() } ?? ""
        let target = parts.count >= 2 ? String(parts[1]) : ""
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        return (method, target, headers)
    }

    private static func request(
        _ parsed: (method: String, target: String, headers: [String: String]), body: Data
    ) -> Request {
        Request(method: parsed.method, target: parsed.target, headers: parsed.headers, body: body)
    }

    private func respond(_ request: Request, on connection: NWConnection) {
        let path = request.path.removingPercentEncoding ?? request.path
        if path == "/cast/media" || path.hasPrefix("/cast/media/") || path.hasPrefix("/cast/live/") {
            respondCast(request, path: path, on: connection)
            return
        }
        guard request.method == "GET" || request.method == "HEAD" else {
            write(.failure(405, code: "METHOD", message: "method not allowed"), headOnly: true, on: connection)
            return
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard let app = components.first else {
            write(.failure(404, code: "NOT_FOUND", message: "not found"), headOnly: request.method == "HEAD", on: connection)
            return
        }
        let relative = components.dropFirst().joined(separator: "/")
        // `DirectoryAppAssetSource` owns the path rules: plain components only,
        // no traversal, missing files are misses.
        lock.lock()
        let current = source
        lock.unlock()
        guard let asset = current?.asset(app: app, path: relative) else {
            write(.failure(404, code: "NOT_FOUND", message: "not found"), headOnly: request.method == "HEAD", on: connection)
            return
        }
        let reply = CastHTTPReply(status: 200, contentType: asset.mime, body: asset.data)
        write(reply, headOnly: request.method == "HEAD", on: connection)
    }

    // MARK: - cast media routes

    private func respondCast(_ request: Request, path: String, on connection: NWConnection) {
        lock.lock()
        let handler = castMedia
        lock.unlock()
        guard let handler else {
            write(.failure(503, code: "OFFLINE", message: "cast media offline"), headOnly: true, on: connection)
            return
        }
        Task { [weak self] in
            guard let self else { return }
            let reply: CastHTTPReply
            let components = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            if components.count == 2, components[0] == "cast", components[1] == "media" {
                guard request.method == "POST" else {
                    reply = .failure(405, code: "METHOD", message: "method not allowed")
                    self.write(reply, headOnly: true, on: connection)
                    return
                }
                reply = await handler.uploadRecording(
                    data: request.body,
                    contentType: request.headers["content-type"] ?? "",
                    durationMs: request.headers["x-cast-duration-ms"].flatMap(Int.init)
                        ?? request.query["durationMs"].flatMap(Int.init)
                )
            } else if components.count == 3, components[0] == "cast", components[1] == "media" {
                guard request.method == "GET" || request.method == "HEAD" else {
                    reply = .failure(405, code: "METHOD", message: "method not allowed")
                    self.write(reply, headOnly: true, on: connection)
                    return
                }
                reply = await handler.recording(name: components[2], range: request.headers["range"])
            } else if components.count == 4, components[0] == "cast", components[1] == "live", components[3] == "segment" {
                guard request.method == "POST" else {
                    reply = .failure(405, code: "METHOD", message: "method not allowed")
                    self.write(reply, headOnly: true, on: connection)
                    return
                }
                reply = await handler.appendSegment(
                    liveId: components[2],
                    data: request.body,
                    isInit: request.query["init"] == "1",
                    mime: request.query["mime"]
                )
            } else if components.count == 4, components[0] == "cast", components[1] == "live" {
                guard request.method == "GET" || request.method == "HEAD" else {
                    reply = .failure(405, code: "METHOD", message: "method not allowed")
                    self.write(reply, headOnly: true, on: connection)
                    return
                }
                if components[3] == "index.m3u8" {
                    reply = await handler.livePlaylist(liveId: components[2])
                } else {
                    reply = await handler.liveFile(liveId: components[2], name: components[3], range: request.headers["range"])
                }
            } else {
                reply = .failure(404, code: "NOT_FOUND", message: "not found")
            }
            self.write(reply, headOnly: request.method == "HEAD", on: connection)
        }
    }

    // MARK: - writing

    private func write(_ reply: CastHTTPReply, headOnly: Bool, on connection: NWConnection) {
        let reason: String
        switch reply.status {
        case 200: reason = "OK"
        case 206: reason = "Partial Content"
        case 400: reason = "Bad Request"
        case 404: reason = "Not Found"
        case 405: reason = "Method Not Allowed"
        case 409: reason = "Conflict"
        case 413: reason = "Payload Too Large"
        case 415: reason = "Unsupported Media Type"
        case 416: reason = "Range Not Satisfiable"
        case 503: reason = "Service Unavailable"
        default: reason = "Internal Server Error"
        }
        var head = "HTTP/1.1 \(reply.status) \(reason)\r\n"
        head += "content-type: \(reply.contentType)\r\n"
        head += "content-length: \(reply.body.count)\r\n"
        head += "cache-control: no-store\r\n"
        head += "connection: close\r\n"
        for (name, value) in reply.headers {
            head += "\(name): \(value)\r\n"
        }
        head += "\r\n"
        var payload = Data(head.utf8)
        if !headOnly { payload.append(reply.body) }
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
#endif
