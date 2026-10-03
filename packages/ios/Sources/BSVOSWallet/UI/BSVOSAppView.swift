import SwiftUI

/// The app's root: pair first, then the wallet.
///
/// The credential is read from the store on launch; there is no "skip" path,
/// because without a paired credential none of the wallet calls are authorised
/// and a shell full of error banners would be a worse first run than a pairing
/// screen that explains itself.
public struct BSVOSAppView: View {
    private let baseURL: URL
    private let credentialStore: CredentialStore
    private let seedVault: SeedVault
    private let biometrics: BiometricGate

    /// What this launch is: the phone's own wallet, the daemon's, or nothing
    /// yet. The rule is `WalletLaunchMode.decide`, and it prefers the local
    /// wallet: a phone that has both should not silently spend from the other.
    @State private var launch: Launch = .checking
    @State private var session: WalletSession?
    @State private var appsContext: AppsContext?
    /// Set when push is unavailable, so the approvals screen can say so.
    @State private var pushNote: String?
    private let pushStatus: PushStatusBox?

    @Environment(\.scenePhase) private var scenePhase

    enum Launch {
        case checking
        case unconfigured
        case daemon(DeviceCredential)
        case standalone(LocalWalletBackend)
    }

    public init(
        baseURL: URL,
        credentialStore: CredentialStore = KeychainCredentialStore(),
        seedVault: SeedVault = KeychainSeedVault(),
        biometrics: BiometricGate = LocalAuthenticationGate(),
        pushStatus: PushStatusBox? = nil
    ) {
        self.baseURL = baseURL
        self.credentialStore = credentialStore
        self.seedVault = seedVault
        self.biometrics = biometrics
        self.pushStatus = pushStatus
    }

    public var body: some View {
        Group {
            switch launch {
            case .checking:
                ProgressView().task { load() }

            case .unconfigured:
                WalletSetupView(
                    seedVault: seedVault,
                    baseURL: baseURL,
                    credentialStore: credentialStore
                ) {
                    load()
                }

            case .daemon:
                if let session {
                    RootView(session: session, pushNote: pushNote ?? pushStatus?.note, apps: appsContext)
                        .task {
                            // Asked for only once paired: a notification
                            // permission prompt before there is anything to
                            // notify about is noise. A standalone wallet has no
                            // daemon to register with, so it never asks.
                            await requestPushIfNeeded()
                        }
                }

            case .standalone(let backend):
                if let session {
                    RootView(session: session, pushNote: pushStatus?.note, apps: appsContext)
                        .task { await backend.refreshPendingTransactions() }
                        .onChange(of: scenePhase) { _, phase in
                            // The phone-sized monitor: recheck in-flight
                            // transactions when the app comes back, because
                            // nothing else can do it while it is closed.
                            guard phase == .active else { return }
                            Task {
                                await backend.refreshPendingTransactions()
                                await session.refresh()
                            }
                        }
                }
            }
        }
    }

    private func load() {
        let credential = try? credentialStore.load()
        switch WalletLaunchMode.decide(hasLocalPhrase: seedVault.hasPhrase, hasDaemonCredential: credential != nil) {
        case .standalone:
            let stack = makeStandaloneStack()
            session = WalletSession(backend: stack.backend, biometrics: biometrics)
            appsContext = stack.apps
            launch = .standalone(stack.backend)
        case .daemon:
            guard let credential else { launch = .unconfigured; return }
            session = WalletSession(
                backend: DeviceWalletBackend(baseURL: baseURL, credential: credential),
                biometrics: biometrics
            )
            appsContext = AppsContext(
                registry: DeviceAppRegistry(baseURL: baseURL, credential: credential)
            ) { app in
                AppBridge(app: app, backend: DeviceAppBridgeBackend(baseURL: baseURL, credential: credential))
            }
            launch = .daemon(credential)
        case .unconfigured:
            session = nil
            appsContext = nil
            launch = .unconfigured
        }
    }

    private struct StandaloneStack {
        let backend: LocalWalletBackend
        let apps: AppsContext
    }

