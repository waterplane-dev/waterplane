package dev.waterplane.app;

import android.Manifest;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * "Save this file out of the app" — the one thing the WebView silently refuses
 * to do, for bytes that are already on the phone.
 *
 * The download queue (`web/pull.ts`) can finish a transfer with the bytes in
 * IndexedDB, and saving them out was a hidden `<a download href="blob:…">`
 * click. In Chrome that lands in Downloads. In a Capacitor WebView **nothing
 * happens at all**: no download listener, no error, no file — the tap looked
 * like it worked and the 23 MB APK existed nowhere a file manager could see. A
 * `DownloadListener` does not fix it either, because a `blob:` URL lives in the
 * renderer and cannot be handed to `DownloadManager`.
 *
 * So the bytes come across the bridge instead, in chunks, and are written here.
 *
 * <b>This is no longer the main path in the APK.</b> {@link ShellPullService}
 * downloads a file itself and publishes it without the bridge or the WebView
 * being involved at all — which is what makes a transfer survive the app being
 * backgrounded. This plugin stays for the bytes that only the page has: a
 * download that finished under the range engine before the native one existed,
 * and anything a browser-side path parked in IndexedDB.
 *
 * Two things still shape it:
 *
 *  - **Chunked, never one call.** A base64 APK is ~31 MB of JSON string; pushing
 *    that through the bridge in a single call is the sort of thing that works on
 *    the desk and OOMs on the phone. The web side slices the blob, so peak
 *    memory is one chunk on each side regardless of file size.
 *  - **Assembled in the cache, published at the end.** Chunks append to a
 *    `.part` in `getCacheDir()`, and only a complete file is copied into the
 *    public Downloads collection. An interrupted save leaves nothing half-written
 *    where a file manager would show it as the real thing.
 *
 * Where the file GOES, what it ends up called and whether it is there already
 * are {@link Downloads}' — one implementation, because this plugin and the
 * service must not word the same outcome two ways.
 */
