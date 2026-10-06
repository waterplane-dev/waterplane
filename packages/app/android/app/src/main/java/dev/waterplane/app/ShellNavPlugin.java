package dev.waterplane.app;

import android.webkit.JavascriptInterface;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * One fact, pushed the other way: **how many screens the web app has below the
 * one on display.**
 *
 * Everything else the shell needs from the page it can ask for. This it cannot,
 * because of when the question is asked. Android 13+ decides at the moment a
 * back SWIPE begins — before anything is committed, while the finger is still
 * moving — whether the app is going to handle this Back, so that it can play
 * either the in-app animation or the one that slides the app away. An answer
 * that requires a round trip into JavaScript does not exist yet at that moment,
 * so the shell has to have decided in advance; the only way to decide in advance
 * is to already know.
 *
 * Hence a push rather than a pull. The web app calls this whenever its route
 * changes:
 *
 * <pre>
 *   window.ShellAndroidInterface?.setBackDepth(depth)
 * </pre>
 *
 * and {@link MainActivity#setWebBackDepth} turns it into the enabled state of
 * the back callback — enabled above 0, off at 0 so the platform's own Back runs
 * and the app exits the way every other app exits.
 *
 * **Optional, on purpose.** A bundle that never calls it leaves the depth
 * unknown and the shell falls back to asking `window.shellBack()` over
 * `evaluateJavascript`, which is what it has always done. The UI updates over
 * the air and the shell does not, so the receiving end has to be able to sit
 * here unused until a bundle that knows about it arrives.
 *
 * Registered as a plugin rather than by a bare `addJavascriptInterface` in the
 * activity for one reason: a plugin's {@code load()} runs while the bridge is
 * being built, i.e. before the page is loaded, which is the only point at which
 * adding an interface is guaranteed to be visible to the document's own scripts.
 */
@CapacitorPlugin(name = "ShellNav")
public class ShellNavPlugin extends Plugin {

    static final String INTERFACE = "ShellAndroidInterface";

    @Override
    public void load() {
        super.load();
        getBridge().getWebView().addJavascriptInterface(this, INTERFACE);
    }

    /**
     * Called on the WebView's JavaScript thread, never the main thread — the
     * activity hops back for the part that touches the callback.
     *
     * @param depth entries the web app has pushed below the current screen; 0
     *              means the launcher screen, i.e. "the next Back is not mine".
     */
    @JavascriptInterface
    public void setBackDepth(int depth) {
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).setWebBackDepth(depth);
        }
    }

    /**
     * The second fact the page has to push rather than be asked for: **which
     * theme it resolved to, and the colour it painted itself.**
     *
     * The status and navigation bars are window attributes. No stylesheet
     * reaches them, so a page that went light while the bars stayed dark leaves
     * a black band above a white app with white icons on it — the exact
     * "somebody forgot to paint this" look the dark-only theme in `styles.xml`
     * was written to avoid, only now on the other side.
     *
     * Pushed for the same reason as {@link #setBackDepth}: the activity
     * re-asserts bar appearance on resume, from the recents snapshot, before the
     * WebView has run a line of script — so the answer has to be already known.
     *
     * Optional in exactly the same way. A bundle that never calls it leaves the
     * app dark end to end, which is what it was.
     *
     * @param theme      "light" or "dark", already resolved from the user's
     *                   choice and the OS (`web/theme.ts`) — this side does not
     *                   re-derive it from night mode, which would disagree with
     *                   the page whenever the user has overridden the OS.
     * @param background the page's own `--bg`, as `#rrggbb`.
     */
    @JavascriptInterface
    public void setTheme(String theme, String background) {
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).setWebTheme(theme, background);
        }
    }
}
