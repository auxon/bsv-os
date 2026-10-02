import SwiftUI

/// The ledger. Read-only on the phone: the daemon's `history` already gives
/// status and a plain-language hint per row, and inventing our own wording
/// would drift from what the CLI and the desktop shell say.
public struct TransactionsView: View {
    let session: WalletSession

    public var body: some View {
        List {
            if session.transactions.isEmpty {
                ContentUnavailableView(
                    "No transactions yet",
                    systemImage: "list.bullet",
                    description: Text("Everything this wallet sends shows up here, with its confirmation state.")
                )
            } else {
                ForEach(session.transactions) { tx in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(tx.label ?? "transaction").font(.callout)
                            Spacer()
                            StatusChip(status: tx.status)
                        }
                        Text(tx.txid)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        if let hint = tx.hint, !hint.isEmpty {
                            Text(hint).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle("History")
        .refreshable { await session.refresh() }
    }
}

struct StatusChip: View {
    let status: String

    private var tone: Color {
        switch status {
        case "mined": return .green
        case "failed": return .red
        default: return .orange   // "seen": broadcast, not yet confirmed
        }
    }

    var body: some View {
        Text(status)
            .font(.caption2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tone.opacity(0.18), in: Capsule())
            .foregroundStyle(tone)
    }
}

/// Policy, with the same one-tap Revoke/Allow shape the desktop panel uses.
public struct PolicyView: View {
    let session: WalletSession

    public var body: some View {
        List {
            if let error = session.lastError {
                ErrorBanner(error: error) { session.clearError() }
            }
            if session.policies.isEmpty {
                ContentUnavailableView(
                    "No policies yet",
                    systemImage: "slider.horizontal.3",
                    description: Text("Approving a request creates one. Until then an origin must ask every time.")
                )
            } else {
                Section("Origins") {
                    ForEach(session.policies) { policy in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(policy.origin).font(.callout)
                                Text(policy.spendCapSats > 0
                                     ? "cap \(StatusStrip.sats(policy.spendCapSats)) sats"
                                     : "must ask each time")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(policy.mode)
                                .font(.caption2)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Self.tone(for: policy.mode).opacity(0.18), in: Capsule())
                                .foregroundStyle(Self.tone(for: policy.mode))
                        }
                    }
                }
                Text("Changing policy from the phone arrives with the approvals flow; for now this is a read-only view of what the daemon enforces.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Policy")
        .refreshable { await session.refresh() }
    }

    /// "ask" is the middle state: an origin the operator has neither allowed
    /// with a cap nor blocked outright.
    static func tone(for mode: String) -> Color {
        switch mode {
        case "deny": return .red
        case "allow": return .green
        default: return .orange
        }
    }
}
