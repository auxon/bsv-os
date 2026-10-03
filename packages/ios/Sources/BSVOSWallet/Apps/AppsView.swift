import SwiftUI
#if canImport(WebKit)
import WebKit
#endif

/// The app list: what is installed, and a way to launch it.
///
/// Where the registry lives depends on the launch: the daemon's `appList` /
/// `appInstall` / `appRemove` when this phone is paired, or the phone's own
/// registry when it holds its own wallet. The view does not know the
/// difference — `AppsContext` carries the registry and the bridge factory.
public struct AppsView: View {
    let session: WalletSession
    let context: AppsContext

    @State private var apps: [InstalledApp] = []
    @State private var loading = false
    @State private var installDomain = ""
    @State private var error: WalletError?
    @State private var opened: InstalledApp?

    public init(session: WalletSession, context: AppsContext) {
        self.session = session
        self.context = context
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

            if let makeHost = context.makeBundledHost, !context.bundledApps.isEmpty {
                #if canImport(UIKit)
                Section {
                    ForEach(context.bundledApps, id: \.self) { name in
                        NavigationLink(name) {
                            BundledAppScreen(host: makeHost(name))
                        }
                    }
                } header: {
                    Text("Included apps")
                } footer: {
                    Text("These ride in the app and run without a server. Their spends still need approval.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                #endif
            }

            Section("Install") {
                TextField("example.com", text: $installDomain)
                    .autocorrectionDisabled()
                    .installFieldStyle()
                Button("Install") { Task { await install() } }
                    .disabled(installDomain.trimmingCharacters(in: .whitespaces).isEmpty)
                Text("The wallet fetches and validates the manifest, pins its hash, and records the spend cap it asks for. Widening that cap later needs your approval.")
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
            AppHostScreen(app: app, context: context)
        }
        #endif
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            apps = try await context.registry.list()
            error = nil
        } catch let walletError as WalletError {
            error = walletError
        } catch {
            self.error = WalletError(code: "APP_REGISTRY", message: error.localizedDescription)
        }
    }

    private func install() async {
        let domain = installDomain.trimmingCharacters(in: .whitespaces).lowercased()
        guard !domain.isEmpty else { return }
        do {
            _ = try await context.registry.install(domain: domain, manifestJson: nil)
            installDomain = ""
            await load()
        } catch let walletError as WalletError {
            error = walletError
        } catch {
            self.error = WalletError(code: "APP_REGISTRY", message: error.localizedDescription)
        }
    }

    private func remove(_ app: InstalledApp) async {
        do {
            try await context.registry.remove(domain: app.domain)
            await load()
        } catch let walletError as WalletError {
            error = walletError
        } catch {
            self.error = WalletError(code: "APP_REGISTRY", message: error.localizedDescription)
        }
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
    let context: AppsContext

    @StateObject private var controller: AppHostController

    public init(app: InstalledApp, context: AppsContext) {
        self.app = app
        self.context = context
        _controller = StateObject(wrappedValue: AppHostController(app: app, bridge: context.makeBridge(app)))
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
