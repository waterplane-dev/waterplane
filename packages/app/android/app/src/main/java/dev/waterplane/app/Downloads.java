package dev.waterplane.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.UUID;

/**
 * **The phone's Downloads folder, and the one implementation of everything this
 * app does to it.**
 *
 * Two callers now write here and they must not describe the outcome
 * differently: {@link ShellSavePlugin}, which takes bytes across the bridge out
 * of IndexedDB, and {@link ShellPullService}, which downloads them itself and
 * never involves the WebView at all. "The file landed and the user was told
 * where" is one behaviour; forking it is how one caller quietly stops saying
 * so — and the read-back of the name MediaStore actually chose is exactly the
 * part a second implementation forgets.
 *
 * Two publish paths, because Downloads is two different APIs:
 *
 *  - **API 29+** — scoped storage. Insert into {@code MediaStore.Downloads}
 *    with {@code IS_PENDING}, no permission at all, and read back the display
 *    name because MediaStore renames a collision rather than overwriting it.
 *  - **Below that** ({@code minSdk} is 24) — a real path behind
 *    {@code WRITE_EXTERNAL_STORAGE}, which is a runtime prompt. Only a
 *    {@code Plugin} can ask for one, so {@link #canPublish} exists for the
 *    service to check BEFORE it starts writing, and to hand the job back to the
 *    plugin rather than failing a finished download.
 */
final class Downloads {

    private static final String TAG = "shell";

    private Downloads() {}

    /** What Downloads holds for a name. */
    static final class Found {
        final String name;
        final long size;
        final long modified;
        Found(String name, long size, long modified) { this.name = name; this.size = size; this.modified = modified; }
    }

    /**
     * Can this process publish without asking a human first?
     *
     * True on API 29+ unconditionally. Below it the answer is the storage
     * permission, which a Service cannot request — so a caller with no UI asks
     * this first and leaves the file where it is instead of failing it.
     */
    static boolean canPublish(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return true;
        return ctx.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /** Copy a finished file into the phone's Downloads. Returns the destination
     *  as the UI shows it — "Downloads/thing.apk" — with the name read back. */
    static String publish(Context ctx, File src, String name, String mime) throws IOException {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? publishMediaStore(ctx, src, name, mime)
                : publishLegacy(src, name);
    }

    /**
     * Is this file already sitting in Downloads?
     *
     * Matching is by NAME FAMILY plus exact SIZE. The family is the name asked
     * for plus the "stem (n).ext" MediaStore itself produces on a collision; the
     * size is what makes a match mean "these bytes", since a rebuilt APK keeps
     * its name. With no size the exact display name is the only claim that can
     * be made.
     *
     * Scoped storage means this sees what THIS app inserted, which is exactly
     * the set worth asking about — a file we saved and the user then deleted
     * loses its row, which is the answer we want.
     */
    @Nullable
    static Found find(Context ctx, String name, long size) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? findMediaStore(ctx, name, size)
                : findLegacy(name, size);
    }

    /**
     * Delete a file this app saved to Downloads — the clean-up after an install
     * ({@link ShellPullService#cleanAfterInstall}).
     *
     * Matched EXACTLY: the display name the save read back, and the byte count,
     * so a different file that happens to share the name (a later build, or
     * something the person put there) is never touched. Returns null when it
     * was removed, "" when it is not there any more (nothing to do), and a
     * sentence when it is there and could not be removed — the caller puts
     * that on the row rather than pretending the space came back.
     *
     * On API 29+ the query only sees rows this app inserted, which is exactly
     * the set it may delete without asking. A reinstall of waterplane loses that
     * ownership; the platform then refuses, and that refusal is the sentence.
     */
    @Nullable
    static String remove(Context ctx, String name, long size) {
        if (name == null || name.isEmpty() || name.contains("/")) return "";
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? removeMediaStore(ctx, name, size)
                : removeLegacy(ctx, name, size);
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @Nullable
    private static String removeMediaStore(Context ctx, String name, long size) {
        ContentResolver cr = ctx.getContentResolver();
        String sel = MediaStore.Downloads.DISPLAY_NAME + " = ?";
        String[] args = { name };
        if (size > 0) {
            sel += " AND " + MediaStore.Downloads.SIZE + " = ?";
            args = new String[] { name, String.valueOf(size) };
        }
        try (android.database.Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[] { MediaStore.Downloads._ID }, sel, args, null)) {
            if (c == null || !c.moveToFirst()) return "";
            Uri uri = android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
            return cr.delete(uri, null, null) > 0 ? null : "the copy in Downloads could not be removed";
        } catch (SecurityException e) {
            return "the copy in Downloads/" + name + " is no longer this app's to delete — remove it by hand";
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot remove from Downloads: " + e);
            return "the copy in Downloads could not be removed: " + e.getMessage();
        }
    }

