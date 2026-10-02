import SwiftUI

/// The app's root: pair first, then the wallet.
///
/// The credential is read from the store on launch; there is no "skip" path,
/// because without a paired credential none of the wallet calls are authorised
/// and a shell full of error banners would be a worse first run than a pairing
/// screen that explains itself.
public struct BSVOSAppView: View {
    private let baseURL: URL
    private let store: CredentialStore
    private let biometrics: BiometricGate

    @State private var credential: DeviceCredential?
    @State private var checking = true

    public init(
        baseURL: URL,
        store: CredentialStore = KeychainCredentialStore(),
        biometrics: BiometricGate = LocalAuthenticationGate()
    ) {
        self.baseURL = baseURL
        self.store = store
        self.biometrics = biometrics
    }

    public var body: some View {
        Group {
            if checking {
                ProgressView().task { load() }
            } else if let credential {
                RootView(session: WalletSession(
                    backend: DeviceWalletBackend(baseURL: baseURL, credential: credential),
                    biometrics: biometrics
                ))
            } else {
                PairingView(baseURL: baseURL, store: store) { paired in
                    credential = paired
                }
            }
        }
    }

    private func load() {
        credential = try? store.load()
        checking = false
    }
}

/// Enter the code the desktop printed. Also offers forget/revoke, because a
/// device that was revoked on the desktop should be able to start over without
/// reinstalling the app.
public struct PairingView: View {
    let baseURL: URL
    let store: CredentialStore
    let onPaired: (DeviceCredential) -> Void

    @State private var code = ""
    @State private var deviceName = ""
    @State private var busy = false
    @State private var error: WalletError?

    public init(baseURL: URL, store: CredentialStore, onPaired: @escaping (DeviceCredential) -> Void) {
        self.baseURL = baseURL
        self.store = store
        self.onPaired = onPaired
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
