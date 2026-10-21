package dev.waterplane.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The web layer's switch for {@link ShellLinkService} — and the only thing that
 * can turn it on.
 *
 * <b>Everything the service needs to know comes through here, because none of it
 * is a fact about the APK.</b> The daemon's address lives in the WebView's
 * localStorage (`hostUrl.ts`), and `PROTOCOL_VERSION` ships in the
 * over-the-air bundle while this binary does not update — so a constant on the
 * Java side would drift, quietly, in the direction of "the background link stops
 * working after a protocol bump nobody thought about". They are parameters.
 *
 * Reached off the `Capacitor.Plugins` global rather than an npm import, the way
 * `webUpdate.ts` and `nativeSave.ts` already do it, so no native-shell
 * dependency enters the bundle every browser downloads.
 *
 * <b>Inert until called.</b> Nothing else starts the service: with the stored
 * flag unset the boot receiver returns immediately and no periodic work is
 * scheduled. A user who never touches the toggle sees no notification, no
 * service and no behaviour change.
 */
@CapacitorPlugin(
    name = "ShellLink",
    permissions = {
        @Permission(alias = ShellLinkPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class ShellLinkPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";
    private static final String TAG = "shell-link";

    /** Is this build capable of the background link at all? False in every
     *  browser, where the plugin does not exist and the caller sees no object. */
    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("notifications", getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED);
        ret.put("batteryExempt", isBatteryExempt());
        ret.put("powerSave", isPowerSave());
        call.resolve(ret);
    }

    /** Everything a settings row needs to describe the link in one read. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = ShellLinkService.describe(getContext());
        ret.put("notifications", getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED);
        ret.put("batteryExempt", isBatteryExempt());
        call.resolve(ret);
    }

    /**
     * Switch the background link on, and point it at a host.
     *
     * @param url      the daemon's WebSocket URL — `wsUrl()` in `hostUrl.ts`,
     *                 i.e. exactly what the page's own socket uses.
     * @param protocol `PROTOCOL_VERSION` from `@waterplane/shared`.
     * @param label    what to call the host on the status line; the address.
     */
    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("ws://") || url.startsWith("wss://"))) {
            call.reject("a ws:// or wss:// url is required");
            return;
        }
        int protocol = call.getInt("protocol", 1);
        String label = call.getString("label");
        if (label == null || label.isEmpty()) label = hostOf(url);
        ShellLinkService.enable(getContext(), url, protocol, label);
        call.resolve(ShellLinkService.describe(getContext()));
    }

    /** Switch it off: the service stops, its notification goes, the periodic
     *  backstop is cancelled and the boot receiver will not start it again. */
    @PluginMethod
    public void stop(PluginCall call) {
        ShellLinkService.disable(getContext());
        call.resolve();
    }

    /**
     * How many sends the page is holding that it has not delivered.
     *
     * The service cannot see the send queue — it is in localStorage and its
     * upload bytes are in IndexedDB — so this is the one number it is told. It
     * matters only in the case the page cannot cover itself: the app swiped
     * away with prompts queued, where the service comes back, sees a non-zero
     * count and says "N prompts waiting — open to send". Persisted, because the
     * process death that lost the page is exactly what it has to survive.
     */
    @PluginMethod
    public void setQueueDepth(PluginCall call) {
        ShellLinkService.setQueueDepth(getContext(), call.getInt("depth", 0));
        call.resolve();
    }

    /**
     * Ask for POST_NOTIFICATIONS.
     *
     * A refusal is not fatal and must not be treated as one: the service still
     * runs, the process still stays out of the freezer and the queue still
     * drains — there is simply nowhere for the alerts to appear. The caller is
     * expected to say that rather than to refuse to enable the link.
     */
    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            answerNotifications(call);
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "notificationsResult");
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        answerNotifications(call);
    }

    private void answerNotifications(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED);
        call.resolve(ret);
    }

    /**
     * Send the user to the battery-optimisation exemption.
     *
     * This is not only about battery. An app the system is allowed to doze
     * <em>cannot start a foreground service from the background</em>, which is
     * what {@link ShellBootReceiver} and {@link ShellLinkWorker} do — so the
     * exemption is also what makes the recovery paths work after an OEM killer
     * takes the service down. Offered, never demanded: the link runs without it
     * and degrades to "a notification in the next Doze maintenance window".
     *
     * Deliberately a Settings intent rather than the direct-grant dialog: the
     * direct one needs `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` to be requested
     * as a permission and is the shape Play Store policy objects to. This one
     * shows the user the switch and lets them decide.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Intent i = ShellLinkService.batterySettingsIntent(getContext());
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (RuntimeException e) {
            Log.w(TAG, "no battery settings screen: " + e);
            // Every phone has the app-details page even when it lacks the
            // direct one; landing there beats a button that does nothing.
            try {
                Intent fallback = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            } catch (RuntimeException e2) {
                call.reject("cannot open battery settings: " + e2.getMessage());
                return;
            }
        }
        call.resolve();
    }

    /**
     * The app's own notification settings. Android stops showing the
     * permission dialog after it has been refused twice, so from then on this
     * page is the only place the switch can be turned on.
     */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent i;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName()));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("cannot open notification settings: " + e.getMessage());
        }
    }

    /** The phone's own battery saver — the page offers to stop the strip's
     *  tab-order sync while it is on (`tabsSyncSaver.ts`). */
    private boolean isPowerSave() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isPowerSaveMode();
    }

    private boolean isBatteryExempt() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    /** "100.64.0.5:8770" out of "ws://100.64.0.5:8770/ws" — what the
     *  status line says it is connected to. */
    private static String hostOf(String url) {
        try {
            Uri u = Uri.parse(url);
            String host = u.getHost();
            if (host == null) return url;
            int port = u.getPort();
            return port > 0 ? host + ":" + port : host;
        } catch (RuntimeException e) {
            return url;
        }
    }
}
