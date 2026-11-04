package dev.waterplane.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Checks one over-the-air bundle against what its desktop signed. No Android
 * here, so all of it runs on the JVM ({@code ShellBundleVerifyTest}).
 *
 * The wire shape is fixed by the LAN security plan, section 8a: a manifest's
 * {@code signed} is base64 of UTF-8 JSON
 * {@code {"v":1,"hostId","buildId","gen","total","files":[{"path","size","sha256"}]}},
 * and {@code sig} is base64 of the IEEE P1363 {@code r‖s} pair over those decoded
 * bytes. Only what is inside {@code signed} counts, so nothing is canonicalised.
 *
 * **minSdk is 24, and that decides what may be used here:** `java.util.Base64`,
 * `java.nio.file` and `String.join` all arrive in API 26, and `android.util.Base64`
 * and `org.json` are stubs on the JVM. So base64 and JSON are the small strict
 * readers below, and a symlink is found by comparing canonical paths.
 */
final class ShellBundleVerify {
    private ShellBundleVerify() {}

    /** Refusal codes, as a rejected plugin call carries them. */
    static final String UNSIGNED = "UNSIGNED";
    static final String PIN_FIRST = "PIN_FIRST";
    static final String NOT_PINNED = "NOT_PINNED";
    static final String NOT_VERIFIED = "NOT_VERIFIED";
    static final String BAD_SIGNATURE = "BAD_SIGNATURE";
    static final String BAD_MANIFEST = "BAD_MANIFEST";
    static final String WRONG_BUILD = "WRONG_BUILD";
    static final String ROLLBACK = "ROLLBACK";
    static final String BAD_FILES = "BAD_FILES";

    /** A check that failed: a code for the page, words for the person. */
    static final class Refused extends Exception {
        final String code;

        Refused(String code, String words) {
            super(words);
            this.code = code;
        }
    }

    static final class Entry {
        final String path;
        final long size;
        final String sha256;

        Entry(String path, long size, String sha256) {
            this.path = path;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    /** The parsed inside of {@code signed}. */
    static final class Manifest {
        final String hostId;
        final String buildId;
        final long gen;
        final long total;
        final List<Entry> files;

        Manifest(String hostId, String buildId, long gen, long total, List<Entry> files) {
            this.hostId = hostId;
            this.buildId = buildId;
            this.gen = gen;
            this.total = total;
            this.files = files;
        }
    }

    /** `signed` is read before any key is chosen, so its size is bounded first. A real one is ~50 KB. */
    static final int SIGNED_MAX = 1 << 20;
    private static final int JSON_DEPTH_MAX = 16;
    private static final int DIR_DEPTH_MAX = 32;
    private static final int PATH_MAX = 1024;
    /** JSON numbers are doubles on the desktop's side; past this they are not exact integers. */
    private static final long SAFE_INT_MAX = (1L << 53) - 1;

    private static final Pattern HOST_ID = Pattern.compile("^[a-z0-9]{4,16}$");
    private static final Pattern BUILD_ID = Pattern.compile("^[a-f0-9]{8,64}$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern NUMBER = Pattern.compile("^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$");

    /** The order of P-256: a signature's r and s are both in [1, n-1]. */
    private static final BigInteger P256_N =
            new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);
    /** Everything before the point in a P-256 SPKI: the algorithm, the curve, the uncompressed marker. */
    private static final byte[] P256_SPKI_HEADER = hex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
    private static final int P256_SPKI_LENGTH = 91;

    static boolean goodHostId(String s) {
        return s != null && HOST_ID.matcher(s).matches();
    }

    // ── base64 ───────────────────────────────────────────────────────────
    /**
     * Standard padded base64, strictly: no whitespace, no url alphabet, zero
     * trailing bits. Strict so a key has exactly one spelling, which is what
     * lets the pin store compare keys as strings.
     *
     * @return the bytes, or null if this is not base64
     */
    static byte[] unbase64(String s) {
        if (s == null || s.length() % 4 != 0) return null;
        int n = s.length();
        int pad = n == 0 || s.charAt(n - 1) != '=' ? 0 : s.charAt(n - 2) == '=' ? 2 : 1;
        byte[] out = new byte[n / 4 * 3 - pad];
        int acc = 0, bits = 0, o = 0;
        for (int i = 0; i < n - pad; i++) {
            int v = base64Value(s.charAt(i));
            if (v < 0) return null;
            acc = (acc << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) (acc >> bits);
                acc &= (1 << bits) - 1;
            }
        }
        return acc == 0 ? out : null;
    }

