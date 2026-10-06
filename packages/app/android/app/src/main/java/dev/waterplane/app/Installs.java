package dev.waterplane.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * **Putting a downloaded APK on this phone** — the one implementation, the way
 * {@link Downloads} is the one implementation of "where a saved file goes".
 *
 * The transport already ends with the bytes of a fresh build sitting in the
 * app's own directory ({@link ShellPullService#binOf}) minutes after an agent on
 * the desktop finished writing the code. Everything after that was a person
 * finding the file in Downloads and tapping through a file manager. This is
 * that last step.
 *
 * <b>What Android will and will not allow, because the whole design follows
 * from it:</b>
 *
 * <ul>
 *   <li><b>"Install unknown apps" is a special access</b>
 *       ({@code REQUEST_INSTALL_PACKAGES} plus a per-app switch in Settings).
 *       Without it nothing here can run at all, and it can only be turned on by
 *       the person, on the phone — so {@link #canInstall} is asked before any
 *       verb is drawn and {@link #settingsIntent} is how the row offers the fix.</li>
 *   <li><b>The FIRST install of a package always shows the system dialog.</b>
 *       There is no flag, no permission and no trick that removes it, and this
 *       class does not pretend otherwise.</li>
 *   <li><b>An UPDATE can be silent</b> from API 31 up:
 *       {@code setRequireUserAction(USER_ACTION_NOT_REQUIRED)} with
 *       {@code UPDATE_PACKAGES_WITHOUT_USER_ACTION} declared, the target already
 *       installed, and — from API 34 — this app holding update ownership, which
 *       {@code setRequestUpdateOwnership} asks for on the install that does show
 *       a dialog. So the shape is <i>one dialog per app, ever</i>: the first
 *       time, and then never again.</li>
 *   <li><b>A refused silent install is not an error.</b> The platform answers
 *       {@code STATUS_PENDING_USER_ACTION} instead, and the confirmation intent
 *       it hands back is the same one the loud path uses. Every reason for a
 *       refusal — a changed signing key, an ownership the user took back, a
 *       policy this code has not heard of — arrives through that one door, so
 *       asking for silence can never cost an install.</li>
 * </ul>
 *
 * <b>The allow-list is checked here and decided on the phone's screen</b>
 * (`web/installPolicy.ts`, synced as `installAllow`). It is mirrored into
 * this app's preferences because the decision has to be readable with the
 * document frozen — the install happens at the end of a download that runs in a
 * service precisely so it does not need the page to be awake. A package that is
 * not on it is never installed by itself; its row grows a button instead.
 */
final class Installs {

    private static final String TAG = "shell-install";

    private static final String PREFS = "shell.install";
    private static final String KEY_ALLOW = "allow";

    /** Broadcast action the {@link PackageInstaller} answers on. */
    static final String ACTION_STATUS = "dev.waterplane.app.install.STATUS";
    /** Which pull row this session belongs to, so the answer can be written
     *  onto it rather than into a log nobody reads. */
    static final String EXTRA_PULL_ID = "pullId";
    /** Whether the attempt a status is about asked for silence — the receiver's
     *  only way to tell a refused silence from a refused install. */
    static final String EXTRA_SILENT = "silent";

    private Installs() {}

    // ── what the phone is willing to do ──────────────────────────────────

    /** Is this file an APK at all? Name AND declared type, because the host's
     *  mime table and a phone's own guess have disagreed before, and either one
     *  saying so is enough to try reading it. */
    static boolean isApk(@Nullable String name, @Nullable String mime) {
        String n = name == null ? "" : name.toLowerCase(java.util.Locale.ROOT);
        String m = mime == null ? "" : mime.toLowerCase(java.util.Locale.ROOT);
        return n.endsWith(".apk") || m.equals("application/vnd.android.package-archive");
    }

    /** Has the person granted this app "install unknown apps"? False is the
     *  normal state until they do, and it is the one thing no code here can
     *  change. */
    static boolean canInstall(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        try {
            return ctx.getPackageManager().canRequestPackageInstalls();
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot read the install permission: " + e);
            return false;
        }
    }

    /** The Settings screen carrying that switch, aimed at this app. */
    static Intent settingsIntent(Context ctx) {
        Intent i = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        android.net.Uri.parse("package:" + ctx.getPackageName()))
                : new Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS);
        return i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** Can an update of an already-installed package skip the dialog on this
     *  Android, in this build? False in the `play` flavor whatever the Android:
     *  Play's policy is a confirm dialog for every install, and that build does
     *  not even declare UPDATE_PACKAGES_WITHOUT_USER_ACTION. */
    static boolean silentPossible() {
        return BuildConfig.QUIET_INSTALLS && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
    }

    // ── which distribution this is ──────────────────────────────────────

    /** "dev" (the owner's sideloaded build) or "play" (from Google Play) —
     *  what the page is told through `ShellInstall.status()`, so the shared web
     *  bundle can word the difference without being built per flavor. */
    static String distribution() {
        return BuildConfig.DISTRIBUTION;
    }

    /** What the `play` build says when asked to install itself. One string,
     *  because the row and the log must read the same refusal. */
    static final String SELF_UPDATE_REFUSED =
            "this build updates through Google Play — install the new version from the Play Store";

    /** What it says about an archive it cannot name: the self-update check
     *  needs the package, and an unreadable file is never assumed not to be us. */
    static final String UNREADABLE_REFUSED =
            "could not read which app this file is, and this build installs only an app it can name";

    /**
     * Why this build must not install this archive, or null where it may.
     *
     * The `play` flavor never installs or updates its OWN package — Play's
     * policy bans an app from Play updating itself from anywhere else — and,
     * since that check needs the package name, never installs an archive it
     * could not read. The `dev` flavor refuses nothing here.
     */
    @Nullable
    static String refusal(Context ctx, @Nullable Info info) {
        if (BuildConfig.SELF_UPDATE) return null;
        if (info == null) return UNREADABLE_REFUSED;
        if (info.pkg.equals(ctx.getPackageName())) return SELF_UPDATE_REFUSED;
        return null;
    }

    /**
     * Who installed this package, and who may update it quietly — the half of
     * "one dialog per app, ever" that the phone decides and this app cannot.
     *
     * Update ownership is granted on a package's FIRST install only; asking for
     * it on an update is a no-op. So an app first put on by a file manager,
     * a browser or Android Studio stays that installer's: every build waterplane
     * installs afterwards asks, however often it asks for silence. This reads
     * the record so the page can SAY so instead of promising a quiet update.
     *
     * Null where there is nothing to read: not installed, not visible, or an
     * Android too old to have the record (API 30). Inside, a null field is
     * "the platform named nobody", never a guess.
     */
    @Nullable
    static String[] source(Context ctx, String pkg) {
        if (pkg == null || pkg.isEmpty() || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null;
        try {
            android.content.pm.InstallSourceInfo s = ctx.getPackageManager().getInstallSourceInfo(pkg);
            String owner = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                    ? s.getUpdateOwnerPackageName() : null;
            return new String[] { s.getInstallingPackageName(), owner };
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ── what an APK says about itself ────────────────────────────────────

    /** What an APK file claims to be, read from the file and never from its
     *  name: three repos here all build `app-debug.apk`. */
    static final class Info {
        final String pkg;
        final String label;
        final String version;
        final long code;
        Info(String pkg, String label, String version, long code) {
            this.pkg = pkg; this.label = label; this.version = version; this.code = code;
        }
    }

    @Nullable
    static Info read(Context ctx, File apk) {
        if (!apk.isFile()) return null;
        PackageManager pm = ctx.getPackageManager();
        try {
            PackageInfo info = pm.getPackageArchiveInfo(apk.getAbsolutePath(), 0);
            if (info == null || info.packageName == null) return null;
            String label = info.packageName;
            ApplicationInfo app = info.applicationInfo;
            if (app != null) {
                // Without these the label read comes back as the package name:
                // the archive's own ApplicationInfo has no idea where it lives.
                app.sourceDir = apk.getAbsolutePath();
                app.publicSourceDir = apk.getAbsolutePath();
                try {
                    CharSequence l = pm.getApplicationLabel(app);
                    if (l != null && l.length() > 0) label = l.toString();
                } catch (RuntimeException ignored) { /* the package name is a fine label */ }
            }
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
            return new Info(info.packageName, label,
                    info.versionName == null ? "" : info.versionName, code);
        } catch (RuntimeException e) {
            // A truncated or corrupt archive. The row keeps the file and says
            // nothing about a package, which is the honest answer.
            Log.w(TAG, "unreadable apk: " + e);
            return null;
        }
    }

    /** Is this package already on the phone? That is what decides whether the
     *  dialog can be skipped — and it is the only question asked of it. */
    static boolean isInstalled(Context ctx, String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            ctx.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * The {@code versionCode} of the package as INSTALLED, or -1 where there is
     * none to read.
     *
     * The one question that can settle an install nobody heard the end of. The
     * headline case is waterplane updating ITSELF: the platform kills this process to
     * replace it, which takes the status callback with it, so the row would sit
     * at {@code installing} for ever and the fleet would never learn which
     * version of waterplane a phone is running. Comparing what the archive said
     * against what is installed answers it afterwards, from facts.
     *
     * **-1 means nobody could read it**, never 0 — a package with no version is
     * a different claim from a package that is not there.
     */
    static long installedCode(Context ctx, String pkg) {
        if (pkg == null || pkg.isEmpty()) return -1;
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(pkg, 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : (long) info.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return -1;
        } catch (RuntimeException e) {
            return -1;
        }
    }

    // ── the allow-list ───────────────────────────────────────────────────

    static Set<String> allowed(Context ctx) {
        Set<String> out = new LinkedHashSet<>();
        String raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ALLOW, "[]");
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i, "");
                if (!s.isEmpty()) out.add(s);
            }
        } catch (JSONException e) {
            // An unreadable list is an EMPTY list: this one decides whether code
            // installs itself, so a parse failure must fall to asking.
            Log.w(TAG, "unreadable allow-list, allowing nothing: " + e);
        }
        return out;
    }

    /** Replace the list. The page owns it; this is a mirror kept where a frozen
     *  document cannot be asked. */
    static void setAllowed(Context ctx, List<String> pkgs) {
        JSONArray arr = new JSONArray();
        for (String p : pkgs == null ? new ArrayList<String>() : pkgs) {
            if (p != null && !p.isEmpty()) arr.put(p);
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_ALLOW, arr.toString()).commit();
    }

    /**
     * May this file install itself, with nobody watching?
     *
     * Three conditions, all of them the person's own decisions: they granted
     * the special access, they put this package on the list, and the package is
     * already installed — a first install shows a dialog whatever anybody wants,
     * so starting one unattended would leave a notification asking for a tap
     * that nobody asked for.
     */
    static boolean mayAutoInstall(Context ctx, @Nullable Info info) {
        if (info == null) return false;
        // The `play` build starts no install by itself: every one would be a
        // confirm dialog nobody asked for, and its own package never installs.
        if (!BuildConfig.QUIET_INSTALLS) return false;
        if (refusal(ctx, info) != null) return false;
        if (!canInstall(ctx)) return false;
        if (!allowed(ctx).contains(info.pkg)) return false;
        return isInstalled(ctx, info.pkg);
    }

    // ── the install itself ───────────────────────────────────────────────

    /**
     * Stream an APK into a {@link PackageInstaller} session and commit it.
     *
     * Throws on everything that fails before the commit (an unreadable file, a
     * session the platform would not open); after the commit every outcome —
     * success, failure, and "the user has to confirm this" — arrives at
     * {@link ShellInstallReceiver} instead, because that is the only place the
     * platform reports them.
     *
     * {@code silent} is a REQUEST and never a promise: refused, it comes back as
     * a pending user action, which is the same door the loud path uses.
     */
    static int install(Context ctx, String pullId, File apk, @Nullable Info info, boolean silent)
            throws IOException {
        if (!apk.isFile()) throw new IOException("the file is not on this phone any more");
        // The one door every install goes through (a tap, the automatic path,
        // the loud retry), so the `play` build's refusals live HERE and nowhere
        // a new caller could walk around them.
        String refused = refusal(ctx, info);
        if (refused != null) throw new IOException(refused);
        if (!BuildConfig.QUIET_INSTALLS) silent = false;
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (info != null) params.setAppPackageName(info.pkg);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(silent
                    ? PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED
                    : PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        }
        // Never in the `play` build: update ownership exists to make later
        // installs quiet, and that build installs nothing quietly.
        if (BuildConfig.QUIET_INSTALLS && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Asked on EVERY install, including the loud first one: this is what
            // buys the silence later. Android 14 hands updates of a package to
            // whoever installed it, and a request the user approves in that one
            // dialog is what makes every later build of the same app quiet.
            params.setRequestUpdateOwnership(true);
        }
        int sessionId = pi.createSession(params);
        PackageInstaller.Session session = pi.openSession(sessionId);
        try {
            try (InputStream in = new FileInputStream(apk);
                 OutputStream out = session.openWrite("waterplane", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                session.fsync(out);
            }
            session.commit(statusSender(ctx, pullId, sessionId, silent));
            return sessionId;
        } catch (IOException | RuntimeException e) {
            try { session.abandon(); } catch (RuntimeException ignored) { /* already gone */ }
            throw e instanceof IOException ? (IOException) e : new IOException(e.getMessage(), e);
        } finally {
            session.close();
        }
    }

    private static android.content.IntentSender statusSender(Context ctx, String pullId, int sessionId,
                                                             boolean silent) {
        Intent i = new Intent(ctx, ShellInstallReceiver.class)
                .setAction(ACTION_STATUS)
                .putExtra(EXTRA_PULL_ID, pullId)
                .putExtra(EXTRA_SILENT, silent);
        // MUTABLE because the platform fills this intent in with the status, the
        // message and — the one that matters — the confirmation intent. An
        // immutable one arrives empty and every install reads as "failed for no
        // stated reason".
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getBroadcast(ctx, sessionId, i, flags).getIntentSender();
    }

    /** The platform's own status code as a sentence a row can carry. Its
     *  {@code EXTRA_STATUS_MESSAGE} is included where there is one — it names
     *  the signature mismatch and the downgrade, which are the two failures a
     *  person can actually do something about. */
    static String failureText(int status, @Nullable String message) {
        String base;
        switch (status) {
            case PackageInstaller.STATUS_FAILURE_ABORTED: base = "the install was cancelled"; break;
            case PackageInstaller.STATUS_FAILURE_BLOCKED: base = "the phone blocked the install"; break;
            case PackageInstaller.STATUS_FAILURE_CONFLICT: base = "it conflicts with the app already installed"; break;
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE: base = "this build is not compatible with this phone"; break;
            case PackageInstaller.STATUS_FAILURE_INVALID: base = "the file is not a valid app"; break;
            case PackageInstaller.STATUS_FAILURE_STORAGE: base = "there is not enough room"; break;
            default: base = "the install failed"; break;
        }
        return message == null || message.isEmpty() ? base : base + " — " + message;
    }
}
