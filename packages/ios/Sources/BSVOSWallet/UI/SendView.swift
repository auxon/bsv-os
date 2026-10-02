import SwiftUI

/// Send. Deliberately minimal: an address, an amount, and a confirmation that
/// names both. The daemon owns fee arithmetic and policy; this screen must not
/// grow a second opinion about either.
public struct SendView: View {
    let session: WalletSession

    @State private var address = ""
    @State private var amountText = ""
    @State private var lastSent: SendResponse?

    private var amount: Int? {
        Int(amountText.trimmingCharacters(in: .whitespaces))
    }

    public var body: some View {
        List {
            Section {
                StatusStrip(session: session)
            }

            if let error = session.lastError {
                ErrorBanner(error: error) { session.clearError() }
            }
            if let notice = session.notice {
                NoticeBanner(text: notice) { session.clearNotice() }
            }

            Section("Send sats") {
                TextField("Destination address", text: $address)
                    .addressFieldStyle()
                    .font(.system(.body, design: .monospaced))

                TextField("Amount in sats", text: $amountText)
                    .numericKeyboard()

                Button {
                    guard let amount else { return }
                    Task {
                        lastSent = await session.send(to: address, sats: amount)
                        if lastSent != nil {
                            address = ""
                            amountText = ""
                        }
                    }
                } label: {
                    Label("Send", systemImage: "arrow.up.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(address.isEmpty || !(amount ?? 0).isPositive)

                Text("Face ID is required to send. The spend then goes through the daemon's policy engine exactly as it would from the CLI.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            if let sent = lastSent {
                Section("Last send") {
                    LabeledContent("Transaction", value: String(sent.txid.prefix(16)) + "…")
                    LabeledContent("Fee", value: StatusStrip.sats(sent.fee) + " sats")
                }
            }

            if let balance = session.balance {
                Section {
                    Button("Send everything (sweep out) is Phase 1+") {}
                        .disabled(true)
                    Text("This wallet holds \(StatusStrip.sats(balance.total)) sats across \(balance.utxos) output(s).")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Send")
    }
}

private extension Int {
    var isPositive: Bool { self > 0 }
}

// The iOS-only keyboard hints are gated rather than dropped: the same views
// compile for macOS so the package can be built and tested on a Mac, and a
// missing `#if` here is a compile error there, which is the useful direction.
private extension View {
    @ViewBuilder
    func addressFieldStyle() -> some View {
        self.autocorrectionDisabled()
        #if os(iOS)
        self.textInputAutocapitalization(.never)
        #endif
    }

    @ViewBuilder
    func numericKeyboard() -> some View {
        #if os(iOS)
        self.keyboardType(.numberPad)
        #else
        self
        #endif
    }
}
