package dev.waterplane.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import dev.waterplane.app.ShellBundleVerify.Manifest;
import dev.waterplane.app.ShellBundleVerify.Refused;

/**
 * Which desktops may update this app, and when a bundle is let through: the
 * decisions of {@link ShellUpdatePlugin}, kept free of Android so they run on
 * the JVM ({@code ShellUpdatePinsTest}). The plugin is the thin shell around
 * them: prefs, a dialog, a rename.
 *
 * **The rule.** Any pin stored and no valid signature: refused. No pin stored
 * and a {@code signed} field present: refused, the page must pin first. No pin
 * and no {@code signed}: today's behaviour, so an older desktop still updates.
 *
 * **`gen` is a high-water mark per desktop.** Only a person's answer in a native
 * dialog lowers it (a changed key, or forget and pin again). No fallback, revert
 * or new APK does, because none of them call anything here.
 */
final class ShellUpdatePins {
    private ShellUpdatePins() {}

    /** One row of the pin store: this desktop's key and the highest `gen` taken from it. */
    static final class Pin {
        final String hostId;
        final String key;
        final long gen;

        Pin(String hostId, String key, long gen) {
            this.hostId = hostId;
            this.key = key;
            this.gen = gen;
        }
    }

    /** What a {@code pinUpdateKey} call needs from the person. */
    enum Ask { ALREADY_PINNED, FIRST_KEY, KEY_CHANGED }

    /** {@code signed} and {@code sig} kept beside a verified bundle. */
    static final class Stored {
        final String signed;
        final String sig;

        Stored(String signed, String sig) {
            this.signed = signed;
            this.sig = sig;
        }
    }

    /** Stands in for a store that cannot be read: a pin that matches nothing, so nothing unsigned gets in. */
    private static final String UNREADABLE = "";
    private static final int NAME_MAX = 60;

    // ── the store ────────────────────────────────────────────────────────
    static List<Pin> parse(String json) {
        if (json == null || json.isEmpty()) return Collections.emptyList();
        try {
            Object top = ShellBundleVerify.readJson(json);
            if (!(top instanceof List)) return unreadable();
            List<Pin> out = new ArrayList<>();
            for (Object row : (List<?>) top) {
                if (!(row instanceof Map)) return unreadable();
                Map<?, ?> m = (Map<?, ?>) row;
                Object hostId = m.get("hostId");
                Object key = m.get("key");
                Object gen = m.get("gen");
                if (!(hostId instanceof String) || !ShellBundleVerify.goodHostId((String) hostId)
                        || !(key instanceof String) || !(gen instanceof Long) || (Long) gen < 0) {
                    return unreadable();
                }
                out.add(new Pin((String) hostId, (String) key, (Long) gen));
            }
            return out;
        } catch (Refused e) {
            return unreadable();
        }
    }

    private static List<Pin> unreadable() {
        return Collections.singletonList(new Pin(UNREADABLE, UNREADABLE, 0));
    }

    /** Host ids and base64 keys hold nothing JSON would need escaped: the plugin checks both before {@link #accept}. */
    static String serialize(List<Pin> pins) {
        StringBuilder out = new StringBuilder("[");
        for (Pin p : real(pins)) {
            if (out.length() > 1) out.append(',');
            out.append("{\"hostId\":\"").append(p.hostId)
                    .append("\",\"key\":\"").append(p.key)
                    .append("\",\"gen\":").append(p.gen).append('}');
        }
        return out.append(']').toString();
    }

    /** The rows that name a desktop: what {@code info()} reports. */
    static List<Pin> real(List<Pin> pins) {
        List<Pin> out = new ArrayList<>();
        for (Pin p : pins) if (!UNREADABLE.equals(p.hostId)) out.add(p);
        return out;
    }

    static Ask ask(List<Pin> pins, String hostId, String key) {
        boolean host = false;
        for (Pin p : pins) {
            if (!p.hostId.equals(hostId)) continue;
            if (p.key.equals(key)) return Ask.ALREADY_PINNED;
            host = true;
        }
        return host ? Ask.KEY_CHANGED : Ask.FIRST_KEY;
    }

