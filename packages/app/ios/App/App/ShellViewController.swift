import UIKit
import WebKit
import Capacitor

/**
 * The iOS shell's one screen — the counterpart of Android's `MainActivity`,
 * holding only what the basics need (docs/analysis/ios-shell-plan.md has the
 * class-by-class table of what was ported and what is Android-only).
 *
 * Three jobs, each one a thing the page cannot do for itself:
 *
 *  - **The keyboard resizes the page, it does not cover it.** WKWebView's
 *    default is to leave the layout viewport full height and pan the document
 *    so the focused field shows — which pushes the app's header off the top and
 *    leaves the composer's send row under the keyboard's suggestion bar.
 *    Android gets `resizes-content` from the window; here the WebView's frame
 *    is shortened by exactly the keyboard's overlap, so `innerHeight` shrinks
 *    and the web layer's own flex layout puts the composer on top of it. The
 *    frame now ends above the home indicator, so `env(safe-area-inset-bottom)`
 *    drops to 0 by itself — no double gap.
 *
 *  - **A resume wakes the socket.** `ws.ts` checks its socket on viewport
 *    events; iOS suspends the process a few seconds after it leaves the
 *    screen, and the socket it comes back with may be one the OS already tore
 *    down. `shellNudge("resume")` is the same call Android makes, guarded at
 *    the far end so a bundle that predates it is no worse off.
 *
 *  - **`waterplane://pair?…` reaches the page.** Same contract as Android:
 *    `window.shellPair(url)` answers truthy once it has looked at the link, and
 *    a falsy answer (bundle not booted yet, cold start) is retried for 20 s.
 *
 * External links need nothing here: Capacitor's navigation delegate already
 * hands any top-level navigation off the app's own origin to the system
 * (`UIApplication.open`), which is what `openExternal.ts` relies on.
 */
class ShellViewController: CAPBridgeViewController {
    /// Points of the WebView the docked keyboard currently covers.
    private var keyboardOverlap: CGFloat = 0

    /// `#0b0d10`, the app's background — what shows for the frames before the
    /// bundle paints and behind the keyboard while it animates.
    private static let background = UIColor(red: 0x0b / 255.0, green: 0x0d / 255.0, blue: 0x10 / 255.0, alpha: 1)

    /// The page's resolved theme, "dark" or "light", as last reported.
    private var pageTheme = "dark"

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShellSavePlugin())

        webView?.isOpaque = false
        paint(Self.background)
        followPageTheme()

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)),
                       name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        nc.addObserver(self, selector: #selector(keyboardWillHide(_:)),
                       name: UIResponder.keyboardWillHideNotification, object: nil)
        nc.addObserver(self, selector: #selector(didBecomeActive),
                       name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    // MARK: - Theme

    /// The status bar's icons follow the PAGE's theme, not the phone's: the
    /// app has its own light/dark/system choice, and a light page under
    /// light-content icons hides the clock. Android hears this through
    /// `ShellAndroidInterface.setTheme`; here the shell reads the same two
    /// facts `theme.ts` already writes — `<html data-theme>` and
    /// `<meta name="theme-color">` — so no web contract is added or faked.
    override var preferredStatusBarStyle: UIStatusBarStyle {
        pageTheme == "light" ? .darkContent : .lightContent
    }

    private static let themeScript = """
    (function () {
      var post = function () {
        var m = document.querySelector('meta[name="theme-color"]');
        window.webkit.messageHandlers.shellTheme.postMessage({
          theme: document.documentElement.getAttribute('data-theme') || '',
          bg: m ? m.getAttribute('content') || '' : ''
        });
      };
      new MutationObserver(post).observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme'], subtree: false });
      post();
    })();
    """

    private func followPageTheme() {
        guard let ucc = webView?.configuration.userContentController else { return }
        ucc.add(ThemeListener(self), name: "shellTheme")
        ucc.addUserScript(WKUserScript(source: Self.themeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    fileprivate func pageThemeChanged(theme: String, bg: String) {
        if theme == "light" || theme == "dark", theme != pageTheme {
            pageTheme = theme
            setNeedsStatusBarAppearanceUpdate()
        }
        if let color = Self.color(hex: bg) { paint(color) }
    }

    /// What shows behind the page — before it paints, and under the keyboard.
    private func paint(_ color: UIColor) {
        view.backgroundColor = color
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
    }

    private static func color(hex: String) -> UIColor? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                       blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }

    // MARK: - Keyboard

    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let win = view.window else { return }
        let kb = win.convert(end, from: win.screen.coordinateSpace)
        // A keyboard sliding off the bottom, or an undocked/floating one that
        // does not reach the bottom edge, covers nothing the layout must avoid.
        let docked = kb.maxY >= win.bounds.maxY - 1
        setOverlap(docked ? max(0, win.bounds.maxY - kb.minY) : 0, note)
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        setOverlap(0, note)
    }

    private func setOverlap(_ overlap: CGFloat, _ note: Notification) {
        guard overlap != keyboardOverlap else { return }
        keyboardOverlap = overlap
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        UIView.animate(withDuration: duration) { self.applyFrame() }
    }

    private func applyFrame() {
        guard let win = view.window else { return }
        var f = win.bounds
        f.size.height -= keyboardOverlap
        view.frame = f
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { _ in self.applyFrame() }
    }

    // MARK: - Calls into the page

    @objc private func didBecomeActive() {
        callWindow("shellNudge", arg: "resume")
    }

    /// A `waterplane://pair?…` link, from a cold start or while running.
    func openPairLink(_ url: URL, attempt: Int = 0) {
        callWindow("shellPair", arg: url.absoluteString) { took in
            guard !took, attempt < 40 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.openPairLink(url, attempt: attempt + 1)
            }
        }
    }

    /// `window.<fn>(<arg>)` if the page defines it — the one shape every push
    /// from this shell into the page takes, as on Android (`callWindow`).
    /// `fn` is a bare global name, never input; `arg` is JSON-encoded.
    private func callWindow(_ fn: String, arg: String, done: ((Bool) -> Void)? = nil) {
        guard let web = webView,
              let data = try? JSONSerialization.data(withJSONObject: [arg]),
              let list = String(data: data, encoding: .utf8) else { done?(false); return }
        let literal = String(list.dropFirst().dropLast())
        let js = "!!(window.\(fn) && window.\(fn)(\(literal)))"
        web.evaluateJavaScript(js) { result, _ in done?((result as? Bool) ?? false) }
    }
}

/// `WKUserContentController` retains its handlers; this weak hop keeps it from
/// retaining the view controller too.
private final class ThemeListener: NSObject, WKScriptMessageHandler {
    weak var owner: ShellViewController?
    init(_ owner: ShellViewController) { self.owner = owner }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        owner?.pageThemeChanged(theme: body["theme"] as? String ?? "", bg: body["bg"] as? String ?? "")
    }
}
