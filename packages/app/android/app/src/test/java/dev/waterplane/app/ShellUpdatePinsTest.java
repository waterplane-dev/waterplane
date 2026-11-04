package dev.waterplane.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import dev.waterplane.app.ShellBundleVerify.Refused;
import dev.waterplane.app.ShellUpdatePins.Ask;
import dev.waterplane.app.ShellUpdatePins.Pin;
import dev.waterplane.app.ShellUpdatePins.Stored;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;

import org.junit.BeforeClass;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The pin and gate rules of {@link ShellUpdatePins}, on the JVM. The dialog around them needs a device. */
public class ShellUpdatePinsTest {

    private static final String HOST = "aaaa1111";
    private static final String OTHER_HOST = "bbbb2222";
    private static final String ID = "0123456789abcdef";
    private static final byte[] PAGE = "<!doctype html>\n".getBytes(StandardCharsets.UTF_8);

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static KeyPair mine;
    private static KeyPair theirs;
    private static String myKey;
    private static String theirKey;

    @BeforeClass
    public static void keys() throws Exception {
        mine = newKey();
        theirs = newKey();
        myKey = spki(mine);
        theirKey = spki(theirs);
    }

    private static KeyPair newKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        return g.generateKeyPair();
    }

    private static String spki(KeyPair k) {
        return Base64.getEncoder().encodeToString(k.getPublic().getEncoded());
    }

    private static String b64(byte[] b) {
        return Base64.getEncoder().encodeToString(b);
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }

    /** {@code signed}, base64, for a one-file bundle holding {@link #PAGE}. */
    private static String signed(String hostId, String buildId, long gen) throws Exception {
        String json = "{\"v\":1,\"hostId\":\"" + hostId + "\",\"buildId\":\"" + buildId + "\",\"gen\":" + gen
                + ",\"total\":" + PAGE.length + ",\"files\":[{\"path\":\"index.html\",\"size\":" + PAGE.length
                + ",\"sha256\":\"" + hex(MessageDigest.getInstance("SHA-256").digest(PAGE)) + "\"}]}";
        return b64(json.getBytes(StandardCharsets.UTF_8));
    }

    /** P1363 over the decoded bytes: the JDK signs DER, so this is the reverse of the code under test. */
    private static String sig(KeyPair k, String signedB64) throws Exception {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(k.getPrivate());
        s.update(Base64.getDecoder().decode(signedB64));
        byte[] der = s.sign();
        byte[] out = new byte[64];
        int rLen = der[3];
        int sAt = 4 + rLen + 2;
        int sLen = der[sAt - 1];
        copyScalar(der, 4, rLen, out, 0);
        copyScalar(der, sAt, sLen, out, 32);
        return b64(out);
    }

    private static void copyScalar(byte[] der, int at, int len, byte[] out, int to) {
        int skip = len > 32 ? len - 32 : 0;
        System.arraycopy(der, at + skip, out, to + 32 - (len - skip), len - skip);
    }

    private File bundle() throws Exception {
        File dir = tmp.newFolder();
        Files.write(new File(dir, "index.html").toPath(), PAGE);
        return dir;
    }

    private static List<Pin> pinned(long gen) {
        return Collections.singletonList(new Pin(HOST, myKey, gen));
    }

    private void assertAdmitRefused(String code, List<Pin> pins, String id, String signed, String sig, File dir) {
        try {
            ShellUpdatePins.admit(pins, id, signed, sig, dir);
            fail("expected " + code);
        } catch (Refused e) {
            assertEquals(code, e.code);
        }
    }

    // ── the store ────────────────────────────────────────────────────────
    @Test
    public void theFirstPinAsksAndTheSameKeyDoesNot() {
        List<Pin> none = Collections.emptyList();
        assertEquals(Ask.FIRST_KEY, ShellUpdatePins.ask(none, HOST, myKey));
        assertEquals(Ask.ALREADY_PINNED, ShellUpdatePins.ask(ShellUpdatePins.accept(none, HOST, myKey), HOST, myKey));
    }

    @Test
    public void aDifferentKeyForTheHostIsAChange() {
        assertEquals(Ask.KEY_CHANGED, ShellUpdatePins.ask(pinned(3), HOST, theirKey));
        assertEquals(Ask.FIRST_KEY, ShellUpdatePins.ask(pinned(3), OTHER_HOST, theirKey));
    }

    @Test
    public void acceptingAChangedKeyReplacesTheRowAndResetsGen() {
        List<Pin> after = ShellUpdatePins.accept(pinned(9), HOST, theirKey);
        assertEquals(1, after.size());
        assertEquals(theirKey, after.get(0).key);
        assertEquals(0, after.get(0).gen);
    }

    @Test
    public void acceptingTheSameKeyKeepsGen() {
        List<Pin> rows = pinned(9);
        assertSame(rows, ShellUpdatePins.accept(rows, HOST, myKey));
    }

    @Test
    public void forgettingTouchesOnlyThatHost() {
        List<Pin> two = ShellUpdatePins.accept(pinned(4), OTHER_HOST, theirKey);
        List<Pin> left = ShellUpdatePins.forget(two, HOST);
        assertEquals(1, left.size());
        assertEquals(OTHER_HOST, left.get(0).hostId);
    }

    @Test
    public void forgetThenPinIsTheWayBackForARestoredDesktop() {
        List<Pin> rows = ShellUpdatePins.accept(ShellUpdatePins.forget(pinned(50), HOST), HOST, myKey);
        assertEquals(0, ShellUpdatePins.highWater(rows, HOST));
    }

    @Test
    public void theStoreRoundTrips() {
        List<Pin> rows = ShellUpdatePins.accept(pinned(12), OTHER_HOST, theirKey);
        List<Pin> back = ShellUpdatePins.parse(ShellUpdatePins.serialize(rows));
        assertEquals(2, back.size());
        assertEquals(HOST, back.get(0).hostId);
        assertEquals(myKey, back.get(0).key);
        assertEquals(12, back.get(0).gen);
        assertEquals(theirKey, back.get(1).key);
    }

    @Test
    public void anEmptyStoreIsNoPins() {
        assertTrue(ShellUpdatePins.parse(null).isEmpty());
        assertTrue(ShellUpdatePins.parse("").isEmpty());
        assertTrue(ShellUpdatePins.parse("[]").isEmpty());
    }

    @Test
    public void anUnreadableStoreRefusesRatherThanReadingAsNoPins() throws Exception {
        for (String bad : new String[] { "{", "{}", "[1]", "[{\"hostId\":\"x\",\"key\":\"k\",\"gen\":0}]" }) {
            List<Pin> rows = ShellUpdatePins.parse(bad);
            assertFalse(bad, rows.isEmpty());
            assertTrue(ShellUpdatePins.real(rows).isEmpty());
            assertAdmitRefused(ShellBundleVerify.UNSIGNED, rows, ID, null, null, bundle());
            String s = signed(HOST, ID, 1);
            assertAdmitRefused(ShellBundleVerify.NOT_PINNED, rows, ID, s, sig(mine, s), bundle());
            assertFalse(ShellUpdatePins.servable(rows, ID, new Stored(s, sig(mine, s)), bundle()));
            // A person's yes repairs it.
            assertEquals(1, ShellUpdatePins.accept(rows, HOST, myKey).size());
        }
    }

    // ── finishBundle ─────────────────────────────────────────────────────
    @Test
    public void noPinAndNoSignedIsTodaysBehaviour() throws Exception {
        assertNull(ShellUpdatePins.admit(Collections.emptyList(), ID, null, null, bundle()));
    }

    @Test
    public void noPinAndSignedIsRefusedThePageMustPinFirst() throws Exception {
        String s = signed(HOST, ID, 1);
        assertAdmitRefused(ShellBundleVerify.PIN_FIRST, Collections.emptyList(), ID, s, sig(mine, s), bundle());
        assertAdmitRefused(ShellBundleVerify.PIN_FIRST, Collections.emptyList(), ID, "", "", bundle());
    }

    @Test
    public void aPinAndNoSignedIsRefused() throws Exception {
        assertAdmitRefused(ShellBundleVerify.UNSIGNED, pinned(0), ID, null, null, bundle());
    }

    @Test
    public void aGoodBundlePasses() throws Exception {
        String s = signed(HOST, ID, 5);
        ShellBundleVerify.Manifest m = ShellUpdatePins.admit(pinned(5), ID, s, sig(mine, s), bundle());
        assertNotNull(m);
        assertEquals(HOST, m.hostId);
        assertEquals(5, m.gen);
    }

    @Test
    public void aMissingOrBadSigIsRefused() throws Exception {
        String s = signed(HOST, ID, 1);
        assertAdmitRefused(ShellBundleVerify.BAD_SIGNATURE, pinned(0), ID, s, null, bundle());
        assertAdmitRefused(ShellBundleVerify.BAD_SIGNATURE, pinned(0), ID, s, "@@@@", bundle());
        assertAdmitRefused(ShellBundleVerify.BAD_SIGNATURE, pinned(0), ID, s, b64(new byte[64]), bundle());
        assertAdmitRefused(ShellBundleVerify.BAD_SIGNATURE, pinned(0), ID, s, sig(theirs, s), bundle());
    }

    @Test
    public void onePinnedDesktopCannotSignForAnother() throws Exception {
        List<Pin> rows = ShellUpdatePins.accept(pinned(0), OTHER_HOST, theirKey);
        String s = signed(HOST, ID, 1);   // claims HOST, signed with OTHER_HOST's key
        assertAdmitRefused(ShellBundleVerify.BAD_SIGNATURE, rows, ID, s, sig(theirs, s), bundle());
    }

    @Test
    public void aBundleFromAnUnpinnedDesktopIsRefused() throws Exception {
        String s = signed(OTHER_HOST, ID, 1);
        assertAdmitRefused(ShellBundleVerify.NOT_PINNED, pinned(0), ID, s, sig(theirs, s), bundle());
    }

    @Test
    public void anyPinnedDesktopsBundlePassesNotOnlyTheFirst() throws Exception {
        List<Pin> rows = ShellUpdatePins.accept(pinned(0), OTHER_HOST, theirKey);
        String s = signed(OTHER_HOST, ID, 1);
        assertEquals(OTHER_HOST, ShellUpdatePins.admit(rows, ID, s, sig(theirs, s), bundle()).hostId);
    }

    @Test
    public void aSignatureForAnotherBuildIsRefused() throws Exception {
        String s = signed(HOST, "ffffffffffffffff", 1);
        assertAdmitRefused(ShellBundleVerify.WRONG_BUILD, pinned(0), ID, s, sig(mine, s), bundle());
    }

    @Test
    public void filesThatDoNotMatchAreRefused() throws Exception {
        File dir = bundle();
        Files.write(new File(dir, "extra.js").toPath(), new byte[] { 1 });
        String s = signed(HOST, ID, 1);
        assertAdmitRefused(ShellBundleVerify.BAD_FILES, pinned(0), ID, s, sig(mine, s), dir);
    }

    @Test
    public void malformedSignedIsRefused() throws Exception {
        assertAdmitRefused(ShellBundleVerify.BAD_MANIFEST, pinned(0), ID, "@@@@", "", bundle());
        assertAdmitRefused(ShellBundleVerify.BAD_MANIFEST, pinned(0), ID, "", "", bundle());
    }

    // ── gen ──────────────────────────────────────────────────────────────
    @Test
    public void genBelowTheHighWaterIsRefused() throws Exception {
        String s = signed(HOST, ID, 4);
        assertAdmitRefused(ShellBundleVerify.ROLLBACK, pinned(5), ID, s, sig(mine, s), bundle());
    }

    @Test
    public void genEqualToTheHighWaterPasses() throws Exception {
        String s = signed(HOST, ID, 5);
        assertNotNull(ShellUpdatePins.admit(pinned(5), ID, s, sig(mine, s), bundle()));
    }

    @Test
    public void theHighWaterOnlyRises() {
        assertEquals(8, ShellUpdatePins.highWater(ShellUpdatePins.raise(pinned(5), HOST, 8), HOST));
        assertEquals(5, ShellUpdatePins.highWater(ShellUpdatePins.raise(pinned(5), HOST, 3), HOST));
    }

    @Test
    public void theHighWaterIsPerDesktop() {
        List<Pin> rows = ShellUpdatePins.accept(pinned(5), OTHER_HOST, theirKey);
        rows = ShellUpdatePins.raise(rows, OTHER_HOST, 9);
        assertEquals(5, ShellUpdatePins.highWater(rows, HOST));
        assertEquals(9, ShellUpdatePins.highWater(rows, OTHER_HOST));
    }

    @Test
    public void aRaisedMarkSurvivesTheStore() {
        List<Pin> rows = ShellUpdatePins.raise(pinned(1), HOST, 40);
        assertEquals(40, ShellUpdatePins.highWater(ShellUpdatePins.parse(ShellUpdatePins.serialize(rows)), HOST));
    }

    // ── stage and applyNow ───────────────────────────────────────────────
    @Test
    public void recheckPassesWhatFinishKept() throws Exception {
        String s = signed(HOST, ID, 2);
        ShellUpdatePins.recheck(pinned(2), ID, new Stored(s, sig(mine, s)), bundle());
    }

    @Test
    public void aDirectoryWithNoVerifiedManifestIsRefusedWhileAnyPinExists() throws Exception {
        try {
            ShellUpdatePins.recheck(pinned(0), ID, null, bundle());
            fail("refused");
        } catch (Refused e) {
            assertEquals(ShellBundleVerify.NOT_VERIFIED, e.code);
        }
    }

    @Test
    public void noPinMeansNothingToRecheck() throws Exception {
        ShellUpdatePins.recheck(Collections.emptyList(), ID, null, bundle());
    }

    @Test
    public void recheckRefusesABuildOlderThanTheMark() throws Exception {
        String s = signed(HOST, ID, 2);
        try {
            ShellUpdatePins.recheck(pinned(3), ID, new Stored(s, sig(mine, s)), bundle());
            fail("refused");
        } catch (Refused e) {
            assertEquals(ShellBundleVerify.ROLLBACK, e.code);
        }
    }

    @Test
    public void recheckFindsFilesChangedSinceFinish() throws Exception {
        File dir = bundle();
        String s = signed(HOST, ID, 2);
        Files.write(new File(dir, "index.html").toPath(), new byte[PAGE.length]);
        try {
            ShellUpdatePins.recheck(pinned(2), ID, new Stored(s, sig(mine, s)), dir);
            fail("refused");
        } catch (Refused e) {
            assertEquals(ShellBundleVerify.BAD_FILES, e.code);
        }
    }

    // ── the launch check ─────────────────────────────────────────────────
    @Test
    public void aLaunchKeepsAVerifiedBundleEvenBelowTheMark() throws Exception {
        String s = signed(HOST, ID, 2);
        assertTrue(ShellUpdatePins.servable(pinned(9), ID, new Stored(s, sig(mine, s)), bundle()));
    }

    @Test
    public void aLaunchWithNoPinKeepsWhatItHas() throws Exception {
        assertTrue(ShellUpdatePins.servable(Collections.emptyList(), ID, null, bundle()));
    }

    @Test
    public void aLaunchDropsWhatNoLongerVerifiesWithoutThrowing() throws Exception {
        String s = signed(HOST, ID, 2);
        String good = sig(mine, s);
        assertFalse("no manifest", ShellUpdatePins.servable(pinned(0), ID, null, bundle()));
        assertFalse("key changed", ShellUpdatePins.servable(
                ShellUpdatePins.accept(pinned(0), HOST, theirKey), ID, new Stored(s, good), bundle()));
        assertFalse("garbage", ShellUpdatePins.servable(pinned(0), ID, new Stored("@", "@"), bundle()));
        assertFalse("gone", ShellUpdatePins.servable(pinned(0), ID, new Stored(s, good), new File(tmp.getRoot(), "nope")));
        File same = bundle();
        Files.write(new File(same, "index.html").toPath(), new byte[PAGE.length]);
        assertFalse("same size, other bytes", ShellUpdatePins.servable(pinned(0), ID, new Stored(s, good), same));
    }

    // ── what is kept beside a bundle ─────────────────────────────────────
    @Test
    public void whatIsKeptReadsBack() throws Exception {
        File f = new File(tmp.getRoot(), "nested/dir/x.manifest");
        ShellUpdatePins.writeStored(f, "c2lnbmVk", "c2ln");
        Stored back = ShellUpdatePins.readStored(f);
        assertEquals("c2lnbmVk", back.signed);
        assertEquals("c2ln", back.sig);
        ShellUpdatePins.writeStored(f, "b3RoZXI=", "c2ln");
        assertEquals("b3RoZXI=", ShellUpdatePins.readStored(f).signed);
        assertEquals(1, f.getParentFile().list().length);   // no temp left behind
    }

    @Test
    public void aMissingOrTornFileReadsAsNothing() throws Exception {
        assertNull(ShellUpdatePins.readStored(new File(tmp.getRoot(), "absent")));
        File f = tmp.newFile();
        Files.write(f.toPath(), "only one line".getBytes(StandardCharsets.UTF_8));
        assertNull(ShellUpdatePins.readStored(f));
    }

    // ── what the dialogs say ─────────────────────────────────────────────
    @Test
    public void aNameCannotFakeALineOfTheDialog() {
        assertEquals("Studio", ShellUpdatePins.safeName("Stu\ndio", HOST));
        assertEquals("evil", ShellUpdatePins.safeName("‮evil ", HOST));
        assertEquals(HOST, ShellUpdatePins.safeName("\n\t ", HOST));
        assertEquals(HOST, ShellUpdatePins.safeName(null, HOST));
        char[] long_ = new char[500];
        Arrays.fill(long_, 'x');
        assertEquals(60, ShellUpdatePins.safeName(new String(long_), HOST).length());
    }

    @Test
    public void theDialogNamesTheDesktopAndTheFingerprintAndWhatItMeans() {
        String print = ShellBundleVerify.grouped(ShellBundleVerify.fingerprint(myKey));
        String first = ShellUpdatePins.pinWords(Ask.FIRST_KEY, "Studio", myKey)[1];
        assertTrue(first.contains("Studio"));
        assertTrue(first.contains(print));
        assertTrue(first.contains("this desktop will be able to update this app"));
        String[] changed = ShellUpdatePins.pinWords(Ask.KEY_CHANGED, "Studio", myKey);
        assertTrue(changed[0].contains("changed"));
        assertTrue(changed[1].contains(print));
    }

    @Test
    public void forgettingTheLastKeySaysWhatThatLoosens() {
        assertFalse(ShellUpdatePins.forgetWords("Studio", false)[1].contains("unsigned"));
        assertTrue(ShellUpdatePins.forgetWords("Studio", true)[1].contains("unsigned"));
    }

    @Test
    public void rowsAreNotSharedWithTheCaller() {
        List<Pin> mineRows = new ArrayList<>(pinned(1));
        List<Pin> out = ShellUpdatePins.raise(mineRows, HOST, 2);
        assertEquals(1, mineRows.get(0).gen);
        assertEquals(2, out.get(0).gen);
    }
}
