package dev.waterplane.app;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

import java.io.File;

/**
 * **The page's handle on {@link ShellPullService}** — and nothing more than a
 * handle.
 *
 * Every decision about a download stays in `web/pull.ts`: what is worth
 * fetching, in what order, what a row says, when to give up. This passes four
 * verbs across and hands back the service's own list. The split is the point:
 * the transfer had to leave the document (a frozen page runs no tasks — see
 * {@link ShellPullService}), the JUDGEMENT did not, and duplicating it in Java
 * is how the two ends start disagreeing about what happened.
 *
 * <b>The list is the truth; the events are a courtesy.</b> `pullChanged` fires
 * on every state change, and a backgrounded page will miss most of them — the
 * document is frozen, so the callback is a task nobody runs. `list()` is
 * therefore what the page reads on every wake, and it answers with the service
 * STOPPED, straight out of {@code SharedPreferences}, because the service stops
 * itself the moment the queue drains.
 */
@CapacitorPlugin(
    name = "ShellPull",
    permissions = {
        @Permission(alias = ShellPullPlugin.STORAGE, strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class ShellPullPlugin extends Plugin implements ShellPullService.Watcher {

    static final String STORAGE = "storage";

    @Override
    public void load() {
        ShellPullService.setWatcher(this);
    }

    @Override
    protected void handleOnDestroy() {
        ShellPullService.setWatcher(null);
        super.handleOnDestroy();
    }

    /** The service pushed a change. Rows, not a diff: the page applies the whole
     *  list, which is the same code path its wake-up re-read takes. */
    @Override
    public void onPullChanged(JSONArray items) {
        JSObject ev = new JSObject();
        ev.put("items", items);
        notifyListeners("pullChanged", ev);
    }

    /**
     * Fetch this file, in the background, until it is here.
     *
     * Idempotent by id: asking twice resumes the first request rather than
     * starting a second copy of it. `autoSave` says a person tapped, which is
     * what decides whether the finished file is published into Downloads by
     * itself.
     */
    @PluginMethod
    public void enqueue(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String name = Downloads.safeName(call.getString("name"));
        if (id == null || id.isEmpty() || url == null || url.isEmpty() || name == null) {
            call.reject("bad arguments");
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            // Screen-scraped text is not a link, and nothing else is a download.
            call.reject("only http(s) downloads");
            return;
        }
        Double sizeArg = call.getDouble("size");
        ShellPullService.enqueue(getContext(), id, url, name,
                call.getString("mime"),
                sizeArg == null ? 0L : (long) (double) sizeArg,
                call.getString("etag"),
                Boolean.TRUE.equals(call.getBoolean("autoSave")));
        call.resolve(state());
    }

    /** Stop the transfer, keep the bytes. It resumes from the offset. */
    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("bad arguments"); return; }
        ShellPullService.mutate(getContext(), id, ShellPullService.ACTION_CANCEL);
        call.resolve();
    }

    /** Forget the row and delete whatever of the file is on the phone. */
    @PluginMethod
    public void discard(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("bad arguments"); return; }
        ShellPullService.mutate(getContext(), id, ShellPullService.ACTION_DISCARD);
        call.resolve();
    }

    /**
     * Put a finished download into Downloads now — the "save to phone" button
     * for a file the service fetched but nobody asked to publish (the host's own
     * auto-pull rules do not tap anything).
     *
     * Below API 29 the public Downloads directory is a real path behind a
     * runtime prompt, and only a Plugin can ask for one. So the permission is
     * requested HERE and the work is handed to the service afterwards, rather
     * than having a service fail a finished download over a dialog it cannot
     * show.
     */
    @PluginMethod
    public void publish(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("bad arguments"); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState(STORAGE) != PermissionState.GRANTED) {
            requestPermissionForAlias(STORAGE, call, "storageResult");
            return;
        }
        ShellPullService.mutate(getContext(), id, ShellPullService.ACTION_PUBLISH);
        call.resolve();
    }

    @PermissionCallback
    private void storageResult(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("bad arguments"); return; }
        if (getPermissionState(STORAGE) != PermissionState.GRANTED) {
            call.reject("storage permission refused — the file was not saved");
            return;
        }
        ShellPullService.mutate(getContext(), id, ShellPullService.ACTION_PUBLISH);
        call.resolve();
    }

    /**
     * Every row the service holds, plus where a finished file's bytes are.
     *
     * `path` is what the page turns into an `<img src>` for a downloaded image
     * (`Capacitor.convertFileSrc`): the bytes stay in the app's own directory
     * and are never carried across the bridge, which is the whole reason a 90 MB
     * download costs nothing to have.
     */
    /** Mirror the page's auto-download switch, so a `pull.new` the link
     *  service receives while the page is frozen obeys it. */
    @PluginMethod
    public void setAuto(PluginCall call) {
        ShellPullService.setAuto(getContext(), !Boolean.FALSE.equals(call.getBoolean("on")));
        call.resolve();
    }

    /** The "keep only the Downloads copy" switch, held by the shell because the
     *  save it follows runs with the page frozen
     *  ({@link ShellPullService#dropAfterSave}). */
    @PluginMethod
    public void setDropAfterSave(PluginCall call) {
        boolean on = !Boolean.FALSE.equals(call.getBoolean("on"));
        ShellPullService.setDrop(getContext(), on);
        // Turning it on covers what is already in Downloads, off the main thread:
        // each row is a MediaStore query.
        if (on) new Thread(() -> {
            for (String id : ShellPullService.ids(getContext())) ShellPullService.dropAfterSave(getContext(), id);
        }, "shell-pull-drop").start();
        call.resolve();
    }

    @PluginMethod
    public void list(PluginCall call) {
        call.resolve(state());
    }

    private JSObject state() {
        JSONArray items = ShellPullService.snapshot(getContext());
        for (int i = 0; i < items.length(); i++) {
            org.json.JSONObject o = items.optJSONObject(i);
            if (o == null) continue;
            File bin = ShellPullService.binOf(getContext(), o.optString("id", ""));
            if (bin.isFile()) {
                try { o.put("path", bin.getAbsolutePath()); } catch (org.json.JSONException ignored) { /* row keeps no path */ }
            }
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        ret.put("running", ShellPullService.isRunning());
        ret.put("dropAfterSave", ShellPullService.dropEnabled(getContext()));
        return ret;
    }
}
