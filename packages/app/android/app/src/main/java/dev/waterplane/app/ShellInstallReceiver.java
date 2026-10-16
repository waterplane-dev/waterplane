package dev.waterplane.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * **Where every install ends up** — the {@link PackageInstaller}'s own answer,
 * and the only place it is ever reported.
 *
 * Three outcomes and they are three different claims:
 *
 * <ul>
 *   <li><b>Installed.</b> Written onto the pull row, which is what the phone's
 *       download list reads; a notification only when nobody is looking at the
 *       app, the same rule {@link ShellPullService}'s "saved to Downloads" uses.</li>
 *   <li><b>The platform wants a confirmation.</b> It hands back the intent that
 *       shows the system installer, and this is the FIRST install of any package
 *       — plus every one where the silent path was refused. With the app open
 *       that intent is started straight away. <b>With the app in the background
 *       it cannot be</b>: Android forbids a background activity start, and a
 *       dialog that appears over whatever the person is doing would be worse if
 *       it could. So it becomes a notification carrying the same intent, and the
 *       row says the install is waiting for a tap — never that it failed.</li>
 *   <li><b>Failed.</b> The platform's own reason, in full, onto the row. A
 *       signature mismatch (a build from another desktop's debug key) and a
 *       version downgrade are the two that happen here in practice, and both are
 *       only actionable if the words survive.</li>
 * </ul>
 *
 * It is {@code exported="false"}: the only sender is this app's own
 * {@link PendingIntent}, filled in by the platform.
 */
public class ShellInstallReceiver extends BroadcastReceiver {

    private static final String TAG = "shell-install";
    private static final String CHANNEL = "install";

    /** "Later" on the ready-to-install notification. */
    static final String ACTION_SNOOZE = "dev.waterplane.app.install.SNOOZE";
    /** The snooze ran out: post the notification again, if it still applies. */
    static final String ACTION_REMIND = "dev.waterplane.app.install.REMIND";
    static final String EXTRA_ID = "id";
    /** How long "Later" is. One step, no picker: a notification action is a
     *  button, and the app's own list is where a build waits for longer. */
    static final long SNOOZE_MS = 60L * 60 * 1000;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        if (ACTION_SNOOZE.equals(intent.getAction())) { snooze(ctx, intent.getStringExtra(EXTRA_ID)); return; }
        if (ACTION_REMIND.equals(intent.getAction())) { remind(ctx, intent.getStringExtra(EXTRA_ID)); return; }
        if (!Installs.ACTION_STATUS.equals(intent.getAction())) return;
        String id = intent.getStringExtra(Installs.EXTRA_PULL_ID);
        if (id == null) id = "";
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        String name = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME);
        // WHICH attempt this is about. A person can start a second install while
        // the first is still waiting at the system installer, and a status for
        // the one they walked away from must not be written over the one they
        // are watching — it would stamp an outcome beside the other attempt's
        // record of who asked for it. Absent (0) is accepted: losing an outcome
        // over a missing extra is worse than the race it would guard.
        int session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, 0);

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            askUser(ctx, id, name, session, intent);
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            // The platform names the package it installed, and that is the only
            // way a row whose archive could not be read gets into the desktop's
            // log at all — the log is keyed on which app.
            ShellPullService.noteInstall(ctx, id, "installed", "", session, name);
            cancelReady(ctx, name, id);
            announce(ctx, id, name != null ? name : "The app", "installed", null);
            // The opt-in clean-up: the APK is not needed once it is on. File and
            // MediaStore work, so off the main thread.
            if (ShellPullService.cleanEnabled(ctx)) {
                final String rowId = id;
                final PendingResult pending = goAsync();
                new Thread(() -> {
                    try {
                        ShellPullService.cleanAfterInstall(ctx, rowId);
                    } catch (RuntimeException e) {
                        Log.w(TAG, "clean-up after install: " + e);
                    } finally {
                        pending.finish();
                    }
                }, "shell-install-clean").start();
            }
            return;
        }
        String why = Installs.failureText(status, message);
        if (intent.getBooleanExtra(Installs.EXTRA_SILENT, false) && refusedSilence(status, message)) {
            // Nobody was asked, so this is a refusal of the SILENCE, not of the
            // app: the verifier would not pass what it could not show. Ask. The
            // retry streams the whole file, hence off the main thread.
            final String rowId = id;
            final PendingResult pending = goAsync();
            new Thread(() -> {
                try {
                    if (!ShellPullService.installLoudAfterRefusal(ctx, rowId, session)) {
                        Log.w(TAG, "install failed: " + why);
                        ShellPullService.noteInstall(ctx, rowId, "failed", why, session, name);
                        announce(ctx, rowId, name != null ? name : "Install failed", why, null);
                    }
                } finally {
                    pending.finish();
                }
            }, "shell-install-retry").start();
            return;
        }
        Log.w(TAG, "install failed: " + why);
        ShellPullService.noteInstall(ctx, id, "failed", why, session, name);
        announce(ctx, id, name != null ? name : "Install failed", why, null);
    }

    /** Did the platform refuse to do this QUIETLY, rather than refuse the app?
     *  Play Protect's verifier reports it as an aborted (or blocked) install
     *  with {@code INSTALL_FAILED_VERIFICATION_FAILURE}; a signature conflict or
     *  a downgrade is a real answer, and asking again would only repeat it. */
    static boolean refusedSilence(int status, @Nullable String message) {
        if (message != null && message.contains("VERIFICATION_FAILURE")) return true;
        return status == PackageInstaller.STATUS_FAILURE_BLOCKED
                || status == PackageInstaller.STATUS_FAILURE_ABORTED;
    }

    /**
     * The system installer has to be shown. Straight away if the app is in
     * front; otherwise as a notification, because a background activity start
     * is refused by the platform and the row must not sit at "installing" for
     * ever waiting for one.
     */
    private void askUser(Context ctx, String id, @Nullable String pkg, int session, Intent status) {
        Intent confirm = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            confirm = status.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
        } else {
            confirm = status.getParcelableExtra(Intent.EXTRA_INTENT);
        }
        if (confirm == null) {
            ShellPullService.noteInstall(ctx, id, "failed",
                    "the phone asked for a confirmation but did not say where", session, pkg);
            return;
        }
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (ShellLinkService.isAppForeground()) {
            try {
                ctx.startActivity(confirm);
                ShellPullService.noteInstall(ctx, id, "asked", "", session, pkg);
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "cannot show the installer: " + e);
            }
        }
        ShellPullService.noteInstall(ctx, id, "asked", "", session, pkg);
        postReady(ctx, id, confirm);
    }

    // ── ready to install: one notification per app, with "Later" ─────────

    /**
     * "Tiptoi 1.4 is ready to install", with Install and Later.
     *
     * Posted for every finished APK that did not install itself — not on the
     * list, a first install, a refused silence — because a one-tap install that
     * nobody hears about is a build that waits until somebody opens the
     * Downloads screen. The auto-pull rule that brought the file down is the
     * "I want this"; the notification is the tap it still needs.
     *
     * <b>Tagged by PACKAGE</b>, so the next build of the same app replaces this
     * one rather than stacking beside it, and an install of it clears it.
     *
     * {@code confirm} is the system installer's own intent where a session is
     * already waiting for it (one tap to the dialog). Without one, Install opens
     * the app with the row's id and the install starts from the foreground —
     * a notification cannot start an activity through a receiver (Android 12's
     * trampoline rule), and a background install would only come back here
     * asking for the tap it was given.
     */
    static void postReady(Context ctx, String id, @Nullable Intent confirm) {
        ShellPullService.Ready r = ShellPullService.ready(ctx, id);
        if (r == null) return;
        NotificationManager nm = channel(ctx);
        if (nm == null) return;
        String tag = readyTag(r.pkg, id);
        int code = tag.hashCode();
        PendingIntent install = confirm != null
                ? PendingIntent.getActivity(ctx, code, confirm,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
                : PendingIntent.getActivity(ctx, code,
                        new Intent(ctx, MainActivity.class)
                                .setAction(MainActivity.ACTION_INSTALL)
                                .putExtra(MainActivity.EXTRA_INSTALL_ID, id)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent later = PendingIntent.getBroadcast(ctx, code,
                new Intent(ctx, ShellInstallReceiver.class).setAction(ACTION_SNOOZE).putExtra(EXTRA_ID, id),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = r.label + (r.version.isEmpty() ? "" : " " + r.version) + " is ready to install";
        String text = "Tap to install. Later reminds you in an hour; the app's Apps list keeps it either way.";
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_app)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(install)
                .addAction(0, "Install", install)
                .addAction(0, "Later", later)
                .build();
        try {
            nm.notify(tag, code, n);
        } catch (SecurityException e) {
            Log.d(TAG, "not shown: " + e);
        }
    }

    static String readyTag(@Nullable String pkg, String id) {
        return "ready|" + (pkg != null && !pkg.isEmpty() ? pkg : id);
    }

    static void cancelReady(Context ctx, @Nullable String pkg, String id) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        String tag = readyTag(pkg, id);
        nm.cancel(tag, tag.hashCode());
    }

    private static void snooze(Context ctx, @Nullable String id) {
        if (id == null) return;
        ShellPullService.Ready r = ShellPullService.ready(ctx, id);
        cancelReady(ctx, r != null ? r.pkg : null, id);
        if (r == null) return;
        long until = System.currentTimeMillis() + SNOOZE_MS;
        ShellPullService.snooze(ctx, id, until);
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent remind = PendingIntent.getBroadcast(ctx, readyTag(r.pkg, id).hashCode(),
                new Intent(ctx, ShellInstallReceiver.class).setAction(ACTION_REMIND).putExtra(EXTRA_ID, id),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // Inexact on purpose: no exact-alarm permission, and "in about an hour"
        // is what Later means. Lost on a reboot — the app's list is the record.
        am.set(AlarmManager.RTC_WAKEUP, until, remind);
    }

    /** The snooze ran out. Only if the build is still the one worth installing
     *  and nobody has since installed it or snoozed it again for longer. */
    private static void remind(Context ctx, @Nullable String id) {
        if (id == null) return;
        ShellPullService.Ready r = ShellPullService.ready(ctx, id);
        if (r == null || r.snoozeUntil == 0) return;
        if (r.snoozeUntil > System.currentTimeMillis() + 60_000) return;
        ShellPullService.snooze(ctx, id, 0);
        postReady(ctx, id, null);
    }

    @Nullable
    private static NotificationManager channel(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "App installs",
                    NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("A build downloaded from your desktop is ready to install");
            nm.createNotificationChannel(ch);
        }
        return nm;
    }

    /** One line in the shade. The confirm intent rides on it where there is one
     *  — that notification IS the install, not a note about it. */
    private void announce(Context ctx, String id, String title, String text, @Nullable Intent confirm) {
        if (confirm == null && ShellLinkService.isAppForeground()) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "App installs",
                    NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("A build downloaded from your desktop is ready to install");
            nm.createNotificationChannel(ch);
        }
        int code = (id + title).hashCode();
        PendingIntent tap = confirm != null
                ? PendingIntent.getActivity(ctx, code, confirm,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
                : PendingIntent.getActivity(ctx, code,
                        new Intent(ctx, MainActivity.class)
                                .setAction(Intent.ACTION_MAIN)
                                .addCategory(Intent.CATEGORY_LAUNCHER)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_app)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(tap)
                .build();
        try {
            nm.notify("install|" + id, code, n);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS refused. The row still says what happened; there
            // is simply nowhere else to say it.
            Log.d(TAG, "not shown: " + e);
        }
    }
}
