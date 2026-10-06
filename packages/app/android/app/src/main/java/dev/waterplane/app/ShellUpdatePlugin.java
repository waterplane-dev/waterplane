package dev.waterplane.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

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
        int fails = prefs.getInt(KEY_BOOT_FAILS, 0);
        boolean recovered = false;
        if (fails >= MAX_BOOT_FAILS) {
            capacitor(ctx).edit().remove(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH).apply();
            prefs.edit().putInt(KEY_BOOT_FAILS, 0).putLong(KEY_LAST_RECOVERY, System.currentTimeMillis()).apply();
            recovered = true;
            fails = 0;
        }
        // Count this launch. `markHealthy` clears it once the UI is actually up,
        // so the counter only ever grows across launches that did not get there.
        prefs.edit().putInt(KEY_BOOT_FAILS, fails + 1).apply();
        return recovered;
    }

    // ── JS API ───────────────────────────────────────────────────────────
    /** The web app has rendered. Clears the boot-failure counter. */
    @PluginMethod
    public void markHealthy(PluginCall call) {
        ours(getContext()).edit().putInt(KEY_BOOT_FAILS, 0).apply();
        call.resolve();
    }

    /** Where we are running from, and whether a recovery has ever fired. */
    @PluginMethod
    public void info(PluginCall call) {
        String base = bridge.getServerBasePath();
        JSObject ret = new JSObject();
        ret.put("builtIn", base == null || base.isEmpty());
        ret.put("basePath", base == null ? "" : base);
        ret.put("staged", capacitor(getContext()).getString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, ""));
        ret.put("lastRecoveryAt", ours(getContext()).getLong(KEY_LAST_RECOVERY, 0));
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

    /** Keep only the bundle we just staged; older downloads are dead weight. */
    private void prune(String keepId) {
        File dir = bundlesDir(getContext());
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (!k.getName().equals(keepId)) deleteRecursive(k);
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