    /// The standalone stack: file-backed stores next to the Keychain phrase,
    /// falling back to memory if the directory cannot be made (a broken store
    /// should not stop the wallet from opening), plus the phone's registry and
    /// the in-process bridge for whatever app it hosts.
    private func makeStandaloneStack() -> StandaloneStack {
        let policyStore: any PolicyStore = (try? FilePolicyStore(url: FilePolicyStore.defaultURL()))
            ?? InMemoryPolicyStore()
        let ledger: any LedgerStore = (try? FileLedgerStore(url: FileLedgerStore.defaultURL()))
            ?? InMemoryLedgerStore()
        let chain = CombinedProvider()
        let policy = PolicyEngine(store: policyStore)
        let backend = LocalWalletBackend(vault: seedVault, chain: chain, policy: policy, ledger: ledger)
        let registryStore: any AppRegistryStore = (try? FileAppRegistryStore(url: FileAppRegistryStore.defaultURL()))
            ?? InMemoryAppRegistryStore()
        let registry = LocalAppRegistry(store: registryStore, transport: URLSessionTransport(), policy: policy)
        return StandaloneStack(
            backend: backend,
            apps: AppsContext(registry: registry) { app in
                AppBridge(app: app, backend: LocalAppBridgeBackend(wallet: backend, chain: chain))
            }
        )
    }

    private func requestPushIfNeeded() async {
        #if canImport(UserNotifications)
        guard case .daemon = launch else { return }
        let registrar = PushRegistrar()
        await registrar.requestAuthorization()
        switch registrar.state {
        case .denied:
            pushNote = PushCopy.denied
        case .failed(let why):
            pushNote = PushCopy.forRegistrationFailure(why)
        default:
            // Registered, or still waiting on APNs. The delegate reports a
            // registration failure through PushStatusBox when it arrives.
            pushNote = pushStatus?.note
        }
        #endif
    }
}

/// Which wallet this launch uses. Extracted so the precedence is testable
/// without a SwiftUI host: a phone with its own wallet uses it even when a
/// daemon credential is also present, because quietly spending from the other
/// wallet is the worst way to be surprised.
public enum WalletLaunchMode: Equatable, Sendable {
    case standalone
    case daemon
    case unconfigured

    public static func decide(hasLocalPhrase: Bool, hasDaemonCredential: Bool) -> WalletLaunchMode {
        if hasLocalPhrase { return .standalone }
        if hasDaemonCredential { return .daemon }
        return .unconfigured
    }
}

/// Enter the code the desktop printed. Also offers forget/revoke, because a
/// device that was revoked on the desktop should be able to start over without
/// reinstalling the app.
public struct PairingView: View {
    let baseURL: URL
    let store: CredentialStore
    let onPaired: (DeviceCredential) -> Void
    /// Shown when the pairing screen was pushed from a setup flow that has a
    /// way back; nil when pairing is the only thing the app can do.
    let onCancel: (() -> Void)?

    @State private var code = ""
    @State private var deviceName = ""
    @State private var busy = false
    @State private var error: WalletError?

    public init(
        baseURL: URL,
        store: CredentialStore,
        onPaired: @escaping (DeviceCredential) -> Void,
        onCancel: (() -> Void)? = nil
    ) {
        self.baseURL = baseURL
        self.store = store
        self.onPaired = onPaired
        self.onCancel = onCancel
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("On the machine running the daemon, run **bsv device pair** and enter the code it prints.")
                        .font(.callout)
                }

                Section("Pairing code") {
                    TextField("ABCD2345", text: $code)
                        .font(.system(.title3, design: .monospaced))
                        .autocorrectionDisabled()
                        .pairingFieldStyle()
                    TextField("Name for this device", text: $deviceName)
                        .autocorrectionDisabled()
                }

                if let error {
                    Section {
                        Text(error.message).foregroundStyle(.orange).font(.callout)
                        Text(error.code).font(.caption2).foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button {
                        Task { await pair() }
                    } label: {
                        if busy { ProgressView() } else { Text("Pair") }
                    }
                    .disabled(busy || code.trimmingCharacters(in: .whitespaces).count < 6)
                } footer: {
                    Text("The code expires two minutes after it is generated and works once.")
                }

                Section {
                    Text("The daemon must be reachable over your VPN. Its wallet RPC stays loopback-only; this app talks to a separate device surface that a paired token unlocks.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Pair this phone")
            .toolbar {
                if let onCancel {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back", action: onCancel)
                    }
                }
            }
        }
    }

    private func pair() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let client = DevicePairingClient(baseURL: baseURL)
            let credential = try await client.pair(
                code: code,
                name: deviceName.trimmingCharacters(in: .whitespaces).isEmpty ? "iPhone" : deviceName
            )
            try store.save(credential)
            onPaired(credential)
        } catch let walletError as WalletError {
            error = walletError
        } catch {
            // A bare `catch` binds the thrown value to `error`, shadowing the
            // state property, so `self.` is required to reach it.
            self.error = WalletError(code: "PAIR_FAILED", message: String(describing: error))
        }
    }
}

private extension View {
    @ViewBuilder
    func pairingFieldStyle() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.characters)
            .keyboardType(.asciiCapable)
        #else
        self
        #endif
    }
}
