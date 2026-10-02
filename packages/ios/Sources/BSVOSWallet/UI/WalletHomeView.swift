import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Wallet home: balance, receive, and the summary counts the desktop panel
/// shows at the top of its dashboard.
public struct WalletHomeView: View {
    let session: WalletSession

    public var body: some View {
        List {
            Section {
                StatusStrip(session: session)
            }

            if let error = session.lastError {
                ErrorBanner(error: error) { session.clearError() }
            }

            if let balance = session.balance {
                Section("Balance") {
                    LabeledContent("Confirmed", value: StatusStrip.sats(balance.confirmed) + " sats")
                    if balance.unconfirmed != 0 {
                        LabeledContent("Unconfirmed", value: StatusStrip.sats(balance.unconfirmed) + " sats")
                    }
                    LabeledContent("Spendable outputs", value: "\(balance.utxos)")
                }
            }

            Section("Receive") {
                ReceiveBlock(session: session)
            }

            Section("Activity") {
                LabeledContent("In flight", value: "\(session.summary.inFlight)")
                LabeledContent("Mined", value: "\(session.summary.mined)")
                LabeledContent("Failed", value: "\(session.summary.failed)")
                LabeledContent("Origins allowed", value: "\(session.summary.allowedOrigins)")
                LabeledContent("Origins blocked", value: "\(session.summary.deniedOrigins)")
            }

            if session.locked && session.hasWallet {
                Section {
                    Button("Unlock to see balance") {
                        Task { await session.unlock() }
                    }
                    Text("The daemon keeps the wallet locked until asked, and unlocks from the OS keyring — no passphrase. Face ID protects spending, not reading.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Wallet")
        .refreshable { await session.refresh() }
    }
}

/// Address + QR. Prefers the daemon's own QR PNG and falls back to generating
/// one locally, so a failed `addressQr` still leaves a usable receive screen.
struct ReceiveBlock: View {
    let session: WalletSession

    private var imageData: Data? {
        if let url = session.qr?.dataUrl, let data = QRCode.data(fromDataUrl: url) { return data }
        if let address = session.balance?.address { return QRCode.image(from: address) }
        return nil
    }

    private var address: String? { session.balance?.address ?? session.qr?.address }

    var body: some View {
        if let address {
            VStack(alignment: .leading, spacing: 10) {
                imageView
                Text(address)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                Button("Copy address") { CopyPaste.copy(address) }
                    .font(.callout)
            }
            .padding(.vertical, 4)
        } else {
            Text(session.locked ? "Locked." : "No address yet.")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var imageView: some View {
        if let imageData {
            #if canImport(UIKit)
            if let ui = UIImage(data: imageData) {
                Image(uiImage: ui).interpolation(.none).resizable().frame(width: 180, height: 180)
            }
            #elseif canImport(AppKit)
            if let ns = NSImage(data: imageData) {
                Image(nsImage: ns).interpolation(.none).resizable().frame(width: 180, height: 180)
            }
            #endif
        }
    }
}

/// Clipboard, without importing UIKit at the call sites.
enum CopyPaste {
    static func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
