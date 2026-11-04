package dev.waterplane.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Map;

/**
 * The page's hand on {@link ShellTlsPins}. Its presence is the capability check: no plugin, no TLS
 * route, so a shipped APK that learned a pin simply ignores it.
 *
 * <pre>
 *   Capacitor.Plugins.ShellTls.setPin({hostId, spki})   // one pin per host, set replaces
 *   Capacitor.Plugins.ShellTls.removePin({hostId})
 *   Capacitor.Plugins.ShellTls.list() → {pins: [{hostId, spki}]}
 *   Capacitor.Plugins.ShellTls.lastRefusal() → {host?, spki?, at?}
 * </pre>
 *
 * {@code setPin} also drops the recorded refusal: the page only calls it once a sealed pairing or a
 * protected welcome has said which key is the desktop's.
 */
@CapacitorPlugin(name = "ShellTls")
public class ShellTlsPlugin extends Plugin {

    @PluginMethod
    public void setPin(PluginCall call) {
        String hostId = call.getString("hostId");
        ShellTlsPins.Outcome o = ShellTlsPins.set(getContext(), hostId, call.getString("spki"));
        if (o == ShellTlsPins.Outcome.REFUSED) {
            call.reject("bad arguments");
            return;
        }
        ShellLinkService.pinChanged(hostId, o != ShellTlsPins.Outcome.SAME);
        if (o == ShellTlsPins.Outcome.REPLACED) forgetWebViewDecisions(call);
        else call.resolve();
    }

    @PluginMethod
    public void removePin(PluginCall call) {
        String hostId = call.getString("hostId");
        if (hostId == null) {
            call.reject("bad arguments");
            return;
        }
        boolean held = ShellTlsPins.remove(getContext(), hostId);
        if (held) ShellLinkService.pinChanged(hostId, true);
        forgetWebViewDecisions(call);
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray pins = new JSArray();
        for (Map.Entry<String, String> e : ShellTlsPins.read(getContext()).all().entrySet()) {
            JSObject row = new JSObject();
            row.put("hostId", e.getKey());
            row.put("spki", e.getValue());
            pins.put(row);
        }
        JSObject ret = new JSObject();
        ret.put("pins", pins);
        call.resolve(ret);
    }

    @PluginMethod
    public void lastRefusal(PluginCall call) {
        JSObject ret = new JSObject();
        ShellTlsPins.Refusal r = ShellTlsPins.lastRefusal(getContext());
        if (r != null) {
            if (r.host != null) ret.put("host", r.host);
            if (r.spki != null) ret.put("spki", r.spki);
            ret.put("at", r.at);
        }
        call.resolve(ret);
    }

    /**
     * The WebView remembers a {@code proceed()} per host and certificate, and the handler is not
     * asked again, so a key this phone no longer trusts would stay let in for as long as the
     * process lives. The call resolves after the clear: the page's next dial must not race it.
     */
    private void forgetWebViewDecisions(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            getBridge().getWebView().clearSslPreferences();
            call.resolve();
        });
    }
}
