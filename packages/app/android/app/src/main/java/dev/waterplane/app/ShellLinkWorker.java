package dev.waterplane.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/**
 * "Is the link still up?" — asked every fifteen minutes by something the app
 * does not control.
 *
 * A foreground service is not immortal. An OEM task killer, a low-memory kill
 * that outruns {@code START_STICKY}, a user's "force stop" — all of them leave
 * the service down with nothing inside the app alive to notice, which is the
 * one failure mode this whole design exists to avoid ("never silently never").
 * WorkManager survives process death and reboots and is the only scheduler here
 * that does.
 *
 * <b>Deliberately not the transport.</b> WorkManager's floor is fifteen minutes,
 * which is fine for "make sure the connection exists" and useless for "a
 * question is waiting" — so this re-founds the service and asks it nothing else.
 * The socket stays where it can be permanent.
 *
 * <b>Scheduled only while the link is enabled</b>, and cancelled when it is
 * switched off, so the opt-out is complete rather than merely quiet.
 */
public class ShellLinkWorker extends Worker {

    private static final String TAG = "shell-link";
    private static final String WORK = "shell.link.health";

    public ShellLinkWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context ctx) {
        if (!ShellLinkService.isEnabled(ctx)) return;
        try {
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                    ShellLinkWorker.class, 15, TimeUnit.MINUTES).build();
            // KEEP, not UPDATE: re-scheduling on every service start would reset
            // the period each time and a health check that never comes due is
            // not a health check.
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                    WORK, ExistingPeriodicWorkPolicy.KEEP, req);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot schedule health check: " + e);
        }
    }

    static void cancel(Context ctx) {
        try {
            WorkManager.getInstance(ctx).cancelUniqueWork(WORK);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot cancel health check: " + e);
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        if (!ShellLinkService.isEnabled(ctx)) return Result.success();
        if (ShellLinkService.isRunning()) {
            // Up. Still nudge it: a socket can be a zombie inside a service that
            // is perfectly alive, and the nudge costs one Intent.
            ShellLinkService.startIfEnabled(ctx, "health-nudge");
            return Result.success();
        }
        Log.w(TAG, "link service was down — restarting it");
        ShellLinkService.startIfEnabled(ctx, "health-restart");
        return Result.success();
    }
}