    @Nullable
    private static String removeLegacy(Context ctx, String name, long size) {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        File f = dir == null ? null : new File(dir, name);
        if (f == null || !f.isFile() || (size > 0 && f.length() != size)) return "";
        if (!canPublish(ctx)) return "the copy in Downloads/" + name + " stays — this app no longer has storage permission";
        return f.delete() ? null : "the copy in Downloads could not be removed";
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private static String publishMediaStore(Context ctx, File src, String name, String mime) throws IOException {
        ContentResolver cr = ctx.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        // Invisible to other apps until every byte is there, so a file manager
        // never lists a truncated copy as if it were the file.
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Downloads rejected the file");
        try {
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new IOException("cannot open " + uri);
                copy(src, out);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(uri, done, null, null);
        } catch (IOException e) {
            // A pending row nobody finished is invisible but still occupies
            // space and holds the display name — remove it so a retry is clean.
            cr.delete(uri, null, null);
            throw e;
        }
        return "Downloads/" + displayName(ctx, uri, name);
    }

    /** Below API 29: a real path, and collisions are ours to avoid. */
    private static String publishLegacy(File src, String name) throws IOException {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("no Downloads directory");
        File target = uniquify(dir, name);
        try (OutputStream out = new FileOutputStream(target)) {
            copy(src, out);
        }
        return "Downloads/" + target.getName();
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @Nullable
    private static Found findMediaStore(Context ctx, String name, long size) {
        String[] proj = {
            MediaStore.Downloads.DISPLAY_NAME,
            MediaStore.Downloads.SIZE,
            MediaStore.Downloads.DATE_MODIFIED,
        };
        // Exact name first: the answer with no size needed, and the common case.
        Found exact = queryOne(ctx, proj, MediaStore.Downloads.DISPLAY_NAME + " = ?", new String[] { name }, name, size);
        if (exact != null) return exact;
        if (size <= 0) return null;
        // Then the renamed copies. Selecting on SIZE keeps the cursor to a
        // handful of rows however big Downloads is; the family test is done in
        // Java, where a LIKE pattern's own metacharacters cannot bite.
        return queryOne(ctx, proj, MediaStore.Downloads.SIZE + " = ?", new String[] { String.valueOf(size) }, name, size);
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @Nullable
    private static Found queryOne(Context ctx, String[] proj, String sel, String[] args, String name, long size) {
        ContentResolver cr = ctx.getContentResolver();
        try (android.database.Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, proj, sel, args,
                MediaStore.Downloads.DATE_MODIFIED + " DESC")) {
            if (c == null) return null;
            while (c.moveToNext()) {
                String have = c.isNull(0) ? "" : c.getString(0);
                long haveSize = c.isNull(1) ? -1 : c.getLong(1);
                long modified = c.isNull(2) ? 0 : c.getLong(2) * 1000L;
                if (!sameFile(name, size, have, haveSize)) continue;
                return new Found(have, haveSize, modified);
            }
        }
        return null;
    }

    @Nullable
    private static Found findLegacy(String name, long size) {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        File[] kids = dir == null ? null : dir.listFiles();
        if (kids == null) return null;
        Found best = null;
        for (File k : kids) {
            if (!k.isFile() || !sameFile(name, size, k.getName(), k.length())) continue;
            if (best == null || k.lastModified() > best.modified) best = new Found(k.getName(), k.length(), k.lastModified());
        }
        return best;
    }

    /**
     * Same name (or the same name as MediaStore renamed it) and, when we know
     * one, the same byte count. Size is what stops a rebuilt APK reading as the
     * one already saved — the name is identical every build.
     */
    static boolean sameFile(String name, long size, String have, long haveSize) {
        if (have == null || have.isEmpty()) return false;
        if (size > 0 && haveSize != size) return false;
        if (have.equals(name)) return true;
        if (size <= 0) return false;                 // only an exact name can speak for unknown bytes
        return isRenamedCopy(name, have);
    }

    /** `app.apk` vs `app (3).apk` — MediaStore's own collision form. */
    static boolean isRenamedCopy(String name, String have) {
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        if (!have.startsWith(stem) || !have.endsWith(ext)) return false;
        String mid = have.substring(stem.length(), have.length() - ext.length());
        if (!mid.startsWith(" (") || !mid.endsWith(")")) return false;
        String n = mid.substring(2, mid.length() - 1);
        if (n.isEmpty()) return false;
        for (int i = 0; i < n.length(); i++) if (!Character.isDigit(n.charAt(i))) return false;
        return true;
    }

    /**
     * The name comes from the host's file listing, so it is a path as far as
     * this side is concerned. Only the basename is ever used, and it is stripped
     * of anything that would let it address a different file.
     */
    @Nullable
    static String safeName(String raw) {
        if (raw == null) return null;
        String base = raw.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9._ +()\\-]", "_").trim();
        while (base.startsWith(".")) base = base.substring(1);
        if (base.length() > 120) base = base.substring(base.length() - 120);
        return base.isEmpty() ? null : base;
    }

    static String guessMime(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (mime != null) return mime;
            // The one the platform map does not know and this app produces most.
            if (ext.equals("apk")) return "application/vnd.android.package-archive";
        }
        return "application/octet-stream";
    }

    /** What MediaStore actually called the file, which may not be what we asked. */
    private static String displayName(Context ctx, Uri uri, String fallback) {
        try (android.database.Cursor c = ctx.getContentResolver()
                .query(uri, new String[] { MediaStore.Downloads.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot read saved name: " + e);
        }
        return fallback;
    }

    private static void copy(File from, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        try (InputStream in = new FileInputStream(from)) {
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        out.flush();
    }

    /** `x.apk` → `x (1).apk`, so a second save never overwrites the first. */
    private static File uniquify(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, stem + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, stem + " (" + UUID.randomUUID() + ")" + ext);
    }
}
