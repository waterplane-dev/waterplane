package dev.waterplane.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;

/**
 * **The page's handle on installing a downloaded APK** — and, like
 * {@link ShellPullPlugin}, nothing more than a handle.
 *
 * Every decision stays in `web/installPolicy.ts`: which package may install
 * itself, what a row says, what a refusal reads like. This passes four verbs
 * across and answers with what the PHONE will allow, which is the one thing the
 * page cannot work out for itself.
 *
 * The verdict lives on the pull row, not here — an install starts at the end of
 * a download that runs in a service on purpose, so it can and does happen with
 * the document frozen. The page reads it back the same way it reads everything
 * else about a transfer: off `ShellPull.list()`.
 */
@CapacitorPlugin(name = "ShellInstall")
public class ShellInstallPlugin extends Plugin {

    /**
     * What this phone allows, right now.
     *
     * `canInstall` is the special access ("install unknown apps"), which only
     * the person can grant and which no amount of code can work around;
     * `silent` says whether an UPDATE could skip the system dialog on this
     * Android version. Both are facts about the device, so the page draws a
     * sentence rather than a dead button when either is false.
     */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("canInstall", Installs.canInstall(getContext()));
        ret.put("silent", Installs.silentPossible());
        // Which distribution this shell is ("dev" | "play") and its own package.
        // The web bundle is shared by both and updates over the air, so it ASKS
        // rather than being built per flavor; a shell older than this field
        // says nothing, and the page reads absent as today's full behaviour.
        ret.put("distribution", Installs.distribution());
        ret.put("self", getContext().getPackageName());
        JSArray allow = new JSArray();
        for (String p : Installs.allowed(getContext())) allow.put(p);
        ret.put("allow", allow);
        // The clean-up switch lives in the shell (it runs at the install's
        // receiver, with the page asleep), so the page reads it from here.
        ret.put("cleanAfterInstall", ShellPullService.cleanEnabled(getContext()));
        call.resolve(ret);
    }

    /** Turn the delete-the-APK-after-it-installs clean-up on or off for this
     *  phone ({@link ShellPullService#cleanAfterInstall}). */
    @PluginMethod
    public void setCleanAfterInstall(PluginCall call) {
        ShellPullService.setClean(getContext(), Boolean.TRUE.equals(call.getBoolean("on")));
        call.resolve();
    }

    /**
     * For each named package: who installed it and who owns its updates
     * ({@link Installs#source}). A package with nothing to read is left out,
     * so absent means unknown, never "not ours". `self` is this app's own
     * package — the name the page compares against.
     */
    @PluginMethod
    public void sources(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("self", getContext().getPackageName());
        ret.put("sdk", android.os.Build.VERSION.SDK_INT);
        JSObject out = new JSObject();
        JSArray arr = call.getArray("packages");
        if (arr != null) {
            try {
                for (Object o : arr.toList()) {
                    if (!(o instanceof String) || ((String) o).isEmpty()) continue;
                    String[] s = Installs.source(getContext(), (String) o);
                    if (s == null) continue;
                    JSObject one = new JSObject();
                    one.put("installer", s[0]);
                    one.put("updateOwner", s[1]);
                    out.put((String) o, one);
                }
            } catch (JSONException e) {
                // an unreadable list reads nothing: every package stays unknown
            }
        }
        ret.put("sources", out);
        call.resolve(ret);
    }

    /** Open the Settings screen carrying the "install unknown apps" switch.
     *  Offered, never demanded — there is no dialog to request this one. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            getContext().startActivity(Installs.settingsIntent(getContext()));
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("this phone has no screen for that switch");
        }
    }

    /**
     * Replace the allow-list.
     *
     * The list is the page's (synced, so a second phone inherits it); this is
     * the mirror the download service reads, because the install happens where
     * the document may be frozen.
     */
    @PluginMethod
    public void setAllow(PluginCall call) {
        JSArray arr = call.getArray("packages");
        List<String> out = new ArrayList<>();
        if (arr != null) {
            try {
                for (Object o : arr.toList()) {
                    if (o instanceof String && !((String) o).isEmpty()) out.add((String) o);
                }
            } catch (JSONException e) {
                call.reject("unreadable list");
                return;
            }
        }
        Installs.setAllowed(getContext(), out);
        call.resolve();
    }

    /**
     * Install this finished download now.
     *
     * A tap, so it runs whatever the allow-list says — somebody is looking at
     * the screen, which is the confirmation the list exists to stand in for.
     * The answer comes back on the pull row, through
     * {@link ShellInstallReceiver}, because that is where the platform reports
     * it and a second route would be a second version of the truth.
     */
    @PluginMethod
    public void install(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) { call.reject("bad arguments"); return; }
        ShellPullService.mutate(getContext(), id, ShellPullService.ACTION_INSTALL);
        call.resolve();
    }
}
