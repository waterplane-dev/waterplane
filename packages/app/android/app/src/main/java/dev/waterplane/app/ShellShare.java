package dev.waterplane.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.MimeTypeMap;
import androidx.annotation.Nullable;
import com.getcapacitor.Bridge;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "Share → waterplane" from any other app (the system share sheet).
 *
 * The sender hands us {@code content://} URIs whose read grant lasts only as
 * long as this activity's intent — the page asks the person WHERE the files go
 * first, which can take minutes, and by then the grant may be gone. So the
 * bytes are copied into this app's own cache at once, and the page is handed
 * {@code http://localhost/_capacitor_file_/…} URLs to them: same origin as the
 * bundle, served by Capacitor's local server, read with an ordinary
 * {@code fetch}. Nothing is uploaded from here — the page routes the files
 * through exactly the path the compose bar's camera and paperclip use.
 *
 * Any app can share to us, so what arrives is content a person chose to send,
 * never a command: the page always asks before it lands anywhere.
 */
final class ShellShare {

    private static final String TAG = "shell";
    private static final String DIR = "share";
    /** A share older than this was either taken or abandoned; its copies go. */
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;

    private ShellShare() {}

    static boolean isShare(@Nullable Intent intent) {
        if (intent == null) return false;
        String a = intent.getAction();
        return Intent.ACTION_SEND.equals(a) || Intent.ACTION_SEND_MULTIPLE.equals(a);
    }

    /**
     * Copy what {@code intent} shares and describe it as JSON
     * ({@code {files:[{url,name,type,size}], text}}). Blocking — call off the
     * UI thread. Null when the share held nothing readable at all.
     */
    @Nullable
    static String collect(Context ctx, Intent intent, Bridge bridge) {
        File root = new File(ctx.getCacheDir(), DIR);
        sweep(root);
        File dir = new File(root, Long.toString(System.currentTimeMillis()));
        try {
            JSONArray files = new JSONArray();
            for (Uri u : streams(intent)) {
                JSONObject f = copy(ctx, u, dir, bridge);
                if (f != null) files.put(f);
            }
            String text = joinText(intent.getStringExtra(Intent.EXTRA_SUBJECT),
                    textOf(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)));
            if (files.length() == 0 && text.isEmpty()) return null;
            JSONObject o = new JSONObject();
            o.put("files", files);
            o.put("text", text);
            return o.toString();
        } catch (Exception e) {
            Log.w(TAG, "share: " + e);
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> streams(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                    : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) for (Uri u : many) if (u != null) out.add(u);
        } else {
            Uri one = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                    : intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) out.add(one);
        }
        return out;
    }

    @Nullable
    private static JSONObject copy(Context ctx, Uri u, File dir, Bridge bridge) {
        ContentResolver cr = ctx.getContentResolver();
        // `file://` from another app is a path into ITS storage; refuse rather
        // than read whatever this process happens to be able to read.
        if (!ContentResolver.SCHEME_CONTENT.equals(u.getScheme())) return null;
        String type = cr.getType(u);
        String name = safeName(displayName(cr, u), type);
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        File out = unique(dir, name);
        long size = 0;
        try (InputStream in = cr.openInputStream(u); OutputStream os = new FileOutputStream(out)) {
            if (in == null) return null;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) { os.write(buf, 0, n); size += n; }
        } catch (Exception e) {
            Log.w(TAG, "share: could not read " + u + ": " + e);
            out.delete();
            return null;
        }
        try {
            JSONObject f = new JSONObject();
            f.put("url", bridge.getLocalUrl() + Bridge.CAPACITOR_FILE_START + Uri.encode(out.getAbsolutePath(), "/"));
            f.put("name", out.getName());
            f.put("type", type != null ? type : "");
            f.put("size", size);
            return f;
        } catch (Exception e) {
            return null;
        }
    }

    @Nullable
    private static String displayName(ContentResolver cr, Uri u) {
        try (Cursor c = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) { /* a provider that answers no queries */ }
        return u.getLastPathSegment();
    }

    /** A plain file name: no directories, nothing hidden, an extension when the type implies one. */
    static String safeName(@Nullable String raw, @Nullable String type) {
        String n = raw == null ? "" : raw;
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replaceAll("[\\x00-\\x1f:*?\"<>|]", "_").replaceAll("^\\.+", "").trim();
        if (n.isEmpty()) n = "shared";
        if (n.length() > 120) n = n.substring(n.length() - 120);
        if (n.indexOf('.') < 0 && type != null) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
            if (ext != null) n = n + "." + ext;
        }
        return n;
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; f.exists(); i++) f = new File(dir, stem + "-" + i + ext);
        return f;
    }

    private static String textOf(@Nullable CharSequence cs) {
        return cs == null ? "" : cs.toString().trim();
    }

    private static String joinText(@Nullable String subject, String text) {
        String s = subject == null ? "" : subject.trim();
        if (s.isEmpty() || text.contains(s)) return text;
        return text.isEmpty() ? s : s + "\n" + text;
    }

    /** Drop share copies older than {@link #KEEP_MS}. */
    private static void sweep(File root) {
        File[] old = root.listFiles();
        if (old == null) return;
        long cut = System.currentTimeMillis() - KEEP_MS;
        for (File d : old) if (d.lastModified() < cut) rm(d);
    }

    private static void rm(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) rm(k);
        f.delete();
    }
}