    /** The store after a person said yes: one row for this desktop, its `gen` starting over unless the key is the same. */
    static List<Pin> accept(List<Pin> pins, String hostId, String key) {
        if (ask(pins, hostId, key) == Ask.ALREADY_PINNED) return pins;
        List<Pin> out = forget(real(pins), hostId);
        out.add(new Pin(hostId, key, 0));
        return out;
    }

    static List<Pin> forget(List<Pin> pins, String hostId) {
        List<Pin> out = new ArrayList<>();
        for (Pin p : pins) if (!p.hostId.equals(hostId)) out.add(p);
        return out;
    }

    /** Never lowers: a verified `gen` below the mark leaves it where it is. */
    static List<Pin> raise(List<Pin> pins, String hostId, long gen) {
        List<Pin> out = new ArrayList<>();
        for (Pin p : pins) {
            out.add(p.hostId.equals(hostId) && p.gen < gen ? new Pin(p.hostId, p.key, gen) : p);
        }
        return out;
    }

    static long highWater(List<Pin> pins, String hostId) {
        long gen = 0;
        for (Pin p : pins) if (p.hostId.equals(hostId) && p.gen > gen) gen = p.gen;
        return gen;
    }

    // ── the gate ─────────────────────────────────────────────────────────
    /**
     * {@code finishBundle}'s decision, over a complete `.part` directory.
     *
     * @return the verified manifest, or null for the unsigned path (no pin, no
     *         {@code signed})
     */
    static Manifest admit(List<Pin> pins, String id, String signed, String sig, File dir) throws Refused {
        if (signed == null) {
            if (pins.isEmpty()) return null;
            throw new Refused(ShellBundleVerify.UNSIGNED,
                    "this bundle is not signed and this phone only takes signed updates now: update the desktop");
        }
        if (pins.isEmpty()) {
            throw new Refused(ShellBundleVerify.PIN_FIRST,
                    "this bundle is signed but no desktop's key is pinned yet: pin the key first");
        }
        return verified(pins, id, signed, sig, dir, true);
    }

    /**
     * {@code stage} and {@code applyNow}: the same check again, over a final
     * directory and the {@link Stored} kept for it. {@code stored} is null for a
     * directory no verified manifest was kept for: a bundle from before pins, or
     * one taken unsigned. No pin stored means nothing to check it against.
     */
    static void recheck(List<Pin> pins, String id, Stored stored, File dir) throws Refused {
        if (pins.isEmpty()) return;
        if (stored == null) {
            throw new Refused(ShellBundleVerify.NOT_VERIFIED,
                    "this phone has no verified signature for that bundle: it has to be downloaded again");
        }
        verified(pins, id, stored.signed, stored.sig, dir, true);
    }

    /**
     * May the stored path keep serving at this launch? Runs before the bridge
     * exists, so it never throws, and a no here costs only a start on the APK's
     * own bundle.
     *
     * This is not a formality: `stage` is not the only way to that preference.
     * Capacitor's core `WebView` plugin gives page code `setServerBasePath` and
     * `persistServerBasePath`, so this launch check is what stops a page
     * persisting a directory nobody verified. Hashes are therefore checked too;
     * a bundle is a few MB, so that is milliseconds.
     *
     * The one thing left out of {@link #recheck} is `gen`: a bundle already
     * serving when a newer one finished is not a rollback, and dropping it for
     * that would swap a verified build for a possibly older one inside the APK.
     */
    static boolean servable(List<Pin> pins, String id, Stored stored, File dir) {
        if (pins.isEmpty()) return true;
        if (stored == null) return false;
        try {
            verified(pins, id, stored.signed, stored.sig, dir, false);
            return true;
        } catch (Refused | RuntimeException e) {
            return false;
        }
    }

