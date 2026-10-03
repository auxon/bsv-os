import SwiftUI

/// First run: create a wallet on this phone, restore one from its phrase, or
/// pair with a desktop daemon.
///
/// The standalone options are the S4 path. The phrase is generated here, shown
/// once, and stored only after the human says they wrote it down — so backing
/// out of the screen leaves no half-made wallet behind.
public struct WalletSetupView: View {
    let seedVault: SeedVault
    let baseURL: URL
    let credentialStore: CredentialStore
    let onReady: () -> Void

    private enum Step: Equatable {
        case welcome
        case backup
        case restore
        case pair
    }

    @State private var step: Step = .welcome
    @State private var phraseToBackUp = ""
    @State private var restoreInput = ""
    @State private var error: String?

    private var backupWords: [String] {
        phraseToBackUp.split(separator: " ").map(String.init)
    }

    public init(
        seedVault: SeedVault,
        baseURL: URL,
        credentialStore: CredentialStore,
        onReady: @escaping () -> Void
    ) {
        self.seedVault = seedVault
        self.baseURL = baseURL
        self.credentialStore = credentialStore
        self.onReady = onReady
    }

    public var body: some View {
        switch step {
        case .welcome: welcome
        case .backup: backup
        case .restore: restore
        case .pair:
            PairingView(baseURL: baseURL, store: credentialStore, onPaired: { _ in onReady() }, onCancel: {
                step = .welcome
            })
        }
    }

    // MARK: - welcome

    private var welcome: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This phone can hold its own wallet, or act as a remote for a wallet daemon running on your computer.")
                        .font(.callout)
                }

                Section {
                    Button {
                        error = nil
                        do {
                            phraseToBackUp = try seedVault.generatePhrase()
                            step = .backup
                        } catch {
                            self.error = "Could not generate a recovery phrase: \(error)"
                        }
                    } label: {
                        Label("Create a new wallet", systemImage: "plus.circle")
                    }
                    Button {
                        error = nil
                        restoreInput = ""
                        step = .restore
                    } label: {
                        Label("Restore from a recovery phrase", systemImage: "square.and.arrow.down")
                    }
                } header: {
                    Text("On this phone")
                } footer: {
                    Text("The wallet and its keys stay on this phone. Nothing needs to be running anywhere else.")
                }

                Section {
                    Button {
                        error = nil
                        step = .pair
                    } label: {
                        Label("Pair with a wallet daemon", systemImage: "desktopcomputer")
                    }
                } header: {
                    Text("On a computer")
                } footer: {
                    Text("The daemon keeps custody; this phone becomes an approver and spends through the paired device surface.")
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.orange).font(.callout)
                    }
                }
            }
            .navigationTitle("bsvOS")
        }
    }

    // MARK: - creating

    private var backup: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Write these words down, in order, somewhere offline. They are the only copy of this wallet — nobody, including this app, can recover it without them.")
                        .font(.callout)
                }

                Section("Recovery phrase") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 6)], spacing: 6) {
                        ForEach(backupWords.indices, id: \.self) { index in
                            HStack(spacing: 4) {
                                Text("\(index + 1).").foregroundStyle(.secondary)
                                Text(backupWords[index]).font(.system(.body, design: .monospaced))
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    Button("I wrote it down") {
                        storeGenerated()
                    }
                    Button("Cancel", role: .destructive) {
                        phraseToBackUp = ""
                        step = .welcome
                    }
                } footer: {
                    Text("The phrase is stored in the Keychain only after you continue.")
                }
            }
            .navigationTitle("Back up your wallet")
            .interactiveDismissDisabled()
        }
    }

    private func storeGenerated() {
        do {
            try seedVault.importPhrase(phraseToBackUp)
            phraseToBackUp = ""
            onReady()
        } catch {
            self.error = "Could not store the wallet: \(error)"
        }
    }

    // MARK: - restoring

    private var restore: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Enter the 12 or 24 words, separated by spaces. They are checked before anything is stored.")
                        .font(.callout)
                    TextEditor(text: $restoreInput)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 96)
                        .autocorrectionDisabled()
                        .restoreFieldStyle()
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.orange).font(.callout)
                    }
                }

                Section {
                    Button("Restore wallet") {
                        restoreWallet()
                    }
                    .disabled(restoreInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel", role: .destructive) {
                        restoreInput = ""
                        step = .welcome
                    }
                }
            }
            .navigationTitle("Restore a wallet")
        }
    }

    private func restoreWallet() {
        error = nil
        do {
            try seedVault.importPhrase(restoreInput)
            restoreInput = ""
            onReady()
        } catch {
            self.error = "That does not look like a valid recovery phrase. Check the words and the order, then try again."
        }
    }
}

private extension View {
    @ViewBuilder
    func restoreFieldStyle() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never)
            .keyboardType(.asciiCapable)
        #else
        self
        #endif
    }
}
