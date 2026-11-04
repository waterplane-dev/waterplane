package dev.waterplane.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import dev.waterplane.app.ShellBundleVerify.Manifest;
import dev.waterplane.app.ShellBundleVerify.Refused;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;

import org.junit.BeforeClass;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** {@link ShellBundleVerify} against a real Node signature (`gen-update-vector.mjs`). */
public class ShellBundleVerifyTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static Map<?, ?> vector;
    private static String publicKey;
    private static byte[] signed;
    private static byte[] sig;

    @BeforeClass
    public static void readVector() throws Exception {
        try (InputStream in = ShellBundleVerifyTest.class.getClassLoader()
                .getResourceAsStream("update-signature-vector.json")) {
            assertNotNull("update-signature-vector.json is on the test classpath", in);
            byte[] all = new byte[1 << 16];
            int n = 0;
            int got;
            while ((got = in.read(all, n, all.length - n)) > 0) n += got;
            vector = (Map<?, ?>) ShellBundleVerify.readJson(new String(all, 0, n, StandardCharsets.UTF_8));
        }
        publicKey = (String) vector.get("publicKey");
        signed = b64((String) vector.get("signed"));
        sig = b64((String) vector.get("sig"));
    }

    private static byte[] b64(String s) {
        return Base64.getDecoder().decode(s);
    }

    /** The vector's bundle on disk. */
    private File bundle() throws IOException {
        File root = tmp.newFolder("bundle");
        for (Map.Entry<?, ?> e : ((Map<?, ?>) vector.get("files")).entrySet()) {
            File f = new File(root, (String) e.getKey());
            f.getParentFile().mkdirs();
            Files.write(f.toPath(), b64((String) e.getValue()));
        }
        return root;
    }

    private static void assertRefused(String code, File root) throws Exception {
        try {
            ShellBundleVerify.checkFiles(root, ShellBundleVerify.parse(signed));
            fail("expected " + code);
        } catch (Refused e) {
            assertEquals(code, e.code);
        }
    }

    private static void assertMalformed(String json) {
        try {
            ShellBundleVerify.parse(json.getBytes(StandardCharsets.UTF_8));
            fail("expected a refusal for " + json);
        } catch (Refused e) {
            assertEquals(ShellBundleVerify.BAD_MANIFEST, e.code);
        }
    }

    private static final String SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    private static String manifest(String v, String hostId, String buildId, String gen, String total, String files) {
        return "{\"v\":" + v + ",\"hostId\":" + hostId + ",\"buildId\":" + buildId
                + ",\"gen\":" + gen + ",\"total\":" + total + ",\"files\":" + files + "}";
    }

    private static String file(String path, String size, String sha) {
        return "{\"path\":\"" + path + "\",\"size\":" + size + ",\"sha256\":\"" + sha + "\"}";
    }

    private static String withFiles(String... rows) {
        return manifest("1", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1", "0", "[" + String.join(",", rows) + "]");
    }

    // ── signatures ───────────────────────────────────────────────────────
    @Test
    public void nodesSignatureVerifies() {
        assertTrue(ShellBundleVerify.signatureOk(signed, sig, publicKey));
    }

    @Test
    public void bothDerEdgesOfEveryScalarVerify() {
        Map<?, ?> edges = (Map<?, ?>) vector.get("edges");
        assertEquals(4, edges.size());
        for (Map.Entry<?, ?> e : edges.entrySet()) {
            assertTrue((String) e.getKey(), ShellBundleVerify.signatureOk(signed, b64((String) e.getValue()), publicKey));
        }
    }

    @Test
    public void tamperedBytesDoNotVerify() {
        byte[] tampered = b64((String) ((Map<?, ?>) vector.get("tampered")).get("signed"));
        assertFalse(Arrays.equals(signed, tampered));
        assertFalse(ShellBundleVerify.signatureOk(tampered, sig, publicKey));
    }

    @Test
    public void aFlippedSignatureBitDoesNotVerify() {
        byte[] bad = sig.clone();
        bad[40] ^= 1;
        assertFalse(ShellBundleVerify.signatureOk(signed, bad, publicKey));
    }

    @Test
    public void theWrongKeyDoesNotVerify() {
        assertFalse(ShellBundleVerify.signatureOk(signed, sig, (String) vector.get("otherKey")));
    }

    @Test
    public void aSignatureOfTheWrongLengthIsRefused() {
        assertNull(ShellBundleVerify.p1363ToDer(null));
        assertNull(ShellBundleVerify.p1363ToDer(new byte[0]));
        assertNull(ShellBundleVerify.p1363ToDer(Arrays.copyOf(sig, 63)));
        assertNull(ShellBundleVerify.p1363ToDer(Arrays.copyOf(sig, 65)));
        assertFalse(ShellBundleVerify.signatureOk(signed, Arrays.copyOf(sig, 65), publicKey));
    }

    @Test
    public void aZeroOrOutOfRangeScalarIsRefused() {
        byte[] zeroR = sig.clone();
        Arrays.fill(zeroR, 0, 32, (byte) 0);
        byte[] zeroS = sig.clone();
        Arrays.fill(zeroS, 32, 64, (byte) 0);
        byte[] maxS = sig.clone();
        Arrays.fill(maxS, 32, 64, (byte) 0xff);
        assertNull(ShellBundleVerify.p1363ToDer(zeroR));
        assertNull(ShellBundleVerify.p1363ToDer(zeroS));
        assertNull(ShellBundleVerify.p1363ToDer(maxS));
        assertFalse(ShellBundleVerify.signatureOk(signed, zeroR, publicKey));
        assertFalse(ShellBundleVerify.signatureOk(signed, zeroS, publicKey));
    }

    @Test
    public void onlyAP256SpkiIsAKey() throws Exception {
        assertTrue(ShellBundleVerify.validKey(publicKey));
        assertFalse(ShellBundleVerify.validKey(null));
        assertFalse(ShellBundleVerify.validKey(""));
        assertFalse(ShellBundleVerify.validKey("not base64!"));
        java.security.KeyPairGenerator g = java.security.KeyPairGenerator.getInstance("EC");
        g.initialize(new java.security.spec.ECGenParameterSpec("secp384r1"));
        assertFalse(ShellBundleVerify.validKey(
                Base64.getEncoder().encodeToString(g.generateKeyPair().getPublic().getEncoded())));
    }

    @Test
    public void theFingerprintIsTheHashOfTheDerGroupedForAPerson() throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(b64(publicKey));
        StringBuilder hex = new StringBuilder();
        for (byte b : hash) hex.append(String.format("%02x", b));
        assertEquals(hex.toString(), ShellBundleVerify.fingerprint(publicKey));
        assertEquals("abcd ef01 23", ShellBundleVerify.grouped("abcdef0123"));
        assertEquals(64 + 15, ShellBundleVerify.grouped(hex.toString()).length());
    }

    // ── base64 ───────────────────────────────────────────────────────────
    @Test
    public void base64MatchesTheJdkOnEveryPaddingLength() {
        for (int n = 0; n < 70; n++) {
            byte[] bytes = new byte[n];
            for (int i = 0; i < n; i++) bytes[i] = (byte) (i * 37 + n);
            assertArrayEquals(bytes, ShellBundleVerify.unbase64(Base64.getEncoder().encodeToString(bytes)));
        }
    }

    @Test
    public void base64HasExactlyOneSpelling() {
        assertNull(ShellBundleVerify.unbase64(null));
        assertNull(ShellBundleVerify.unbase64("QQ"));         // no padding
        assertNull(ShellBundleVerify.unbase64("QR=="));       // nonzero trailing bits
        assertNull(ShellBundleVerify.unbase64("Q Q="));       // whitespace
        assertNull(ShellBundleVerify.unbase64("Q-_="));       // url alphabet
        assertNull(ShellBundleVerify.unbase64("Q=Q="));       // padding inside
        assertArrayEquals(new byte[] { 'A' }, ShellBundleVerify.unbase64("QQ=="));
    }

    // ── the manifest ─────────────────────────────────────────────────────
    @Test
    public void theVectorParses() throws Exception {
        Manifest m = ShellBundleVerify.parse(signed);
        assertEquals("a1b2c3d4", m.hostId);
        assertEquals("0123456789abcdef", m.buildId);
        assertEquals(7, m.gen);
        assertEquals(3, m.files.size());
    }

    @Test
    public void aWrongVersionIsRefused() {
        String files = "[" + file("index.html", "0", SHA) + "]";
        assertMalformed(manifest("2", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1", "0", files));
        assertMalformed(manifest("0", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1", "0", files));
        assertMalformed(manifest("\"1\"", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1", "0", files));
        assertMalformed(manifest("1.0", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1", "0", files));
    }

    @Test
    public void malformedFieldsAreRefused() {
        String files = "[" + file("index.html", "0", SHA) + "]";
        assertMalformed(manifest("1", "\"NOT A HOST\"", "\"0123456789abcdef\"", "1", "0", files));
        assertMalformed(manifest("1", "7", "\"0123456789abcdef\"", "1", "0", files));
        assertMalformed(manifest("1", "\"a1b2c3d4\"", "\"../evil\"", "1", "0", files));
        assertMalformed(manifest("1", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "-1", "0", files));
        assertMalformed(manifest("1", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1.5", "0", files));
        assertMalformed(manifest("1", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "9007199254740992", "0", files));
        assertMalformed(manifest("1", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1", "1", files));   // total != sum
        assertMalformed(manifest("1", "\"a1b2c3d4\"", "\"0123456789abcdef\"", "1", "0", "[]"));
        assertMalformed(withFiles(file("index.html", "-1", SHA)));
        assertMalformed(withFiles(file("index.html", "0", "ABCD")));
        assertMalformed(withFiles(file("other.html", "0", SHA)));                                  // no index.html
        assertMalformed(withFiles(file("index.html", "0", SHA), file("index.html", "0", SHA)));
    }

    @Test
    public void aPathThatCouldEscapeIsRefusedInTheManifest() {
        for (String path : new String[] {
                "../index.html", "a/../../b", "/etc/passwd", "a//b", "a/./b", "a/", ".", "..", "a\\\\b", "" }) {
            assertMalformed(withFiles(file("index.html", "0", SHA), file(path, "0", SHA)));
        }
    }

    @Test
    public void textThatIsNotCleanJsonIsRefused() {
        assertMalformed("");
        assertMalformed("[]");
        assertMalformed("{\"v\":1");
        assertMalformed(withFiles(file("index.html", "0", SHA)) + " x");
        // The two ends of the contract would resolve a repeated key differently.
        assertMalformed("{\"v\":1,\"v\":1}");
        StringBuilder deep = new StringBuilder();
        for (int i = 0; i < 5000; i++) deep.append('[');
        assertMalformed(deep.toString());
        try {
            ShellBundleVerify.parse(new byte[] { '{', (byte) 0xc3, '}' });
            fail("bad UTF-8");
        } catch (Refused e) {
            assertEquals(ShellBundleVerify.BAD_MANIFEST, e.code);
        }
        try {
            ShellBundleVerify.parse(new byte[ShellBundleVerify.SIGNED_MAX + 1]);
            fail("too big");
        } catch (Refused e) {
            assertEquals(ShellBundleVerify.BAD_MANIFEST, e.code);
        }
    }

    // ── the directory ────────────────────────────────────────────────────
    @Test
    public void theExactFilesPass() throws Exception {
        ShellBundleVerify.checkFiles(bundle(), ShellBundleVerify.parse(signed));
    }

    @Test
    public void anExtraFileFails() throws Exception {
        File root = bundle();
        Files.write(new File(root, "assets/extra.js").toPath(), new byte[] { 1 });
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void anExtraEmptyDirectoryFails() throws Exception {
        File root = bundle();
        assertTrue(new File(root, "assets/nothing").mkdir());
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void aMissingFileFails() throws Exception {
        File root = bundle();
        assertTrue(new File(root, "assets/app.js").delete());
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void anAlteredFileOfTheSameSizeFails() throws Exception {
        File root = bundle();
        File f = new File(root, "index.html");
        byte[] bytes = Files.readAllBytes(f.toPath());
        bytes[0] ^= 1;
        Files.write(f.toPath(), bytes);
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void aFileOfAnotherSizeFails() throws Exception {
        File root = bundle();
        Files.write(new File(root, "assets/empty.txt").toPath(), new byte[] { 1 });
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void aSymlinkInPlaceOfAFileFailsEvenWithTheRightBytes() throws Exception {
        File root = bundle();
        File app = new File(root, "assets/app.js");
        File elsewhere = tmp.newFile("elsewhere.js");
        Files.write(elsewhere.toPath(), Files.readAllBytes(app.toPath()));
        assertTrue(app.delete());
        Files.createSymbolicLink(app.toPath(), elsewhere.toPath());
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void aSymlinkedDirectoryFails() throws Exception {
        File root = bundle();
        File assets = new File(root, "assets");
        File moved = tmp.newFolder("moved");
        for (File f : assets.listFiles()) assertTrue(f.renameTo(new File(moved, f.getName())));
        assertTrue(assets.delete());
        Files.createSymbolicLink(assets.toPath(), moved.toPath());
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void aDanglingSymlinkFails() throws Exception {
        File root = bundle();
        Files.createSymbolicLink(new File(root, "gone").toPath(), new File(root, "nowhere").toPath());
        assertRefused(ShellBundleVerify.BAD_FILES, root);
    }

    @Test
    public void aSymlinkedRootFails() throws Exception {
        File link = new File(tmp.getRoot(), "linked");
        Files.createSymbolicLink(link.toPath(), bundle().toPath());
        assertRefused(ShellBundleVerify.BAD_FILES, link);
    }

    /**
     * The HOST's own vector, read from where the host's tests read it: the fixture above is made by
     * this package's script, so on its own it proves only that Java agrees with that script.
     */
    @Test
    public void verifiesWhatTheHostSigned() throws Exception {
        File f = new File("../../../shared/test/fixtures/update-signature-vector.json");
        assertTrue("run from packages/app/android/app: " + f.getAbsolutePath(), f.isFile());
        Map<?, ?> v = (Map<?, ?>) ShellBundleVerify.readJson(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        String key = (String) v.get("updateKey");
        byte[] hostSigned = b64((String) v.get("signed"));
        assertTrue(ShellBundleVerify.signatureOk(hostSigned, b64((String) v.get("sig")), key));
        assertEquals(v.get("fingerprint"), ShellBundleVerify.fingerprint(key));
        assertNotNull(ShellBundleVerify.parse(hostSigned));
        Map<?, ?> bad = (Map<?, ?>) v.get("tampered");
        assertFalse(ShellBundleVerify.signatureOk(b64((String) bad.get("signed")), b64((String) bad.get("sig")), key));
    }
}