    private static Manifest verified(List<Pin> pins, String id, String signed, String sig, File dir,
                                     boolean checkGen) throws Refused {
        byte[] bytes = ShellBundleVerify.unbase64(signed);
        if (bytes == null) {
            throw new Refused(ShellBundleVerify.BAD_MANIFEST, "the signed list of files is not base64");
        }
        Manifest m = ShellBundleVerify.parse(bytes);
        byte[] sigBytes = ShellBundleVerify.unbase64(sig);
        boolean hostPinned = false;
        boolean good = false;
        for (Pin p : pins) {
            if (!p.hostId.equals(m.hostId)) continue;
            hostPinned = true;
            good = good || ShellBundleVerify.signatureOk(bytes, sigBytes, p.key);
        }
        if (!hostPinned) {
            throw new Refused(ShellBundleVerify.NOT_PINNED, "this bundle comes from a desktop this phone has not pinned");
        }
        if (!good) {
            throw new Refused(ShellBundleVerify.BAD_SIGNATURE,
                    "the signature on this bundle does not match the key pinned for that desktop");
        }
        if (!m.buildId.equals(id)) {
            throw new Refused(ShellBundleVerify.WRONG_BUILD, "the signature is for a different build than this bundle");
        }
        if (checkGen && m.gen < highWater(pins, m.hostId)) {
            throw new Refused(ShellBundleVerify.ROLLBACK,
                    "this bundle is older than one this phone already took from that desktop");
        }
        ShellBundleVerify.checkFiles(dir, m);
        return m;
    }

    // ── what the dialogs say ─────────────────────────────────────────────
    /**
     * The desktop's name as a dialog may print it. It comes from page code, the
     * party the dialog exists to check, so nothing in it may fake a line of the
     * dialog or reorder it: controls, line breaks and bidi marks go, and the
     * length is capped. The fingerprint is the part that cannot be spoofed.
     */
    static String safeName(String name, String hostId) {
        StringBuilder out = new StringBuilder();
        if (name != null) {
            int kept = 0;
            for (int i = 0; i < name.length() && kept < NAME_MAX; ) {
                int c = name.codePointAt(i);
                i += Character.charCount(c);
                switch (Character.getType(c)) {
                    case Character.CONTROL: case Character.FORMAT: case Character.SURROGATE:
                    case Character.PRIVATE_USE: case Character.UNASSIGNED:
                    case Character.LINE_SEPARATOR: case Character.PARAGRAPH_SEPARATOR:
                        continue;
                    default:
                        out.appendCodePoint(c);
                        kept++;
                }
            }
        }
        String t = out.toString().trim();
        return t.isEmpty() ? hostId : t;
    }

    /** Title, message, yes, no. */
    static String[] pinWords(Ask ask, String name, String key) {
        String print = ShellBundleVerify.grouped(ShellBundleVerify.fingerprint(key));
        if (ask == Ask.KEY_CHANGED) {
            return new String[] {
                    "This desktop's update key changed",
                    "\"" + name + "\" now signs its updates with a different key. A reinstalled desktop does this, "
                            + "and so does one pretending to be it.\n\n"
                            + "If you allow it, this desktop will be able to update this app with the new key, "
                            + "and the old key stops working.\n\n"
                            + "New key fingerprint:\n" + print,
                    "Allow new key", "Keep old key" };
        }
        return new String[] {
                "Let this desktop update the app?",
                "\"" + name + "\": this desktop will be able to update this app, and what it sends will run "
                        + "here as the app.\n\n"
                        + "Key fingerprint:\n" + print,
                "Allow", "Not now" };
    }

    /** Title, message, yes, no. {@code last}: no pin stays, so the signature rule stops applying. */
    static String[] forgetWords(String name, boolean last) {
        return new String[] {
                "Forget this desktop's update key?",
                "\"" + name + "\" will no longer be able to update this app."
                        + (last ? "\n\nIt is the last key here: until another is pinned, this phone "
                                + "takes unsigned updates again." : ""),
                "Forget", "Keep" };
    }

    // ── what is kept beside a bundle ─────────────────────────────────────
    /** Replaces {@code f} whole: a half-written file must read as nothing, never as a manifest. */
    static void writeStored(File f, String signed, String sig) throws IOException {
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write((signed + "\n" + sig + "\n").getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(f)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("cannot finalise " + f);
        }
    }

    /** @return what {@link #writeStored} wrote, or null if there is no such file or it cannot be read */
    static Stored readStored(File f) {
        if (!f.isFile() || f.length() > 4L * ShellBundleVerify.SIGNED_MAX) return null;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        try (InputStream in = new FileInputStream(f)) {
            int n;
            while ((n = in.read(buf)) > 0) bytes.write(buf, 0, n);
        } catch (IOException e) {
            return null;
        }
        String[] lines = new String(bytes.toByteArray(), StandardCharsets.UTF_8).split("\n", -1);
        return lines.length == 3 && lines[2].isEmpty() ? new Stored(lines[0], lines[1]) : null;
    }
}
