import SwiftUI
import UIKit
import BSVOSWallet

/// The iOS app. Everything it shows lives in the `BSVOSWallet` package; this
/// target exists to be a bundle, to own the notification delegate, and to say
/// which daemon it talks to.
///
/// It deliberately holds no wallet logic: the package is where the tested code
/// is, and a thinner shell is less to get wrong.
/// One push status for the app; the delegate writes it, the approvals screen
/// reads it. Shared because an app has exactly one.
@MainActor
let appPushStatus = PushStatusBox()

@main
struct BSVOSiOSApp: App {
    // The delegate is needed for two things SwiftUI cannot do: receiving the
    // APNs token, and handling a notification action while the app is not
    // running.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            BSVOSAppView(baseURL: AppConfig.daemonURL, pushStatus: appPushStatus)
        }
    }
}

enum AppConfig {
    /// Which daemon this build talks to.
    ///
    /// Read from the Info.plist key `BSVDaemonURL`, so a build for a phone on a
    /// VPN does not have to hardcode an address in source. Falls back to
    /// loopback, which only works in the simulator on the daemon's own machine —
    /// a deliberately useless default rather than a wrong one, because a wrong
    /// address would look like a pairing failure instead of a config mistake.
    static let daemonURL: URL = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "BSVDaemonURL") as? String
        if let configured, let url = URL(string: configured), !configured.isEmpty {
            return url
        }
        NSLog("bsvOS: BSVDaemonURL is not set — falling back to 127.0.0.1, which only works on the daemon's own machine")
        return URL(string: "https://127.0.0.1:2121")!
    }()
}

/// `@preconcurrency` on the notification conformance: the protocol is not
/// main-actor annotated, while `UIApplicationDelegate` methods run on the main
/// actor. Under Swift 6 that mismatch is an error rather than a warning, and the
/// annotation is the documented way to say "these callbacks are delivered on the
/// main thread in practice" without losing concurrency checking elsewhere.
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Registering the category is what gives the lock screen its Approve and
        // Block buttons. Without this the notification still arrives and the
        // actions simply are not offered — a silent half-feature, which is why
        // it happens at launch rather than when push is first requested.
        PushRegistrar.registerCategories()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // MARK: - APNs

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let credential = try? KeychainCredentialStore().load() else {
            NSLog("bsvOS: got an APNs token but this device is not paired yet — will register on next launch")
            return
        }
        Task {
            await PushRegistrar().sendTokenToDaemon(deviceToken, baseURL: AppConfig.daemonURL, credential: credential)
            // Registered: nothing to warn the user about.
            appPushStatus.set(nil)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Not fatal: the wallet works without push. But it is not nothing
        // either — with push off, an approval only appears when the app is
        // opened — so the reason reaches the approvals screen rather than only
        // the log. The common cause is a build without the push entitlement,
        // which is the default here because a personal (free) Apple development
        // team cannot use the Push Notifications capability.
        NSLog("bsvOS: APNs registration failed — \(error.localizedDescription)")
        appPushStatus.set(PushCopy.forRegistrationFailure(error.localizedDescription))
    }

    // MARK: - Notification actions

    /// Handle Approve or Block from the lock screen.
    ///
    /// Note what is *not* here: a biometric check. The actions are registered
    /// with `.authenticationRequired`, so iOS has already demanded Face ID or the
    /// passcode before it calls this — asking again would be a second prompt for
    /// the same decision. The gate exists once, in the place that can enforce it.
    ///
    /// The daemon's policy engine is still the authority: this only calls
    /// `policyApprove`/`policyDeny`, which is what the approvals screen calls too.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let action = PushAction.from(
            userInfo: response.notification.request.content.userInfo,
            actionIdentifier: response.actionIdentifier
        )
        Task {
            await perform(action)
            completionHandler()
        }
    }

    /// Show the notification while the app is open. The daemon already knows;
    /// this only decides whether the user sees it in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    private func perform(_ action: PushAction) async {
        guard let credential = try? KeychainCredentialStore().load() else { return }
        let backend = DeviceWalletBackend(baseURL: AppConfig.daemonURL, credential: credential)
        do {
            switch action {
            case .approve(let origin, let capSats):
                _ = try await backend.policyApprove(origin: origin, capSats: capSats)
            case .deny(let origin):
                _ = try await backend.policyDeny(origin: origin)
            case .unknown:
                // A malformed payload or a plain tap. Nothing to do: the request
                // is still listed in the app, which is where the user lands.
                break
            }
        } catch {
            NSLog("bsvOS: acting on a notification failed — \(error)")
        }
    }
}
