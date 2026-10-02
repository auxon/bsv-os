import SwiftUI
#if canImport(WebKit)
import WebKit
#endif

/// The app list: what the daemon has installed, and a way to launch it.
///
/// The registry stays in the daemon — `appList`, `appInstall` and `appRemove`
/// are device-callable, so there is exactly one list of installed apps with one
/// set of manifest hashes and spend caps, and the phone is just another view of
/// it.
public struct AppsView: View {
    let session: WalletSession
    let baseURL: URL
    let credential: DeviceCredential

    @State private var apps: [InstalledApp] = []
    @State private var loading = false
    @State private var installDomain = ""
    @State private var error: WalletError?
    @State private var opened: InstalledApp?

    public init(session: WalletSession, baseURL: URL, credential: DeviceCredential) {
        self.session = session
        self.baseURL = baseURL
        self.credential = credential
    }

    public var body: some View {
        List {
            if let error {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    VStack(alignment: .leading) {
                        Text(error.message).font(.callout)
                        Text(error.code).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Dismiss") { self.error = nil }.font(.caption)
                }
            }

            if apps.isEmpty && !loading {
                ContentUnavailableView(
                    "No apps installed",
                    systemImage: "square.grid.2x2",
                    description: Text("Install one by its domain. An app can only ask to spend; you approve each request.")
                )
            }

            ForEach(apps) { app in
                AppRow(app: app) {
                    opened = app.isHostable ? app : nil
                    if !app.isHostable {
                        error = WalletError(
                            code: "BAD_MANIFEST",
                            message: "\(app.domain) has no https start URL on its own domain, so it will not be opened."
                        )
                    }
                } remove: {
                    Task { await remove(app) }
                }
            }

            Section("Install") {
                TextField("example.com", text: $installDomain)
                    .autocorrectionDisabled()
                    .installFieldStyle()
                Button("Install") { Task { await install() } }
                    .disabled(installDomain.trimmingCharacters(in: .whitespaces).isEmpty)
                Text("The daemon fetches and validates the manifest, pins its hash, and records the spend cap it asks for. Widening that cap later needs your approval on the desktop.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Apps")
        .refreshable { await load() }
        .task { await load() }
        #if canImport(UIKit)
        // The web view host is iOS-only: UIViewRepresentable has no macOS
        // counterpart, and the phone is the only place apps need hosting.
        .sheet(item: $opened) { app in
            AppHostScreen(app: app, baseURL: baseURL, credential: credential)
        }
        #endif
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let response: AppListResponse = try await call("appList", [:])
            apps = response.apps
            error = nil
        } catch let walletError as WalletError {
            error = walletError
        } catch {
            self.error = WalletError(code: "UNKNOWN", message: String(describing: error))
        }
    }

    private func install() async {
        let domain = installDomain.trimmingCharacters(in: .whitespaces).lowercased()
        guard !domain.isEmpty else { return }
        do {
            let _: AppMutationResponse = try await call("appInstall", ["domain": .string(domain)])
            installDomain = ""
            await load()
        } catch let walletError as WalletError {
            error = walletError
        } catch {
            self.error = WalletError(code: "UNKNOWN", message: String(describing: error))
        }
    }

    private func remove(_ app: InstalledApp) async {
        do {
            let _: AppMutationResponse = try await call("appRemove", ["domain": .string(app.domain)])
            await load()
        } catch let walletError as WalletError {
            error = walletError
        } catch {
            self.error = WalletError(code: "UNKNOWN", message: String(describing: error))
        }
    }

    /// Apps go through the same device client as everything else, so the
    /// allowlist and the token apply unchanged.
    private func call<T: Decodable & Sendable>(_ method: String, _ params: [String: JSONValue]) async throws -> T {
        let client = DeviceWalletClient(baseURL: baseURL, credential: credential)
        return try await client.call(method, params: params)
    }
}

struct AppRow: View {
    let app: InstalledApp
    let open: () -> Void
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(app.name).font(.headline)
                Spacer()
                Button("Open", action: open).buttonStyle(.borderedProminent)
            }
            Text(app.domain).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(app.spendCapSats > 0
                     ? "cap \(StatusStrip.sats(app.spendCapSats)) sats"
                     : "must ask each time")
                    .font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.secondary.opacity(0.15), in: Capsule())
                if !app.intents.isEmpty {
                    Text("\(app.intents.count) intents").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Remove", role: .destructive, action: remove).font(.caption)
            }
        }
        .padding(.vertical, 4)
    }
}

#if canImport(UIKit)
/// One app in its own window, with `window.bsv` injected.
public struct AppHostScreen: View {
    let app: InstalledApp
    let baseURL: URL
    let credential: DeviceCredential

    @StateObject private var controller: AppHostController

    public init(app: InstalledApp, baseURL: URL, credential: DeviceCredential) {
        self.app = app
        self.baseURL = baseURL
        self.credential = credential
        let bridge = AppBridge(
            app: app,
            backend: DeviceAppBridgeBackend(baseURL: baseURL, credential: credential)
        )
        _controller = StateObject(wrappedValue: AppHostController(app: app, bridge: bridge))
    }

    public var body: some View {
        WebContainer(controller: controller)
            .navigationTitle(app.name)
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// `WKWebView` as a SwiftUI view. Small enough to live here rather than in its
/// own type, and iOS-only: the host exists to run apps on the phone.
private struct WebContainer: UIViewRepresentable {
    let controller: AppHostController

    func makeUIView(context: Context) -> WKWebView {
        controller.makeWebView()
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif

private extension View {
    @ViewBuilder
    func installFieldStyle() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never).keyboardType(.URL)
        #else
        self
        #endif
    }
}