@CapacitorPlugin(
    name = "ShellSave",
    permissions = {
        @Permission(alias = ShellSavePlugin.STORAGE, strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class ShellSavePlugin extends Plugin {

    static final String STORAGE = "storage";

    private static final String TAG = "shell";
    /** Where partial saves are assembled. Cache, not files: the OS may reclaim
     *  it, and a half-written save is worth exactly nothing anyway. */
    private static final String STAGING = "saves";
    /** A staging file older than this is from a save nobody is running any more
     *  (the app was killed mid-transfer). Swept on the next `begin`. */
    private static final long STALE_MS = 6 * 60 * 60 * 1000L;

    /** Saves in flight, by the token handed to JavaScript. */
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    private static final class Pending {
        final File part;
        final String name;
        final String mime;
        Pending(File part, String name, String mime) { this.part = part; this.name = name; this.mime = mime; }
    }

    // ── JS API ───────────────────────────────────────────────────────────
    /**
     * Start a save. Returns the token every later call carries, so two saves can
     * never append into each other's file.
     */
    @PluginMethod
    public void begin(PluginCall call) {
        String name = Downloads.safeName(call.getString("name"));
        if (name == null) { call.reject("bad file name"); return; }
        String mime = call.getString("mime");
        if (mime == null || mime.isEmpty() || mime.indexOf('/') < 0) mime = Downloads.guessMime(name);

        File dir = new File(getContext().getCacheDir(), STAGING);
        if (!dir.isDirectory() && !dir.mkdirs()) { call.reject("cannot create " + dir); return; }
        sweep(dir);

        String token = UUID.randomUUID().toString();
        File part = new File(dir, token + ".part");
        try {
            // Truncate rather than trust a fresh UUID: cheap, and it makes the
            // "append" in `chunk` unconditionally correct.
            new FileOutputStream(part, false).close();
        } catch (IOException e) {
            call.reject("cannot open " + part, e);
            return;
        }
        pending.put(token, new Pending(part, name, mime));
        JSObject ret = new JSObject();
        ret.put("token", token);
        call.resolve(ret);
    }

    /** Append one slice of the file. */
    @PluginMethod
    public void chunk(PluginCall call) {
        Pending p = pending.get(call.getString("token"));
        if (p == null) { call.reject("no such save"); return; }
        String data = call.getString("dataBase64");
        if (data == null) { call.reject("bad arguments"); return; }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("bad base64", e);
            return;
        }
        try (FileOutputStream out = new FileOutputStream(p.part, true)) {
            out.write(bytes);
        } catch (IOException e) {
            call.reject("write failed", e);
            return;
        }
        call.resolve();
    }

    /** Publish the assembled file into the phone's Downloads. */
    @PluginMethod
    public void finish(PluginCall call) {
        Pending p = pending.get(call.getString("token"));
        if (p == null) { call.reject("no such save"); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState(STORAGE) != PermissionState.GRANTED) {
            // Below scoped storage the public Downloads directory is a plain path
            // behind a runtime prompt. Ask, then come back into `publish`.
            requestPermissionForAlias(STORAGE, call, "storageResult");
            return;
        }
        publish(call, p);
    }

    @PermissionCallback
    private void storageResult(PluginCall call) {
        Pending p = pending.get(call.getString("token"));
        if (p == null) { call.reject("no such save"); return; }
        if (getPermissionState(STORAGE) != PermissionState.GRANTED) {
            drop(call.getString("token"));
            call.reject("storage permission refused — the file was not saved");
            return;
        }
        publish(call, p);
    }

    /**
     * Is this file already sitting in the phone's Downloads?
     *
     * The one question the save path never asked. Its two answers are the two
     * things the user could not see: a file already there does not need saving
     * again (each re-save is another "app-debug (5).apk", and 90 MB across the
     * bridge to make it), and a file NOT there any more must stop being described
     * as saved. The matching rule is {@link Downloads#find}.
     */
    @PluginMethod
    public void find(PluginCall call) {
        String name = Downloads.safeName(call.getString("name"));
        if (name == null) { call.reject("bad file name"); return; }
        Double sizeArg = call.getDouble("size");
        long size = sizeArg == null ? 0L : (long) (double) sizeArg;
        JSObject ret = new JSObject();
        try {
            Downloads.Found f = Downloads.find(getContext(), name, size);
            ret.put("present", f != null);
            if (f != null) {
                ret.put("where", "Downloads/" + f.name);
                ret.put("size", f.size);
                ret.put("modified", f.modified);
            }
            call.resolve(ret);
        } catch (RuntimeException e) {
            // A refused query is not "the file is gone": say nothing rather than
            // the wrong thing, and let the web side keep offering the save.
            call.reject("cannot read Downloads: " + e.getMessage(), e);
        }
    }

    /** Throw away an abandoned save (the web side gave up mid-transfer). */
    @PluginMethod
    public void abort(PluginCall call) {
        drop(call.getString("token"));
        call.resolve();
    }

    // ── publishing ───────────────────────────────────────────────────────
    private void publish(PluginCall call, Pending p) {
        String token = call.getString("token");
        try {
            String where = Downloads.publish(getContext(), p.part, p.name, p.mime);
            JSObject ret = new JSObject();
            ret.put("where", where);
            call.resolve(ret);
            Log.i(TAG, "saved to " + where);
        } catch (IOException e) {
            call.reject("could not save to Downloads: " + e.getMessage(), e);
        } finally {
            drop(token);
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────
    private void drop(String token) {
        if (token == null) return;
        Pending p = pending.remove(token);
        //noinspection ResultOfMethodCallIgnored
        if (p != null) p.part.delete();
    }

    /** Staging files from a save that never finished — nothing resumes them. */
    private static void sweep(File dir) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        long cutoff = System.currentTimeMillis() - STALE_MS;
        for (File k : kids) {
            //noinspection ResultOfMethodCallIgnored
            if (k.lastModified() < cutoff) k.delete();
        }
    }
}