    private static int base64Value(char c) {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    }

    // ── keys and signatures ──────────────────────────────────────────────
    /** A P-256 public key, or null for anything else: another curve, a compressed point, not DER. */
    private static PublicKey publicKey(String spkiBase64) {
        byte[] der = unbase64(spkiBase64);
        if (der == null || der.length != P256_SPKI_LENGTH) return null;
        if (!Arrays.equals(Arrays.copyOf(der, P256_SPKI_HEADER.length), P256_SPKI_HEADER)) return null;
        try {
            return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
        } catch (GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    static boolean validKey(String spkiBase64) {
        return publicKey(spkiBase64) != null;
    }

    /** Lowercase hex SHA-256 of the SPKI DER, or null if this is not base64. */
    static String fingerprint(String spkiBase64) {
        byte[] der = unbase64(spkiBase64);
        return der == null ? null : toHex(sha256().digest(der));
    }

    /** {@code abcd ef01 …}: what a person can compare by eye. */
    static String grouped(String hexText) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < hexText.length(); i += 4) {
            if (i > 0) out.append(' ');
            out.append(hexText, i, Math.min(i + 4, hexText.length()));
        }
        return out.toString();
    }

    /**
     * IEEE P1363 {@code r‖s} to the DER Java verifies.
     *
     * @return the DER, or null for a wrong length or an r or s out of range
     */
    static byte[] p1363ToDer(byte[] sig) {
        if (sig == null || sig.length != 64) return null;
        BigInteger r = new BigInteger(1, Arrays.copyOfRange(sig, 0, 32));
        BigInteger s = new BigInteger(1, Arrays.copyOfRange(sig, 32, 64));
        if (!scalarInRange(r) || !scalarInRange(s)) return null;
        // `toByteArray` is already the minimal two's complement DER wants: no
        // leading zeros, and one zero byte when the top bit is set.
        byte[] rb = r.toByteArray();
        byte[] sb = s.toByteArray();
        byte[] der = new byte[6 + rb.length + sb.length];
        der[0] = 0x30;
        der[1] = (byte) (4 + rb.length + sb.length);   // at most 70: the short length form
        der[2] = 0x02;
        der[3] = (byte) rb.length;
        System.arraycopy(rb, 0, der, 4, rb.length);
        der[4 + rb.length] = 0x02;
        der[5 + rb.length] = (byte) sb.length;
        System.arraycopy(sb, 0, der, 6 + rb.length, sb.length);
        return der;
    }

    private static boolean scalarInRange(BigInteger v) {
        return v.signum() > 0 && v.compareTo(P256_N) < 0;
    }

