import SwiftUI

/// Approvals: the screen the desktop panel leads with, and the reason the phone
/// is worth having — a spend request arrives while you are away from the desk.
public struct ApprovalsView: View {
    let session: WalletSession

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

            if session.pending.isEmpty {
                Section {
                    ContentUnavailableView(
                        "Nothing waiting",
                        systemImage: "checkmark.shield",
                        description: Text("An origin's first spend is refused and shows up here for you to approve or block.")
                    )
                }
            } else {
                Section("Waiting for you (\(session.pending.count))") {
                    ForEach(session.pending) { request in
                        ApprovalRow(session: session, request: request)
                    }
                }
            }
        }
        .navigationTitle("Approvals")
        .refreshable { await session.refresh() }
    }
}

struct ApprovalRow: View {
    let session: WalletSession
    let request: PendingRequest

    @State private var showingCapEditor = false
    @State private var capText: String = ""

    private var suggested: Int { WalletSession.suggestedCap(for: request) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(request.origin).font(.headline)
                Spacer()
                Text(StatusStrip.sats(request.amountSats) + " sats")
                    .font(.subheadline)
                    .monospacedDigit()
            }

            HStack(spacing: 8) {
                Text(request.action).font(.caption).foregroundStyle(.secondary)
                if let verdict = request.jevVerdict {
                    // Advisory only. Labelled as a suggestion so nobody reads it
                    // as a decision the wallet already made.
                    Text("Jev suggests \(verdict)").font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.secondary.opacity(0.15), in: Capsule())
                }
            }

            HStack(spacing: 10) {
                Button("Approve") {
                    Task { await session.approve(request, capSats: suggested) }
                }
                .buttonStyle(.borderedProminent)

                Button("Cap…") {
                    capText = String(suggested)
                    showingCapEditor = true
                }
                .buttonStyle(.bordered)

                Button("Block", role: .destructive) {
                    Task { await session.deny(request) }
                }
                .buttonStyle(.bordered)
            }
            .font(.callout)
        }
        .padding(.vertical, 4)
        .alert("Spend cap for \(request.origin)", isPresented: $showingCapEditor) {
            TextField("Sats", text: $capText)
            Button("Cancel", role: .cancel) {}
            Button("Approve") {
                if let cap = Int(capText.trimmingCharacters(in: .whitespaces)) {
                    Task { await session.approve(request, capSats: cap) }
                }
            }
        } message: {
            Text("This origin may then spend up to the cap without asking again. 0 means it must ask every time.")
        }
    }
}
