package dev.waterplane.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.widget.Toast;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Over-the-air updates for the web bundle — the native half.
 *
 * The APK carries the UI so a dead tunnel cannot take the app away. Without this
 * plugin the cost of that would be a frozen UI: every web change would need a new
 * APK sideloaded onto the phone. Instead the app downloads the daemon's current
 * bundle into its own storage and points the WebView at it.
 *
 * **Almost all of the work is deliberately NOT here.** Checking the version,
 * fetching the files and verifying their hashes all live in `web/webUpdate.ts`,
 * where they are TypeScript, reuse the app's own host-address handling, and can
 * be read and changed without an Android toolchain. This class is only the four
 * things JavaScript in a WebView cannot do: put bytes on the filesystem, tell
 * Capacitor which directory to serve from, survive a restart, and refuse to
 * brick the app.
 *
 * The mechanism is Capacitor's own: `Bridge.setServerBasePath` plus the
 * `serverBasePath` preference the bridge restores at boot. Two of its properties
 * are load-bearing and come for free:
 *
 *  - Installing a NEW APK resets the preference (`Bridge.isNewBinary`), so a
 *    sideloaded build is never shadowed by an older downloaded bundle.
 *  - The origin does not change (`http://localhost` either way), so localStorage
 *    and IndexedDB carry across an update — the send queue, drafts, the paired
 *    host and cached transcripts all survive.
 *
 * **The safety net.** A downloaded bundle is code that replaces a working app, so
 * the failure to design for is "the new bundle does not start". Every launch
 * increments a counter; the web app zeroes it via `markHealthy` once it has
 * actually mounted. Three launches that never reach that point and
 * {@link #maybeRecover} drops the preference, so the next start comes up on the
 * APK's built-in bundle — which is always present and always works offline.
 * Recovery therefore needs no network, no server and no user action.
 *
 * **Three launches was too slow, and the revert did not stick.** Measured
 * twice on the owner's phone: a downloaded build came up as a white screen and
 * stayed one. "Three cold launches" means swiping the app away three times —
 * reopening it from the recents or the launcher resumes the same blank
 * activity and counts nothing. And when the counter did fire, the APK's own
 * bundle asked the desktop what it was serving, got the same build back,
 * downloaded it, staged it and restarted into it as soon as the phone was put
 * down: the white screen again. So, on top of the counter:
 *
 *  - **A deadline per page load** ({@link #armBootWatch}): a downloaded bundle
 *    that has not called `markHealthy` after {@link #BOOT_DEADLINE_MS} of time
 *    ON SCREEN is abandoned there and then, in the same process — no relaunch.
 *    Only foreground time counts, so a bundle that started while the phone was
 *    in a pocket (the auto-restart does exactly that) is not judged by a
 *    WebView the system was not running.
 *  - **The failed build is remembered** ({@link #KEY_BAD_BUILD}). `stage` and
 *    `applyNow` refuse that id unless the person asks for it by hand, so the
 *    fallback is not undone by the next update check. The next DIFFERENT build
 *    the desktop serves is taken as usual.
 *  - **A stored path with no `index.html`** is dropped before the bridge sees
 *    it, and a newly installed APK always starts on its own bundle (see
 *    {@link #KEY_APK_INSTALLED_AT}).
 */
@CapacitorPlugin(name = "ShellUpdate")
public class ShellUpdatePlugin extends Plugin {

    /** Our own preferences; Capacitor's live in a separate file we only touch via its constants. */
    private static final String PREFS = "shell.update";
    private static final String KEY_BOOT_FAILS = "bootFails";
    private static final String KEY_LAST_RECOVERY = "lastRecoveryAt";

    /**
     * Consecutive launches allowed without the web app reporting healthy before
     * we fall back to the built-in bundle. Three rather than one: a launch can be
     * cut short for innocent reasons (the user swipes the app away while it is
     * still booting, the system kills it under memory pressure), and reverting on
     * the first of those would undo a perfectly good update.
     */
    private static final int MAX_BOOT_FAILS = 3;

    /**
     * The build that fell back, why, and — via {@link #KEY_LAST_RECOVERY} —
     * when. `stage`/`applyNow` refuse this id unless `force` is passed, which
     * only the person's own tap does.
     */
    private static final String KEY_BAD_BUILD = "badBuild";
    private static final String KEY_BAD_REASON = "badReason";

    /**
     * `PackageInfo.lastUpdateTime` of the APK the stored bundle path was chosen
     * under. Capacitor's own "new binary ⇒ forget the downloaded bundle" keys on
     * versionCode/versionName, which `build.gradle` never changes (2 / "1.0"),
     * so a freshly installed APK went on serving the OLD download — including a
     * broken one, which made reinstalling no way out of a white screen.
     */
    private static final String KEY_APK_INSTALLED_AT = "apkInstalledAt";

    /**
     * On-screen time a downloaded bundle gets to call `markHealthy` before the
     * shell gives up on it. `main.tsx` calls it from the first committed render
     * — before pairing, before the socket, before any network — so this is a
     * budget for parsing and mounting a local bundle, which takes well under two
     * seconds on a phone. Fifteen is generous on purpose: a false trip costs a
     * good build until the desktop serves the next one, a late trip costs only
     * seconds of a screen that was blank anyway.
     */
    static final long BOOT_DEADLINE_MS = 15_000;
    private static final long BOOT_TICK_MS = 500;

    /** Bumped per page load (UI thread); `markHealthy` copies it into {@link #healthyLoad}. */
    private static volatile long pageLoad = 0;
    private static volatile long healthyLoad = -1;
    private static final Handler ui = new Handler(Looper.getMainLooper());

    /** Downloaded bundles live here, one directory per build id. */
    private static File bundlesDir(Context ctx) {
        return new File(ctx.getFilesDir(), "bundles");
    }

    private static SharedPreferences ours(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    private static SharedPreferences capacitor(Context ctx) {
        return ctx.getSharedPreferences(com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
    }

    // ── boot watchdog ────────────────────────────────────────────────────
    /**
     * Called from {@link MainActivity#onCreate} BEFORE the bridge is built, which
     * is the only moment clearing the preference still changes which bundle
     * loads: the bridge reads it while coming up.
     *
     * @return true if a recovery happened (the app is now on the built-in bundle)
     */
    static boolean maybeRecover(Context ctx) {
        SharedPreferences prefs = ours(ctx);
        String stored = capacitor(ctx).getString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, "");
        boolean recovered = false;

        // A new APK starts on its own bundle (KEY_APK_INSTALLED_AT says why
        // Capacitor's check does not do this here). Not a failure, so nothing
        // is marked bad: the OTA check simply runs again from the APK's build.
        long installedAt = apkInstalledAt(ctx);
        if (installedAt != 0 && installedAt != prefs.getLong(KEY_APK_INSTALLED_AT, 0)) {
            prefs.edit().putLong(KEY_APK_INSTALLED_AT, installedAt).putInt(KEY_BOOT_FAILS, 0).apply();
            if (!stored.isEmpty()) {
                capacitor(ctx).edit().remove(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH).apply();
                stored = "";
            }
        }

        // A stored bundle that is not there (pruned, half-renamed, wiped) is a
        // blank page Capacitor would serve without complaint. Drop it now.
        if (!stored.isEmpty() && !new File(stored, "index.html").isFile()) {
            dropStoredBundle(ctx, stored, "its files were missing");
            recovered = true;
        }

        int fails = prefs.getInt(KEY_BOOT_FAILS, 0);
        if (fails >= MAX_BOOT_FAILS) {
            dropStoredBundle(ctx, stored, MAX_BOOT_FAILS + " launches in a row never finished starting");
            recovered = true;
            fails = 0;
        }
        // Count this launch. `markHealthy` clears it once the UI is actually up,
        // so the counter only ever grows across launches that did not get there.
        prefs.edit().putInt(KEY_BOOT_FAILS, fails + 1).apply();
        return recovered;
    }

    /** Forget the stored bundle path and remember which build it was and why. */
    private static void dropStoredBundle(Context ctx, String path, String reason) {
        capacitor(ctx).edit().remove(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH).apply();
        SharedPreferences.Editor e = ours(ctx).edit()
                .putInt(KEY_BOOT_FAILS, 0)
                .putLong(KEY_LAST_RECOVERY, System.currentTimeMillis())
                .putString(KEY_BAD_REASON, reason);
        String id = path == null || path.isEmpty() ? "" : new File(path).getName();
        if (!badId(id)) e.putString(KEY_BAD_BUILD, id);
        e.apply();
        com.getcapacitor.Logger.warn("shell-update", "dropped bundle " + id + ": " + reason);
    }

    private static long apkInstalledAt(Context ctx) {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).lastUpdateTime;
        } catch (android.content.pm.PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    /**
     * Start the clock on the page that is loading now. Called by
     * {@link MainActivity} after the bridge is built and on every page start
     * (a bundle swap, a reload), on the UI thread. A page served from the APK's
     * own bundle is not watched: there is nothing further to fall back to.
     */
    static void armBootWatch(MainActivity activity) {
        final long load = ++pageLoad;
        com.getcapacitor.Bridge bridge = activity.getBridge();
        if (bridge == null) return;
        if (downloadedBase(bridge) == null) return;
        ui.postDelayed(new Runnable() {
            long onScreen = 0;
            @Override public void run() {
                if (pageLoad != load || healthyLoad >= load) return;   // superseded, or up
                if (activity.isDestroyed()) return;   // the next onCreate counts instead
                if (activity.getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
                    onScreen += BOOT_TICK_MS;
                }
                if (onScreen < BOOT_DEADLINE_MS) { ui.postDelayed(this, BOOT_TICK_MS); return; }
                fallBack(activity, "it did not finish starting within " + (BOOT_DEADLINE_MS / 1000) + " s on screen");
            }
        }, BOOT_TICK_MS);
    }

    /** Abandon the running downloaded bundle for the APK's own, right now. */
    private static void fallBack(MainActivity activity, String reason) {
        com.getcapacitor.Bridge bridge = activity.getBridge();
        if (bridge == null) return;
        String base = downloadedBase(bridge);
        if (base == null) return;
        dropStoredBundle(activity, base, reason);
        String id = new File(base).getName();
        Toast.makeText(activity, "build " + shortId(id) + " did not start — back on the build inside the app",
                Toast.LENGTH_LONG).show();
        // "public" is Capacitor's default asset directory — the copy `cap sync`
        // put in the APK. Reloads the WebView, which re-arms the watch (a no-op
        // on the built-in bundle).
        bridge.setServerAssetPath("public");
    }

    /**
     * The directory a downloaded bundle is served from, or null on the APK's own.
     * Not "is the base path empty": after `setServerAssetPath("public")` (a
     * fallback, a revert) Capacitor reports the ASSET dir, `public`, as the base
     * path — so an emptiness test called the built-in bundle a download, and the
     * deadline would have re-armed on the very bundle it had just fallen back to.
     * A download is always an absolute path under `files/bundles`.
     */
    static String downloadedBase(com.getcapacitor.Bridge bridge) {
        String base = bridge.getServerBasePath();
        return base != null && base.startsWith("/") ? base : null;
    }

    private static String shortId(String id) {
        return id.length() > 8 ? id.substring(0, 8) : id;
    }

    // ── JS API ───────────────────────────────────────────────────────────
    /** The web app has rendered. Clears the boot-failure counter and stops the deadline. */
    @PluginMethod
    public void markHealthy(PluginCall call) {
        healthyLoad = pageLoad;
        SharedPreferences.Editor e = ours(getContext()).edit().putInt(KEY_BOOT_FAILS, 0);
        // A build that was refused and then started fine (the person retried
        // it by hand) is no longer bad.
        String base = downloadedBase(bridge);
        String bad = ours(getContext()).getString(KEY_BAD_BUILD, "");
        if (base != null && new File(base).getName().equals(bad)) {
            e.remove(KEY_BAD_BUILD).remove(KEY_BAD_REASON);
        }
        e.apply();
        call.resolve();
    }

    /** The refusal `stage`/`applyNow` give a build that already failed here, or null. */
    private String refuseBad(PluginCall call, String id) {
        SharedPreferences prefs = ours(getContext());
        if (!id.equals(prefs.getString(KEY_BAD_BUILD, ""))) return null;
        if (Boolean.TRUE.equals(call.getBoolean("force", false))) {
            prefs.edit().remove(KEY_BAD_BUILD).remove(KEY_BAD_REASON).apply();
            return null;
        }
        return "build " + shortId(id) + " did not start on this phone ("
                + prefs.getString(KEY_BAD_REASON, "no reason recorded") + ")";
    }

    /** Where we are running from, and whether a recovery has ever fired. */
    @PluginMethod
    public void info(PluginCall call) {
        String base = downloadedBase(bridge);
        JSObject ret = new JSObject();
        ret.put("builtIn", base == null);
        ret.put("basePath", base == null ? "" : base);
        ret.put("staged", capacitor(getContext()).getString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, ""));
        ret.put("lastRecoveryAt", ours(getContext()).getLong(KEY_LAST_RECOVERY, 0));
        ret.put("badBuild", ours(getContext()).getString(KEY_BAD_BUILD, ""));
        ret.put("badReason", ours(getContext()).getString(KEY_BAD_REASON, ""));
        // The APK's OWN version, which is a different question from the bundle's
        // build id and had no answer at all. The web layer updates itself over
        // the air; the shell around it does not, so "is the binary current?"
        // needs the installed version to compare anything against. Read from the
        // package manager rather than from a constant compiled into the web
        // bundle, for the reason `shellLink.ts` gives about `PROTOCOL_VERSION`:
        // the bundle updates while the binary does not, so a constant shipped in
        // it would drift away from the APK it claims to describe.
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            ret.put("versionName", pi.versionName == null ? "" : pi.versionName);
            ret.put("versionCode", android.os.Build.VERSION.SDK_INT >= 28
                    ? pi.getLongVersionCode() : (long) pi.versionCode);
        } catch (android.content.pm.PackageManager.NameNotFoundException e) {
            // Cannot happen for our own package; if it somehow does, say nothing
            // rather than a zero that would read as "version 0, please update".
            com.getcapacitor.Logger.warn("shell-update", "own package not found: " + e);
        }
        call.resolve(ret);
    }

    /**
     * Start a fresh download. The bundle is assembled in a `.part` directory and
     * only renamed into place by {@link #finishBundle}, so an interrupted
     * download can never be mistaken for a complete one.
     */
    @PluginMethod
    public void beginBundle(PluginCall call) {
        String id = call.getString("id");
        if (badId(id)) { call.reject("bad bundle id"); return; }
        File part = new File(bundlesDir(getContext()), id + ".part");
        deleteRecursive(part);
        if (!part.mkdirs()) { call.reject("cannot create " + part); return; }
        call.resolve();
    }

    /** Write one file into the in-progress bundle. */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String id = call.getString("id");
        String path = call.getString("path");
        String data = call.getString("dataBase64");
        if (badId(id) || path == null || data == null) { call.reject("bad arguments"); return; }
        File root = new File(bundlesDir(getContext()), id + ".part");
        File target = new File(root, path);
        // Contained the same way every file path in this project is: the path
        // comes off the network, and `assets/../../x` resolves to a real file
        // outside the bundle unless it is checked after resolution.
        try {
            if (!target.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) {
                call.reject("path escapes the bundle");
                return;
            }
        } catch (IOException e) {
            call.reject("cannot resolve path", e);
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) { call.reject("cannot create " + parent); return; }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("bad base64", e);
            return;
        }
        try (FileOutputStream out = new FileOutputStream(target)) {
            out.write(bytes);
        } catch (IOException e) {
            call.reject("write failed", e);
            return;
        }
        call.resolve();
    }

    /** Rename the completed `.part` into its final directory. */
    @PluginMethod
    public void finishBundle(PluginCall call) {
        String id = call.getString("id");
        if (badId(id)) { call.reject("bad bundle id"); return; }
        File part = new File(bundlesDir(getContext()), id + ".part");
        File dest = new File(bundlesDir(getContext()), id);
        if (!new File(part, "index.html").isFile()) { call.reject("bundle has no index.html"); return; }
        deleteRecursive(dest);
        if (!part.renameTo(dest)) { call.reject("cannot finalise bundle"); return; }
        JSObject ret = new JSObject();
        ret.put("path", dest.getAbsolutePath());
        call.resolve(ret);
    }

    /**
     * Make a finished bundle the one served from the NEXT launch, without
     * reloading now.
     *
     * Deliberately not immediate: this is a remote control for live coding
     * sessions, and yanking the page out from under someone mid-turn to install
     * an update they did not ask for is worse than waiting. `applyNow` is the
     * explicit version.
     */
    @PluginMethod
    public void stage(PluginCall call) {
        String id = call.getString("id");
        if (badId(id)) { call.reject("bad bundle id"); return; }
        File dest = new File(bundlesDir(getContext()), id);
        if (!new File(dest, "index.html").isFile()) { call.reject("no such bundle"); return; }
        String refused = refuseBad(call, id);
        if (refused != null) { call.reject(refused, "BAD_BUILD"); return; }
        capacitor(getContext()).edit()
            .putString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, dest.getAbsolutePath())
            .apply();
        prune(id);
        call.resolve();
    }

    /** Switch to a finished bundle immediately (reloads the WebView). */
    @PluginMethod
    public void applyNow(PluginCall call) {
        String id = call.getString("id");
        if (badId(id)) { call.reject("bad bundle id"); return; }
        File dest = new File(bundlesDir(getContext()), id);
        if (!new File(dest, "index.html").isFile()) { call.reject("no such bundle"); return; }
        String refused = refuseBad(call, id);
        if (refused != null) { call.reject(refused, "BAD_BUILD"); return; }
        capacitor(getContext()).edit()
            .putString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, dest.getAbsolutePath())
            .apply();
        prune(id);
        call.resolve();
        bridge.setServerBasePath(dest.getAbsolutePath());
    }

    /**
     * Drop back to the bundle inside the APK. The user-facing escape hatch, and
     * the same thing the boot watchdog does automatically.
     */
    @PluginMethod
    public void revertToBuiltIn(PluginCall call) {
        capacitor(getContext()).edit().remove(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH).apply();
        ours(getContext()).edit().putInt(KEY_BOOT_FAILS, 0).apply();
        call.resolve();
        // "public" is Capacitor's default asset directory — the copy `cap sync`
        // put in the APK.
        bridge.setServerAssetPath("public");
    }

    // ── helpers ──────────────────────────────────────────────────────────
    /** Build ids are hex from the host; anything else has no business as a path. */
    private static boolean badId(String id) {
        return id == null || !id.matches("[a-f0-9]{8,64}");
    }

    /**
     * Keep only the bundle we just staged — and the one being served right now.
     * Deleting the running bundle's directory under the live page turned every
     * lazy chunk it had not loaded yet into a 404 until the next restart.
     */
    private void prune(String keepId) {
        File dir = bundlesDir(getContext());
        File[] kids = dir.listFiles();
        if (kids == null) return;
        String base = downloadedBase(bridge);
        String running = base == null ? "" : new File(base).getName();
        for (File k : kids) {
            if (!k.getName().equals(keepId) && !k.getName().equals(running)) deleteRecursive(k);
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        // Best effort: a file we cannot remove costs disk, never correctness —
        // every bundle directory is addressed by its own build id.
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