    /** ECDSA P-256 over {@code signed}. Anything malformed is simply not a valid signature. */
    static boolean signatureOk(byte[] signed, byte[] sigP1363, String spkiBase64) {
        byte[] der = p1363ToDer(sigP1363);
        PublicKey key = publicKey(spkiBase64);
        if (signed == null || der == null || key == null) return false;
        try {
            Signature v = Signature.getInstance("SHA256withECDSA");
            v.initVerify(key);
            v.update(signed);
            return v.verify(der);
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    // ── the manifest ─────────────────────────────────────────────────────
    /** Read the decoded {@code signed} bytes. Unknown fields are ignored: they are signed too. */
    static Manifest parse(byte[] signed) throws Refused {
        if (signed == null || signed.length > SIGNED_MAX) throw malformed("its size");
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(signed)).toString();
        } catch (CharacterCodingException e) {
            throw malformed("its text");
        }
        Object top = readJson(text);
        if (!(top instanceof Map)) throw malformed("its shape");
        Map<?, ?> m = (Map<?, ?>) top;
        if (!Long.valueOf(1).equals(m.get("v"))) throw malformed("its version");
        Object hostId = m.get("hostId");
        if (!(hostId instanceof String) || !goodHostId((String) hostId)) throw malformed("hostId");
        Object buildId = m.get("buildId");
        if (!(buildId instanceof String) || !BUILD_ID.matcher((String) buildId).matches()) throw malformed("buildId");
        long gen = count(m.get("gen"), "gen");
        long total = count(m.get("total"), "total");
        Object files = m.get("files");
        if (!(files instanceof List) || ((List<?>) files).isEmpty()) throw malformed("files");

        List<Entry> entries = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        long sum = 0;
        for (Object row : (List<?>) files) {
            if (!(row instanceof Map)) throw malformed("files");
            Map<?, ?> f = (Map<?, ?>) row;
            Object path = f.get("path");
            if (!(path instanceof String) || !goodPath((String) path)) throw malformed("a path");
            if (!seen.add((String) path)) throw malformed("a repeated path");
            long size = count(f.get("size"), "a size");
            Object sha = f.get("sha256");
            if (!(sha instanceof String) || !SHA256.matcher((String) sha).matches()) throw malformed("a hash");
            if (size > SAFE_INT_MAX - sum) throw malformed("total");
            sum += size;
            entries.add(new Entry((String) path, size, (String) sha));
        }
        if (sum != total) throw malformed("total");
        if (!seen.contains("index.html")) throw malformed("files");
        return new Manifest((String) hostId, (String) buildId, gen, total, entries);
    }

    private static Refused malformed(String what) {
        return new Refused(BAD_MANIFEST, "the signed list of files is malformed (" + what + ")");
    }

    private static long count(Object v, String what) throws Refused {
        if (!(v instanceof Long) || (Long) v < 0 || (Long) v > SAFE_INT_MAX) throw malformed(what);
        return (Long) v;
    }

    /** A relative path with forward slashes and nothing that can climb out of the bundle. */
    static boolean goodPath(String p) {
        if (p == null || p.isEmpty() || p.length() > PATH_MAX) return false;
        for (int i = 0; i < p.length(); i++) {
            char c = p.charAt(i);
            if (c < 0x20 || c == 0x7f || c == '\\') return false;
        }
        for (String seg : p.split("/", -1)) {
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) return false;
        }
        return true;
    }

    // ── the directory ────────────────────────────────────────────────────
    /**
     * Require {@code root} to hold exactly the files of {@code m}: no extra
     * file, no missing one, nothing that is not a plain file or directory.
     */
    static void checkFiles(File root, Manifest m) throws Refused {
        File real;
        try {
            File abs = root.getAbsoluteFile();
            File parent = abs.getParentFile();
            real = abs.getCanonicalFile();
            if (parent == null || !real.equals(new File(parent.getCanonicalFile(), abs.getName()))) {
                throw badFiles("the bundle directory is a link");
            }
        } catch (IOException e) {
            throw badFiles("the bundle directory cannot be read");
        }
        Map<String, Entry> want = new HashMap<>();
        for (Entry e : m.files) want.put(e.path, e);
        Set<String> found = new HashSet<>();
        walk(real, "", 0, want, found);
        for (Entry e : m.files) {
            if (!found.contains(e.path)) throw badFiles(e.path + " is missing");
        }
    }

    /** {@code dir} is canonical, so any child whose canonical path differs is a link. */
    private static void walk(File dir, String prefix, int depth, Map<String, Entry> want, Set<String> found)
            throws Refused {
        if (depth > DIR_DEPTH_MAX) throw badFiles("the directories go too deep");
        File[] kids = dir.listFiles();
        if (kids == null) throw badFiles(prefix + " cannot be read");
        if (kids.length == 0) throw badFiles("extra empty directory " + prefix);
        for (File kid : kids) {
            String rel = prefix + kid.getName();
            try {
                if (!kid.getCanonicalFile().equals(kid)) throw badFiles(rel + " is a link");
            } catch (IOException e) {
                throw badFiles(rel + " cannot be resolved");
            }
            if (kid.isDirectory()) {
                walk(kid, rel + "/", depth + 1, want, found);
            } else if (kid.isFile()) {
                Entry e = want.get(rel);
                if (e == null) throw badFiles("extra file " + rel);
                if (kid.length() != e.size) throw badFiles(rel + " has the wrong size");
                if (!e.sha256.equals(sha256Of(kid, rel))) throw badFiles(rel + " has the wrong hash");
                found.add(rel);
            } else {
                throw badFiles(rel + " is not a plain file");
            }
        }
    }

