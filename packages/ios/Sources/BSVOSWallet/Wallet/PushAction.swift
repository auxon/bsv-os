import Foundation
/// Carries "push is not working, and why" from the app delegate to the UI.
///
/// A tiny observable box rather than a global: the delegate is not part of the
/// SwiftUI tree, so it cannot pass a binding, and the note has to reach the
/// approvals screen from there. Annotated to the main actor because both ends
/// are, and a shared instance because an app has exactly one push status.
@MainActor
public final class PushStatusBox: ObservableObject {
    /// Nil when push is working (or not yet known). Non-nil is shown to the user.
    @Published public private(set) var note: String?

    public init(note: String? = nil) {
        self.note = note
    }

    public func set(_ note: String?) {
        self.note = note
    }
}

/// What the app tells the user when push is not working.
///
/// This matters more than it looks: with push off, an approval only appears when
/// the app is opened, so a spend request can sit unseen. Saying so is the
/// difference between "nothing needs me" and "I would not be told".
///
/// Copy lives here, in the package, so it can be tested rather than buried in a
/// delegate.
public enum PushCopy {
    public static let denied =
        "Notifications are off, so approvals only appear when you open the app."
    public static let noEntitlement =
        "This build cannot receive push (no push entitlement), so approvals only appear when you open the app."
    public static let notRegistered =
        "Push is not registered yet, so approvals only appear when you open the app."

    /// Turn an APNs registration failure into something a person can act on.
    ///
    /// The no-entitlement case is the common one and has a specific cause worth
    /// naming: a personal (free) Apple development team cannot use the Push
    /// Notifications capability, so the app is built without it and APNs refuses
    /// the registration.
    public static func forRegistrationFailure(_ message: String) -> String {
        let lowered = message.lowercased()
        if lowered.contains("entitlement") || lowered.contains("aps-environment") {
            return noEntitlement
        }
        if lowered.contains("no valid") || lowered.contains("not supported") {
            return noEntitlement
        }
        return "Push could not be registered (\(message)), so approvals only appear when you open the app."
    }
}

#if canImport(UserNotifications)
import UserNotifications
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Phase 3: the phone's half of push.
///
/// The daemon decides *when* to speak; this decides what the notification means
/// and what its buttons do. The parsing is deliberately separated from
/// `UNUserNotificationCenter` so the mapping can be tested: a notification's
/// userInfo is a dictionary from outside the app, and the actions attached to it
/// approve or block spending. That is not a place to guess.
public enum PushAction: Sendable, Equatable {
    /// The category the daemon tags approval pushes with.
    public static let category = "BSV_APPROVAL"
    public static let approveIdentifier = "BSV_APPROVE"
    public static let denyIdentifier = "BSV_DENY"

    case approve(origin: String, capSats: Int)
    case deny(origin: String)
    /// A push we do not recognise, or one whose payload is malformed. Ignored
    /// rather than guessed at.
    case unknown

    /// Build an action from a notification's payload and the button pressed.
    ///
    /// A payload that is missing `origin` is `unknown` even for an approval
    /// button: approving "something" would be worse than doing nothing, and the
    /// request is still visible in the app.
    public static func from(userInfo: [AnyHashable: Any], actionIdentifier: String) -> PushAction {
        guard let kind = userInfo["kind"] as? String, kind == "approval",
              let origin = (userInfo["origin"] as? String)?.trimmingCharacters(in: .whitespaces),
              !origin.isEmpty
        else { return .unknown }

        switch actionIdentifier {
        case approveIdentifier:
            // The daemon sends the amount it queued; the cap offered is the same
            // modest padding the approvals screen suggests, so a lock-screen
            // approval cannot grant far more than was asked for.
            let asked = (userInfo["amountSats"] as? Int) ?? Int(userInfo["amountSats"] as? Double ?? 0)
            return .approve(origin: origin, capSats: Self.suggestedCap(for: asked))
        case denyIdentifier:
            return .deny(origin: origin)
        default:
            return .unknown
        }
    }

    /// Mirrors `WalletSession.suggestedCap` — kept in step by a test, because a
    /// lock-screen approval and an in-app approval must not offer different
    /// limits for the same request.
    public static func suggestedCap(for amountSats: Int) -> Int {
        guard amountSats > 0 else { return 0 }
        let padded = Int((Double(amountSats) * 1.2).rounded(.up))
        let step = 100
        return ((padded + step - 1) / step) * step
    }
}

#if canImport(UserNotifications)
/// Asking for permission, and telling the daemon where to push.
@MainActor
public final class PushRegistrar: NSObject, ObservableObject {
    public enum State: Equatable {
        case unknown
        case denied
        case registered
        case failed(String)
    }

    @Published public private(set) var state: State = .unknown

    /// Register the notification categories, so the lock screen offers the two
    /// buttons. `authenticationRequired` is the point: iOS will insist on Face ID
    /// or the passcode before either button fires, which is the same gate the app
    /// applies in-process — and it means a locked phone cannot approve a spend.
    public static func registerCategories() {
        let approve = UNNotificationAction(
            identifier: PushAction.approveIdentifier,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: PushAction.denyIdentifier,
            title: "Block",
            options: [.authenticationRequired, .destructive]
        )
        let category = UNNotificationCategory(
            identifier: PushAction.category,
            actions: [approve, deny],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// Ask, and if granted, request a device token from APNs.
    public func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                await MainActor.run { registerForRemoteNotifications() }
            } else {
                state = .denied
            }
        } catch {
            state = .failed(String(describing: error))
        }
    }

    private func registerForRemoteNotifications() {
        #if canImport(UIKit)
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    /// Hand the APNs token to the daemon, so it knows where to push. Called from
    /// the app delegate once APNs answers.
    public func sendTokenToDaemon(_ deviceToken: Data, baseURL: URL, credential: DeviceCredential) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        struct PushParams: Encodable, Sendable { let token: String }
        do {
            struct Ack: Decodable, Sendable { let registered: Bool? }
            let client = DeviceWalletClient(baseURL: baseURL, credential: credential)
            let _: Ack = try await client.call("registerPush", params: PushParams(token: hex))
            state = .registered
        } catch {
            state = .failed(String(describing: error))
        }
    }

    /// Unsubscribe. `token` is sent as an explicit null, which the daemon reads
    /// as "clear it" — an omitted field would mean the same thing, but being
    /// explicit keeps the intent readable in a log.
    public func clearOnDaemon(baseURL: URL, credential: DeviceCredential) async {
        struct PushParams: Encodable, Sendable {
            let token: String?
            enum CodingKeys: String, CodingKey { case token }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeNil(forKey: .token)
            }
        }
        struct Ack: Decodable, Sendable { let registered: Bool? }
        let client = DeviceWalletClient(baseURL: baseURL, credential: credential)
        _ = try? await client.call("registerPush", params: PushParams(token: nil)) as Ack
    }
}
#endif
