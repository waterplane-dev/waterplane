package dev.waterplane.app;

import android.Manifest;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.TransportInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Which network the phone is on — the one input the LAN auto-route cannot get
 * from inside a WebView.
 *
 * The page decides whether to talk to a host over its LAN address or over the
 * tailnet (`shared/lanroute.ts`), and one of its gates is "the Wi-Fi this phone
 * is on is one the person saved for that host". A browser has no API for the
 * Wi-Fi name at all, so the shell reads it and hands it over:
 *
 * <pre>
 *   Capacitor.Plugins.ShellNet.current()
 *     → { transport: 'wifi'|'cellular'|'other'|'none',
 *         ssid: string|null,
 *         permission: 'granted'|'denied'|'prompt' }
 *   Capacitor.Plugins.ShellNet.requestLocation() → the same shape, after asking
 *   window.shellNetChanged(<that same object>)   // pushed on change
 * </pre>
 *
 * <b>Why location.</b> Android treats a Wi-Fi name as a location fact (a list
 * of SSIDs places a phone as well as GPS does), so reading it needs
 * ACCESS_FINE_LOCATION (requested together with ACCESS_COARSE_LOCATION: from
 * Android 12 a fine-only request is dropped without a dialog) and the system
 * location switch on. Without them the
 * platform answers {@code "<unknown ssid>"}, which is reported as {@code null}
 * — never guessed. The name is used only to compare with the names saved for
 * each host, on the phone; nothing here sends it anywhere.
 *
 * <b>How the name is read.</b> From API 31 the name is only present in the
 * {@link WifiInfo} carried by {@link NetworkCapabilities#getTransportInfo()} of
 * a callback registered with {@code FLAG_INCLUDE_LOCATION_INFO} —
 * {@code getNetworkCapabilities(network)} hands back a redacted copy. So this
 * plugin keeps its own default-network callback and caches the last
 * capabilities it delivered. Below 31 the deprecated
 * {@link WifiManager#getConnectionInfo()} is still the way.
 *
 * <b>Its own callback, on purpose.</b> {@link ShellLinkService} has one too, but
 * only while the background link is switched on; this one lives exactly as
 * long as the bridge (the activity), which is as long as there is a page to
 * tell. Changes are debounced by {@value #DEBOUNCE_MS} ms — a Wi-Fi hand-over
 * is a burst of lost/available/capabilities — and pushed only when the
 * resulting state differs from the last one pushed.
 *
 * Optional at the far end like every other push from this shell: the call is
 * guarded, so a bundle that has never heard of {@code shellNetChanged} is
 * no worse off.
 */
@CapacitorPlugin(
    name = "ShellNet",
    permissions = {
        @Permission(alias = ShellNetPlugin.LOCATION, strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION })
    }
)
public class ShellNetPlugin extends Plugin {

    static final String LOCATION = "location";
    private static final String TAG = "shell-net";
    private static final long DEBOUNCE_MS = 500;
    private static final String UNKNOWN_SSID = "<unknown ssid>";

    private final Handler handler = new Handler(Looper.getMainLooper());
    @Nullable private ConnectivityManager.NetworkCallback callback;
    /** Last capabilities the callback delivered; null when there is no default network. */
    @Nullable private volatile NetworkCapabilities caps;
    /** JSON of the last state pushed to the page, to push only on change. */
    @Nullable private String lastPushed;
    private final Runnable push = this::pushIfChanged;

    @Override
    public void load() {
        super.load();
        register();
    }

    @Override
    protected void handleOnDestroy() {
        handler.removeCallbacks(push);
        unregister();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void current(PluginCall call) {
        call.resolve(state());
    }

    /**
     * Ask for ACCESS_FINE_LOCATION, resolving with the state after the answer.
     * Never rejects: a refusal is a state ({@code permission: 'denied'}) the
     * page words, not an error.
     */
    @PluginMethod
    public void requestLocation(PluginCall call) {
        if (getPermissionState(LOCATION) == PermissionState.GRANTED) {
            call.resolve(state());
            return;
        }
        requestPermissionForAlias(LOCATION, call, "locationResult");
    }

    @PermissionCallback
    private void locationResult(PluginCall call) {
        // Capabilities delivered before the grant were redacted, and nothing
        // re-delivers them just because a permission changed — re-register so
        // the callback's first delivery carries the name.
        if (getPermissionState(LOCATION) == PermissionState.GRANTED) {
            unregister();
            register();
        }
        call.resolve(state());
        schedulePush();
    }

    // ── State ────────────────────────────────────────────────────────────

    private JSObject state() {
        JSObject ret = new JSObject();
        NetworkCapabilities nc = caps;
        String transport;
        if (nc == null) transport = "none";
        else if (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) transport = "wifi";
        else if (nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) transport = "cellular";
        else transport = "other";
        ret.put("transport", transport);
        String ssid = "wifi".equals(transport) ? ssid(nc) : null;
        ret.put("ssid", ssid != null ? ssid : JSObject.NULL);
        ret.put("permission", permission());
        return ret;
    }

    private String permission() {
        PermissionState s = getPermissionState(LOCATION);
        if (s == PermissionState.GRANTED) return "granted";
        if (s == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    @Nullable
    private String ssid(NetworkCapabilities nc) {
        if (getPermissionState(LOCATION) != PermissionState.GRANTED) return null;
        String raw = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                TransportInfo ti = nc.getTransportInfo();
                if (ti instanceof WifiInfo) raw = ((WifiInfo) ti).getSSID();
            } else {
                WifiManager wm = (WifiManager) getContext().getApplicationContext()
                        .getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    @SuppressWarnings("deprecation")
                    WifiInfo wi = wm.getConnectionInfo();
                    if (wi != null) raw = wi.getSSID();
                }
            }
        } catch (RuntimeException e) {
            Log.d(TAG, "ssid unreadable: " + e);
            return null;
        }
        return cleanSsid(raw);
    }

    /** Strip the quotes Android wraps a UTF-8 name in; the placeholder is "don't know". */
    @Nullable
    static String cleanSsid(@Nullable String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            s = s.substring(1, s.length() - 1);
        }
        if (s.isEmpty() || UNKNOWN_SSID.equals(s) || "0x".equals(s)) return null;
        return s;
    }

    // ── The callback ─────────────────────────────────────────────────────

    private void register() {
        if (callback != null) return;
        ConnectivityManager cm = getContext().getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        ConnectivityManager.NetworkCallback cb;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            cb = new Callback(ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO);
        } else {
            cb = new Callback();
        }
        try {
            cm.registerDefaultNetworkCallback(cb);
            callback = cb;
        } catch (RuntimeException e) {
            Log.w(TAG, "no network callback: " + e);
        }
    }

    private void unregister() {
        ConnectivityManager.NetworkCallback cb = callback;
        callback = null;
        if (cb == null) return;
        ConnectivityManager cm = getContext().getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        try {
            cm.unregisterNetworkCallback(cb);
        } catch (RuntimeException e) {
            Log.d(TAG, "unregister: " + e);
        }
    }

    private final class Callback extends ConnectivityManager.NetworkCallback {
        Callback() { super(); }
        Callback(int flags) { super(flags); }

        @Override
        public void onCapabilitiesChanged(Network network, NetworkCapabilities nc) {
            caps = nc;
            schedulePush();
        }

        @Override
        public void onLost(Network network) {
            caps = null;
            schedulePush();
        }
    }

    private void schedulePush() {
        handler.removeCallbacks(push);
        handler.postDelayed(push, DEBOUNCE_MS);
    }

    private void pushIfChanged() {
        String json = state().toString();
        if (json.equals(lastPushed)) return;
        lastPushed = json;
        MainActivity.callWindow("shellNetChanged", json);
    }
}