    private static Refused badFiles(String what) {
        return new Refused(BAD_FILES, "the bundle does not match what the desktop signed: " + what);
    }

    private static String sha256Of(File f, String rel) throws Refused {
        MessageDigest d = sha256();
        byte[] buf = new byte[64 * 1024];
        try (InputStream in = new FileInputStream(f)) {
            int n;
            while ((n = in.read(buf)) > 0) d.update(buf, 0, n);
        } catch (IOException e) {
            throw badFiles(rel + " cannot be read");
        }
        return toHex(d.digest());
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);   // required on every Java and Android platform
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        }
        return out.toString();
    }

    private static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    // ── JSON ─────────────────────────────────────────────────────────────
    /**
     * Strict JSON: objects are maps, arrays lists, whole numbers {@link Long}.
     * A repeated key is refused rather than resolved, because the two ends of
     * this contract would resolve it differently. `signed` reaches this before
     * its signature is checked (the key is chosen by the hostId inside), so
     * depth is capped and every failure is a {@link Refused}.
     */
    static Object readJson(String text) throws Refused {
        JsonReader r = new JsonReader(text);
        Object v = r.value(0);
        r.space();
        if (r.i != text.length()) throw malformed("its text");
        return v;
    }

    private static final class JsonReader {
        final String s;
        int i = 0;

        JsonReader(String s) {
            this.s = s;
        }

        void space() {
            while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++;
        }

        boolean eat(char c) {
            space();
            if (i < s.length() && s.charAt(i) == c) {
                i++;
                return true;
            }
            return false;
        }

        Object value(int depth) throws Refused {
            if (depth > JSON_DEPTH_MAX) throw malformed("its depth");
            space();
            if (i >= s.length()) throw malformed("its text");
            char c = s.charAt(i);
            if (c == '{') return object(depth);
            if (c == '[') return array(depth);
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            return number();
        }

        Map<String, Object> object(int depth) throws Refused {
            i++;
            Map<String, Object> out = new LinkedHashMap<>();
            if (eat('}')) return out;
            do {
                space();
                if (i >= s.length() || s.charAt(i) != '"') throw malformed("its text");
                String key = string();
                if (out.containsKey(key)) throw malformed("a repeated key");
                if (!eat(':')) throw malformed("its text");
                out.put(key, value(depth + 1));
            } while (eat(','));
            if (!eat('}')) throw malformed("its text");
            return out;
        }

        List<Object> array(int depth) throws Refused {
            i++;
            List<Object> out = new ArrayList<>();
            if (eat(']')) return out;
            do {
                out.add(value(depth + 1));
            } while (eat(','));
            if (!eat(']')) throw malformed("its text");
            return out;
        }

        String string() throws Refused {
            i++;
            StringBuilder out = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return out.toString();
                if (c < 0x20) throw malformed("its text");
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                if (i >= s.length()) break;
                char e = s.charAt(i++);
                switch (e) {
                    case '"': case '\\': case '/': out.append(e); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u': out.append(unicodeEscape()); break;
                    default: throw malformed("its text");
                }
            }
            throw malformed("its text");
        }

        char unicodeEscape() throws Refused {
            if (i + 4 > s.length()) throw malformed("its text");
            int v = 0;
            for (int k = 0; k < 4; k++) {
                int d = Character.digit(s.charAt(i++), 16);
                if (d < 0) throw malformed("its text");
                v = v * 16 + d;
            }
            return (char) v;
        }

        Object number() throws Refused {
            int start = i;
            while (i < s.length() && "+-.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
            String t = s.substring(start, i);
            if (!NUMBER.matcher(t).matches()) throw malformed("its text");
            try {
                return Long.valueOf(t);
            } catch (NumberFormatException e) {
                return Double.valueOf(t);   // a fraction, or too big: never a valid count
            }
        }
    }
}
