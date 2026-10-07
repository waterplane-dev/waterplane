import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ShellViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // A cold start from a `waterplane://pair?…` link: the page is not up
        // yet, and `openPairLink` retries until it answers.
        connectionOptions.urlContexts.forEach(openPairLink)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        URLContexts.forEach(openPairLink)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// Only the app's own scheme, only its `pair` link — anything else is
    /// Capacitor's (`appUrlOpen`) and this shell has nothing to add.
    private func openPairLink(_ ctx: UIOpenURLContext) {
        let url = ctx.url
        guard url.scheme == "waterplane", url.host == "pair",
              let shell = window?.rootViewController as? ShellViewController else { return }
        shell.openPairLink(url)
    }
}
