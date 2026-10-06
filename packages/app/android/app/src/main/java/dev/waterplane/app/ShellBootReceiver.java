package dev.waterplane.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * The link comes back after a reboot, and after the APK is replaced.
 *
 * Without this the background link is a thing the user has to remember to
 * re-enable by opening the app — which is the same as not having it, because
 * the whole point is the phone telling you something while the app is closed.
 *
 * <b>Legal only because the service is {@code specialUse}.</b> Android 15 bans
 * starting a {@code dataSync} foreground service from {@code BOOT_COMPLETED};
 * {@code specialUse} is allowed, which is one of the two reasons
 * {@link ShellLinkService} is that type (the other being the ~6-hour daily cap).
 *
 * <b>Inert unless the user switched the link on.</b> {@code startIfEnabled}
 * reads the stored flag first, so a receiver that fires on a phone where nobody
 * ever touched the toggle does nothing and costs a few microseconds of boot.
 *
 * {@code MY_PACKAGE_REPLACED} is here for the sideload: installing a new APK
 * stops the running service and nothing else would bring it back until the app
 * was next opened by hand.
 */
public class ShellBootReceiver extends BroadcastReceiver {

    private static final String TAG = "shell-link";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            return;
        }
        Log.i(TAG, "boot receiver: " + action);
        // Re-arm the periodic health check too. WorkManager persists its own
        // schedule across reboots, so this is belt and braces — but the one
        // thing that must not happen is the service being down with nothing
        // ever asking about it again.
        ShellLinkWorker.schedule(context);
        ShellLinkService.startIfEnabled(context, action);
    }
}
