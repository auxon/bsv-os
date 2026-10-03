import Foundation
#if canImport(Network)
import Network

/// Serves a bundled app's files over loopback HTTP.
///
/// `loadFileURL` gives the page a `file://` origin, and `file://` is not a web
/// origin: ES modules refuse to load (so the app's script never runs and the
/// page sits on its initial "connecting…"), `fetch("library-index.json")`
/// fails, and secure-context-only APIs (`navigator.mediaDevices`, the
/// clipboard, service workers) are hidden. That is exactly how the bundled
/// apps broke on the phone.
///
/// Loopback is a real origin, and `127.0.0.1` (like `localhost`) is a secure
/// context, so the same assets behave the way they do on the desktop. This
/// serves **static files only**, from one app root, with the same path rules as
/// `DirectoryAppAssetSource`; the wallet RPC still travels through the injected
/// `fetch("/")` shim and the native bridge, and no credential is ever placed in
/// a URL.
public final class BundleAssetServer: @unchecked Sendable {
    /// Production uses one server for the process; tests make their own.
    public static let shared = BundleAssetServer()

    private let queue = DispatchQueue(label: "com.bsvos.bundle-assets", qos: .userInitiated)
    private let lock = NSLock()
    private var source: (any AppAssetSource)?
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

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else {
                connection.cancel()
                return
            }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
                self.respond(to: head, on: connection)
                return
            }
            if isComplete || error != nil || buffer.count > 64 * 1024 {
                connection.cancel()
                return
            }
            self.receive(on: connection, buffer: buffer)
        }
    }

    private func respond(to head: String, on connection: NWConnection) {
        let requestLine = head.split(separator: "\r\n", omittingEmptySubsequences: false).first ?? ""
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            write(status: 400, mime: "text/plain; charset=utf-8", body: Data("bad request".utf8), headOnly: true, on: connection)
            return
        }
        let method = String(parts[0]).uppercased()
        guard method == "GET" || method == "HEAD" else {
            write(status: 405, mime: "text/plain; charset=utf-8", body: Data("method not allowed".utf8), headOnly: true, on: connection)
            return
        }
        let headOnly = method == "HEAD"
        let target = String(parts[1])
        let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? target
        let decoded = path.removingPercentEncoding ?? path
        let components = decoded.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard let app = components.first else {
            write(status: 404, mime: "text/plain; charset=utf-8", body: Data("not found".utf8), headOnly: headOnly, on: connection)
            return
        }
        let relative = components.dropFirst().joined(separator: "/")
        // `DirectoryAppAssetSource` owns the path rules: plain components only,
        // no traversal, missing files are misses.
        lock.lock()
        let current = source
        lock.unlock()
        guard let asset = current?.asset(app: app, path: relative) else {
            write(status: 404, mime: "text/plain; charset=utf-8", body: Data("not found".utf8), headOnly: headOnly, on: connection)
            return
        }
        write(status: 200, mime: asset.mime, body: asset.data, headOnly: headOnly, on: connection)
    }

    private func write(status: Int, mime: String, body: Data, headOnly: Bool, on connection: NWConnection) {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 404: reason = "Not Found"
        case 405: reason = "Method Not Allowed"
        default: reason = "Bad Request"
        }
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "content-type: \(mime)\r\n"
        head += "content-length: \(body.count)\r\n"
        head += "cache-control: no-store\r\n"
        head += "connection: close\r\n\r\n"
        var payload = Data(head.utf8)
        if !headOnly { payload.append(body) }
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
#endif
