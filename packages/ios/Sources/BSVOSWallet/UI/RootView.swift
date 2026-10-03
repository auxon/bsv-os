import SwiftUI

/// The Phase 1 shell: status, approvals, wallet, transactions, policy.
///
/// Scope, and why: docs/ios.md sets the Phase 1 milestone as "approve a spend
/// request and send sats from the phone". Those two actions need exactly these
/// five screens, so these are the five built — not the 34 views of the desktop
/// shell app, which Phase 3 reaches by hosting that app in a web view instead
/// of rewriting it in SwiftUI.
public struct RootView: View {
    @State private var session: WalletSession
    /// Shown on Approvals when push is not working, because an unseen approval
    /// is the failure mode that matters.
    private let pushNote: String?
    /// The app list and bridge factory, when this launch can host apps at all.
    private let apps: AppsContext?

    public init(session: WalletSession, pushNote: String? = nil, apps: AppsContext? = nil) {
        _session = State(initialValue: session)
        self.pushNote = pushNote
        self.apps = apps
    }

    public var body: some View {
        TabView {
            NavigationStack {
                ApprovalsView(session: session, pushNote: pushNote)
            }
            .tabItem { Label("Approvals", systemImage: "checkmark.shield") }
            .badge(session.pending.count)

            NavigationStack {
                WalletHomeView(session: session)
            }
            .tabItem { Label("Wallet", systemImage: "banknote") }

            NavigationStack {
                SendView(session: session)
            }
            .tabItem { Label("Send", systemImage: "arrow.up.circle") }

            NavigationStack {
                TransactionsView(session: session)
            }
            .tabItem { Label("History", systemImage: "list.bullet") }

            NavigationStack {
                PolicyView(session: session)
            }
            .tabItem { Label("Policy", systemImage: "slider.horizontal.3") }

            if let apps {
                NavigationStack {
                    AppsView(session: session, context: apps)
                }
                .tabItem { Label("Apps", systemImage: "square.grid.2x2") }
            }
        }
        .task { await session.refresh() }
    }
}

// MARK: - shared bits

/// The lock/status strip. Mirrors the desktop shell's pill: one line, coloured
/// by state, so the first thing on screen answers "can this wallet act?".
struct StatusStrip: View {
    let session: WalletSession

    private var text: String {
        if let error = session.lastError, !session.hasWallet { return error.message }
        if !session.hasWallet { return "No wallet on the daemon" }
        if session.locked { return "Locked" }
        let total = session.balance?.total ?? 0
        return "\(Self.sats(total)) sats"
    }

    private var tone: Color {
        if !session.hasWallet { return .red }
        if session.locked { return .orange }
        return .green
    }

    static func sats(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(tone).frame(width: 8, height: 8)
            Text(text).font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            if session.loading {
                ProgressView().controlSize(.small)
            } else if session.hasWallet {
                Button(session.locked ? "Unlock" : "Lock") {
                    Task { session.locked ? await session.unlock() : await session.lock() }
                }
                .font(.subheadline)
            }
        }
    }
}

/// A daemon error, shown where the action happened, with the code so it can be
/// looked up — the daemon's codes are meaningful (POLICY_DENY, WALLET_LOCKED),
/// and flattening them into "something went wrong" throws away the answer.
struct ErrorBanner: View {
    let error: WalletError
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(error.message).font(.callout)
                Text(error.code).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Dismiss", action: dismiss).font(.caption)
        }
        .padding(10)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct NoticeBanner: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            Text(text).font(.callout)
            Spacer()
            Button("OK", action: dismiss).font(.caption)
        }
        .padding(10)
        .background(.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}
