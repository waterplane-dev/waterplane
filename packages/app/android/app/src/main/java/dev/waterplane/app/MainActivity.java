package dev.waterplane.app;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;

import org.json.JSONObject;

/**
 * The whole native side of the app: Capacitor's bridge, plus the handful of
 * things that cannot be expressed anywhere else.
 *
 * 1. **The update watchdog runs before the bridge exists.** Capacitor decides
 *    which bundle to serve while coming up, by reading a preference — so the one
 *    moment at which "the last three launches never got anywhere, fall back to
 *    the built-in bundle" can still change the outcome is here, ahead of
 *    `super.onCreate`. Every page load after that is put on a deadline
 *    ({@link ShellUpdatePlugin#armBootWatch}). See {@link ShellUpdatePlugin}.
 *
 * 2. **Saving a file out of the app.** A WebView drops a `blob:` download on
 *    the floor, silently — see {@link ShellSavePlugin}.
 *
 * 3. **Back navigation.** Capacitor 8 wires none, so the platform default —
 *    finish the activity — ran on every Back, including the swipe gesture. See
 *    {@link #registerBackNavigation()}.
 *
 * 4. **Window insets.** The app draws its own strip at the very top of the
 *    screen, so it has to know where the system's status bar ends. See
 *    {@link #takeOverWindowInsets()}.
 *
 * 5. **System-bar appearance.** The UI is dark end to end, so the bars must
 *    carry light icons.
 *
 * 6. **Navigation out of the shell.** The document in this WebView is the app;
 *    a link that replaces it has taken the whole app away. See
 *    {@link #guardNavigation()}.
 *
 * 7. **The background link.** {@link ShellLinkService} keeps the process out of
 *    Android's cached-app freezer so the page's own socket keeps running with
 *    nobody looking; this class is the half of it that knows whether anyone is.
 *    See {@link #nudgeWebView} and {@link #EXTRA_OPEN_SESSION}.
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "shell";

    /**
     * Session a tapped notification wants opened. Put there by
     * {@link ShellLinkService}'s {@code PendingIntent}, read here and handed to
     * the page — the same journey `sw.js`'s {@code notificationclick} makes in
     * the browser, minus the service worker the WebView does not have.
     */
    static final String EXTRA_OPEN_SESSION = "openSession";
    /** Install on the ready-to-install notification (ShellInstallReceiver). */
    static final String ACTION_INSTALL = "dev.waterplane.app.INSTALL_READY";
    static final String EXTRA_INSTALL_ID = "installId";
    /** The row an Install tap asked for, run from `onResume` — the install has
     *  to start with this activity in front, or the system installer it asks
     *  for cannot be shown and the tap comes back as another notification. */
    @Nullable private String pendingInstall;

    /**
     * The live activity, or null when there is none.
     *
     * {@link ShellLinkService} runs in this same process and needs to reach the
     * WebView for exactly one thing — a nudge when the network changed — and
     * must do nothing at all when the activity is gone. A static reference is
     * the plainest way to say "if there is one"; it is cleared in
     * {@link #onDestroy}, so it cannot outlive the window it names.
     */
    private static volatile MainActivity live;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before the bridge: it reads the persisted bundle path during startup,
        // so a recovery decided afterwards would only take effect a launch late.
        ShellUpdatePlugin.maybeRecover(this);
        // Local plugins, so they are not in `capacitor.plugins.json` (which lists
        // npm packages) and have to be registered by hand — before
        // `super.onCreate`, which is where the bridge is built from the
        // accumulated plugin list.
        registerPlugin(ShellUpdatePlugin.class);
        registerPlugin(ShellSavePlugin.class);
        registerPlugin(ShellNavPlugin.class);
        registerPlugin(ShellLinkPlugin.class);
        registerPlugin(ShellPullPlugin.class);
        registerPlugin(ShellInstallPlugin.class);
        registerPlugin(ShellNetPlugin.class);
        registerPlugin(ShellKeystorePlugin.class);

        super.onCreate(savedInstanceState);

        live = this;
        rememberOpenRequest(getIntent());
        rememberInstall(getIntent());
        rememberPairLink(getIntent());
        rememberShare(getIntent());

        registerBackNavigation();
        takeOverWindowInsets();
        guardNavigation();
        catchDownloads();

        // The first page load was started inside `super.onCreate`, before the
        // listener below existed; later ones (a bundle swap, a reload) arm from
        // `onPageStarted`.
        ShellUpdatePlugin.armBootWatch(this);

        applyBarAppearance();
        // The decor view applies the theme's own bar attributes when it is
        // attached, which happens AFTER onCreate returns — so a single call here
        // is silently overwritten. Re-assert once the view tree is up.
        getWindow().getDecorView().post(this::applyBarAppearance);
    }

    @Override
    public void onResume() {
        super.onResume();
        // The web tells us whether it has a screen to go back to; until it has
        // (an older bundle, or a page that has not booted yet) we take every
        // press and ask. Depth 0 means "nothing of ours below" — the callback
        // stays off so the platform handles Back itself, which is what gives the
        // gesture its proper exit animation.
        if (backCallback != null) backCallback.setEnabled(webBackDepth != 0);
        applyBarAppearance();
        // Back from another app (or the recents screen) the bars are shown
        // again by the platform; a page still in fullscreen wants them gone.
        applyImmersive();
        // The service is the only poster of OS notifications, and it must post
        // none while the user is looking at the app's own feed.
        ShellLinkService.setAppForeground(true);
        openRequest.deliver();
        pairRequest.deliver();
        shareRequest.deliver();
        if (pendingInstall != null) {
            String id = pendingInstall;
            pendingInstall = null;
            ShellPullService.Ready r = ShellPullService.ready(this, id);
            ShellInstallReceiver.cancelReady(this, r != null ? r.pkg : null, id);
            ShellPullService.mutate(this, id, ShellPullService.ACTION_INSTALL);
        }
    }

    private void rememberInstall(@Nullable Intent intent) {
        if (intent == null || !ACTION_INSTALL.equals(intent.getAction())) return;
        String id = intent.getStringExtra(EXTRA_INSTALL_ID);
        if (id != null && !id.isEmpty()) pendingInstall = id;
        intent.removeExtra(EXTRA_INSTALL_ID);
    }

    @Override
    public void onPause() {
        super.onPause();
        ShellLinkService.setAppForeground(false);
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        ShellLinkService.setAppForeground(false);
        super.onDestroy();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // `singleTask`, so a tapped notification reaching a live app arrives
        // here rather than through a second onCreate.
        setIntent(intent);
        rememberOpenRequest(intent);
        rememberInstall(intent);
        rememberPairLink(intent);
        rememberShare(intent);
        openRequest.deliver();
        pairRequest.deliver();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyBarAppearance();
    }

    // ── The background link's two touch points ───────────────────────────

    /**
     * Wake the page's own socket.
     *
     * `ws.ts` verifies its socket on `visibilitychange`, `online`, `focus` and
     * `pageshow` — every one of them a viewport event. A page that is alive but
     * not on screen when the network flaps therefore gets no signal at all, and
     * sits on a socket whose `readyState` still says OPEN until somebody picks
     * the phone up. That is the exact window this service exists to cover, so
     * {@link ShellLinkService}'s network callback calls this.
     *
     * <b>Optional at the far end, on purpose.</b> The UI updates over the air
     * and this shell does not, so a bundle that has never heard of
     * `shellNudge` must be no worse off than before — hence the guard
     * inside the expression rather than an assumption about what is loaded.
     */
    static void nudgeWebView(String reason) {
        callWindow("shellNudge", JSONObject.quote(reason));
    }

    /**
     * Call {@code window.<fn>(<jsonArg>)} in the page, fire and forget, if
     * there is a live activity and the page defines {@code fn}.
     *
     * The one shape every push from this shell into the page takes: guarded at
     * the far end (a bundle that predates {@code fn} is no worse off), hopped
     * onto the UI thread (callers are services, callbacks and plugins), and
     * silent when there is no window to tell.
     *
     * @param fn      a bare global name — never user input.
     * @param jsonArg the argument as a JS/JSON literal, already encoded
     *                ({@link JSONObject#quote} for a string, {@code toString()}
     *                of a JSONObject for an object).
     */
    static void callWindow(String fn, String jsonArg) {
        MainActivity a = live;
        if (a == null) return;
        a.runOnUiThread(() -> {
            WebView web = a.getBridge() != null ? a.getBridge().getWebView() : null;
            if (web == null) return;
            String js = "window." + fn + " && window." + fn + "(" + jsonArg + ")";
            try {
                web.evaluateJavascript(js, null);
            } catch (RuntimeException e) {
                Log.d(TAG, fn + " failed: " + e);
            }
        });
    }

    /**
     * A call the page has to TAKE, parked until it does.
     *
     * A cold start from a notification or a link reaches `onResume` long before
     * the bundle has booted and installed its global, so the handover retries
     * ({@value #PARK_RETRIES} × {@value #PARK_RETRY_MS} ms ⇒ 20 s) rather than
     * being dropped on the first miss. The page's function returns truthy when
     * it took the value; anything else (undefined included) means "not yet".
     *
     * One handover at a time: a tap on a live app reaches both `onNewIntent`
     * and `onResume`, and `evaluateJavascript` is asynchronous — without the
     * in-flight guard the page was asked to open the same session twice, in the
     * same millisecond, because neither call had finished when the other
     * started.
     */
    private final class ParkedCall {
        private final String fn;
        @Nullable private String value;
        private int retries;
        private boolean inFlight;

        ParkedCall(String fn) { this.fn = fn; }

        void park(String v) {
            value = v;
            retries = PARK_RETRIES;
        }

        void deliver() {
            final String v = value;
            if (v == null || inFlight) return;
            WebView web = getBridge() != null ? getBridge().getWebView() : null;
            if (web == null) return;
            String js = "!!(window." + fn + " && window." + fn + "(" + JSONObject.quote(v) + "))";
            inFlight = true;
            try {
                web.evaluateJavascript(js, result -> {
                    inFlight = false;
                    if ("true".equals(result)) {
                        value = null;
                        return;
                    }
                    if (--retries <= 0) {
                        Log.w(TAG, "page never took " + fn);
                        value = null;
                        return;
                    }
                    getWindow().getDecorView().postDelayed(this::deliver, PARK_RETRY_MS);
                });
            } catch (RuntimeException e) {
                inFlight = false;
                Log.d(TAG, fn + " failed: " + e);
            }
        }
    }

    private static final int PARK_RETRIES = 40;      // × 500 ms ⇒ 20 s
    private static final long PARK_RETRY_MS = 500;

    /** Session a notification tap asked for, until the page has taken it. */
    private final ParkedCall openRequest = new ParkedCall("shellOpen");
    /** A `waterplane://pair?…` link, until the page has taken it. */
    private final ParkedCall pairRequest = new ParkedCall("shellPair");

    private void rememberOpenRequest(Intent intent) {
        String id = intent != null ? intent.getStringExtra(EXTRA_OPEN_SESSION) : null;
        if (id == null || id.isEmpty()) return;
        openRequest.park(id);
        // Consumed: a rotation or a resume from recents re-reads the launch
        // intent, and focusing a session the user has since navigated away from
        // is worse than doing nothing.
        intent.removeExtra(EXTRA_OPEN_SESSION);
    }

    /**
     * The pairing deep link, `waterplane://pair?u=<base>&c=<code>`, from the host's
     * pair landing page after the APK is installed (see the README). Handed to
     * the page whole: parsing and validating it is `shared/pairing.ts`'s job,
     * and the page must ask the person before adopting a host — any app or web
     * page can fire this link, so its content is a suggestion, never a command.
     */
    private void rememberPairLink(@Nullable Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || !"waterplane".equalsIgnoreCase(data.getScheme())
                || !"pair".equalsIgnoreCase(data.getHost())) return;
        pairRequest.park(data.toString());
        // Consumed, for the same reason as the notification's session: a
        // rotation or a resume from recents re-reads the launch intent.
        intent.setData(null);
        intent.setAction(Intent.ACTION_MAIN);
    }

    /** What another app shared to this one, until the page has taken it. */
    private final ParkedCall shareRequest = new ParkedCall("shellShare");

    /**
     * The system share sheet's `SEND` / `SEND_MULTIPLE` (see {@link ShellShare}).
     * The copy runs off the UI thread — a shared video is hundreds of MB — and
     * parks the description for the page, which asks the person where it goes.
     * Consumed like the pair link: a rotation re-reads the launch intent, and a
     * second copy of the same share would ask the same question twice.
     */
    private void rememberShare(@Nullable Intent intent) {
        if (!ShellShare.isShare(intent)) return;
        final Intent share = new Intent(intent);
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(Intent.EXTRA_STREAM);
        intent.removeExtra(Intent.EXTRA_TEXT);
        final android.content.Context app = getApplicationContext();
        new Thread(() -> {
            String json = getBridge() != null ? ShellShare.collect(app, share, getBridge()) : null;
            runOnUiThread(() -> {
                if (json == null) {
                    Toast.makeText(this, "Nothing in that share could be read", Toast.LENGTH_LONG).show();
                    return;
                }
                shareRequest.park(json);
                shareRequest.deliver();
            });
        }, "shell-share").start();
    }

    // ── Back ─────────────────────────────────────────────────────────────

    /** Registered once in {@link #onCreate}; kept so the depth report can re-arm it. */
    private OnBackPressedCallback backCallback;

    /**
     * How many screens the web app has below the one on display, or -1 when it
     * has not said. Written from the JS thread ({@link ShellNavPlugin}), read on
     * the main thread, hence volatile.
     */
    private volatile int webBackDepth = DEPTH_UNKNOWN;

    static final int DEPTH_UNKNOWN = -1;

    /** How long the web side gets to say whether it handled a Back. */
    private static final long BACK_ANSWER_MS = 1200;

    /**
     * The web app reports its own history depth (see `App.tsx`'s routing
     * effect). This is the difference between guessing and knowing:
     *
     * Android 13+ asks — at the moment the swipe STARTS, before anything is
     * committed — whether the app will handle this Back, so that it can play the
     * right animation and, if the app will not, exit. An answer that only exists
     * after a round trip into JavaScript is an answer that arrives too late to
     * be asked for, so the enabled state of the callback has to be correct
     * AHEAD of the gesture. That is exactly what a pushed depth gives us:
     *
     *  - depth &gt; 0 — there is a screen below. Callback enabled; the system
     *    plays its in-app animation and hands us the press.
     *  - depth 0 — the launcher screen. Callback disabled, so the platform's own
     *    Back runs and the app leaves with the ordinary exit animation.
     *
     * Until a bundle calls this we fall back to asking over
     * `window.shellBack()`, which is what the shell always did.
     */
    void setWebBackDepth(int depth) {
        final int d = Math.max(0, depth);
        // Debug level, and worth the line: a depth that goes STALE is invisible
        // — the app keeps working and just exits on a Back that had a screen
        // below it, which is indistinguishable from the bug this replaced. This
        // is the only place that fact is observable from outside.
        Log.d(TAG, "back depth " + d);
        webBackDepth = d;
        runOnUiThread(() -> {
            if (backCallback != null) backCallback.setEnabled(d != 0);
        });
    }

    /** A page (re)load invalidates whatever the last document told us. */
    private void forgetBackDepth() {
        webBackDepth = DEPTH_UNKNOWN;
        if (backCallback != null) backCallback.setEnabled(true);
    }

    /**
     * Back — the button, the gesture, and Android 13+'s predictive swipe — steps
     * back through the app's own screens, and only leaves when there are none.
     *
     * Capacitor 8 registers nothing on the back dispatcher, so every Back took
     * the platform default and finished the activity: one swipe out of a session
     * dropped the user on the launcher instead of the session list, with the
     * whole UI (queue, drafts, compose box) torn down behind it.
     *
     * The WEB side decides, rather than this class reading
     * {@code WebView.canGoBack()}. Two reasons, both load-bearing: the screens
     * the hash cannot restore (sheets) still push a history entry, which only
     * the web knows about; and the WebView's history also contains the documents
     * an over-the-air bundle swap loaded ({@link ShellUpdatePlugin}), so "can go
     * back" is true at the root screen and would reload a retired build.
     *
     * It decides in one of two ways. {@link #setWebBackDepth} is the good one —
     * the answer is already here when the gesture starts. The fallback asks
     * `window.shellBack()` and is asynchronous, so the press is consumed either
     * way and the exit happens in the callback, behind a deadline: a dead
     * WebView, or a bundle old enough to predate `shellBack`, must not leave the
     * user unable to leave the app. A deadline that expires while we KNOW there
     * are screens below is a busy page, not a dead one, and is ignored.
     */
    private void registerBackNavigation() {
        backCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final int depth = webBackDepth;
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null || depth == 0) {
                    leave();
                    return;
                }
                // One-shot: whichever of the answer and the deadline arrives
                // first decides, and the other becomes a no-op.
                final boolean[] settled = { false };
                Handler handler = new Handler(Looper.getMainLooper());
                Runnable giveUp = () -> {
                    if (settled[0]) return;
                    settled[0] = true;
                    if (depth > 0) {
                        // The page told us there is a screen below; a slow answer
                        // is a busy renderer. Swallowing one press beats closing
                        // an app that had somewhere to go.
                        Log.w(TAG, "back: web busy at depth " + depth + ", press dropped");
                        return;
                    }
                    Log.w(TAG, "back: web did not answer, leaving");
                    leave();
                };
                handler.postDelayed(giveUp, BACK_ANSWER_MS);
                web.evaluateJavascript("!!(window.shellBack && window.shellBack())", value -> {
                    if (settled[0]) return;
                    settled[0] = true;
                    handler.removeCallbacks(giveUp);
                    if (!"true".equals(value)) leave();
                });
            }
        };
        getOnBackPressedDispatcher().addCallback(this, backCallback);
    }

    /**
     * Close the app.
     *
     * Deliberately {@code finishAfterTransition()} and not a second trip through
     * {@code getOnBackPressedDispatcher().onBackPressed()}. Re-entering the
     * dispatcher from inside its own dispatch means disabling this callback for
     * exactly one press and re-arming it later, and under Android 13+'s
     * predictive back — which this app is in by default, targeting SDK 36 — that
     * press is being replayed after the system's own back event has already
     * completed. Finishing directly is the same outcome with no state to get
     * wrong.
     */
    private void leave() {
        finishAfterTransition();
    }

    // ── Insets ───────────────────────────────────────────────────────────

    /**
     * Keep the app's own content out from under the status and navigation bars.
     *
     * The app draws a 22 px connection strip fixed to the very top of the
     * viewport, so "content starts at y=0" and "content starts under the clock
     * and the battery" are the same screen. Which of those you get used to be
     * decided by the platform version:
     *
     *  - `android:windowOptOutEdgeToEdgeEnforcement` kept the pre-15 layout,
     *    where the window sat below the bars. It is honoured on Android 15 and
     *    **ignored on Android 16 for an app targeting SDK 36**, which this one
     *    does — so the same APK laid out one way on one phone and the other way
     *    on the next, and on the newer phone the strip ran under the status bar.
     *  - Capacitor's own `SystemBars` plugin will pad for you, but only above
     *    API 35, and only after a probe of the WebView's major version and of
     *    the viewport meta tag decides between padding the container and passing
     *    the insets through for `env(safe-area-inset-*)` to pick up. Three
     *    conditions, two of which are properties of the WebView the phone
     *    happens to have installed.
     *
     * So the shell pads the WebView's container itself, from whatever insets the
     * window actually hands it. The web layer needs no change and no knowledge
     * of this: its `calc(env(safe-area-inset-top) + var(--ui-pulse-h))` still
     * works, with `env()` contributing the 0 it has always contributed here.
     *
     * Note what this deliberately does NOT do: force edge-to-edge with
     * `setDecorFitsSystemWindows(false)`. It does not have to. Below API 35 the
     * platform still fits the window below the bars and hands this listener
     * insets of zero, so it pads by zero and that path is exactly what it has
     * always been; from API 35 the platform lays the window out edge-to-edge
     * whatever the theme says, hands over real insets, and the same listener
     * pads by them. One rule, both worlds, and no behaviour invented for phones
     * that never had the problem.
     *
     * The listener — not a one-off measurement — is what makes this survive
     * rotation, the keyboard, and a switch between gesture and 3-button
     * navigation: all three are inset changes and all three re-dispatch.
     * `android:configChanges` keeps the activity alive across rotation, which is
     * why nothing re-registers it.
     */
    private void takeOverWindowInsets() {
        // Pre-R the ime type is not a first-class inset and AndroidX approximates
        // it from the legacy system-window insets, which would over-pad. Nothing
        // below API 35 is forced edge-to-edge anyway, so there is nothing here to
        // fix on those versions.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        View frame = (View) getBridge().getWebView().getParent();
        if (frame == null) return;

        ViewCompat.setOnApplyWindowInsetsListener(frame, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            // The keyboard covers the navigation bar, so it replaces the bottom
            // inset rather than adding to it — but only where it is really
            // reported: a window the platform resized for the keyboard itself
            // hands us an ime inset of zero, and `max` is then the bar's.
            int bottom = keyboard ? Math.max(ime.bottom, bars.bottom) : bars.bottom;
            v.setPadding(bars.left, bars.top, bars.right, bottom);
            // Consumed, but spelled out as zero rather than
            // `WindowInsetsCompat.CONSUMED`: a fully consumed dispatch stops the
            // WebView recalculating its own safe area, and the page's CSS still
            // reads `env(safe-area-inset-*)` — which must be 0 here, not stale.
            return new WindowInsetsCompat.Builder(insets)
                    .setInsets(
                            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                            Insets.NONE)
                    .build();
        });
        ViewCompat.requestApplyInsets(frame);
    }

    // ── System bars ──────────────────────────────────────────────────────

    /**
     * The page's resolved theme, pushed down from `web/theme.ts`.
     *
     * `false` — dark — until the page says otherwise, which is also what the
     * launch theme in `styles.xml` paints. That default is load-bearing rather
     * than arbitrary: the window exists before the WebView has a document, so
     * SOMETHING has to be on screen behind the status bar during the splash,
     * and a bundle old enough not to know about `setTheme` never calls this at
     * all. Both cases land on the app's original appearance.
     */
    private volatile boolean lightTheme = false;
    /** The page's own `--bg`, so the strip behind the status bar is the same
     *  colour as the app under it rather than an approximation of it. */
    private volatile int barColor = 0xFF0B0D10;

    /**
     * Called from `ShellNavPlugin.setTheme`, on the WebView's JavaScript thread.
     *
     * A push and not a pull, for the same reason as `setBackDepth`: the answer
     * is needed at moments when evaluating JavaScript is not possible — here,
     * when the activity resumes from the recents snapshot and re-asserts the bar
     * appearance before the page has been asked anything.
     */
    void setWebTheme(String theme, String background) {
        boolean light = "light".equals(theme);
        int color = barColor;
        try {
            if (background != null && background.length() > 0) color = Color.parseColor(background);
        } catch (IllegalArgumentException e) {
            // A page sending a colour we cannot parse keeps the last one. The
            // bars staying as they were is a far smaller fault than a window
            // painted with a thrown exception's absence of a colour.
            Log.w(TAG, "setTheme: unparseable background " + background);
        }
        final int resolved = color;
        runOnUiThread(() -> {
            lightTheme = light;
            barColor = resolved;
            applyBarAppearance();
        });
    }

    /**
     * "The bars are dark, so draw their icons light" — and, since the app grew a
     * light mode, the other way round too.
     *
     * Called from several places on purpose: the appearance is a property of the
     * window's insets controller, and it is re-derived — after `onCreate`, after
     * `BridgeActivity` swaps the theme, and on resume from the recents snapshot.
     * Setting it once left the icons dark-on-dark, i.e. the status bar's
     * contents invisible except the battery's coloured fill. Capacitor's
     * `SystemBars` plugin derives the same property from the phone's NIGHT MODE,
     * which is not a fact about this app: the app follows the OS only when the
     * user has left it on "follow device", and overrides it otherwise — hence
     * `style: "DARK"` in `capacitor.config.ts` and the page telling us directly.
     *
     * The bar COLOURS are set here as well as in the theme. `statusBarColor` is
     * deprecated and ignored from Android 15 on, where the bars are drawn
     * transparent over the window — which is exactly why the window background
     * is set too: on 15+ that is the colour that shows through, and below 15 the
     * two agree so the handover between them is invisible.
     */
    private void applyBarAppearance() {
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(lightTheme);
        bars.setAppearanceLightNavigationBars(lightTheme);
        try {
            getWindow().setStatusBarColor(barColor);
            getWindow().setNavigationBarColor(barColor);
            View decor = getWindow().getDecorView();
            if (decor != null) decor.setBackgroundColor(barColor);
        } catch (Exception e) {
            // Colouring the bars is cosmetic; failing to do it must never be the
            // reason the activity does not come up.
            Log.w(TAG, "bar colour", e);
        }
    }

    /** The page asked for the whole screen (`ShellNavPlugin.setImmersive`). */
    private volatile boolean immersive = false;

    /** Called on the WebView's JavaScript thread; the bars are touched on the UI thread. */
    void setWebImmersive(boolean on) {
        runOnUiThread(() -> {
            immersive = on;
            applyImmersive();
        });
    }

    /**
     * Hidden bars still come back on a swipe from the edge — for a moment, over
     * the page — so Back and Home stay one gesture away and the page never has
     * to draw a way out of a screen the person cannot leave.
     */
    private void applyImmersive() {
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (immersive) {
            bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            bars.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            bars.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    // ── Leaving the shell ────────────────────────────────────────────────

    /**
     * The document in this WebView **is** the app. Replacing it is not a
     * navigation, it is an uninstall for as long as the page stays gone — the
     * send queue, the drafts and the compose box all live in that document — and
     * it is the exact failure this whole package exists to remove.
     *
     * One shape of link does it silently. A relative URL — a markdown link in a
     * transcript, an `<a href>` a sheet renders from host data — resolves
     * against the shell's own origin, `http://localhost`, which is Capacitor's
     * asset server and holds only the bundle. Capacitor allows it (same host as
     * the app), the asset server has nothing at that path, and the app is
     * replaced by a blank 404. Nothing about the tap said that would happen.
     *
     * So: a main-frame navigation to our own origin is allowed only for the app
     * document itself. Anything else on it is refused and named. A main-frame
     * navigation to a DIFFERENT origin does leave — that is a real link to the
     * outside — but it asks first, because the alternative is the app vanishing
     * on a tap the user did not read as "leave".
     *
     * **A file on the daemon is not "the outside".** This hook runs BEFORE the
     * request, so it also fires for a navigation that was only ever going to be
     * a download: {@code shouldOverrideUrlLoading} sees a plain main-frame GET,
     * and it is the RESPONSE — a type the renderer cannot display — that turns
     * it into one. Returning true there cancels the request, so
     * {@link #catchDownloads()} never gets its turn: the Files sheet's own
     * `download` button (`<a download href="…/artifact?path=…">`, absolute
     * because `api.ts` builds these two URLs with `abs()` — the transport patch
     * cannot reach an `<a href>`) answered with "Open in your browser?" instead
     * of saving anything. Nothing in the request tells the two apart —
     * `getRequestHeaders()` is null for a renderer-initiated navigation, and the
     * `download` attribute is dropped by the renderer for a cross-origin href
     * long before we see it — so the discriminator is the ROUTE, which the host
     * already names for exactly this reason: `origin.ts`'s `OPAQUE_READ_ROUTES`
     * is the same two paths, listed there because "the Android shell loads them
     * as `<img src>`/`<a download>`". Those go straight to the downloader.
     *
     * Sub-frame requests, `blob:` and `data:` keep Capacitor's own behaviour.
     */
    private void guardNavigation() {
        if (getBridge() == null) return;
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (request.isForMainFrame() && isOurOrigin(url) && !isAppDocument(url)) {
                    Log.w(TAG, "refused in-shell navigation to " + url);
                    toast("that link points inside the app, not at your host — not opening it");
                    return true;
                }
                if (request.isForMainFrame() && isWeb(url) && !isOurOrigin(url)) {
                    if (isHostFileRoute(url) && isPairedHost(url)) {
                        String name = Downloads.safeName(fileNameOf(url));
                        saveToDownloads(url.toString(), name != null ? name : "download", null, null);
                        return true;
                    }
                    confirmLeaving(url);
                    return true;
                }
                return super.shouldOverrideUrlLoading(view, request);
            }
        });
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                // A reload (an over-the-air bundle swap, the ws.ts watchdog)
                // starts a document that has not reported its depth yet.
                runOnUiThread(MainActivity.this::forgetBackDepth);
                // …and has not proven it can start: a downloaded bundle gets
                // `BOOT_DEADLINE_MS` on screen to say so (ShellUpdatePlugin).
                runOnUiThread(() -> ShellUpdatePlugin.armBootWatch(MainActivity.this));
            }
        });
    }

    /** Capacitor's asset server — the origin the bundle is served from. */
    private static boolean isOurOrigin(Uri url) {
        return "http".equals(url.getScheme()) && "localhost".equals(url.getHost());
    }

    /** The one document this WebView may hold. */
    private static boolean isAppDocument(Uri url) {
        String path = url.getPath();
        return path == null || path.isEmpty() || "/".equals(path) || "/index.html".equals(path);
    }

    private static boolean isWeb(Uri url) {
        return "http".equals(url.getScheme()) || "https".equals(url.getScheme());
    }

    /**
     * The daemon's two file routes — the ones the web app deliberately points an
     * `<a href>`/`<a download>` at, and the same two the host's `origin.ts`
     * exempts from its `Sec-Fetch-Site` backstop with the comment "the Android
     * shell loads them as `<img src>`/`<a download>`". A hit here is a file the
     * user asked for, never a page to hand to a browser.
     *
     * The PATH shape alone used to decide it. That let any origin spell the
     * route: a Markdown link `https://evil/api/repos/x/artifact?path=app.apk`
     * in an agent-written file was fetched into Downloads with one tap and no
     * dialog — the dialog every other foreign link gets. So the shortcut now
     * also needs the URL to be ON the paired host (`isPairedHost`); a foreign
     * origin that merely looks like the route is confirmed like any other link.
     */
    private static boolean isHostFileRoute(Uri url) {
        String path = url.getPath();
        if (path == null) return false;
        return path.matches("/api/repos/[^/]+/artifact")
                || path.matches("/api/repos/[^/]+/inbox/[^/]+");
    }

    /**
     * Is this URL on the host this phone is paired with — scheme AND authority?
     * The background link keeps the host's `ws(s)://` address (`ShellLinkService`);
     * the app's own download links use the same base. No saved host, or another
     * one: not the paired host, so the leave-the-app dialog decides.
     */
    private boolean isPairedHost(Uri url) {
        String base = ShellLinkService.httpBase(ShellLinkService.savedUrl(this));
        if (base == null) return false;
        Uri b = Uri.parse(base);
        String scheme = url.getScheme(), auth = url.getEncodedAuthority();
        return scheme != null && auth != null
                && scheme.equalsIgnoreCase(b.getScheme())
                && auth.equalsIgnoreCase(b.getEncodedAuthority());
    }

    /**
     * What to call the saved file. The artifact route carries the real name in
     * its `path` QUERY parameter, so `URLUtil.guessFileName` — which reads the
     * URL's path — would name every artifact `artifact.bin`.
     */
    private static String fileNameOf(Uri url) {
        String from = url.getQueryParameter("path");
        if (from == null || from.isEmpty()) from = url.getPath();
        if (from == null) return "download";
        int cut = from.lastIndexOf('/');
        String name = cut >= 0 ? from.substring(cut + 1) : from;
        return name.isEmpty() ? "download" : name;
    }

    private void confirmLeaving(Uri url) {
        new AlertDialog.Builder(this)
                .setTitle("Open in your browser?")
                .setMessage(url.toString() + "\n\nThis leaves the app. The app itself keeps running.")
                .setNegativeButton("Stay here", null)
                .setPositiveButton("Open", (d, w) -> openOutside(url))
                .show();
    }

    private void openOutside(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException e) {
            toast("no app on this phone can open that link");
        }
    }

    // ── Downloads the WebView starts by itself ───────────────────────────

    /**
     * A WebView with no {@link android.webkit.DownloadListener} discards every
     * download it starts, in complete silence — the same failure
     * {@link ShellSavePlugin} exists to fix for the app's own save button, but on
     * the path nothing in this app controls: a response the renderer cannot
     * display, or an `<a download>` pointing at the daemon.
     *
     * `blob:` and `data:` cannot be handed to `DownloadManager` (they live in
     * the renderer), and those are the app's own saves anyway, which go over the
     * bridge. Everything else goes to the system downloader — and either way the
     * user is told, which is the whole point: the one outcome not on offer any
     * more is nothing happening.
     */
    private void catchDownloads() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            if (url == null) return;
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                Log.w(TAG, "download the shell cannot take over: " + url);
                toast("use the app's own save button for this file");
                return;
            }
            saveToDownloads(url, URLUtil.guessFileName(url, contentDisposition, mimeType), userAgent, mimeType);
        });
    }

    /**
     * The one place this shell hands a URL to the system downloader. Two callers
     * — the {@link android.webkit.DownloadListener} above, and the navigation
     * guard, which has to cancel the request before the listener would ever see
     * it (see {@link #guardNavigation()}) — and one implementation, because "the
     * file landed in Downloads and the user was told where" is the whole
     * behaviour and forking it is how one caller quietly stops saying so.
     *
     * @param userAgent may be null: only the WebView's own downloads carry one.
     * @param mimeType  may be null; `DownloadManager` sniffs the response.
     */
    private void saveToDownloads(String url, String name, String userAgent, String mimeType) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(mimeType);
            if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Scoped storage: the public Downloads collection, no permission.
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            } else {
                // Below Q the public directory needs a runtime grant we do not
                // hold here. The app's own folder needs none, and a stated
                // location beats a refused one.
                req.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            }
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("no download manager");
            dm.enqueue(req);
            toast("downloading " + name + " → Downloads");
        } catch (RuntimeException e) {
            Log.w(TAG, "download failed: " + e);
            toast("could not download " + name + ": " + e.getMessage());
        }
    }

    private void toast(String text) {
        runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
    }
}
